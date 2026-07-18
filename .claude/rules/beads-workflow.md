# Beads Workflow

## Beads = single source of truth. Nothing lives only in your head.

Context gets compacted. Sessions restart. Beads persist.

### When to create a bead — ALWAYS if:
- User asks to implement, fix, refactor, or change anything
- You discover a bug, tech debt, or improvement during work
- A task needs follow-up that won't happen right now
- You start investigating something non-trivial

### After planning — size check then create beads:
When a plan is finalized and user confirms, BEFORE implementation:

**Step 1: Size check (one sentence decision):**
- >3 files OR >1 domain (DB + API, backend + frontend) → epic with children
- Description has "and then", "after that", multiple steps → multiple beads
- >50 lines estimated → consider splitting
- Otherwise → single bead

Rule of thumb: 1 bead = 1 PR = 1 reviewable diff.

**Step 2: Create beads:**
- Single task: `bd create "Task" -d "..."`
- Epic: `bd create "Feature" -d "..." --type epic`, then children with `--parent` and `--deps`
- Verify: `bd list` — the plan now lives in beads, not just in context

This workspace has `validation.on-create = warn` (set via `bd config set validation.on-create warn`): quality checks on `bd create` warn instead of hard-blocking. Warnings are still actionable — fix the description, don't ignore them.

**Step 3: Only then start work** with `bd ready` → dispatch

### When NOT to create a bead:
- Quick fix approved by user (<10 lines, feature branch)
- Pure research/discussion with no code changes planned

### Status discipline:
- Created → `open` (default)
- Starting work → `bd update {ID} --status in_progress`
- Pushed / PR open → leave in `in_progress` (orchestrator closes after merge)
- Merged/done → `bd close {ID}`
- **Never leave a bead in `in_progress` across sessions without reason**

### Discovered during work:
When you find tech debt, bugs, or improvements while working on something else:
```bash
bd create "Fix: [what]" -d "Discovered while working on {CURRENT_BEAD}: [details]" --deps discovered-from:{CURRENT_BEAD}
```
The `discovered-from` dependency preserves provenance without blocking either bead.
Don't try to fix it now (unless trivial). Create the bead so it's not forgotten.

## Task Start

1. Parse BEAD_ID from dispatch prompt
2. Create worktree:
   ```bash
   REPO_ROOT=$(git rev-parse --show-toplevel)
   WORKTREE_PATH="$REPO_ROOT/.worktrees/bd-{BEAD_ID}"
   mkdir -p "$REPO_ROOT/.worktrees"
   [[ ! -d "$WORKTREE_PATH" ]] && git worktree add "$WORKTREE_PATH" -b bd-{BEAD_ID}
   cd "$WORKTREE_PATH"
   ```
3. Mark in progress: `bd update {BEAD_ID} --status in_progress`
4. Read bead context: `bd show {BEAD_ID}` and `bd comments {BEAD_ID}`
5. Search memories for prior solutions: `bd memories "<keyword>"` (full text of one: `bd recall <key>`). Do this before diving into unfamiliar code or debugging.

## During Implementation

- Work ONLY in your worktree: `.worktrees/bd-{BEAD_ID}/`
- Commit frequently with descriptive messages
- Log progress: `bd comments add {BEAD_ID} "Completed X, working on Y"`

## Task Completion

Execute ALL steps in order:

1. **Self-verify against requirements:**
   - Run `bd show {BEAD_ID}` — re-read the description
   - Check every item/requirement from the description
   - If anything is missing — implement it now, don't skip
2. `git add -A && git commit -m "..."`
3. `git push origin bd-{BEAD_ID}`
4. If the session produced reusable knowledge — a non-obvious problem→solution pair a future session will hit again — store it as a memory (this must happen before the bead is closed):
   `bd remember "[specific problem] → [specific solution]. [context why]"`
   BAD: `bd remember "fixed async issue"` — useless for future search
   GOOD: `bd remember "pg connection pool exhaustion under load → set max=20 and idle_timeout=30s. Default max=10 caused 503s at >50 rps"`
   Memories persist across sessions and are injected at `bd prime`. No reusable insight → skip this step; don't store noise.
5. Leave completion comment: `bd comments add {BEAD_ID} "Completed: [summary]"`
6. Return completion report (checklist is MANDATORY — hook will block without it):
   ```
   BEAD {BEAD_ID} COMPLETE
   Worktree: .worktrees/bd-{BEAD_ID}
   Checklist:
   - [x] requirement 1 from description
   - [x] requirement 2 from description
   Files: [names only]
   Tests: pass
   Summary: [1 sentence]
   ```

Do not update status to `inreview` — this status was removed in bd v1.0.2. Leave the bead in `in_progress` until the orchestrator closes it after the PR merges.

## bd command reference (use ONLY these — do NOT invent commands)

| Action | Command |
|--------|---------|
| Create | `bd create --title="..." -d "..." [--type task\|bug\|feature\|epic] [--parent ID] [--deps type:ID]` (common dep types: `blocks` (default), `discovered-from`, `related`) |
| List | `bd list [--status open\|in_progress\|blocked\|deferred\|closed] [--json]` |
| Show | `bd show {ID} [--json]` |
| Update | `bd update {ID} --status in_progress\|blocked\|deferred [--title\|--description\|--notes]` |
| Close | `bd close {ID} [--reason "..."]` |
| Comments | `bd comments {ID}` / `bd comments add {ID} "text"` |
| Dependencies | `bd dep add {ID} {BLOCKS_ID}` |
| Ready | `bd ready` (unblocked open beads) |
| Blocked | `bd blocked` |
| Search | `bd search "query"` |
| Status | `bd status` (overview/statistics) |
| Prime | `bd prime` (AI context recovery; injects stored memories) |
| Memories | `bd memories [search]` (list/search) / `bd remember "insight" [--key k]` (store) / `bd recall {key}` (read one) / `bd forget {key}` (delete) |

All commands support `--json` for structured output. There is NO `export`, `import`, or `stats` command.

## Banned

- Working directly on main branch
- Implementing without BEAD_ID
- Merging your own branch (user merges via PR)
- Editing files outside your worktree
