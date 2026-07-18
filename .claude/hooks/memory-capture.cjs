#!/usr/bin/env node
'use strict';

// PostToolUse:Bash — Persist LEARNED: insights from bd comments as bd memories.
//
// Watches `bd comments add {ID} "... LEARNED: ..."` (and legacy `bd comment`)
// and stores the LEARNED content via `bd remember` so it is surfaced by
// `bd prime` in every future session. Search with: bd memories "keyword".

const { readStdinJSON, getField, execCommand, runHook } = require('./hook-utils.cjs');

/** Extract { beadId, learned } from a bd comment command, or null. */
function parseLearnedComment(command) {
  // `bd comments add <id> "..."` / `bd comment <id> "..."`
  const m = command.match(/bd\s+comments?(?:\s+add)?\s+([A-Za-z0-9._-]+)\s+["']([\s\S]*)["']\s*$/);
  if (!m) return null;
  const learnedMatch = m[2].slice(0, 4096).match(/LEARNED:\s*([\s\S]*)/);
  if (!learnedMatch) return null;
  const learned = learnedMatch[1].trim().slice(0, 2048);
  return learned ? { beadId: m[1], learned } : null;
}

/** Stable slug key so re-runs update the same memory instead of duplicating. */
function memoryKey(content) {
  const slug = content
    .slice(0, 60)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `learned-${slug}`;
}

/**
 * Invoke `bd remember <content> --key <key>`.
 *
 * Primary path: no shell — args are passed verbatim (correct quoting).
 * On Windows `bd` is usually an npm .cmd shim which needs a shell, so on
 * ENOENT we fall back to shell mode with sanitised content (quotes/newlines
 * collapsed — cmd.exe cannot round-trip them safely).
 */
function bdRemember(content, key) {
  const direct = execCommand('bd', ['remember', content, '--key', key], { shell: false });
  if (direct !== null) return direct;

  const safe = content.replace(/"/g, "'").replace(/\r?\n/g, ' ');
  return execCommand('bd', ['remember', `"${safe}"`, '--key', key]);
}

runHook('memory-capture', () => {
  const input = readStdinJSON();
  if (getField(input, 'tool_name') !== 'Bash') process.exit(0);

  const command = getField(input, 'tool_input.command');
  if (!command || !command.includes('LEARNED:')) process.exit(0);

  const parsed = parseLearnedComment(command);
  if (!parsed) process.exit(0);

  const content = `${parsed.learned} [bead: ${parsed.beadId}]`;
  const result = bdRemember(content, memoryKey(parsed.learned));
  if (result !== null) {
    process.stdout.write(`[memory-capture] stored as bd memory: ${memoryKey(parsed.learned)}\n`);
  }
});
