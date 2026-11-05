import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIProvider } from '../src/ai/openai.js';
import { assemble, LIMITS } from '../src/ai/context.js';

const provider = () => createOpenAIProvider({ baseUrl: 'https://example.test/v1', model: 'test', apiKey: 'secret' });

test('SSE preserves split UTF-8 and the final record without newline', async () => {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}');
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
