import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Markdown removes active HTML and preserves formulas and formatting', async () => {
  const dom = new JSDOM('<!doctype html><div id="result"></div>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { renderMarkdown, createStreamingRenderer } = await server.ssrLoadModule('/src/ui/render.js');
    const el = document.getElementById('result');
    const malicious = '<img src=x onerror="alert(1)"><script>alert(2)</script>\n\n[bad](javascript:alert(3))\n\n**safe** $x^2$';
    renderMarkdown(el, malicious);
    assert.equal(el.querySelector('script'), null);
    assert.equal(el.querySelector('[onerror]'), null);
    assert.equal(el.querySelector('a')?.hasAttribute('href'), false);
    assert.equal(el.querySelector('strong').textContent, 'safe');
    assert.ok(el.querySelector('.katex'));
    const renderer = createStreamingRenderer(el);
    renderer.push(malicious);
    renderer.finalize();
    assert.equal(el.querySelector('[onerror]'), null);
    assert.ok(el.querySelector('.katex'));
  } finally {
    await server.close();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
  }
});
