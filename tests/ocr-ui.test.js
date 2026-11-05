import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('OCR partial result exposes explicit retry and citations can focus retained text pages', async () => {
  const dom = new JSDOM('<div id="text-scroll"></div>');
  const old = Object.fromEntries(['window', 'document', 'Node'].map((name) => [name, globalThis[name]]));
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.Node = dom.window.Node;
  try {
    const source = (await readFile(new URL('../src/ui/textPane.js', import.meta.url), 'utf8'))
      .replace("import { getState, setState } from '../state/store.js';", 'const getState = () => ({ui:{}}); const setState = () => {};')
      .replace("import { renderMarkdown } from './render.js';", 'const renderMarkdown = (el, text) => {el.textContent = text;};');
    const ui = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    ui.initTextPane();
    let calls = [];
    ui.setVisionHandler(async (retry) => { calls.push(retry); });
    ui.renderText({ meta: {}, pages: [{ pageNum: 1, text: 'native' }] });
    ui.renderVisionResult({ meta: {}, pages: [{ pageNum: 1, text: 'recognized' }, { pageNum: 2, text: '', error: 'page failure' }] });
    assert.deepEqual(calls, []);
    const retry = document.querySelector('.text-mode-retry');
    assert.match(retry.textContent, /1 页/);
    retry.click(); retry.click();
    assert.deepEqual(calls, [true]);
    ui.hideVisionProgress();
    assert.equal(retry.disabled, false);
    ui.focusTextPage(2);
    assert.equal(document.activeElement.dataset.pageNum, '2');
    ui.resetTextPane();
    assert.equal(retry.disabled, true);
  } finally {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
    dom.window.close();
  }
});
