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
    renderMarkdown(el, [String.raw`Inline \(x^2\)`, String.raw`\[E=mc^2\]`,
      '`\\(literal\\)`', '```text\n\\[code\\]\n```'].join('\n\n'));
    assert.equal(el.querySelectorAll('.katex').length, 2);
    assert.equal(el.querySelector('code').textContent, String.raw`\(literal\)`);
    assert.equal(el.querySelector('pre code').textContent.trim(), String.raw`\[code\]`);

    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    el.replaceWith(scroller);
    scroller.append(el);
    let height = 500;
    Object.defineProperties(scroller, {
      scrollHeight: { get: () => height },
      clientHeight: { value: 300 },
    });
    scroller.scrollTop = 200;
    const descriptor = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'innerHTML');
    Object.defineProperty(el, 'innerHTML', {
      get() { return descriptor.get.call(this); },
      set(value) { descriptor.set.call(this, value); height = 2000; },
    });
    const renderer = createStreamingRenderer(el);
    renderer.push(malicious);
    renderer.finalize();
    assert.equal(el.querySelector('[onerror]'), null);
    assert.ok(el.querySelector('.katex'));
    assert.equal(scroller.scrollTop, 2000);
    scroller.scrollTop = 100;
    const paused = createStreamingRenderer(el);
    paused.push('new output');
    paused.finalize();
    assert.equal(scroller.scrollTop, 100);
  } finally {
    await server.close();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
  }
});
