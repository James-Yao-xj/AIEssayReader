import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Model pdf.js ownership: omitted workers are destroyed with their document.
test('parallel extraction and later loads retain the application worker', async () => {
  let created = 0;
  let documentsClosed = 0;
  globalThis.workerLibrary = {
    PDFWorker: class {
      constructor({ port }) { this.port = port; this.destroyed = false; created++; }
    },
    getDocument({ worker }) {
      assert.ok(worker, 'each document must receive the application worker');
      assert.equal(worker.destroyed, false);
      return { destroy: async () => { documentsClosed++; }, promise: Promise.resolve({
        numPages: 1,
        getMetadata: async () => ({ info: {} }),
        getPage: async () => ({ getViewport: () => ({ width: 600 }), getTextContent: async () => ({ items: [] }), cleanup() {} }),
        destroy: async () => { documentsClosed++; },
      }) };
    },
  };
  try {
    const source = (await readFile(new URL('../src/pdf/extract.js', import.meta.url), 'utf8'))
      .replace("import * as pdfjsLib from 'pdfjs-dist';", 'const pdfjsLib = globalThis.workerLibrary;')
      .replace("import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';", 'class PdfjsWorker {}');
    const rewritten = source.replace("from './layout.js'", `from '${new URL('../src/pdf/layout.js', import.meta.url).href}'`);
    const { extractText, pdfWorker } = await import('data:text/javascript;base64,' + Buffer.from(rewritten).toString('base64'));
    const file = { arrayBuffer: async () => new ArrayBuffer(0) };
    await Promise.all([extractText(file), extractText(file)]);
    await extractText(file);
    assert.equal(created, 1);
    assert.equal(documentsClosed, 3);
    assert.equal(pdfWorker.destroyed, false);
  } finally { delete globalThis.workerLibrary; }
});

test('abort during text extraction destroys only the document task', async () => {
  let closed = 0;
  let rejectPage;
  let started;
  const pageStarted = new Promise((resolve) => { started = resolve; });
  globalThis.workerLibrary = {
    PDFWorker: class { constructor() { this.destroyed = false; } },
    getDocument({ worker }) {
      assert.equal(worker.destroyed, false);
      return { destroy: async () => { closed++; rejectPage?.(new Error('transport destroyed')); },
        promise: Promise.resolve({ numPages: 2, fingerprints: ['stable'],
          getMetadata: async () => ({ info: {} }),
          getPage: async () => { started(); return new Promise((_, reject) => { rejectPage = reject; }); },
        }) };
    },
  };
  try {
    const source = (await readFile(new URL('../src/pdf/extract.js', import.meta.url), 'utf8'))
      .replace("import * as pdfjsLib from 'pdfjs-dist';", 'const pdfjsLib = globalThis.workerLibrary;')
      .replace("import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';", 'class PdfjsWorker {}')
      .replace("from './layout.js'", `from '${new URL('../src/pdf/layout.js', import.meta.url).href}'`) + '\n// cancellation test';
    const { extractText, pdfWorker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const ctrl = new AbortController();
    const pending = extractText({ arrayBuffer: async () => new ArrayBuffer(0) }, { signal: ctrl.signal });
    await pageStarted;
    ctrl.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.ok(closed >= 1);
    assert.equal(pdfWorker.destroyed, false);
  } finally { delete globalThis.workerLibrary; }
});
