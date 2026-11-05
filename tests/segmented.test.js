import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateSegmented, runSegmented } from '../src/ai/segmented.js';
import { getState, setState } from '../src/state/store.js';
import { countMessagesTokens } from '../src/ai/context.js';

function setup() {
  setState({ paper: { name: 'paper', fullText: 'evidence '.repeat(5000), pages: [] }, segmentedTask: null,
    settings: { reading: { baseUrl: 'https://example.test', model: 'test', apiKey: '', contextTokens: 3000 } } });
}
const stream = text => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n`);

test('segmented translation estimates without requests, pauses and resumes completed parts', async () => {
  setup();
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, undefined);
    assert.ok(countMessagesTokens(body.messages) <= 2700);
    return stream(`translation ${calls}`);
  };
  const estimate = estimateSegmented('translate');
  assert.ok(estimate.parts > 1);
  assert.equal(calls, 0);
  const iterator = runSegmented('translate');
  await iterator.next();
  await iterator.next(); // Commit the first part and emit its separator.
  await iterator.return();
  assert.equal(getState().segmentedTask.nextIndex, 1);
  assert.equal(getState().segmentedTask.status, 'interrupted');
  let output = '';
  for await (const text of runSegmented('translate')) output += text;
  assert.equal(calls, estimate.parts);
  assert.match(output, /translation 1/);
  assert.equal(getState().segmentedTask.status, 'complete');
});

test('segmented analysis admits every call and publishes final synthesis', async () => {
  setup();
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.ok(countMessagesTokens(JSON.parse(options.body).messages) <= 2700);
    return stream(`note ${calls} [p1-c1]`);
  };
  const estimate = estimateSegmented('summarize');
  let output = '';
  for await (const text of runSegmented('summarize')) output += text;
  assert.equal(calls, estimate.estimatedCalls);
  assert.equal(output, `note ${calls} [p1-c1]`);
  assert.equal(getState().segmentedTask.status, 'complete');
});

test('segmented cancellation preserves checkpoint and configuration change prevents reuse', async () => {
  setup();
  const controller = new AbortController();
  globalThis.fetch = async () => { controller.abort(); throw new DOMException('Cancelled', 'AbortError'); };
  await assert.rejects(runSegmented('translate', controller.signal).next(), { name: 'AbortError' });
  assert.equal(getState().segmentedTask.status, 'interrupted');
  assert.equal(estimateSegmented('translate').resumable, true);
  setState({ settings: { ...getState().settings, reading: { ...getState().settings.reading, model: 'changed' } } });
  assert.equal(estimateSegmented('translate').resumable, false);
});

test('large analysis notes use budgeted reduction without dropping completed parts', async () => {
  setup();
  let partCalls = 0;
  let reductionCalls = 0;
  globalThis.fetch = async (_url, options) => {
    const messages = JSON.parse(options.body).messages;
    assert.ok(countMessagesTokens(messages) <= 2700);
    if (messages[0].content.includes('分段分析阶段')) {
      partCalls++;
      return stream('long note '.repeat(1500));
    }
    reductionCalls++;
    return stream('reduced notes [p1-c1]');
  };
  for await (const _text of runSegmented('summarize')) { /* Consume final synthesis. */ }
  assert.equal(getState().segmentedTask.outputs.length, partCalls);
  assert.ok(reductionCalls > 1);
  assert.ok(getState().segmentedTask.outputs.every(text => text.length > 10000));
  assert.equal(getState().segmentedTask.status, 'complete');
});
