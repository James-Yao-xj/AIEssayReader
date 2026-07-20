/* =========================================================
 * src/ui/settings.js
 *
 * 设置面板（modal）。
 * - 字段：Base URL / API Key（password，不回显明文）/ 模型 / 温度
 * - 保存 → store.setState({settings}) + storage.saveSettings()
 * - 打开/关闭：openSettings() / closeSettings()；Esc、点遮罩、点取消都可关闭
 * - API Key 已配置时占位提示"已配置（留空则不修改）"，绝不在 input 里回填明文
 *
 * 暴露：initSettings()（创建 DOM、绑定事件）、openSettings()、closeSettings()
 * ========================================================= */

import { getState, setState } from '../state/store.js';
import { saveSettings } from '../config/storage.js';

/** @type {HTMLDivElement | null} */
let modalEl = null;
/** @type {HTMLFormElement | null} */
let formEl = null;

/**
 * 初始化设置面板：创建 DOM、绑定事件。幂等，重复调用只生效一次。
 */
export function initSettings() {
  if (modalEl) return;
  modalEl = document.createElement('div');
  modalEl.className = 'settings-modal';
  modalEl.hidden = true;
  modalEl.innerHTML = `
    <div class="settings-modal__backdrop" data-close></div>
    <div class="settings-modal__panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div class="settings-modal__header">
        <h2 id="settings-title">设置</h2>
        <button type="button" class="settings-modal__close" data-close aria-label="关闭设置">×</button>
      </div>
      <form class="settings-modal__form" id="settings-form" novalidate>
        <label class="settings-field">
          <span class="settings-field__label">Base URL</span>
          <input type="url" name="baseUrl" placeholder="https://api.openai.com/v1" required />
          <span class="settings-field__hint">OpenAI 兼容接口根地址。OpenAI: https://api.openai.com/v1；DeepSeek: https://api.deepseek.com/v1；OpenRouter: https://openrouter.ai/api/v1。末尾斜杠会自动去掉。</span>
        </label>

        <label class="settings-field">
          <span class="settings-field__label">API Key</span>
          <input type="password" name="apiKey" placeholder="sk-..." autocomplete="off" spellcheck="false" />
          <span class="settings-field__hint">仅保存在本地浏览器 localStorage，刷新后仍保留。已配置时本框留空即不修改，绝不在界面回显明文。</span>
        </label>

        <label class="settings-field">
          <span class="settings-field__label">模型</span>
          <input type="text" name="model" placeholder="gpt-4o-mini" required />
        </label>

        <label class="settings-field">
          <span class="settings-field__label">温度</span>
          <input type="number" name="temperature" min="0" max="2" step="0.1" value="0.3" required />
          <span class="settings-field__hint">0 更确定，1+ 更发散。结构化分析任务建议 0.2~0.4。</span>
        </label>

        <div class="settings-modal__error" id="settings-error" hidden></div>

        <div class="settings-modal__actions">
          <button type="button" data-close>取消</button>
          <button type="submit" class="primary">保存</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modalEl);

  modalEl.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.hasAttribute('data-close')) closeSettings();
  });

  formEl = /** @type {HTMLFormElement} */ (
    modalEl.querySelector('#settings-form')
  );
  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    void save();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalEl && !modalEl.hidden) closeSettings();
  });
}

/**
 * 打开设置面板。会用当前 store.settings 初始化各字段；
 * apiKey 永远不回填明文（已配置时占位提示"已配置（留空则不修改）"）。
 */
export function openSettings() {
  if (!modalEl) initSettings();
  syncFormFromStore();
  showError('');
  modalEl.hidden = false;
  // 自动聚焦第一个空字段
  setTimeout(() => {
    const baseUrl = formEl?.elements.namedItem('baseUrl');
    if (baseUrl instanceof HTMLInputElement) baseUrl.focus();
  }, 0);
}

/** 关闭设置面板。 */
export function closeSettings() {
  if (modalEl) modalEl.hidden = true;
}

/**
 * 把当前 store.settings 同步到表单（apiKey 永远置空，靠 placeholder 提示）。
 */
function syncFormFromStore() {
  if (!formEl) return;
  const { settings } = getState();
  setFieldValue('baseUrl', settings.baseUrl || '');
  setFieldValue('model', settings.model || '');
  setFieldValue('temperature', String(settings.temperature ?? 0.3));
  // apiKey：永不回显明文
  const apiKeyInput = /** @type {HTMLInputElement} */ (
    formEl.elements.namedItem('apiKey')
  );
  apiKeyInput.value = '';
  apiKeyInput.placeholder = settings.apiKey
    ? '已配置（留空则不修改）'
    : 'sk-...';
}

/**
 * @param {string} name
 * @param {string} value
 */
function setFieldValue(name, value) {
  if (!formEl) return;
  const el = formEl.elements.namedItem(name);
  if (el instanceof HTMLInputElement) el.value = value;
}

/**
 * @param {string} msg 空串表示清除错误
 */
function showError(msg) {
  if (!modalEl) return;
  const errEl = modalEl.querySelector('#settings-error');
  if (!(errEl instanceof HTMLElement)) return;
  if (msg) {
    errEl.textContent = msg;
    errEl.hidden = false;
  } else {
    errEl.textContent = '';
    errEl.hidden = true;
  }
}

/** 校验 + 收集 + 保存。 */
async function save() {
  if (!formEl) return;
  const fd = new FormData(formEl);
  const baseUrl = String(fd.get('baseUrl') || '').trim();
  const model = String(fd.get('model') || '').trim();
  const temperatureRaw = String(fd.get('temperature') || '').trim();
  const apiKeyRaw = String(fd.get('apiKey') || '');

  if (!baseUrl) {
    showError('请填写 Base URL。');
    return;
  }
  if (!model) {
    showError('请填写模型名。');
    return;
  }
  const temperature = Number(temperatureRaw);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    showError('温度需为 0~2 之间的数字。');
    return;
  }

  const current = getState().settings;
  // apiKey：用户留空则保留原值，避免"打开面板就清空了 Key"
  const apiKey = apiKeyRaw.trim() ? apiKeyRaw.trim() : current.apiKey;

  /** @type {import('../config/defaults.js').Settings} */
  const newSettings = { baseUrl, apiKey, model, temperature };
  const ok = saveSettings(newSettings);
  if (!ok) {
    showError('保存失败：localStorage 写入异常（可能是隐私模式或配额超限）。');
    return;
  }
  setState({ settings: newSettings });
  showError('');
  closeSettings();
}
