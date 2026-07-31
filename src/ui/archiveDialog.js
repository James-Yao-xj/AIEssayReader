/* =========================================================
 * src/ui/archiveDialog.js
 *
 * 存档管理对话框 UI。
 *
 * - initArchiveButton() 绑定顶栏按钮 → openArchiveDialog()
 * - 对话框内：保存当前 / 历史列表 / 恢复 / 导出 / 删除 / 导入
 * - 订阅 store 同步按钮禁用态
 * ========================================================= */

import { getState, subscribe } from '../state/store.js';
import * as db from '../archive/db.js';
import { hasContent, archiveCurrent, restoreArchive, exportArchive, importArchive } from '../archive/manager.js';

/** ---- 内容类型短标签 ---- */
const TYPE_LABELS = /** @type {const} */ ({
  summarize: '总',
  explainConcepts: '概',
  critique: '质',
  translate: '翻',
});

/**
 * 初始化顶栏存档按钮。幂等。
 */
export function initArchiveButton() {
  const btn = document.getElementById('btn-archive');
  if (!btn) {
    console.warn('[archiveDialog] 找不到 #btn-archive');
    return;
  }

  btn.addEventListener('click', () => openArchiveDialog());

  // 订阅 store：无内容时禁用
  const update = () => {
    /** @type {HTMLButtonElement} */ (btn).disabled = !hasContent();
  };
  subscribe(update);
  update();
}

// ---- 对话框 ----

let dialogRoot = null;
/** @type {((e: KeyboardEvent) => void) | null} */
let dialogEscHandler = null;

/**
 * 打开存档管理对话框。
 */
function openArchiveDialog() {
  closeDialog();

  const overlay = document.createElement('div');
  overlay.className = 'archive-dialog-overlay';
  overlay.innerHTML = `
    <div class="archive-dialog">
      <div class="archive-dialog__header">
        <h3>存档管理</h3>
        <button type="button" class="archive-dialog__close" data-action="archive-close">&times;</button>
      </div>
      <div class="archive-dialog__body">
        <div class="archive-dialog__save-section">
          <button type="button" class="ai-btn ai-btn--primary" data-action="archive-save">
            📥 保存当前
          </button>
        </div>
        <div class="archive-dialog__divider">历史存档</div>
        <div class="archive-dialog__list" data-archive-list>
          <div class="archive-dialog__empty">加载中…</div>
        </div>
      </div>
      <div class="archive-dialog__footer">
        <button type="button" class="ai-btn ai-btn--ghost" data-action="archive-import">
          📤 导入 .json
        </button>
        <input type="file" accept=".json" data-archive-file-input hidden>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  dialogRoot = overlay;

  bindDialogEvents(overlay);
  refreshList();
}

function closeDialog() {
  if (dialogEscHandler) {
    document.removeEventListener('keydown', dialogEscHandler);
    dialogEscHandler = null;
  }
  if (dialogRoot) {
    dialogRoot.remove();
    dialogRoot = null;
  }
}

// ---- 事件绑定 ----

/**
 * @param {HTMLElement} overlay
 */
function bindDialogEvents(overlay) {
  // 关闭
  overlay.querySelector('[data-action="archive-close"]')?.addEventListener('click', closeDialog);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });
  dialogEscHandler = (e) => {
    if (e.key === 'Escape') closeDialog();
  };
  document.addEventListener('keydown', dialogEscHandler);

  // 保存当前
  overlay.querySelector('[data-action="archive-save"]')?.addEventListener('click', async () => {
    const btn = /** @type {HTMLButtonElement} */ (overlay.querySelector('[data-action="archive-save"]'));
    if (!hasContent()) return;
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      await archiveCurrent();
      await refreshList();
    } catch (err) {
      alert(`存档失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      btn.disabled = !hasContent();
      btn.textContent = '📥 保存当前';
    }
  });

  // 导入
  overlay.querySelector('[data-action="archive-import"]')?.addEventListener('click', () => {
    const input = /** @type {HTMLInputElement} */ (overlay.querySelector('[data-archive-file-input]'));
    input.value = '';
    input.click();
  });

  const fileInput = /** @type {HTMLInputElement} */ (overlay.querySelector('[data-archive-file-input]'));
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      await importArchive(file);
      await refreshList();
    } catch (err) {
      alert(`导入失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
  });

  // 刷新列表时重新绑定每项的 action（事件委托）
  overlay.querySelector('[data-archive-list]')?.addEventListener('click', async (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const btn = target.closest('button');
    if (!btn) return;

    const action = btn.dataset.action;
    const idStr = btn.dataset.archiveId;
    if (!idStr) return;
    const id = Number(idStr);

    if (action === 'archive-restore') {
      if (!confirm('恢复存档将替换当前会话中的论文信息和 AI 结果（对话记录也会被替换）。确定继续？')) return;
      try {
        const record = await db.getArchive(id);
        if (record) {
          restoreArchive(record);
          closeDialog();
        }
      } catch (err) {
        alert(`恢复失败：${err instanceof Error ? err.message : '未知错误'}`);
      }
    } else if (action === 'archive-export') {
      try {
        const record = await db.getArchive(id);
        if (record) exportArchive(record);
      } catch (err) {
        alert(`导出失败：${err instanceof Error ? err.message : '未知错误'}`);
      }
    } else if (action === 'archive-delete') {
      if (!confirm('确定删除这条存档？此操作不可撤销。')) return;
      try {
        await db.deleteArchive(id);
        await refreshList();
      } catch (err) {
        alert(`删除失败：${err instanceof Error ? err.message : '未知错误'}`);
      }
    }
  });
}

// ---- 列表渲染 ----

async function refreshList() {
  if (!dialogRoot) return;
  const listEl = dialogRoot.querySelector('[data-archive-list]');
  if (!listEl) return;

  // 同步保存按钮状态
  const saveBtn = /** @type {HTMLButtonElement} */ (dialogRoot.querySelector('[data-action="archive-save"]'));
  if (saveBtn) {
    saveBtn.disabled = !hasContent();
  }

  try {
    const archives = await db.listArchives();
    if (archives.length === 0) {
      listEl.innerHTML = '<div class="archive-dialog__empty">暂无存档记录</div>';
      return;
    }

    listEl.innerHTML = archives.map((rec) => {
      const time = formatTime(rec.createdAt);
      const indicators = buildIndicators(rec);
      return `
        <div class="archive-item">
          <div class="archive-item__info">
            <div class="archive-item__title">📄 ${escapeHtml(rec.title)}</div>
            <div class="archive-item__meta">
              <span class="archive-item__indicators">${indicators}</span>
              <span class="archive-item__time">${time}</span>
            </div>
          </div>
          <div class="archive-item__actions">
            <button type="button" class="ai-btn ai-btn--ghost archive-item__btn"
              data-action="archive-restore" data-archive-id="${rec.id}">恢复</button>
            <button type="button" class="ai-btn ai-btn--ghost archive-item__btn"
              data-action="archive-export" data-archive-id="${rec.id}">导出</button>
            <button type="button" class="ai-btn ai-btn--ghost archive-item__btn archive-item__btn--danger"
              data-action="archive-delete" data-archive-id="${rec.id}">删除</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    listEl.innerHTML = `<div class="archive-dialog__empty" style="color:#c53030">
      加载失败：${err instanceof Error ? escapeHtml(err.message) : '未知错误'}</div>`;
  }
}

// ---- 工具 ----

/**
 * 构建内容类型指标字符串。
 * @param {import('../archive/manager.js').ArchiveRecord} rec
 * @returns {string}
 */
function buildIndicators(rec) {
  const sr = rec.savedResults || {};
  const parts = [];
  for (const [key, label] of Object.entries(TYPE_LABELS)) {
    const has = typeof sr[key] === 'string' && sr[key].trim();
    parts.push(`<span class="archive-indicator ${has ? 'archive-indicator--on' : ''}">${label}${has ? '✓' : '-'}</span>`);
  }
  const hasChat = Array.isArray(rec.messages) && rec.messages.length > 0;
  parts.push(`<span class="archive-indicator ${hasChat ? 'archive-indicator--on' : ''}">对${hasChat ? '✓' : '-'}</span>`);
  return parts.join(' ');
}

/**
 * ISO 时间戳 → 友好的本地时间字符串。
 * @param {string} iso
 * @returns {string}
 */
function formatTime(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
