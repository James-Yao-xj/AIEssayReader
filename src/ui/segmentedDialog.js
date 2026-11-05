import { estimateSegmented } from '../ai/client.js';
import { activateDialog } from './dialog.js';
import { getState } from '../state/store.js';

/** Review the multi-request cost before starting or resuming an explicit task. */
export function showSegmentedDialog(task, onStart, onError) {
  let estimate;
  try { estimate = estimateSegmented(task); } catch (error) { onError(error); return; }
  const overlay = document.createElement('div');
  overlay.className = 'download-dialog-overlay';
  overlay.innerHTML = `<div class="download-dialog" role="dialog" aria-modal="true" aria-labelledby="segment-title" tabindex="-1">
    <div class="download-dialog__header"><h3 id="segment-title">分段处理论文</h3></div>
    <div class="download-dialog__body"><p data-estimate></p>
      <p>每段会分别调用你配置的模型，可能产生额外费用。分析任务在片段整理后生成综合回答；若片段回答较长，可能追加合并请求。不限制模型输出 Token。</p>
      <p>停止后保留已完成的段落，下次可继续。修改论文或模型设置后需要重新开始。</p></div>
    <div class="download-dialog__actions"><button type="button" class="ai-btn" data-cancel>取消</button><button type="button" class="ai-btn ai-btn--primary" data-start></button></div>
  </div>`;
  overlay.querySelector('[data-estimate]').textContent = `共 ${estimate.parts} 段，预计还需至少 ${estimate.remainingCalls} 次模型调用。`;
  const previous = getState().segmentedTask;
  if (previous && previous.id !== estimate.id && previous.status !== 'complete') {
    const warning = document.createElement('p');
    warning.textContent = '开始此任务将替换先前未完成的分段进度。需要保留旧进度时，请先取消并保存存档。';
    overlay.querySelector('.download-dialog__body').append(warning);
  }
  const start = overlay.querySelector('[data-start]');
  start.textContent = estimate.resumable ? '继续分段处理' : '开始分段处理';
  document.body.append(overlay);
  let release;
  const close = () => { overlay.remove(); release?.(); };
  release = activateDialog(overlay, close);
  overlay.querySelector('[data-cancel]').addEventListener('click', close);
  start.addEventListener('click', () => { close(); onStart(); });
}
