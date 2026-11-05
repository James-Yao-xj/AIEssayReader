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

test('consumer cancellation retains partial output with interrupted status', async () => {
  reset();
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\ndata: [DONE]\n');
  const iterator = chat('question');
  await iterator.next();
  await iterator.return();
  assert.equal(getState().messages[1].content, 'partial');
  assert.equal(getState().messages[1].status, 'interrupted');
});

const successStream = () => new Response('data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}\n');
const history = (count, content = i => `UNIQUE_MESSAGE_${i}`) => Array.from({ length: count }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user', content: content(i),
}));

test('summarized prefix is not repeated as raw history in the next request', async () => {
  reset();
  setState({ messages: history(12), conversationSummary: { text: 'Earlier discussion', summarizedUpTo: 4 } });
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (!request.stream) return Response.json({ choices: [{ message: { content: 'Summary' } }] });
    const contents = request.messages.slice(1).map(m => m.content);
    assert.equal(contents.includes('UNIQUE_MESSAGE_0'), false);
    assert.equal(contents.includes('UNIQUE_MESSAGE_3'), false);
    assert.equal(contents.includes('UNIQUE_MESSAGE_4'), true);
    return successStream();
  };
  for await (const _chunk of chat('Next question')) { /* Consume the reply. */ }
  assert.match(getState().chatStatus.text, /省略/);
});

test('summary input is bounded, advances whole pairs, and clamps old and new summaries', async () => {
  const { countMessagesTokens, estimateTokens } = await import('../src/ai/context.js');
  reset();
  const messages = history(40, i => `TURN_${i}: ${'中'.repeat(1000)}`);
  setState({ messages, conversationSummary: { text: '旧'.repeat(10000), summarizedUpTo: 2 } });
  let summaryRequest;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.stream) return successStream();
    summaryRequest = request;
    assert.ok(countMessagesTokens(request.messages) <= 8000);
    assert.ok(!request.messages[1].content.includes('TURN_0:'));
    assert.ok(!request.messages[1].content.includes('TURN_1:'));
    return Response.json({ choices: [{ message: { content: '新'.repeat(10000) } }] });
  };
  for await (const _chunk of chat('question')) { /* Consume the reply. */ }
  assert.ok(summaryRequest);
  const summary = getState().conversationSummary;
  assert.ok(summary.summarizedUpTo > 2 && summary.summarizedUpTo < 30);
  assert.equal(summary.pending.offset, 0);
  assert.ok(estimateTokens(summary.text) <= 1200);
  assert.match(getState().chatStatus.text, /分批/);
});

test('an oversized old message makes bounded fragment progress across turns', async () => {
  const { countMessagesTokens } = await import('../src/ai/context.js');
  reset();
  setState({ messages: history(12, i => i < 2 ? '中'.repeat(12000) : `message ${i}`) });
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.stream) return successStream();
    assert.ok(countMessagesTokens(body.messages) <= 8000);
    return Response.json({ choices: [{ message: { content: 'Fragment summary' } }] });
  };
  for await (const _chunk of chat('question')) { /* Consume the reply. */ }
  const first = getState().conversationSummary.pending.offset;
  assert.ok(first > 0);
  assert.equal(getState().conversationSummary.summarizedUpTo, 0);
  for await (const _chunk of chat('next')) { /* Consume the reply. */ }
  assert.ok(getState().conversationSummary.pending.offset > first);
});

test('summary failure reports omitted history without advancing its boundary', async () => {
  reset();
  setState({ messages: history(24), conversationSummary: { text: 'Prior summary', summarizedUpTo: 2 } });
  globalThis.fetch = async (_url, options) => JSON.parse(options.body).stream
    ? successStream() : new Response('unavailable', { status: 503 });
  for await (const _chunk of chat('question')) { /* Consume the reply. */ }
  assert.equal(getState().conversationSummary.summarizedUpTo, 2);
  assert.match(getState().chatStatus.text, /省略/);
  assert.match(getState().chatStatus.text, /摘要失败/);
});

test('oversized full-paper tasks fail before fetch and replace stale coverage', async () => {
  const { summarize } = await import('../src/ai/client.js');
  reset();
  setState({ paper: { fullText: '中'.repeat(100000) }, chatStatus: { text: 'old coverage' } });
  let called = false;
  globalThis.fetch = async () => { called = true; return successStream(); };
  await assert.rejects(summarize().next());
  assert.equal(called, false);
  assert.match(getState().chatStatus.text, /上下文未发送/);
});

test('streamed partial answers are autosave-visible and failure keeps explicit status', async () => {
  reset();
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"Saved partial"}}]}\n');
  const iterator = chat('question');
  await iterator.next();
  assert.equal(getState().messages.at(-1).status, 'generating');
  assert.equal(getState().messages.at(-1).content, 'Saved partial');
  await assert.rejects(iterator.next(), /提前结束/);
  assert.equal(getState().messages.at(-1).status, 'failed');
  assert.equal(getState().messages.at(-1).content, 'Saved partial');
  assert.ok(getState().contextEvidence[0].id.startsWith('p1-c'));
});
