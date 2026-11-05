import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('document changes clear analysis and archive restore replaces missing tabs', async () => {
  const dom = new JSDOM('<!doctype html><div id="pane-ai"></div>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLButtonElement = dom.window.HTMLButtonElement;
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const pane = await server.ssrLoadModule('/src/ui/aiPane.js');
    const store = await server.ssrLoadModule('/src/state/store.js');
    pane.initAiPane();
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    assert.equal(tabs.filter(tab => tab.tabIndex === 0).length, 1);
    tabs[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(document.activeElement, tabs[1]);
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
    assert.ok(document.getElementById(tabs[1].getAttribute('aria-controls')));

    pane.setSavedResults({ summarize: 'old summary', critique: 'old critique' });
    store.setState({ paper: { name: 'next.pdf', fullText: 'new paper', pages: [], meta: {} } });
    assert.ok(Object.values(pane.getSavedResults()).every((value) => value === ''));
    assert.equal(document.querySelector('[data-section="summarize"] [data-result]').textContent, '');
    pane.setSavedResults({ summarize: 'restored summary' });
    pane.refreshAfterRestore();
    assert.equal(pane.getSavedResults().critique, '');
    assert.equal(document.querySelector('[data-section="summarize"] [data-result]').textContent.trim(), 'restored summary');
    assert.equal(store.getState().ui.busy, false);
  } finally {
    await server.close();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.HTMLElement;
    delete globalThis.HTMLButtonElement;
  }
});
