import test from 'node:test';
import assert from 'node:assert/strict';
import { planContext, estimateTokens, countMessagesTokens, trimToTokenBudget, assemble, getLastRetrievedIndices } from '../src/ai/context.js';

const question = { role: 'user', content: '解释 gradient 收敛的证据' };
const bounded = (plan) => {
  assert.equal(plan.stats.estimatedTokens, countMessagesTokens(plan.messages));
  assert.ok(plan.stats.estimatedTokens <= Math.floor(plan.stats.budgetTokens * 0.9));
};

test('weighted estimate and prefix account for Chinese and preserve Unicode', () => {
  assert.equal(estimateTokens('abc'), 1);
  assert.equal(estimateTokens('中文'), 4);
  assert.equal(estimateTokens('abc中文'), 5);
  assert.equal(trimToTokenBudget('ab😀中文', 3), 'ab😀');
  assert.equal(trimToTokenBudget('中文', 1), '');
});

test('bilingual long paper and a giant paragraph stay within shared budget', () => {
  for (const fullText of ['english words '.repeat(30000), '中文证明梯度下降'.repeat(20000)]) {
    const plan = planContext({ task: 'chat', paper: { fullText }, messages: [question] });
    bounded(plan);
    assert.equal(plan.messages.at(-1), question);
    assert.ok(plan.stats.paperChunks > 0);
    assert.ok(plan.stats.paperChunks < plan.stats.totalPaperChunks);
    assert.equal(plan.stats.paperChunks, plan.retrievedIndices.length);
  }
});

test('summary boundary is applied before the history window', () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `turn ${index}` }));
  messages.push(question);
  const plan = planContext({ task: 'chat', paper: { fullText: 'paper' }, messages,
    summarizedUpTo: 6, conversationSummary: 'older turns', budgetTokens: 10000 });
  bounded(plan);
  assert.deepEqual(plan.messages.slice(1), messages.slice(6));
  assert.equal(plan.stats.historyMessages, 5);
  assert.equal(plan.stats.omittedMessages, 6);
  assert.ok(plan.messages[0].content.includes('older turns'));
});

test('complete current question survives even when it exceeds history allocation', () => {
  const latest = { role: 'user', content: '中文'.repeat(1500) };
  const plan = planContext({ task: 'chat', paper: { fullText: 'paper' },
    messages: [{ role: 'assistant', content: 'old'.repeat(10000) }, latest], budgetTokens: 10000 });
  bounded(plan);
  assert.equal(plan.messages.at(-1).content, latest.content);
  assert.equal(plan.stats.historyMessages, 1);
});

test('oversized prompts and questions fail without silent truncation', () => {
  assert.throws(() => planContext({ task: 'chat', templates: { chat: '中'.repeat(20000) }, messages: [question] }), /提示词/);
  assert.throws(() => planContext({ task: 'chat', messages: [{ role: 'user', content: '中'.repeat(20000) }] }), /当前提问/);
});

test('all full-paper task types reject oversized paper instead of dropping its tail', () => {
  for (const task of ['summarize', 'explainConcepts', 'critique', 'translate']) {
    assert.throws(() => planContext({ task, paper: { fullText: '中'.repeat(20000) } }), /论文全文/);
    const plan = planContext({ task, paper: { fullText: '完整论文 LAST_SENTENCE' } });
    bounded(plan);
    assert.ok(plan.messages[0].content.includes('LAST_SENTENCE'));
    assert.equal(plan.stats.paperChunks, plan.stats.totalPaperChunks);
  }
});

test('pure plans do not change compatibility retrieval metadata', () => {
  assemble({ task: 'chat', paper: { fullText: 'one paper' }, messages: [question] });
  planContext({ task: 'chat', paper: { fullText: 'different\n\npaper' }, messages: [question] });
  assert.deepEqual(getLastRetrievedIndices(), [0]);
  assert.deepEqual(getLastRetrievedIndices(), []);
});

test('a summary boundary without an actual summary cannot remove history', () => {
  const messages = [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }, question];
  const plan = planContext({ task: 'chat', messages, summarizedUpTo: 100 });
  assert.deepEqual(plan.messages.slice(1), messages);
  assert.equal(plan.stats.omittedMessages, 0);
});

test('multi-megabyte paragraph retrieval avoids repeated request tokenization', { timeout: 5000 }, () => {
  const plan = planContext({ task: 'chat', paper: { fullText: '证明gradient descent中文 '.repeat(150000) }, messages: [question] });
  bounded(plan);
  assert.ok(plan.stats.totalPaperChunks > 1000);
});

test('a rejected compatibility request clears earlier retrieval metadata', () => {
  assemble({ task: 'chat', paper: { fullText: 'paper' }, messages: [question] });
  assert.throws(() => assemble({ task: 'translate', paper: { fullText: 'x'.repeat(200000) } }));
  assert.deepEqual(getLastRetrievedIndices(), []);
});

test('page citations stay stable across selection and resolve only known chunks', async () => {
  const { chunkPaper, resolveCitation } = await import('../src/ai/context.js');
  const paper = { fullText: 'Fallback must not change page IDs', pages: [
    { pageNum: 1, text: 'First page. '.repeat(400) }, { pageNum: 2, text: 'Second page.' },
  ] };
  const chunks = chunkPaper(paper);
  assert.equal(chunks[0].id, 'p1-c1');
  assert.equal(chunks.at(-1).id, 'p2-c1');
  assert.equal(resolveCitation(paper, 'p2-c1').pageNum, 2);
  assert.equal(resolveCitation(paper, 'p99-c1'), null);
  const plan = planContext({ task: 'chat', paper, messages: [{ role: 'user', content: 'Explain page two' }], budgetTokens: 3000 });
  for (const evidence of plan.evidence) assert.ok(plan.messages[0].content.includes(`[${evidence.id}]`));
});

test('incomplete assistant text is retained in history storage but excluded from context', () => {
  const messages = [ { role: 'user', content: 'Previous question' },
    { role: 'assistant', content: 'UNTRUSTED PARTIAL ANSWER', status: 'interrupted' },
    { role: 'user', content: 'Next question' } ];
  const plan = planContext({ task: 'chat', paper: { fullText: 'Evidence' }, messages });
  assert.ok(!plan.messages.some(message => message.content.includes('UNTRUSTED PARTIAL')));
  assert.ok(plan.messages.some(message => message.content === 'Previous question'));
});
