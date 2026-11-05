import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { getState, setState, subscribe } from '../src/state/store.js';

test('matching PDF reattaches without clearing session and full-text restore removes stale binary', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html);
  const previousGlobals = Object.fromEntries(['window', 'document', 'Element'].map((name) => [name, globalThis[name]]));
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Element = dom.window.Element;
  const calls = { text: null, cleaned: 0 };
  const native = { meta: { nPages: 1 }, fingerprint: 'original', pages: [{ pageNum: 1, text: 'native' }], fullText: 'native' };
  const noop = () => {};
  globalThis.mainMocks = { getState, setState, subscribe,
    loadSettings: () => ({ reading: {}, recognition: {}, fontSize: 14 }),
    extractText: async () => native,
    renderPdf: async (_file, container) => {
      container.innerHTML = '<canvas></canvas>';
      return { totalPages: 1, cleanup: () => { calls.cleaned++; } };
    },
    renderText: (paper) => { calls.text = paper; }, renderVisionResult: noop,
    initAutosave: async () => ({}), initSettings: noop, openSettings: noop,
    initAiPane: noop, initTextPane: noop, resetTextPane: noop, focusTextPage: noop,
    setVisionHandler: noop, setVisionAbort: noop, setVisionProgress: noop, hideVisionProgress: noop,
    initPaneResize: noop, initPaneCollapse: noop, initArchiveButton: noop,
    extractWithVision: noop, describeErr: (error) => error.message,
  };
  const source = (await readFile(new URL('../src/main.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  const prefix = `const { ${Object.keys(globalThis.mainMocks).join(', ')} } = globalThis.mainMocks;\n`;
  try {
    const { loadPdf } = await import('data:text/javascript;base64,' + Buffer.from(prefix + source).toString('base64'));
    const restored = { name: 'old.pdf', fingerprint: 'original', meta: { nPages: 1 }, fullText: 'saved OCR', pages: [{ pageNum: 1, text: 'saved OCR' }] };
    const history = [{ role: 'user', content: 'retained question' }];
    setState({ paper: restored, messages: history, savedResults: { summarize: 'retained result' } });
    await loadPdf({ name: 'renamed.pdf', type: 'application/pdf' });
    assert.equal(getState().paper, restored);
    assert.equal(getState().messages, history);
    assert.equal(calls.text.fullText, 'saved OCR');
    assert.equal(getState().savedResults.summarize, 'retained result');
    const another = { ...restored, fingerprint: 'archive-two', fullText: 'restored two' };
    setState({ paper: another });
    assert.equal(document.querySelector('#pdf-scroll canvas'), null);
    assert.equal(calls.text, another);
    assert.ok(calls.cleaned > 0);
    await loadPdf({ name: 'different.pdf', type: 'application/pdf' });
    assert.equal(getState().paper.fingerprint, 'original');
    assert.deepEqual(getState().messages, []);
    assert.deepEqual(getState().savedResults, {});
    assert.match(document.getElementById('status-text').textContent, /不匹配/);
  } finally {
    for (const [name, value] of Object.entries(previousGlobals)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
    delete globalThis.mainMocks;
    dom.window.close();
  }
});
