import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBObjectStore } from 'fake-indexeddb';
import { createServer } from 'vite';
import { parseArchive } from '../src/archive/schema.js';

const paper = { name: 'paper.pdf', fingerprint: 'pdf-id', meta: { title: 'Paper', nPages: 1 }, fullText: 'Full paper for continued questions', pages: [{ pageNum: 1, text: 'Full paper for continued questions' }] };
const progress = { id: 'task1', task: 'translate', paperKey: 'p', configKey: 'c', nextIndex: 1, outputs: ['第一段'], status: 'generating', stage: 'parts', result: '', total: 2 };

test('version two preserves paper, incomplete messages, summary cursor and task progress', () => {
  const snapshot = parseArchive({ schemaVersion: 2, title: 'Paper', paper, messages: [{ id: 'm1', role: 'assistant', content: 'Partial', status: 'interrupted', error: 'network' }], resultStatuses: { summarize: 'failed' }, conversationSummary: { text: 'Earlier', summarizedUpTo: 0, pending: { messageIndex: 0, offset: 3 } }, segmentedTask: progress });
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.paper)), paper);
  assert.equal(snapshot.messages[0].status, 'interrupted');
  assert.equal(snapshot.messages[0].id, 'm1');
  assert.deepEqual(snapshot.segmentedTask, progress);
  assert.deepEqual(snapshot.conversationSummary.pending, { messageIndex: 0, offset: 3 });
  assert.throws(() => parseArchive({ ...snapshot, schemaVersion: 999 }));
  assert.throws(() => parseArchive({ ...snapshot, paper: { ...paper, pages: [{ pageNum: 0, text: '' }] } }));
  assert.throws(() => parseArchive({ ...snapshot, segmentedTask: { ...progress, nextIndex: 9 } }));
  assert.throws(() => parseArchive({ ...snapshot, segmentedTask: { ...progress, outputs: [] } }));
  assert.throws(() => parseArchive({ ...snapshot, segmentedTask: { ...progress, reduceIndex: 1 } }));
});

test('archives and debounced latest session remain separate and restore without model calls', async () => {
  const dom = new JSDOM('<!doctype html><div id="pane-ai"></div>');
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLButtonElement']) globalThis[key] = dom.window[key];
  globalThis.indexedDB = indexedDB;
  // Seed the previous schema, then verify that the session-store upgrade retains archives.
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('aie-archives', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('archives', { keyPath: 'id', autoIncrement: true });
      store.createIndex('createdAt', 'createdAt');
      store.add({ title: 'Legacy', paperMeta: { name: '', nPages: 0 }, createdAt: '2026-01-01' });
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  let session;
  try {
    const store = await server.ssrLoadModule('/src/state/store.js');
    const pane = await server.ssrLoadModule('/src/ui/aiPane.js');
    const manager = await server.ssrLoadModule('/src/archive/manager.js');
    const db = await server.ssrLoadModule('/src/archive/db.js');
    const autosave = await server.ssrLoadModule('/src/archive/autosave.js');
    pane.initAiPane();
    const legacy = await db.listArchives();
    assert.equal(legacy[0].title, 'Legacy');
    await db.deleteArchive(legacy[0].id);
    store.setState({ paper, messages: [{ role: 'assistant', content: 'Partial', status: 'generating' }], segmentedTask: progress });
    pane.setSavedResults({ summarize: 'Partial analysis' });
    pane.setSavedResultStatuses({ summarize: 'generating' });
    const archived = await manager.archiveCurrent();
    session = await autosave.initAutosave({ debounceMs: 5 });
    await session.flush();
    assert.equal((await db.listArchives()).length, 1);
    assert.equal((await db.loadSession()).paper.fullText, paper.fullText);
    // A queued snapshot owns its text before later state changes.
    const pending = session.flush();
    store.setState({ paper: { ...paper, fullText: 'replacement' } });
    await pending;
    assert.equal((await db.loadSession()).paper.fullText, paper.fullText);
    session.dispose();
    store.setState({ paper: null, messages: [], savedResults: {}, resultStatuses: {}, segmentedTask: null });
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('Startup must not invoke a model'); };
    session = await autosave.initAutosave({ debounceMs: 10000 });
    assert.equal(calls, 0);
    assert.equal(store.getState().paper.fingerprint, paper.fingerprint);
    assert.equal(store.getState().messages[0].status, 'interrupted');
    assert.equal(pane.getSavedResultStatuses().summarize, 'interrupted');
    assert.equal(store.getState().segmentedTask.status, 'interrupted');
    assert.match(document.querySelector('[data-section="summarize"] [data-result-status]').textContent, /未完成/);
    assert.match(document.querySelector('[data-chat-list]').textContent, /未完成/);
    manager.restoreArchive(archived);
    assert.equal(store.getState().paper.fullText, paper.fullText);
    assert.equal((await db.listArchives()).length, 1);
    session.dispose();
    store.setState({ paper: { ...paper, name: 'pending-file.pdf' } });
    session = await autosave.initAutosave({ debounceMs: 10000, canRestore: () => false });
    assert.equal(store.getState().paper.name, 'pending-file.pdf');
    session.dispose();
    const startup = autosave.initAutosave({ debounceMs: 10000 });
    store.setState({ paper: { ...paper, name: 'user-selected.pdf' } });
    session = await startup;
    assert.equal(store.getState().paper.name, 'user-selected.pdf');
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = () => { throw new Error('quota exceeded'); };
    try {
      await assert.rejects(session.flush(), /quota exceeded/);
      assert.equal(store.getState().autosaveStatus.status, 'failed');
    } finally { IDBObjectStore.prototype.put = originalPut; }
    await session.flush();
    assert.equal(store.getState().autosaveStatus.status, 'saved');
  } finally {
    session?.dispose();
    await server.close();
    dom.window.close();
  }
});
