import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('PDF deduplicates jobs, limits concurrency, caps DPR pixels, resizes and releases canvases', async () => {
  const dom = new JSDOM('<div id="pdf"></div>');
  const old = Object.fromEntries(['window', 'document', 'IntersectionObserver', 'ResizeObserver'].map((name) => [name, globalThis[name]]));
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(window, 'devicePixelRatio', { value: 4 });
  window.HTMLCanvasElement.prototype.getContext = () => ({});
  let observer, resize;
  globalThis.IntersectionObserver = class {
    constructor(callback) { observer = callback; }
    observe() {} disconnect() {}
  };
  globalThis.ResizeObserver = class {
    constructor(callback) { resize = callback; }
    observe() {} disconnect() {}
  };
  let width = 1000;
  const container = document.getElementById('pdf');
  Object.defineProperty(container, 'clientWidth', { get: () => width });
  const jobs = [];
  let count = 0;
  globalThis.workerMock = {};
  globalThis.pdfMock = { getDocument: (options) => {
    assert.equal(options.worker, globalThis.workerMock);
    return ({ promise: Promise.resolve({
    numPages: 12,
    getPage: async () => ({
      getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
      render: ({ canvasContext, viewport, transform }) => {
        count++;
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        jobs.push({ resolve, viewport, transform });
        return { promise, cancel: resolve };
      }, cleanup() {},
    }), destroy: async () => {},
  }) }); } };
  try {
    const source = (await readFile(new URL('../src/pdf/render.js', import.meta.url), 'utf8')).replace("import { pdfjsLib, pdfWorker } from './extract.js';", 'const pdfjsLib = globalThis.pdfMock; const pdfWorker = globalThis.workerMock;');
    const { renderPdf } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const handle = await renderPdf({ arrayBuffer: async () => new ArrayBuffer(0) }, container);
    const holders = [...container.children];
    const notify = (target, isIntersecting = true) => observer([{ target, isIntersecting }]);
    notify(holders[0]); notify(holders[0]); notify(holders[1]); notify(holders[2]);
    await tick();
    assert.equal(count, 2);
    assert.ok(jobs[0].transform[0] < 4);
    jobs[0].resolve(); jobs[1].resolve(); await tick();
    jobs[2].resolve(); await tick();
    assert.equal(count, 3);
    const canvas = holders[0].querySelector('canvas');
    assert.ok(canvas.width * canvas.height <= 4_000_000);
    assert.equal(canvas.style.width, '968px');
    width = 600; resize(); await tick();
    for (let i = 3; i < jobs.length; i++) jobs[i].resolve();
    await tick();
    for (let i = 3; i < jobs.length; i++) jobs[i].resolve();
    await tick();
    assert.equal(holders[0].querySelector('canvas').style.width, '568px');
    // Move across the document. Old rasters must not accumulate indefinitely.
    for (let i = 0; i < holders.length; i++) notify(holders[i], false);
    for (let i = 3; i < holders.length; i++) {
      notify(holders[i]); await tick(); jobs.at(-1).resolve(); await tick(); notify(holders[i], false);
    }
    assert.ok(container.querySelectorAll('canvas').length <= 8);
    assert.ok(holders[0].style.minHeight.endsWith('px'));
    const rasters = [...container.querySelectorAll('canvas')];
    handle.cleanup();
    assert.equal(container.querySelectorAll('canvas').length, 0);
    assert.ok(rasters.every((raster) => raster.width === 0));
  } finally {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
    delete globalThis.pdfMock;
    delete globalThis.workerMock;
    dom.window.close();
  }
});
