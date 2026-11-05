/** Explicit, resumable multi-request reading. Calling estimates makes no requests. */
import { getState, setState } from '../state/store.js';
import { createProvider } from './openai.js';
import { chunkPaper, countMessagesTokens, trimToTokenBudget } from './context.js';
import { GLOBAL_STYLE, SUMMARIZE, EXPLAIN_CONCEPTS, CRITIQUE, TRANSLATE } from './prompts.js';

const templates = { summarize: SUMMARIZE, explainConcepts: EXPLAIN_CONCEPTS, critique: CRITIQUE, translate: TRANSLATE };
const fields = { summarize: 'promptSummarize', explainConcepts: 'promptExplainConcepts', critique: 'promptCritique', translate: 'promptTranslate' };

/** Hash document and configuration identity without storing credentials. */
function fingerprint(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}-${(hash >>> 0).toString(16)}`;
}

function prepare(task) {
  if (!templates[task]) throw new Error('此任务不支持分段处理。');
  const { paper, settings } = getState();
  if (!paper?.fullText) throw new Error('请先加载论文。');
  const budgetTokens = settings.reading.contextTokens ?? 24000;
  const template = settings[fields[task]]?.trim() || templates[task];
  const paperKey = fingerprint(JSON.stringify([paper.name, paper.fullText, paper.pages]));
  const configKey = fingerprint(JSON.stringify([settings.reading, template]));
  const evidence = chunkPaper(paper);
  const parts = [];
  let group = [];
  const partInstruction = task === 'translate' ? template : `${template}\n这是分段分析阶段。记录本段的事实、方法和限制，保留来源标识，供最终综合分析。`;
  // Use original labels directly; planner labels must not renumber a section.
  const directRequest = (chunks, instruction = partInstruction) => [
    { role: 'system', content: `${GLOBAL_STYLE}\n${instruction}\n只可引用片段已有的 [pN-cM] 标识。` },
    { role: 'user', content: chunks.map(c => `[${c.id}]\n${c.text}`).join('\n\n') },
  ];
  const fits = messages => countMessagesTokens(messages) <= Math.floor(budgetTokens * .9);
  for (const chunk of evidence) {
    if (group.length && !fits(directRequest([...group, chunk]))) { parts.push(group); group = []; }
    if (!fits(directRequest([chunk]))) throw new Error('单段或提示词超过预算，请提高上下文预算。');
    group.push(chunk);
  }
  if (group.length) parts.push(group);
  if (!parts.length) throw new Error('论文没有可处理文本。');
  return { task, paper, paperKey, configKey, evidence, parts, directRequest, fits, budgetTokens, template };
}

/** Return an estimate only. Reduction calls depend on model output length. */
export function estimateSegmented(task) {
  const plan = prepare(task);
  const id = `${task}:${plan.paperKey}:${plan.configKey}`;
  const saved = getState().segmentedTask;
  const resumable = saved?.id === id;
  return { id, parts: plan.parts.length, total: plan.parts.length,
    estimatedCalls: plan.parts.length + (task === 'translate' ? 0 : 1),
    remainingCalls: Math.max(0, plan.parts.length - (resumable ? saved.nextIndex : 0)) + (task === 'translate' ? 0 : 1),
    resumable, additionalReductionPossible: task !== 'translate' };
}
export const prepareSegmented = estimateSegmented;

/** Run only after explicit consent. Completed parts survive cancellation. */
export async function* runSegmented(task, signal) {
  const plan = prepare(task);
  const estimate = estimateSegmented(task);
  const existing = getState().segmentedTask;
  let checkpoint = existing?.id === estimate.id ? { ...existing } : {
    id: estimate.id, task, paperKey: plan.paperKey, configKey: plan.configKey,
    nextIndex: 0, outputs: [], status: 'interrupted', stage: 'parts', result: '', total: plan.parts.length,
  };
  const provider = createProvider(getState().settings.reading);
  const current = () => getState().paper === plan.paper && getState().segmentedTask?.id === checkpoint.id;
  const save = patch => { checkpoint = { ...checkpoint, ...patch }; if (getState().paper === plan.paper) setState({ segmentedTask: checkpoint }); };
  const publishRequest = (messages, phase, evidence) => setState({
    contextEvidence: evidence,
    chatStatus: { text: `分段${phase}：估算 ${countMessagesTokens(messages)}/${plan.budgetTokens} tokens；完成 ${checkpoint.nextIndex}/${plan.parts.length} 段` },
  });
  const check = () => { signal?.throwIfAborted(); if (!current()) throw new DOMException('Document changed', 'AbortError'); };
  if (checkpoint.status === 'complete') { yield checkpoint.result; return; }
  save({ status: 'generating', error: '' });
  let displayed = task === 'translate' ? checkpoint.outputs.join('\n\n') : '';
  if (displayed) yield displayed + '\n\n';
  try {
    for (let index = checkpoint.nextIndex; index < plan.parts.length; index++) {
      check();
      const chunks = plan.parts[index];
      setState({ contextEvidence: chunks });
      const instruction = task === 'translate' ? plan.template : `${plan.template}\n这是分段分析阶段。记录本段的事实、方法和限制，保留来源标识，供最终综合分析。`;
      const request = plan.directRequest(chunks, instruction);
      if (!plan.fits(request)) throw new Error('分段任务提示词超过预算。');
      publishRequest(request, task === 'translate' ? '翻译' : '分析', chunks);
      let output = '';
      for await (const text of provider.chat(request, { signal })) {
        check(); output += text;
        if (task === 'translate') { displayed += text; yield text; }
      }
      check();
      save({ nextIndex: index + 1, outputs: [...checkpoint.outputs, output], result: task === 'translate' ? displayed : '' });
      if (task === 'translate') { displayed += '\n\n'; yield '\n\n'; }
    }
    if (task === 'translate') { save({ status: 'complete', result: checkpoint.outputs.join('\n\n') }); return; }

    const synthesisRequest = notes => [
      { role: 'system', content: `${GLOBAL_STYLE}\n${plan.template}\n根据全部分段笔记综合回答，保留原始来源标识，不得编造来源。` },
      { role: 'user', content: notes.join('\n\n') },
    ];
    let notes = checkpoint.reduceInputs || checkpoint.outputs;
    let level = checkpoint.reduceLevel || 0;
    while (!plan.fits(synthesisRequest(notes))) {
      if (level >= 3) throw new Error('综合笔记仍超过预算；已保留分段结果，请提高预算后重新处理。');
      // Split every note completely; no section evidence is silently dropped.
      const fragments = [];
      for (const note of notes) {
        let rest = note;
        while (rest) {
          const allowance = Math.max(1, Math.floor(plan.budgetTokens * .9) - countMessagesTokens(synthesisRequest([])) - 32);
          const piece = trimToTokenBudget(rest, allowance);
          if (!piece) throw new Error('综合提示词超过预算。');
          fragments.push(piece); rest = rest.slice(piece.length);
        }
      }
      const reduced = checkpoint.stage === 'reduce' ? [...(checkpoint.reduceOutputs || [])] : [];
      let index = checkpoint.stage === 'reduce' ? checkpoint.reduceIndex || 0 : 0;
      save({ stage: 'reduce', reduceInputs: notes, reduceOutputs: [...reduced], reduceIndex: index, reduceLevel: level });
      for (; index < fragments.length; index++) {
        check();
        const request = synthesisRequest([fragments[index]]);
        if (!plan.fits(request)) throw new Error('综合笔记片段超过预算。');
        publishRequest(request, '笔记归并', plan.evidence);
        const text = await provider.chatOnce(request, { signal }); check();
        reduced.push(text);
        save({ reduceOutputs: [...reduced], reduceIndex: index + 1 });
      }
      notes = reduced; level++;
      save({ stage: 'synthesis', reduceInputs: notes, reduceOutputs: [], reduceIndex: 0, reduceLevel: level });
    }
    check();
    save({ stage: 'synthesis', result: '' });
    setState({ contextEvidence: plan.evidence });
    publishRequest(synthesisRequest(notes), '综合', plan.evidence);
    let result = '';
    for await (const text of provider.chat(synthesisRequest(notes), { signal })) {
      check(); result += text; save({ result }); yield text;
    }
    check(); save({ status: 'complete', result });
  } catch (error) {
    if (current()) save({ status: signal?.aborted || error.name === 'AbortError' ? 'interrupted' : 'failed',
      result: task === 'translate' ? displayed : checkpoint.result, error: error.message });
    throw error;
  } finally {
    if (current() && checkpoint.status === 'generating') save({ status: 'interrupted' });
  }
}
