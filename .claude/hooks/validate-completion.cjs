#!/usr/bin/env node
'use strict';

// SubagentStop: Enforce bead lifecycle — work verification
// Refactored: main function <30 lines, helpers handle each check.

const fs = require('fs');
const path = require('path');
const {
  readStdinJSON, getField, approve, block,
  execCommand, execCommandJSON, getRepoRoot, runHook,
} = require('./hook-utils.cjs');

/**
 * Statuses an agent may legitimately leave a bead in when it stops.
 * 'in_progress' is the normal case — the orchestrator closes the bead after the
 * PR merges (see .claude/rules/beads-workflow.md).  'closed' covers agents that
 * finished and closed it themselves; 'blocked'/'deferred' cover work halted for
 * an external reason.  'open' is NOT accepted: it means work never started.
 * The old 'inreview' status was removed from bd in v1.0.2 and is now invalid.
 *
 * Must stay above the runHook() call below — `const` is not hoisted, and the
 * main body runs at module load time.
 */
const AGENT_TERMINAL_STATUSES = ['in_progress', 'closed', 'blocked', 'deferred'];

runHook('validate-completion', () => {
  const input = readStdinJSON();
  const agentTranscript = getField(input, 'agent_transcript_path');
  const mainTranscript = getField(input, 'transcript_path');
  const agentId = getField(input, 'agent_id');

  if (!agentTranscript || !fs.existsSync(agentTranscript)) approve();

  // Determine subagent type BEFORE expensive transcript parsing
  const subagentType = extractSubagentType(agentId, mainTranscript);
  const isSupervisor = subagentType.includes('supervisor');

  // Worker supervisors are exempt from all checks
  if (subagentType.includes('worker')) approve();

  // Extract last assistant response
  const lastResponse = extractLastResponse(agentTranscript);

  // Non-supervisors: only verify if they output completion patterns
  if (!isSupervisor) {
    const hasCompletion = /BEAD.*COMPLETE/.test(lastResponse)
      && /(Worktree:|Branch:).*bd-/.test(lastResponse);
    if (!hasCompletion) approve();
  }

  // Supervisors must include completion report
  if (isSupervisor) verifyCompletionFormat(lastResponse);

  const beadId = extractBeadId(lastResponse);
  verifyChecklist(lastResponse, beadId);
  verifyComment(agentTranscript, beadId);
  verifyWorktree(beadId);
  verifyBeadStatus(beadId);
  verifyVerbosity(lastResponse);

  approve();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract subagent_type by scanning main transcript for the Task tool_use. */
function extractSubagentType(agentId, mainTranscript) {
  if (!agentId || !mainTranscript || !fs.existsSync(mainTranscript)) return '';
  try {
    const lines = fs.readFileSync(mainTranscript, 'utf8').split('\n').filter(Boolean);

    // Find parentToolUseID from the agent entry
    let parentToolUseId = '';
    for (const line of lines) {
      if (line.includes(`"agentId":"${agentId}"`)) {
        try { parentToolUseId = JSON.parse(line).parentToolUseID || ''; } catch { /* skip */ }
        break;
      }
    }
    if (!parentToolUseId) return '';

    // Find the Task tool_use with that ID
    for (const line of lines) {
      if (line.includes(`"id":"${parentToolUseId}"`) && line.includes('"name":"Task"')) {
        try {
          const content = JSON.parse(line).message?.content;
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c.type === 'tool_use' && c.id === parentToolUseId && c.input) {
                return c.input.subagent_type || '';
              }
            }
          }
        } catch { /* skip */ }
        break;
      }
    }
  } catch { /* fail open */ }
  return '';
}

/** Extract last assistant text response from agent transcript (last 200 lines). */
function extractLastResponse(transcriptPath) {
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8')
      .split('\n').filter(Boolean).slice(-200);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(lines[i]).message;
        if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b.text) return b.text;
          }
        }
      } catch { /* skip line */ }
    }
  } catch { /* fail open */ }
  return '';
}

/** Extract BEAD_ID from response text. */
function extractBeadId(response) {
  const m = response.match(/BEAD\s+([A-Za-z0-9._-]+)/);
  return m ? m[1] : '';
}

/** Block if completion report format is missing. */
function verifyCompletionFormat(response) {
  const hasBeadComplete = /BEAD.*COMPLETE/.test(response);
  const hasWorktreeOrBranch = /(Worktree:|Branch:).*bd-/.test(response);
  if (!hasBeadComplete || !hasWorktreeOrBranch) {
    block(
      'Work verification failed: completion report missing.\n\n' +
      'Required format:\n' +
      'BEAD {BEAD_ID} COMPLETE\n' +
      'Worktree: .worktrees/bd-{BEAD_ID}\n' +
      'Files: [list]\n' +
      'Tests: pass\n' +
      'Summary: [1 sentence]'
    );
  }
}

/** Block if completion report has no checklist or has unchecked items. */
function verifyChecklist(response, beadId) {
  if (!response.includes('Checklist:')) {
    block(
      'Work verification failed: completion report missing Checklist.\n\n' +
      'Re-read the bead description with `bd show ' + (beadId || '{BEAD_ID}') + '` and add:\n' +
      'Checklist:\n- [x] requirement 1\n- [x] requirement 2'
    );
  }

  const unchecked = response.match(/- \[ \]/g);
  if (unchecked) {
    block(
      `Work verification failed: ${unchecked.length} unchecked item(s) in Checklist.\n\n` +
      'Complete all requirements before marking done, or update the bead description if requirements changed.'
    );
  }
}

/**
 * Block if the bead has no comments.
 *
 * Source of truth is `bd comments {ID} --json`.  Only if bd is unreachable
 * (not on PATH for this process) do we fall back to scanning the transcript
 * for a `bd comments add` invocation — the agent may legitimately have called
 * bd by absolute path, so the pattern tolerates `...\bd.exe" comments add`.
 */
function verifyComment(transcriptPath, beadId) {
  const missing = (id) => block(
    'Work verification failed: no comment on bead.\n\n' +
    `Run: bd comments add ${id || '{BEAD_ID}'} "Completed: [summary]"`
  );

  if (beadId) {
    const comments = execCommandJSON('bd', ['comments', beadId, '--json']);
    if (Array.isArray(comments)) {
      if (comments.length === 0) missing(beadId);
      return;
    }
    // bd unavailable / unparseable — fall through to the transcript heuristic
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    if (/bd(?:\.exe)?(?:\\?["'])?\s+comments?\b/.test(content)) return;
  } catch { /* skip */ }
  missing(beadId);
}

/** Block if worktree missing, has uncommitted changes, or branch not pushed. */
function verifyWorktree(beadId) {
  const repoRoot = getRepoRoot();
  if (!repoRoot || !beadId) return;

  const worktreePath = path.join(repoRoot, '.worktrees', `bd-${beadId}`);
  if (!fs.existsSync(worktreePath)) {
    block('Work verification failed: worktree not found.\n\nCreate worktree first via API.');
  }

  const uncommitted = execCommand('git', ['-C', worktreePath, 'status', '--porcelain']);
  if (uncommitted) {
    block('Work verification failed: uncommitted changes.\n\nRun in worktree:\n  git add -A && git commit -m "..."');
  }

  const hasRemote = execCommand('git', ['-C', worktreePath, 'remote', 'get-url', 'origin']);
  if (hasRemote) {
    const branchName = `bd-${beadId}`;
    const remoteExists = execCommand('git', ['-C', worktreePath, 'ls-remote', '--heads', 'origin', branchName]);
    if (!remoteExists) {
      block('Work verification failed: branch not pushed.\n\nRun: git push -u origin bd-{BEAD_ID}');
    }
  }
}

/** Block if the bead was never moved out of 'open' (or is in an unknown state). */
function verifyBeadStatus(beadId) {
  if (!beadId) return;
  const beadData = execCommandJSON('bd', ['show', beadId, '--json']);
  // bd unreachable or output unparseable — fail open, never block on tooling.
  if (!Array.isArray(beadData) || !beadData[0]) return;
  const status = beadData[0].status;
  if (!status) return;
  if (!AGENT_TERMINAL_STATUSES.includes(status)) {
    block(
      `Work verification failed: bead status is '${status}'.\n\n` +
      `Expected one of: ${AGENT_TERMINAL_STATUSES.join(', ')}.\n` +
      `Run: bd update ${beadId} --status in_progress\n` +
      'Leave it in_progress — the orchestrator closes the bead after the PR merges.'
    );
  }
}

/** Block if response exceeds verbosity limits (15 lines / 800 chars). */
function verifyVerbosity(response) {
  const lineCount = response.split('\n').length;
  const charCount = response.length;
  if (lineCount > 25 || charCount > 1200) {
    block(`Work verification failed: response too verbose (${lineCount} lines, ${charCount} chars). Max: 25 lines, 1200 chars.`);
  }
}
