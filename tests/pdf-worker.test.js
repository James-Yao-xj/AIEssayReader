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
      return { promise: Promise.resolve({
        numPages: 1,
        getMetadata: async () => ({ info: {} }),
        getPage: async () => ({ getTextContent: async () => ({ items: [] }), cleanup() {} }),
        destroy: async () => { documentsClosed++; },
      }) };
    },
  };
  try {
    const source = (await readFile(new URL('../src/pdf/extract.js', import.meta.url), 'utf8'))
      .replace("import * as pdfjsLib from 'pdfjs-dist';", 'const pdfjsLib = globalThis.workerLibrary;')
      .replace("import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';", 'class PdfjsWorker {}');
    const { extractText, pdfWorker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const file = { arrayBuffer: async () => new ArrayBuffer(0) };
    await Promise.all([extractText(file), extractText(file)]);
    await extractText(file);
    assert.equal(created, 1);
    assert.equal(documentsClosed, 3);
    assert.equal(pdfWorker.destroyed, false);
  } finally { delete globalThis.workerLibrary; }
});
