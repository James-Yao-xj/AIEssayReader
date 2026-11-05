import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIProvider } from '../src/ai/openai.js';
import { assemble, LIMITS } from '../src/ai/context.js';

const provider = () => createOpenAIProvider({ baseUrl: 'https://example.test/v1', model: 'test', apiKey: 'secret' });

test('SSE preserves split UTF-8 and the final record without newline', async () => {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}');
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) {
    for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
    c.close();
  }}));
  assert.equal(await provider().chatOnce([]), '你好');
});

test('stream errors are surfaced instead of reporting success', async () => {
  globalThis.fetch = async () => new Response('data: {"error":{"message":"quota"}}\n');
  await assert.rejects(provider().chatOnce([]), /quota/);
});

test('empty non-streaming replies fail explicitly', async () => {
  globalThis.fetch = async () => Response.json({ choices: [] });
  await assert.rejects(provider().chatOnce([], { stream: false }), /未返回文本/);
});

test('oversized question does not silently exceed context budget', () => {
  assert.throws(() => assemble({ task: 'chat', paper: { fullText: 'paper' }, messages: [
    { role: 'user', content: 'x'.repeat(LIMITS.MAX_TOTAL_CHARS) },
  ] }), /提问过长/);
});

test('a large unbroken paper stays inside the chat budget', () => {
  const messages = assemble({ task: 'chat', paper: { fullText: 'x'.repeat(200000) }, messages: [
    { role: 'user', content: 'Explain the paper' },
  ] });
  assert.ok(messages.reduce((sum, m) => sum + m.content.length, 0) <= LIMITS.MAX_TOTAL_CHARS);
});

test('keyless private-network endpoints omit Authorization and clamp temperature', async () => {
  let received;
  globalThis.fetch = async (url, options) => {
    received = { url, ...options };
    return Response.json({ choices: [{ message: { content: 'ok' } }] });
  };
  const local = createOpenAIProvider({ baseUrl: ' http://192.168.1.5:11434/v1/ ', apiKey: ' ', model: ' local ', temperature: 9 });
  assert.equal(await local.chatOnce([], { stream: false }), 'ok');
  assert.equal(received.url, 'http://192.168.1.5:11434/v1/chat/completions');
  assert.equal(received.headers.Authorization, undefined);
  assert.equal(JSON.parse(received.body).temperature, 2);
});

test('invalid endpoint schemes and ambiguous credentials fail before fetch', () => {
  for (const baseUrl of ['file:///tmp/model', 'ftp://example.test', 'example.test/v1', 'https://user:pass@example.test', 'https://example.test/v1?key=secret']) {
    assert.throws(() => createOpenAIProvider({ baseUrl, model: 'test' }), /Base URL/);
  }
});

test('empty, malformed and interrupted streams cannot become successful replies', async () => {
  for (const [data, error] of [
    ['data: [DONE]\n', /未返回文本/],
    ['data: {bad json}\n', /无效的流式数据/],
    ['data: {"choices":[{"delta":{"content":"partial"}}]}\n', /提前结束/],
    ['data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n', /长度上限/],
  ]) {
    globalThis.fetch = async () => new Response(data);
    await assert.rejects(provider().chatOnce([]), error);
  }
});

test('DONE ends a text stream and cancels its reader', async () => {
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\ndata: [DONE]\n')); },
    cancel() { cancelled = true; },
  }));
  assert.equal(await provider().chatOnce([]), 'ok');
  assert.equal(cancelled, true);
});

test('non-streaming truncated or filtered text cannot become a valid summary', async () => {
  for (const reason of ['length', 'content_filter']) {
    globalThis.fetch = async () => Response.json({ choices: [{
      finish_reason: reason, message: { content: 'partial summary' },
    }] });
    await assert.rejects(provider().chatOnce([], { stream: false }), /上限|过滤/);
  }
});
