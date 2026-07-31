# Design: 存档功能

## Architecture Overview

```
┌─ index.html ─────────────────────────────────────────────┐
│  <header>                                                │
│    <button id="btn-archive"> 💾 存档 </button>  ← NEW    │
│  </header>                                               │
└──────────────────────────────────────────────────────────┘

┌─ src/archive/db.js (NEW) ────────────────────────────────┐
│  IndexedDB CRUD wrapper                                  │
│  - openDB() → IDBDatabase                                │
│  - saveArchive(record) → id                              │
│  - listArchives() → ArchiveRecord[]                      │
│  - getArchive(id) → ArchiveRecord | null                 │
│  - deleteArchive(id) → void                              │
└──────────────────────────────────────────────────────────┘

┌─ src/archive/manager.js (NEW) ───────────────────────────┐
│  Business logic                                          │
│  - archiveCurrent()      — 收集当前状态，写入 IndexedDB   │
│  - restoreArchive(rec)   — 写入 store + aiPane           │
│  - exportArchive(rec)    — 下载 .json                     │
│  - importArchive(file)   — 读取 .json → IndexedDB         │
└──────────────────────────────────────────────────────────┘

┌─ src/ui/archiveDialog.js (NEW) ──────────────────────────┐
│  Dialog rendering + events                               │
│  - openArchiveDialog()   — 渲染 + 绑定事件               │
│  - renderArchiveList()   — 刷新列表                       │
└──────────────────────────────────────────────────────────┘

┌─ src/ui/aiPane.js (MODIFIED) ────────────────────────────┐
│  + export getSavedResults()                              │
│  + export setSavedResults(rs)                            │
│  + export refreshAfterRestore()                          │
└──────────────────────────────────────────────────────────┘

┌─ src/main.js (MODIFIED) ─────────────────────────────────┐
│  + import { initArchiveButton } from './ui/archiveDialog' │
│  + initArchiveButton() in startup                        │
└──────────────────────────────────────────────────────────┘
```

## Data Model

### IndexedDB

| Property | Value |
|----------|-------|
| Database name | `aie-archives` |
| Version | 1 |
| Object store | `archives` |
| Key path | `id` (auto-increment) |
| Index | `createdAt` (for sorted listing) |

### ArchiveRecord Schema

```typescript
interface ArchiveRecord {
  id?: number;              // auto-increment, assigned by IndexedDB
  title: string;            // paper meta.title || paper.name || '未命名论文'
  paperMeta: {
    name: string;           // original filename
    title?: string;         // parsed title from PDF metadata
    authors?: string[];     // parsed authors
    nPages: number;         // page count
  };
  savedResults: {
    summarize: string;      // markdown, empty if not generated
    explainConcepts: string;
    critique: string;
    translate: string;
  };
  messages: ChatMessage[];  // full chat history
  createdAt: string;        // ISO 8601, e.g. "2026-07-31T15:22:00.000Z"
}
```

### Export File Format

Same schema as `ArchiveRecord` minus `id`. Stored as `.json` with pretty-print for human readability.

```
{paper-title}_存档_2026-07-31.json
```

## Module Contracts

### `src/archive/db.js`

```js
// All async, return promises. Errors thrown with descriptive messages.

function openDB(): Promise<IDBDatabase>
  // Opens (or creates + migrates) the database. Idempotent — caches the handle.

function saveArchive(record: Omit<ArchiveRecord, 'id'>): Promise<number>
  // Writes to object store. Returns the auto-generated id.

function listArchives(): Promise<ArchiveRecord[]>
  // Returns all records, sorted by createdAt descending (newest first).

function getArchive(id: number): Promise<ArchiveRecord | null>
  // Single record lookup.

function deleteArchive(id: number): Promise<void>
  // Deletes by key. Silently succeeds if id doesn't exist.
```

### `src/archive/manager.js`

```js
function archiveCurrent(): Promise<ArchiveRecord>
  // 1. Read store.paper.meta, store.messages
  // 2. Read aiPane.getSavedResults()
  // 3. Validate: at least one non-empty result or message exists
  // 4. Build ArchiveRecord, call db.saveArchive()
  // 5. Return the saved record (with id assigned)

function restoreArchive(record: ArchiveRecord): void
  // 1. setState({ paper: { name, meta, fullText: '', pages: [] } })
  //    — partial paper, no text/pages (PDF not restorable)
  // 2. setState({ messages: record.messages })
  // 3. aiPane.setSavedResults(record.savedResults)
  // 4. aiPane.refreshAfterRestore()
  // 5. Show status bar: "已恢复存档：{title}（PDF 需重新拖入）"

function exportArchive(record: ArchiveRecord): void
  // 1. Build { ...record } minus id
  // 2. JSON.stringify with 2-space indent
  // 3. Blob download: "{title}_存档_{date}.json"

async function importArchive(file: File): Promise<ArchiveRecord>
  // 1. FileReader readAsText
  // 2. JSON.parse + validate schema
  // 3. db.saveArchive()
  // 4. Return saved record
```

### `src/ui/aiPane.js` — New Exports

```js
export function getSavedResults(): Record<string, string>
  // Returns shallow copy of module-scoped savedResults.

export function setSavedResults(rs: Record<string, string>): void
  // Replaces savedResults. Called during restore.
  // Triggers save button state sync for all tabs.

export function refreshAfterRestore(): void
  // Re-renders chat list from store.messages
  // Switches to first tab that has content (or chat)
  // Updates all save button states
```

### `src/ui/archiveDialog.js`

```js
export function initArchiveButton(): void
  // Finds btn-archive in DOM, binds click → openArchiveDialog()
  // Subscribes to store to sync disabled state

function openArchiveDialog(): void
  // Creates overlay + dialog DOM, binds all events
  // Calls renderArchiveList()

function renderArchiveList(): Promise<void>
  // Calls db.listArchives(), renders each item
```

## Key Design Decisions

### Why IndexedDB over localStorage?
- Single paper archive can exceed 5-10MB (chat messages + analysis results)
- IndexedDB supports large values, indexing, and async access

### Why raw IndexedDB over a library (idb)?
- Project has zero external runtime deps beyond the existing marked/katex/pdfjs
- Raw IndexedDB API is well-supported in all modern browsers
- The wrapper surface is tiny (~80 lines for CRUD + open)

### Why savedResults stays module-scoped (not moved to store)?
- Minimizes diff: only add 3 exports to aiPane.js
- Archive manager reads via getter — clean boundary
- Store changes would cascade to more files

### Restore is partial
- `paper.fullText` and `paper.pages` are NOT archived (too large, IndexedDB quota)
- After restore, AI analysis tabs still work because archived `paperMeta` provides title/name
- Chat after restore works only for viewing history (new messages need paper text)
- Status bar clearly warns "PDF 需重新拖入"

## UI States

### Archive button (top bar)
| State | Appearance |
|-------|-----------|
| No paper loaded + no messages | `disabled` |
| Paper loaded, nothing generated | `disabled` |
| At least 1 analysis result OR 1 chat message | `enabled` |

### Dialog: empty state
```
┌─ 存档管理 ──────────────────────── [×] ─┐
│  [📥 保存当前]  (disabled — 暂无可存档内容) │
│  ── 历史存档 ──────────────────────────  │
│  (暂无存档记录)                            │
│  [📤 导入 .json]                          │
└──────────────────────────────────────────┘
```

### Dialog: with archives
```
┌─ 存档管理 ──────────────────────── [×] ─┐
│  [📥 保存当前]                            │
│  ── 历史存档 ──────────────────────────  │
│  ┌────────────────────────────────────┐ │
│  │ 📄 Attention Is All You Need       │ │
│  │   总✓ 概✓ 质- 翻✓ 对✓  · 2026-07-31 │ │
│  │   [恢复] [导出] [删除]              │ │
│  └────────────────────────────────────┘ │
│  [📤 导入 .json]                         │
└──────────────────────────────────────────┘
```

### Content type shorthand in list
| Key | Label |
|-----|-------|
| summarize | 总 |
| explainConcepts | 概 |
| critique | 质 |
| translate | 翻 |
| chat | 对 |

## CSS Plan

- Dialog overlay: reuse existing `.download-dialog-overlay` pattern
- Dialog card: new `.archive-dialog` class
- Archive item: new `.archive-item` class
- Colors: CSS custom properties from existing theme (`--bg`, `--text`, `--border`, etc.)

No new CSS file — styles added to `src/styles.css`.

## Rollback Points

1. New files under `src/archive/` — can be deleted without affecting existing features
2. `archiveDialog.js` — independent module, removing import from main.js reverts to pre-archive state
3. `aiPane.js` exports are additive — removing them doesn't break existing callers
4. `index.html` — removing the button + `main.js` import reverts cleanly
