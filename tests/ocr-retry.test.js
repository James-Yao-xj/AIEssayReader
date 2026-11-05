import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function loadVision() {
  const source = (await readFile(new URL('../src/pdf/vision.js', import.meta.url), 'utf8'))
    .replace("import { pdfjsLib, pdfWorker } from './extract.js';", 'const pdfjsLib = globalThis.ocrPdf; const pdfWorker = {};')
    .replace("import { createProvider, buildVisionMessage } from '../ai/openai.js';", 'const createProvider = () => globalThis.ocrProvider; const buildVisionMessage = (prompt, image) => image;')
    .replace("import { getState } from '../state/store.js';", 'const getState = () => ({ settings: { recognition: { baseUrl: "https://test", model: "vision" } } });')
    .replace(/async function renderPageToImage\([\s\S]*?\n}\n/, 'async function renderPageToImage(page) { return page.number; }\n');
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

test('OCR retries only failed pages, retains successes and stops global API errors', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let closed = 0;
  globalThis.ocrPdf = { getDocument: () => ({ destroy: async () => { closed++; }, promise: Promise.resolve({
    numPages: 3, fingerprints: ['same-file'], getPage: async (number) => ({ number, cleanup() {} }),
  }) }) };
  let calls = [];
  globalThis.ocrProvider = { chatOnce: async ([number]) => {
    calls.push(number);
    if (number === 2) throw new Error('one damaged page');
    return `Page ${number}`;
  } };
  try {
    const { extractWithVision } = await loadVision();
    const file = { arrayBuffer: async () => new ArrayBuffer(0) };
    const first = await extractWithVision(file);
    assert.deepEqual(first.failedPages, [2]);
    assert.equal(first.pages[0].text, 'Page 1');
    calls = [];
    globalThis.ocrProvider.chatOnce = async ([number]) => { calls.push(number); return 'Recovered page'; };
    const retry = await extractWithVision(file, { previousResult: first, retryFailedOnly: true });
    assert.deepEqual(calls, [2]);
    assert.deepEqual(retry.failedPages, []);
    assert.equal(retry.pages[0].text, 'Page 1');
    calls = [];
    globalThis.ocrProvider.chatOnce = async ([number]) => { calls.push(number); throw new Error('API Key 无效（HTTP 401）'); };
    await assert.rejects(extractWithVision(file), (error) => {
      assert.equal(error.partialResult.pages.length, 3);
      return /401/.test(error.message);
    });
    assert.deepEqual(calls, [1]);
    assert.equal(closed, 3);
    const ctrl = new AbortController(); ctrl.abort();
    await assert.rejects(extractWithVision(file, { signal: ctrl.signal }), { name: 'AbortError' });
    assert.equal(closed, 3);
  } finally {
    delete globalThis.ocrPdf;
    delete globalThis.ocrProvider;
  }
});
