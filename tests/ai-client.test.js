import test from 'node:test';
import assert from 'node:assert/strict';
import { chat } from '../src/ai/client.js';
import { getState, setState } from '../src/state/store.js';

function reset() {
  setState({ paper: { fullText: 'Original paper' }, messages: [], conversationSummary: null,
    retrievedChunkIndices: [], settings: { reading: { apiKey: 'test', model: 'test', baseUrl: 'https://example.test' } } });
}

test('a response for an old paper cannot enter the new conversation', async () => {
  reset();
  let release;
  const response = new Promise(resolve => { release = resolve; });
  globalThis.fetch = () => response;
  const pending = chat('question').next();
  setState({ paper: { fullText: 'New paper' }, messages: [] });
  release(new Response('data: {"choices":[{"delta":{"content":"Old answer"}}]}\n'));
  assert.equal((await pending).done, true);
  assert.deepEqual(getState().messages, []);
});

test('an already cancelled chat does not add a user message', async () => {
  reset();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(chat('question', abort.signal).next(), { name: 'AbortError' });
  assert.deepEqual(getState().messages, []);
});

test('a pending summary cannot restore context after archive or paper replacement', async () => {
  reset();
  setState({ messages: Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `message ${i}`,
  })) });
  let releaseSummary;
  let summaryStarted;
  const started = new Promise(resolve => { summaryStarted = resolve; });
  globalThis.fetch = async (_url, request) => {
    if (JSON.parse(request.body).stream) {
      return new Response('data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}\n');
    }
    summaryStarted();
    return new Promise(resolve => { releaseSummary = resolve; });
  };
  const iterator = chat('question');
  assert.equal((await iterator.next()).value, 'Answer');
  const completion = iterator.next();
  await started;
  setState({ paper: { fullText: '' }, messages: [], conversationSummary: null, chatStatus: null });
  releaseSummary(Response.json({ choices: [{ message: { content: 'Stale summary' } }] }));
  await completion;
  assert.equal(getState().conversationSummary, null);
  assert.equal(getState().chatStatus, null);
});

test('failed chat restores history so retry sends the question only once', async () => {
  reset();
  const original = [{ role: 'user', content: 'previous' }, { role: 'assistant', content: 'answer' }];
  setState({ messages: original, settings: { reading: { apiKey: '', model: 'local', baseUrl: 'http://192.168.1.2/v1' } } });
  globalThis.fetch = async () => new Response('data: {"error":{"message":"temporary"}}\n');
  await assert.rejects(chat('retry question').next(), /temporary/);
  assert.equal(getState().messages, original);

  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    const sent = JSON.parse(options.body).messages;
    assert.equal(sent.filter(m => m.content === 'retry question').length, 1);
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\ndata: [DONE]\n');
  };
  for await (const _chunk of chat('retry question')) { /* Read the complete reply. */ }
  assert.equal(getState().messages.length, 4);
});

test('consumer cancellation removes a partial user turn from stored history', async () => {
  reset();
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\ndata: [DONE]\n');
  const iterator = chat('question');
  await iterator.next();
  await iterator.return();
  assert.deepEqual(getState().messages, []);
});
