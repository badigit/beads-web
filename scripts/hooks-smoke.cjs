#!/usr/bin/env node
'use strict';

// hooks-smoke.cjs — smoke tests for all .claude/hooks/*.cjs hooks.
//
// Run:  node scripts/hooks-smoke.cjs
// Exit: 0 when all checks pass, 1 otherwise.
//
// Feeds each hook reference stdin JSON payloads and asserts the resulting
// deny/ask/approve/block decision or injected context. External tools are
// isolated: `bd`/`gh` are replaced with stub executables (behaviour driven by
// BD_STUB_* env vars), git runs inside throwaway repos in a temp sandbox.
// No real bd database, git remote, or network is touched.

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOKS_DIR = path.join(__dirname, '..', '.claude', 'hooks');
const IS_WIN = process.platform === 'win32';

let sandbox, stubBin, repoMain, repoFeature, repoNudge, emptyDir;
let passed = 0;
let failed = 0;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    if (detail) console.log(`       ${String(detail).replace(/\n/g, '\n       ')}`);
  }
}

/** Spawn a hook with a JSON payload on stdin; returns { stdout, status }. */
function runHookProc(hookName, payload, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CLAUDE_TOOL_INPUT;
  if (opts.stubs) {
    const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
    env[pathKey] = stubBin + path.delimiter + (env[pathKey] || '');
  }
  const res = spawnSync(process.execPath, [path.join(HOOKS_DIR, hookName)], {
    input: opts.rawInput !== undefined ? opts.rawInput : JSON.stringify(payload),
    cwd: opts.cwd || sandbox,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

/** Parse the hook decision from stdout: deny/ask/approve/block, or null. */
function parseDecision(stdout) {
  try {
    const j = JSON.parse(stdout.trim());
    if (j.hookSpecificOutput) return j.hookSpecificOutput.permissionDecision || null;
    if (j.decision) return j.decision;
  } catch { /* plain text or empty output */ }
  return null;
}

function reasonOf(stdout) {
  try {
    const j = JSON.parse(stdout.trim());
    if (j.hookSpecificOutput) return j.hookSpecificOutput.permissionDecisionReason || '';
    return j.reason || '';
  } catch {
    return '';
  }
}

function pre(tool, toolInput, extra = {}) {
  return { tool_name: tool, tool_input: toolInput, ...extra };
}

// ---------------------------------------------------------------------------
// Sandbox setup: stub bd/gh + throwaway git repos
// ---------------------------------------------------------------------------

function writeStubs() {
  stubBin = path.join(sandbox, 'stub-bin');
  fs.mkdirSync(stubBin);
  // Windows stubs (cmd shims, CRLF)
  const bdCmd = [
    '@echo off',
    'if defined BD_STUB_LOG echo %* >> "%BD_STUB_LOG%"',
    'if "%~1"=="--version" echo bd-stub 0.0.0',
    'if "%~1"=="show" if defined BD_STUB_SHOW_JSON echo %BD_STUB_SHOW_JSON%',
    'if "%~1"=="dep" if defined BD_STUB_DEP_JSON echo %BD_STUB_DEP_JSON%',
    'if "%~1"=="list" if defined BD_STUB_LIST_JSON echo %BD_STUB_LIST_JSON%',
    'exit /b 0',
  ].join('\r\n') + '\r\n';
  fs.writeFileSync(path.join(stubBin, 'bd.cmd'), bdCmd);
  fs.writeFileSync(path.join(stubBin, 'gh.cmd'), '@echo off\r\nexit /b 0\r\n');
  // POSIX stubs
  const bdSh = [
    '#!/bin/sh',
    '[ -n "$BD_STUB_LOG" ] && echo "$@" >> "$BD_STUB_LOG"',
    'case "$1" in',
    '  --version) echo bd-stub 0.0.0 ;;',
    '  show) [ -n "$BD_STUB_SHOW_JSON" ] && printf "%s\\n" "$BD_STUB_SHOW_JSON" ;;',
    '  dep)  [ -n "$BD_STUB_DEP_JSON" ] && printf "%s\\n" "$BD_STUB_DEP_JSON" ;;',
    '  list) [ -n "$BD_STUB_LIST_JSON" ] && printf "%s\\n" "$BD_STUB_LIST_JSON" ;;',
    'esac',
    'exit 0',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(stubBin, 'bd'), bdSh, { mode: 0o755 });
  fs.writeFileSync(path.join(stubBin, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

function makeRepo(name, branch) {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', branch], { stdio: 'ignore' });
  execFileSync('git', [
    '-C', dir, '-c', 'user.email=smoke@test', '-c', 'user.name=smoke',
    'commit', '--allow-empty', '--no-verify', '-q', '-m', 'init',
  ], { stdio: 'ignore' });
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testBashGuard() {
  console.log('bash-guard.cjs');
  let r = runHookProc('bash-guard.cjs', pre('Bash', { command: 'git commit --no-verify -m "x"' }));
  check('deny git commit --no-verify', parseDecision(r.stdout) === 'deny' && reasonOf(r.stdout).includes('no-verify'), r.stdout);

  r = runHookProc('bash-guard.cjs', pre('Bash', { command: 'git commit -n -m "x"' }));
  check('deny git commit -n', parseDecision(r.stdout) === 'deny', r.stdout);

  r = runHookProc('bash-guard.cjs', pre('Bash', { command: 'git log -n 5' }));
  check('allow git log -n 5 (regression: -n only for commit)', r.stdout.trim() === '' && r.status === 0, r.stdout);

  r = runHookProc('bash-guard.cjs', pre('Bash', { command: 'bd create "Task"' }));
  check('deny bd create without description', parseDecision(r.stdout) === 'deny' && reasonOf(r.stdout).includes('description'), r.stdout);

  r = runHookProc('bash-guard.cjs', pre('Bash', { command: 'bd create "Task" -d "Details"' }));
  check('allow bd create with description', r.stdout.trim() === '', r.stdout);

  r = runHookProc('bash-guard.cjs', pre('Bash', { command: 'bd close bweb-1 --force' }));
  check('allow bd close --force', r.stdout.trim() === '', r.stdout);

  r = runHookProc('bash-guard.cjs', pre('Bash', { command: 'bd close bweb-50' }), {
    stubs: true,
    env: {
      BD_STUB_SHOW_JSON: '[{"id":"bweb-50","issue_type":"epic","status":"open"}]',
      BD_STUB_LIST_JSON: '[{"id":"bweb-50.1","status":"open"}]',
    },
  });
  check('deny epic close with open children', parseDecision(r.stdout) === 'deny' && reasonOf(r.stdout).includes('incomplete children'), r.stdout);

  r = runHookProc('bash-guard.cjs', pre('Bash', { command: 'echo hello' }));
  check('allow generic command', r.stdout.trim() === '', r.stdout);

  r = runHookProc('bash-guard.cjs', pre('Bash', { command: 'git commit --no-verify -m x' }, { permission_mode: 'bypassPermissions' }));
  check('bypass mode converts deny to warning', r.stdout.includes('[HOOK WARNING') && parseDecision(r.stdout) === null, r.stdout);
}

function testEnforceBranch() {
  console.log('enforce-branch-before-edit.cjs');
  const edit = fp => pre('Edit', { file_path: fp, old_string: 'a', new_string: 'b\nc' });

  let r = runHookProc('enforce-branch-before-edit.cjs', edit(path.join(repoMain, 'src', 'app.ts')), { cwd: repoMain });
  check('ask (not deny) on main', parseDecision(r.stdout) === 'ask', r.stdout);
  check('main ask names branch and change size', reasonOf(r.stdout).includes("'main'") && reasonOf(r.stdout).includes('~2 lines'), r.stdout);

  r = runHookProc('enforce-branch-before-edit.cjs', pre('Write', { file_path: path.join(repoMain, 'new.ts'), content: 'a\nb\nc' }), { cwd: repoMain });
  check('ask on main for Write (new file)', parseDecision(r.stdout) === 'ask' && reasonOf(r.stdout).includes('new file'), r.stdout);

  r = runHookProc('enforce-branch-before-edit.cjs', edit(path.join(repoFeature, 'src', 'app.ts')), { cwd: repoFeature });
  check('quick-fix ask on feature branch', parseDecision(r.stdout) === 'ask' && reasonOf(r.stdout).includes('Quick fix'), r.stdout);

  r = runHookProc('enforce-branch-before-edit.cjs', edit(path.join(repoMain, '.worktrees', 'bd-x', 'f.ts')), { cwd: repoMain });
  check('allow edits inside .worktrees', r.stdout.trim() === '', r.stdout);

  r = runHookProc('enforce-branch-before-edit.cjs', edit(path.join(repoMain, 'CLAUDE.md')), { cwd: repoMain });
  check('allow CLAUDE.md', r.stdout.trim() === '', r.stdout);
}

function testDispatchGuard() {
  console.log('dispatch-guard.cjs');
  const task = (type, prompt) => pre('Task', { subagent_type: type, prompt });

  let r = runHookProc('dispatch-guard.cjs', task('rust-supervisor', 'Do the thing'));
  check('deny supervisor without BEAD_ID', parseDecision(r.stdout) === 'deny' && reasonOf(r.stdout).includes('bead-required'), r.stdout);

  r = runHookProc('dispatch-guard.cjs', task('merge-supervisor', 'Resolve conflicts'));
  check('allow merge-supervisor without BEAD_ID', r.stdout.trim() === '', r.stdout);

  r = runHookProc('dispatch-guard.cjs', task('general-purpose', 'Research something'));
  check('allow non-supervisor without BEAD_ID', r.stdout.trim() === '', r.stdout);

  r = runHookProc('dispatch-guard.cjs', task('rust-supervisor', 'BEAD_ID: bweb-1.2\nImplement'));
  check('deny epic child without EPIC_BRANCH', parseDecision(r.stdout) === 'deny' && reasonOf(r.stdout).includes('epic-branch-required'), r.stdout);

  r = runHookProc('dispatch-guard.cjs', task('rust-supervisor', 'BEAD_ID: bweb-77\nImplement'), {
    stubs: true,
    env: { BD_STUB_SHOW_JSON: '[{"id":"bweb-77","status":"closed"}]' },
  });
  check('deny dispatch to closed bead', parseDecision(r.stdout) === 'deny' && reasonOf(r.stdout).includes('closed-bead'), r.stdout);

  r = runHookProc('dispatch-guard.cjs', task('rust-supervisor', 'BEAD_ID: bweb-88.2\nEPIC_BRANCH: bd-bweb-88\nImplement'), {
    stubs: true,
    env: {
      BD_STUB_SHOW_JSON: '[{"id":"bweb-88.2","status":"open"}]',
      BD_STUB_DEP_JSON: '[{"id":"bweb-88.1","status":"open"},{"id":"bweb-88","status":"open"}]',
    },
  });
  check('deny child with unresolved blockers', parseDecision(r.stdout) === 'deny' && reasonOf(r.stdout).includes('blocked-task'), r.stdout);
  check('parent epic excluded from blockers', reasonOf(r.stdout).includes('unresolved blockers: bweb-88.1\n'), r.stdout);

  r = runHookProc('dispatch-guard.cjs', task('rust-supervisor', 'BEAD_ID: bweb-99.1\nEPIC_BRANCH: bd-bweb-99\nImplement'), {
    stubs: true,
    env: {
      BD_STUB_SHOW_JSON: '[{"id":"bweb-99","status":"open","design":"Z:/definitely/missing/design.md"}]',
      BD_STUB_DEP_JSON: '[]',
    },
  });
  check('deny when epic design doc missing', parseDecision(r.stdout) === 'deny' && reasonOf(r.stdout).includes('design-doc-missing'), r.stdout);

  r = runHookProc('dispatch-guard.cjs', task('worker-supervisor', 'BEAD_ID: bweb-77\nImplement'), {
    stubs: true,
    env: { BD_STUB_SHOW_JSON: '[{"id":"bweb-77","status":"closed"}]' },
  });
  check('worker supervisor exempt from lifecycle checks', r.stdout.trim() === '', r.stdout);

  r = runHookProc('dispatch-guard.cjs', task('rust-supervisor', 'BEAD_ID: bweb-77\nImplement'), {
    stubs: true,
    env: { BD_STUB_SHOW_JSON: '[{"id":"bweb-77","status":"open"}]' },
  });
  check('allow dispatch to open bead', r.stdout.trim() === '', r.stdout);
}

function testMemoryCapture() {
  console.log('memory-capture.cjs');
  const logFile = path.join(sandbox, 'bd-calls.log');
  const stubEnv = { BD_STUB_LOG: logFile };
  const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');

  let r = runHookProc('memory-capture.cjs',
    pre('Bash', { command: 'bd comments add bweb-t9 "LEARNED: smoke harness works. Stub bd received the remember call"' }),
    { stubs: true, env: stubEnv });
  check('bd remember invoked for LEARNED comment',
    readLog().includes('remember') && readLog().includes('--key learned-smoke-harness-works'),
    `log: ${readLog()} stdout: ${r.stdout}`);
  check('hook reports stored memory', r.stdout.includes('[memory-capture] stored'), r.stdout);

  fs.rmSync(logFile, { force: true });
  r = runHookProc('memory-capture.cjs',
    pre('Bash', { command: 'bd comments add bweb-t9 "Completed: no learnings here"' }),
    { stubs: true, env: stubEnv });
  check('no bd call without LEARNED', !fs.existsSync(logFile) && r.stdout.trim() === '', r.stdout);

  fs.rmSync(logFile, { force: true });
  r = runHookProc('memory-capture.cjs',
    pre('Bash', { command: 'bd comment bweb-t9 "LEARNED: legacy singular form works too"' }),
    { stubs: true, env: stubEnv });
  check('legacy `bd comment` form captured', readLog().includes('remember'), readLog());
  fs.rmSync(logFile, { force: true });
}

function testValidateCompletion() {
  console.log('validate-completion.cjs');
  const mkLine = text => JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text }] } });

  let r = runHookProc('validate-completion.cjs', {});
  check('approve when no agent transcript', parseDecision(r.stdout) === 'approve', r.stdout);

  const t1 = path.join(sandbox, 'agent-1.jsonl');
  fs.writeFileSync(t1, mkLine('BEAD test-1 COMPLETE\nWorktree: .worktrees/bd-test-1\nFiles: x\nTests: pass') + '\n');
  r = runHookProc('validate-completion.cjs', { agent_transcript_path: t1 });
  check('block completion report without Checklist', parseDecision(r.stdout) === 'block' && reasonOf(r.stdout).includes('Checklist'), r.stdout);

  const t2 = path.join(sandbox, 'agent-2.jsonl');
  fs.writeFileSync(t2, mkLine('BEAD test-1 COMPLETE\nWorktree: .worktrees/bd-test-1\nChecklist:\n- [x] a\n- [ ] b\nFiles: x') + '\n');
  r = runHookProc('validate-completion.cjs', { agent_transcript_path: t2 });
  check('block unchecked checklist items', parseDecision(r.stdout) === 'block' && reasonOf(r.stdout).includes('unchecked'), r.stdout);

  const t3 = path.join(sandbox, 'agent-3.jsonl');
  fs.writeFileSync(t3, mkLine('Just investigated some files, here is a summary.') + '\n');
  r = runHookProc('validate-completion.cjs', { agent_transcript_path: t3 });
  check('approve non-completion response', parseDecision(r.stdout) === 'approve', r.stdout);
}

function testSessionStart() {
  console.log('session-start.cjs');
  let r = runHookProc('session-start.cjs', {}, { cwd: emptyDir });
  check('reports missing .beads', r.stdout.includes('No .beads'), r.stdout);

  fs.mkdirSync(path.join(repoMain, '.beads'), { recursive: true });
  r = runHookProc('session-start.cjs', {}, { cwd: repoMain, stubs: true });
  check('shows task status banner', r.stdout.includes('## Task Status'), r.stdout);
  check('suggests bd create when no beads', r.stdout.includes('No active beads'), r.stdout);
  check('no inreview references', !r.stdout.includes('inreview'), r.stdout);
  check('no dead recall.cjs reference', !r.stdout.includes('recall.cjs'), r.stdout);
}

function testNudge() {
  console.log('nudge-claude-md-update.cjs');
  let r = runHookProc('nudge-claude-md-update.cjs', {}, { cwd: repoFeature });
  check('silent without CLAUDE.md', r.stdout.trim() === '', r.stdout);

  fs.writeFileSync(path.join(repoNudge, 'CLAUDE.md'), '# P\n\n## Current State\n\n');
  r = runHookProc('nudge-claude-md-update.cjs', {}, { cwd: repoNudge });
  check('nudges on empty Current State', r.stdout.includes('MAINTENANCE REMINDER'), r.stdout);

  fs.writeFileSync(path.join(repoNudge, 'CLAUDE.md'), '# P\n\n## Current State\n- doing things\n');
  r = runHookProc('nudge-claude-md-update.cjs', {}, { cwd: repoNudge });
  check('soft reminder when Current State filled', r.stdout.includes('consider updating CLAUDE.md'), r.stdout);
}

function testStdinResilience() {
  console.log('stdin resilience (all hooks must exit 0)');
  const hooks = fs.readdirSync(HOOKS_DIR).filter(f => f.endsWith('.cjs') && f !== 'hook-utils.cjs');
  for (const hook of hooks) {
    const r1 = runHookProc(hook, null, { rawInput: '' });
    check(`${hook}: exit 0 on empty stdin`, r1.status === 0, `status=${r1.status} stderr=${r1.stderr}`);
    const r2 = runHookProc(hook, null, { rawInput: 'not json {{{' });
    check(`${hook}: exit 0 on garbage stdin`, r2.status === 0, `status=${r2.status} stderr=${r2.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-smoke-'));
  try {
    writeStubs();
    repoMain = makeRepo('repo-main', 'main');
    repoFeature = makeRepo('repo-feature', 'feature-x');
    repoNudge = makeRepo('repo-nudge', 'main');
    emptyDir = path.join(sandbox, 'empty');
    fs.mkdirSync(emptyDir);

    testBashGuard();
    testEnforceBranch();
    testDispatchGuard();
    testMemoryCapture();
    testValidateCompletion();
    testSessionStart();
    testNudge();
    testStdinResilience();

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
