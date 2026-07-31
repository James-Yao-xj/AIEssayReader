# Implement: 存档功能

## Execution Order

### Step 1: `src/archive/db.js` — IndexedDB CRUD

Create the data layer. No UI or existing-module dependency.

- [ ] Open database `aie-archives` v1, object store `archives` with keyPath `id` autoIncrement
- [ ] Create index on `createdAt`
- [ ] Export: `saveArchive(record)` → `Promise<number>`
- [ ] Export: `listArchives()` → `Promise<ArchiveRecord[]>` (sorted by createdAt desc)
- [ ] Export: `getArchive(id)` → `Promise<ArchiveRecord | null>`
- [ ] Export: `deleteArchive(id)` → `Promise<void>`
- [ ] Handle upgrades (future schema migration)
- [ ] Cache db handle after first open

### Step 2: `src/ui/aiPane.js` — Expose savedResults

Minimal changes to existing file.

- [ ] Export `getSavedResults()` — returns shallow copy of `savedResults`
- [ ] Export `setSavedResults(rs)` — replaces `savedResults`, calls `syncSaveButton()` for each task
- [ ] Export `refreshAfterRestore()` — re-renders chat list, syncs save buttons, switches to first tab with content

### Step 3: `src/archive/manager.js` — Business Logic

Depends on Step 1 + Step 2.

- [ ] `archiveCurrent()`:
  - Read `getState().paper.meta`, `getState().messages`
  - Read `getSavedResults()`
  - Validate: at least one non-empty result or chat message
  - Build `ArchiveRecord` with `createdAt: new Date().toISOString()`
  - Call `db.saveArchive()`
  - Return saved record
- [ ] `restoreArchive(record)`:
  - `setState({ paper: partial from record.paperMeta })`
  - `setState({ messages: record.messages })`
  - `setSavedResults(record.savedResults)`
  - `refreshAfterRestore()`
  - Show status bar warning about PDF re-import
- [ ] `exportArchive(record)`:
  - Strip `id`, JSON.stringify, Blob download
  - Filename: `{title}_存档_{date}.json`
- [ ] `importArchive(file)`:
  - FileReader → JSON.parse → validate schema → `db.saveArchive()`
  - Return saved record

### Step 4: `src/ui/archiveDialog.js` — Dialog UI

Depends on Step 1 + Step 3.

- [ ] `initArchiveButton()`:
  - Find `#btn-archive` in DOM
  - Bind click → `openArchiveDialog()`
  - Subscribe to store: disable when no content
- [ ] `openArchiveDialog()`:
  - Create overlay + dialog DOM per design.md layout
  - Bind save / restore / delete / export / import events
  - Bind close (×, overlay click, Escape)
  - Call `renderArchiveList()` on open
- [ ] `renderArchiveList()`:
  - Fetch from `db.listArchives()`
  - Render each item with content type indicators
  - Empty state when no archives
- [ ] Content type indicators: show ✓/- for each of 5 types based on non-empty string/messages
- [ ] Delete: confirm dialog before deleting
- [ ] Restore: confirm if current session has unsaved content
- [ ] After save/delete/import: refresh list

### Step 5: `index.html` — Add Archive Button

- [ ] Add `<button id="btn-archive">` in `<header class="app-header">`, after theme button, before settings button

### Step 6: `src/main.js` — Wire Up

- [ ] Import `{ initArchiveButton }` from `./ui/archiveDialog.js`
- [ ] Call `initArchiveButton()` after `initSettings()` / `initAiPane()`

### Step 7: `src/styles.css` — CSS Styles

- [ ] `.archive-dialog-overlay` — fixed overlay with centered dialog
- [ ] `.archive-dialog` — card with max-width ~500px, max-height ~80vh
- [ ] `.archive-dialog__header` — title + close button
- [ ] `.archive-dialog__body` — scrollable list area
- [ ] `.archive-item` — per-archive row with title, indicators, actions
- [ ] `.archive-item__title` — paper title
- [ ] `.archive-item__indicators` — content type tags (✓ green / - gray)
- [ ] `.archive-item__actions` — restore/export/delete buttons
- [ ] `.archive-empty` — empty state text
- [ ] Reuse existing button styles (`.ai-btn`, `.ai-btn--primary`, `.ai-btn--ghost`)

### Step 8: Build & Verify

- [ ] `npm run build` — no errors
- [ ] `npm run preview` — manual smoke test all ACs

## Validation Commands

```bash
# Build check
npm run build

# If any lint/type check exists
npx tsc --noEmit 2>/dev/null || true
```

## Risky Files

| File | Risk | Mitigation |
|------|------|-----------|
| `src/ui/aiPane.js` | Existing code, adding exports | Additive only — exports don't change internal logic |
| `src/main.js` | Startup wiring | Single import + call, isolated |
| `index.html` | DOM structure | One button addition, no existing element changes |

## Rollback

1. Remove `<button id="btn-archive">` from `index.html`
2. Remove `initArchiveButton()` call + import from `main.js`
3. Delete `src/archive/` directory
4. Delete `src/ui/archiveDialog.js`
5. Revert aiPane.js to remove 3 exported functions
6. Remove archive CSS from `styles.css`
