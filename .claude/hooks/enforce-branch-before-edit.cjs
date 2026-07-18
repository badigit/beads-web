#!/usr/bin/env node
'use strict';

// PreToolUse: Edit + Write — Branch protection, subagent bypass, quick-fix escape hatch
// Consolidated from: enforce-branch-before-edit + block-orchestrator-tools (Edit/Write logic)

const path = require('path');
const {
  readStdinJSON, getField, ask,
  getCurrentBranch, containsPathSegment, isSubagent, runHook,
} = require('./hook-utils.cjs');

/** Human-readable size of the pending change, for the ask() prompt. */
function describeChange(input, toolName) {
  if (toolName === 'Edit') {
    const oldStr = getField(input, 'tool_input.old_string');
    const newStr = getField(input, 'tool_input.new_string');
    const newLines = newStr ? newStr.split('\n').length : 0;
    const oldChars = oldStr ? oldStr.length : 0;
    const newChars = newStr ? newStr.length : 0;
    return `~${newLines} lines (${oldChars} → ${newChars} chars)`;
  }
  const content = getField(input, 'tool_input.content');
  const contentLines = content ? content.split('\n').length : 0;
  return `~${contentLines} lines (new file)`;
}

runHook('enforce-branch-before-edit', () => {
  const input = readStdinJSON();
  const toolName = getField(input, 'tool_name');

  // --- Subagents get full access ---
  if (isSubagent(input)) process.exit(0);

  const filePath = getField(input, 'tool_input.file_path');
  const fileName = path.basename(filePath);

  // --- Always-allowed paths ---
  if (containsPathSegment(filePath, '.claude/plans')) process.exit(0);
  if (fileName === 'CLAUDE.md' || fileName === 'CLAUDE.local.md') process.exit(0);
  if (fileName === 'git-issues.md') process.exit(0);

  // Allow memory files (.claude/**/memory/**)
  if (containsPathSegment(filePath, 'memory')) {
    const norm = filePath.replace(/\\/g, '/');
    if (norm.includes('.claude') && norm.includes('memory')) process.exit(0);
  }

  // Allow edits inside worktrees
  if (containsPathSegment(filePath, '.worktrees')) process.exit(0);
  if (containsPathSegment(process.cwd(), '.worktrees')) process.exit(0);

  // --- Branch checks ---
  const branch = getCurrentBranch();
  const sizeInfo = describeChange(input, toolName);

  // On main/master → ask (user may legitimately work without a worktree)
  if (branch === 'main' || branch === 'master') {
    ask(
      `Edit directly on '${branch}'?\n` +
      `  File: ${fileName}\n` +
      `  Change: ${sizeInfo}\n\n` +
      'Approve to edit on the default branch.\n' +
      'Deny to branch first:\n' +
      '  git checkout -b quick-fix-description  (quick fix <10 lines)\n' +
      '  or use the full bead workflow (.worktrees/bd-{BEAD_ID}).'
    );
  }

  // On feature branch → quick-fix ask with change size
  ask(
    `Quick fix on branch '${branch}'?\n` +
    `  File: ${fileName}\n` +
    `  Change: ${sizeInfo}\n\n` +
    'Approve for trivial changes (<10 lines).\n' +
    'Deny to use full bead workflow instead.'
  );
});
