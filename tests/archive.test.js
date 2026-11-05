import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArchive } from '../src/archive/schema.js';
import { sleep, getRecommendations, resolveInput, resolvePaper } from '../src/related/semanticScholar.js';

test('archive rejects invalid nested data before persistence', () => {
  for (const patch of [{ title: {} }, { messages: 'bad' }, { messages: [{ role: 'system', content: 'bad' }] }, { savedResults: [] }, { paperMeta: { nPages: -1 } }, { createdAt: {} }]) {
    assert.throws(() => parseArchive({ title: 'paper', ...patch }));
  }
});

test('legacy archive defaults and known result fields survive', () => {
  const result = parseArchive({ title: 'paper', savedResults: JSON.parse('{"summarize":"text","__proto__":"bad"}') });
  assert.equal(result.paperMeta.name, '');
  assert.deepEqual(result.savedResults, { summarize: 'text' });
  assert.deepEqual(result.messages, []);
});

test('delay rejects an already aborted signal', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(sleep(1000, ctrl.signal), { name: 'AbortError' });
});

test('recommendations use the separate recommendations API', async (t) => {
  let url;
  t.mock.method(globalThis, 'fetch', async (value) => {
    url = value;
    return Response.json({ recommendedPapers: [{ paperId: 'b', title: 'next' }] });
  });
  assert.equal((await getRecommendations('abc'))[0].title, 'next');
  assert.match(url, /^https:\/\/api.semanticscholar.org\/recommendations\/v1\/papers\/forpaper\/abc\?/);
});

test('DOI path cannot introduce a query string', async (t) => {
  let url;
  t.mock.method(globalThis, 'fetch', async (value) => {
    url = value;
    return Response.json({ paperId: 'abc', title: 'paper' });
  });
  await resolvePaper('10.1234/foo?bar#baz');
  assert.match(url, /DOI:10%2E1234|DOI:10\.1234%2Ffoo%3Fbar%23baz/);
});

test('paper URLs accept title slugs and PDF arXiv links', () => {
  assert.equal(resolveInput('https://www.semanticscholar.org/paper/A-title/' + 'a'.repeat(40)).type, 'paperId');
  assert.deepEqual(resolveInput('https://arxiv.org/pdf/2401.12345'), { type: 'arxiv', value: '2401.12345' });
});

test('archive write waits for transaction commit and reports abort', async (t) => {
  let transaction;
  const database = {
    transaction() {
      const request = { result: 7 };
      transaction = { objectStore: () => ({ add: () => request }) };
      return transaction;
    },
  };
  const previousIndexedDB = globalThis.indexedDB;
  t.after(() => {
    if (previousIndexedDB === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = previousIndexedDB;
  });
  globalThis.indexedDB = {
    open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess({ target: request }));
      return request;
    },
  };
  const { saveArchive } = await import('../src/archive/db.js');
  let settled = false;
  const pending = saveArchive({ title: 'paper' }).then((id) => { settled = true; return id; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  transaction.oncomplete();
  assert.equal(await pending, 7);
  const failed = saveArchive({ title: 'paper' });
  await new Promise((resolve) => setImmediate(resolve));
  transaction.onabort();
  await assert.rejects(failed, /存档写入失败/);
});
