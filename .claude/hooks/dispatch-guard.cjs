#!/usr/bin/env node
'use strict';

// PreToolUse: Task — Supervisor dispatch guard
// Consolidated from: enforce-bead-for-supervisor.sh + enforce-sequential-dispatch.sh
//
// Checks (supervisors only; merge-supervisor fully exempt):
//   1. BEAD_ID present in the dispatch prompt (all work must be tracked)
//   2. Epic children (BEAD_ID with a dot) must specify EPIC_BRANCH
//   3. Bead is not closed/done (create a follow-up bead instead)
//   4. Epic children have no unresolved blockers
//   5. Epic design doc exists when the epic declares a design path

const fs = require('fs');
const {
  readStdinJSON, getField, deny, parseBeadId,
  execCommandJSON, runHook,
} = require('./hook-utils.cjs');

function denyBeadRequired() {
  deny(
    '<bead-required>\nAll supervisor work MUST be tracked with a bead.\n\n' +
    '<action>\nFor standalone tasks:\n' +
    '  1. bd create "Task title" -d "Description"\n' +
    '  2. Dispatch with: BEAD_ID: {id}\n\n' +
    'For epic children (cross-domain features):\n' +
    '  1. bd create "Epic" -d "..." --type epic\n' +
    '  2. bd create "Child" -d "..." --parent {EPIC_ID}\n' +
    '  3. Dispatch with: BEAD_ID: {child_id}, EPIC_BRANCH: bd-{epic_id}, EPIC_ID: {epic_id}\n' +
    '</action>\n</bead-required>'
  );
}

function denyEpicBranchRequired() {
  deny(
    '<epic-branch-required>\nChild task detected (BEAD_ID contains dot). EPIC_BRANCH is required.\n\n' +
    'Child tasks work on the shared epic branch, not their own branch.\n\n' +
    '<format>\nBEAD_ID: {CHILD_ID}       (e.g., BD-001.2)\n' +
    'EPIC_BRANCH: bd-{EPIC_ID} (e.g., bd-BD-001)\n' +
    'EPIC_ID: {EPIC_ID}        (e.g., BD-001)\n\n' +
    '[Task description]\n</format>\n\n' +
    'This ensures all epic children work on the same branch for consistency.\n' +
    '</epic-branch-required>'
  );
}

/** Deny when the target bead is already closed/done. */
function checkNotClosed(beadId) {
  const beadData = execCommandJSON('bd', ['show', beadId, '--json']);
  const status = beadData && beadData[0] ? beadData[0].status || '' : '';
  if (status === 'closed' || status === 'done') {
    deny(
      `<closed-bead>\nBead ${beadId} is already ${status}. Do not reopen closed beads.\n\n` +
      'Create a new bead for follow-up work and relate it:\n\n' +
      `  bd create "Fix: [description]" -d "Follow-up to ${beadId}: [details]"\n` +
      '  # Returns: {NEW_ID}\n' +
      `  bd dep relate {NEW_ID} ${beadId}\n\n` +
      'Then dispatch with the NEW bead ID.\n</closed-bead>'
    );
  }
}

/** Deny when an epic child still has unresolved blockers. */
function checkBlockers(beadId, epicId) {
  const deps = execCommandJSON('bd', ['dep', 'list', beadId, '--json']);
  if (!Array.isArray(deps)) return;
  const blockers = deps
    .filter(d => d && d.id && d.id !== epicId
      && d.status !== 'done' && d.status !== 'closed')
    .map(d => d.id);
  if (blockers.length > 0) {
    deny(
      `<blocked-task>\nCannot dispatch ${beadId} - unresolved blockers: ${blockers.join(', ')}\n\n` +
      'Complete blocking tasks first, then dispatch this one.\n\n' +
      'Use: bd ready --json to see tasks with no blockers.\n</blocked-task>'
    );
  }
}

/** Deny when the epic declares a design path but the file does not exist. */
function checkDesignDoc(epicId) {
  const epicData = execCommandJSON('bd', ['show', epicId, '--json']);
  const designPath = epicData && epicData[0] ? epicData[0].design || '' : '';
  if (designPath && !fs.existsSync(designPath)) {
    deny(
      `<design-doc-missing>\nEpic ${epicId} has design path '${designPath}' but file doesn't exist.\n\n` +
      'Before dispatching architect, verify you fully understand the epic:\n' +
      '  1. Are the requirements clear and unambiguous?\n' +
      '  2. Do you know the expected inputs/outputs?\n' +
      '  3. Are there edge cases or constraints to consider?\n' +
      '  4. Do you understand how this integrates with existing code?\n\n' +
      'If requirements are CLEAR - dispatch architect to create the design doc first:\n' +
      `  Task(subagent_type="architect", prompt="Create design doc for EPIC_ID: ${epicId}\\n` +
      `Output: ${designPath}")\n\n` +
      'If requirements are UNCLEAR - use AskUserQuestion to clarify FIRST.\n' +
      '</design-doc-missing>'
    );
  }
}

runHook('dispatch-guard', () => {
  const input = readStdinJSON();
  if (getField(input, 'tool_name') !== 'Task') process.exit(0);

  const subagentType = getField(input, 'tool_input.subagent_type');
  const prompt = getField(input, 'tool_input.prompt');

  // Only supervisors are guarded; merge-supervisor is fully exempt
  // (merge conflicts are incidental to other work, not tracked separately).
  if (!subagentType.includes('supervisor')) process.exit(0);
  if (subagentType === 'merge-supervisor') process.exit(0);

  // 1. BEAD_ID required
  if (!prompt.includes('BEAD_ID:')) denyBeadRequired();
  const beadId = parseBeadId(prompt);
  if (!beadId) process.exit(0);

  // 2. Epic children must carry EPIC_BRANCH
  const isChild = beadId.includes('.');
  if (isChild && !prompt.includes('EPIC_BRANCH:')) denyEpicBranchRequired();

  // Worker supervisors are exempt from lifecycle checks
  if (subagentType.includes('worker')) process.exit(0);

  // 3. Bead must not be closed/done
  checkNotClosed(beadId);

  // 4-5. Epic child: blockers resolved, design doc exists
  if (isChild) {
    const epicId = beadId.replace(/\.[^.]+$/, '');
    checkBlockers(beadId, epicId);
    checkDesignDoc(epicId);
  }

  process.exit(0);
});
