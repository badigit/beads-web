# Feature: Memory Feature — Unified Toolbar + Memory Panel

**Epic:** beads-kanban-ui-t25
**Created:** 2026-01-27

> **⚠️ SUPERSEDED (2026-07-19, bweb-1vr) — historical record only.**
>
> The data source described below, `.beads/memory/knowledge.jsonl`, is **dead**.
> Investigation bweb-30u found that nothing had written that file since January
> 2026: no `.beads/memory/` directory existed in any project on the machine, and
> the panel was permanently empty for every project while `bd memories` held real
> data. The two were unrelated systems sharing the name "Memory".
>
> The Memory panel now reads and writes **bd's own memories** (`bd remember` /
> `bd memories` / `bd recall` / `bd forget`), which live in the project's Dolt
> database. The JSONL path was removed outright rather than kept as a fallback —
> there was no data anywhere to fall back to. The entry shape is now just
> `{key, content}`; the `type`, `tags`, `ts`, `source`, `bead`, and archive
> concepts below **do not exist** in bd memories.
>
> Current behaviour: `server/src/routes/memory.rs`.

## Overview

Add a Memory feature to the beads-kanban-ui that lets users browse, search, edit, and archive knowledge base entries (`.beads/memory/knowledge.jsonl`) from within the UI. This involves:

1. New Rust backend endpoints for reading, editing, and deleting memory entries
2. A redesigned unified floating toolbar on the kanban board with a Memory button
3. A slide-out Memory panel (Sheet) for viewing and managing entries

## Requirements

- R1: Users can view all knowledge base entries from the kanban board
- R2: Users can search and filter entries by type (learned/investigation)
- R3: Users can edit entry content and tags inline
- R4: Users can archive or permanently delete entries
- R5: Users can navigate from a memory entry to its linked bead
- R6: The kanban board header is simplified to a minimal breadcrumb line
- R7: All toolbar controls (search, type filter, today, memory, sort, filter) are consolidated into a single floating pill bar

## Constraints

- C1: Must use existing shadcn/ui components (Sheet, Badge, Tabs, etc.) — no new UI library dependencies
- C2: Must follow the existing fetchApi pattern in `src/lib/api.ts`
- C3: Must follow the existing Axum route handler pattern (see `server/src/routes/beads.rs`)
- C4: JSONL files are the source of truth — no database storage for memory
- C5: Path security validation (`validate_path_security`) must be applied to all endpoints
- C6: Must not break existing keyboard navigation (/ for search, arrow keys, etc.)
- C7: The toolbar refactor must preserve all existing QuickFilterBar functionality

## Schema

### knowledge.jsonl (Existing Format — Read Only)

Each line is a JSON object:

```json
{"key":"slugified-key","type":"learned","content":"Text content...","source":"orchestrator","tags":["learned","swift","ui"],"ts":1769505562,"bead":"project-id.3"}
```

### knowledge.archive.jsonl (Existing Format)

Same structure as `knowledge.jsonl`. Entries moved here when archived.

No database schema changes required — all operations are file-based JSONL read/write.

## API Contract

### GET /api/memory?path={project_path}

Read all entries from the active knowledge file.

**Query Parameters:**
- `path` (required): Absolute path to the project root

**Response (200):**
```json
{
  "entries": [
    {
      "key": "slugified-key",
      "type": "learned",
      "content": "Text content...",
      "source": "orchestrator",
      "tags": ["learned", "swift", "ui"],
      "ts": 1769505562,
      "bead": "project-id.3"
    }
  ],
  "stats": {
    "total": 42,
    "learned": 30,
    "investigation": 12,
    "archived": 5
  }
}
```

**Error Responses:**
- `403`: Path security validation failed
- `500`: File read error

**Implementation Notes:**
- Read `.beads/memory/knowledge.jsonl`, parse each line as JSON
- Count archived entries from `.beads/memory/knowledge.archive.jsonl` (if it exists)
- Skip malformed lines gracefully (log warning, continue)
- Return entries sorted by `ts` descending (newest first)
- If the knowledge file does not exist or is empty, return `{ "entries": [], "stats": { "total": 0, "learned": 0, "investigation": 0, "archived": 0 } }`

### GET /api/memory/stats?path={project_path}

Lightweight endpoint returning only stats (no entry content).

**Query Parameters:**
- `path` (required): Absolute path to the project root

**Response (200):**
```json
{
  "total": 42,
  "learned": 30,
  "investigation": 12,
  "archived": 5
}
```

### PUT /api/memory

Edit an existing entry by key.

**Request Body:**
```json
{
  "path": "/absolute/path/to/project",
  "key": "slugified-key",
  "content": "Updated content text",
  "tags": ["updated", "tags"]
}
```

- `content` and `tags` are both optional — omit to leave unchanged
- At least one of `content` or `tags` must be provided

**Response (200):**
```json
{
  "success": true,
  "entry": { "key": "...", "type": "...", "content": "...", "source": "...", "tags": ["..."], "ts": 1769505562, "bead": "..." }
}
```

**Error Responses:**
- `400`: No `content` or `tags` provided
- `403`: Path security validation failed
- `404`: Entry with given key not found
- `500`: File write error

**Implementation Notes:**
- Read all lines from knowledge.jsonl
- Find the line matching `key`
- Update `content` and/or `tags` fields on that entry
- Do NOT update `ts` — it represents original creation time
- Write all lines back (read-modify-write pattern, same as `beads.rs` add_comment)

### DELETE /api/memory

Remove or archive an entry by key.

**Request Body:**
```json
{
  "path": "/absolute/path/to/project",
  "key": "slugified-key",
  "archive": true
}
```

- `archive: true` — Move entry to `knowledge.archive.jsonl` (append), then remove from `knowledge.jsonl`
- `archive: false` — Permanently delete from `knowledge.jsonl`

**Response (200):**
```json
{
  "success": true,
  "archived": true
}
```

**Error Responses:**
- `403`: Path security validation failed
- `404`: Entry with given key not found
- `500`: File write error

## Shared Constants

### TypeScript Types (add to `src/types/index.ts`)

```typescript
// ============================================================================
// Memory Types
// ============================================================================

export type MemoryType = "learned" | "investigation";

export interface MemoryEntry {
  key: string;
  type: MemoryType;
  content: string;
  source: string;
  tags: string[];
  ts: number;
  bead: string;
}

export interface MemoryStats {
  total: number;
  learned: number;
  investigation: number;
  archived: number;
}

export interface MemoryResponse {
  entries: MemoryEntry[];
  stats: MemoryStats;
}
```

### Rust Types (add to `server/src/routes/memory.rs`)

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MemoryEntry {
    pub key: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub content: String,
    pub source: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub ts: i64,
    #[serde(default)]
    pub bead: String,
}

#[derive(Debug, Serialize)]
pub struct MemoryStats {
    pub total: usize,
    pub learned: usize,
    pub investigation: usize,
    pub archived: usize,
}

#[derive(Debug, Serialize)]
pub struct MemoryListResponse {
    pub entries: Vec<MemoryEntry>,
    pub stats: MemoryStats,
}

#[derive(Debug, Deserialize)]
pub struct MemoryParams {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateMemoryRequest {
    pub path: String,
    pub key: String,
    pub content: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteMemoryRequest {
    pub path: String,
    pub key: String,
    pub archive: bool,
}
```

## Data Flow

### Read Flow
1. User opens kanban board → clicks Memory button in toolbar
2. Memory panel (Sheet) opens
3. `useMemory(projectPath)` hook fires
4. Hook calls `fetchApi<MemoryResponse>("/api/memory?path=...")`
5. Rust handler reads `{project_path}/.beads/memory/knowledge.jsonl`
6. Rust handler counts lines in `knowledge.archive.jsonl` for archived stat
7. Returns parsed entries + stats
8. Frontend renders entries in ScrollArea with search/filter

### Edit Flow
1. User clicks DropdownMenu on an entry → "Edit content" or "Edit tags"
2. Inline edit UI appears (textarea for content, tag input for tags)
3. User confirms edit
4. Hook calls `fetchApi("/api/memory", { method: "PUT", body: { path, key, content?, tags? } })`
5. Rust handler reads `knowledge.jsonl`, finds matching key, updates fields, writes back
6. Hook refetches entries

### Archive/Delete Flow
1. User clicks DropdownMenu on an entry → "Archive" or "Delete"
2. Confirmation for delete (archive is immediate)
3. Hook calls `fetchApi("/api/memory", { method: "DELETE", body: { path, key, archive: bool } })`
4. Rust handler reads `knowledge.jsonl`, removes matching entry
5. If `archive=true`, appends removed entry to `knowledge.archive.jsonl`
6. Writes remaining entries back to `knowledge.jsonl`
7. Hook refetches entries

### Navigate to Bead Flow
1. User clicks DropdownMenu on an entry → "Navigate to bead"
2. MemoryPanel closes
3. BeadDetail panel opens for the linked bead ID
4. Reuses existing `handleSelectBead` / `setDetailBeadId` pattern in `kanban-board.tsx`

## UI Design

### Toolbar Layout (Refactored)

**Before:** Two separate bars (header with back + name, then QuickFilterBar)

**After:**
```
← Project Name                                        (breadcrumb line — no border/bg)

   ┌─────────────────────────────────────────────────────────────┐
   │ [🔍 Search] | All Epics Tasks | Today | 🧠 Memory | ↕  ≡  │  (floating pill)
   └─────────────────────────────────────────────────────────────┘

 Open            In Progress        In Review          Closed
```

**Breadcrumb line:** No border, no background. `flex items-center gap-2 px-4 py-2`.

**Floating pill toolbar:** `rounded-xl bg-zinc-900/80 backdrop-blur border border-zinc-800 mx-auto max-w-fit px-3 py-2 mb-3`

**Memory button:** Same toggle pattern as Today. `BrainCircuit` icon + "Memory" label. Active: `bg-purple-500/20 text-purple-400`. Inactive: `bg-zinc-800/50 text-zinc-400 hover:text-zinc-200`.

### Memory Panel (Sheet)

Uses Sheet component, `side="right"`, same as BeadDetail.

```
┌──────────────────────────────────┐
│ Memory                     [X]   │  SheetTitle
│ 42 entries                       │  SheetDescription
├──────────────────────────────────┤
│ [🔍 Search memories...]         │  Input
│ [All] [Learned] [Investigation]  │  Tabs
├──────────────────────────────────┤
│ ScrollArea                       │
│ ┌──────────────────────────────┐ │
│ │ LEARN  slug-key     2m ago   │ │  Badge(info) + timestamp
│ │ Content text preview...      │ │  line-clamp-3
│ │ [tag1] [tag2]  BD-ez3.3 [⋮] │ │  tags + bead link + menu
│ ├──────────────────────────────┤ │
│ │ INVES  another-key   1h ago  │ │
│ │ Investigation content...     │ │
│ │ [tag3]         BD-c42.1 [⋮]  │ │
│ └──────────────────────────────┘ │
├──────────────────────────────────┤
│ 30 learned · 12 investigation    │  Footer stats
└──────────────────────────────────┘
```

**Entry card:** `rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-2`

**Type badges:**
- learned → `Badge variant="info" appearance="light" size="xs"` → "LEARN"
- investigation → `Badge variant="success" appearance="light" size="xs"` → "INVES"

**DropdownMenu per entry:**
- Edit content (Pencil)
- Edit tags (Tag)
- Navigate to bead (ExternalLink)
- Separator
- Archive (Archive)
- Delete (Trash2, text-red-400)

## New Files

### Backend (Rust)

| File | Purpose |
|------|---------|
| `server/src/routes/memory.rs` | Memory API route handlers |

**Modifications:**

| File | Change |
|------|--------|
| `server/src/routes/mod.rs` | Add `pub mod memory;` |
| `server/src/main.rs` | Register 4 routes under `/api/memory` |

### Frontend (Next.js)

| File | Purpose |
|------|---------|
| `src/components/memory-panel.tsx` | Memory Sheet panel component |
| `src/hooks/use-memory.ts` | Hook to fetch/mutate memory entries |

**Modifications:**

| File | Change |
|------|--------|
| `src/types/index.ts` | Add Memory types |
| `src/lib/api.ts` | Add `memory` API namespace |
| `src/app/project/kanban-board.tsx` | Refactor header → breadcrumb + floating toolbar + memory panel |
| `src/components/quick-filter-bar.tsx` | Update container style to floating pill, add Memory button props |

## Implementation Tasks

### Task 1: beads-kanban-ui-t25.1 — Rust Backend Memory API
**Supervisor:** rust-supervisor

### Task 2: beads-kanban-ui-t25.2 — Next.js Frontend Unified Toolbar + Memory Panel
**Supervisor:** nextjs-supervisor
**Depends on:** beads-kanban-ui-t25.1

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| JSONL corruption on concurrent writes | Single-user desktop app; acceptable. File locking later if needed. |
| knowledge.jsonl may not exist | Backend returns empty response; frontend shows empty state. |
| Toolbar refactor breaks keyboard nav | `searchInputRef` passed through unchanged; `/` shortcut is DOM-level. |
| Large knowledge files (1000+ entries) | Simple map initially; add virtualization later if needed. |
| Memory + BeadDetail Sheet conflict | Separate `open` states; Memory closes before BeadDetail opens via `onNavigateToBead`. |
