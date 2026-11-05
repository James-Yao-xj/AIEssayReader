import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { activateDialog } from '../src/ui/dialog.js';

test('modal traps both tab directions, ignores hidden fields and restores focus', () => {
  const dom = new JSDOM('<button id="open">Open</button><div id="modal"><section role="dialog" tabindex="-1"><button id="first">First</button><div hidden><input></div><div aria-hidden="true"><button>Hidden</button></div><button id="last">Last</button></section></div>');
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  const { document, KeyboardEvent } = dom.window;
  const trigger = document.querySelector('#open');
  trigger.focus();
  let escaped = false;
  const cleanup = activateDialog(document.querySelector('#modal'), () => { escaped = true; });
  assert.equal(trigger.inert, true);
  assert.equal(document.activeElement.id, 'first');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(document.activeElement.id, 'last');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(document.activeElement.id, 'first');
  trigger.focus();
  assert.equal(document.activeElement.id, 'first');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(escaped, true);
  cleanup();
  cleanup();
  assert.equal(document.activeElement, trigger);
  assert.equal(Boolean(trigger.inert), false);
  dom.window.close();
});

test('main document provides persistent file entry, skip link and live status', async () => {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'));
  const doc = dom.window.document;
  assert.equal(doc.querySelector('#btn-open-pdf').tagName, 'BUTTON');
  assert.equal(doc.querySelector('.skip-link').getAttribute('href'), '#reader');
  assert.equal(doc.querySelector('#reader').getAttribute('tabindex'), '-1');
  assert.equal(doc.querySelector('#status-bar').getAttribute('aria-live'), 'polite');
  assert.equal(doc.querySelector('#key-hint').tagName, 'BUTTON');
  dom.window.close();
});

test('settings dialog restores trigger focus and permits clearing saved keys', async () => {
  const { createServer } = await import('vite');
  const dom = new JSDOM('<!doctype html><button id="trigger">Settings</button>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLFieldSetElement', 'HTMLFormElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'FormData', 'localStorage']) globalThis[key] = dom.window[key];
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const settings = await server.ssrLoadModule('/src/ui/settings.js');
    const store = await server.ssrLoadModule('/src/state/store.js');
    const { DEFAULT_SETTINGS } = await server.ssrLoadModule('/src/config/defaults.js');
    store.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
    store.setState({ settings: { ...store.getState().settings, reading: { ...DEFAULT_SETTINGS.reading, apiKey: 'secret' } } });
    const trigger = document.querySelector('#trigger');
    trigger.focus();
    settings.openSettings();
    assert.equal(document.querySelector('.settings-basic__drawer').inert, true);
    assert.equal(document.querySelector('[name="reading.apiKey"]').value, '');
    document.querySelector('[name="reading.clearApiKey"]').checked = true;
    document.querySelector('#settings-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(store.getState().settings.reading.apiKey, '');
    assert.equal(document.activeElement, trigger);
  } finally {
    await server.close();
    dom.window.close();
  }
});
