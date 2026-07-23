/* =========================================================
 * src/ui/settings.js
 *
 * 设置面板（modal），双标签页结构：
 *   Tab 1 "基本设置" — 两组模型配置以"摘要卡片"呈现，点"配置"按钮后从右侧
 *                      滑入抽屉填写（Base URL / API Key / 模型 / 温度）；
 *                      "显示设置"（字号）保持简单内联 fieldset
 *   Tab 2 "提示词模板" — 4 个可编辑任务提示词 textarea
 *
 * - 保存 → store.setState({settings}) + storage.saveSettings()
 * - 打开/关闭：openSettings() / closeSettings()；Esc、点遮罩、点取消都可关闭
 * - API Key 已配置时占位提示"已配置（留空则不修改）"，绝不在 input 里回填明文
 * - 提示词模板：用户自定义优先，无自定义时用 prompts.js 默认值填充
 * - 每个 textarea 可"恢复默认"（从 prompts.js 内置模板回填）
 *
 * 暴露：initSettings()（创建 DOM、绑定事件）、openSettings()、closeSettings()
 * ========================================================= */

import { getState, setState } from '../state/store.js';
import { saveSettings } from '../config/storage.js';
import {
  SUMMARIZE,
  EXPLAIN_CONCEPTS,
  CRITIQUE,
  CHAT,
} from '../ai/prompts.js';
import { renderMarkdown } from './render.js';

/** 默认模板映射，用于"恢复默认"按钮和 textarea 初始值 */
const DEFAULT_TEMPLATES = /** @type {const} */ ({
  promptSummarize: SUMMARIZE,
  promptExplainConcepts: EXPLAIN_CONCEPTS,
  promptCritique: CRITIQUE,
  promptChat: CHAT,
});

/** @type {HTMLDivElement | null} */
let modalEl = null;
/** @type {HTMLFormElement | null} */
let formEl = null;
/**
 * 当前打开的抽屉对应的模型组；null 表示抽屉关闭（卡片态）。
 * @type {'recognition' | 'reading' | null}
 */
let drawerModel = null;

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
        <button type="button" class="settings-modal__close" data-close aria-label="关闭设置">&times;</button>
      </div>

      <div class="settings-modal__tabs">
        <button type="button" class="settings-modal__tab settings-modal__tab--active" data-tab="basic">基本设置</button>
        <button type="button" class="settings-modal__tab" data-tab="prompts">提示词模板</button>
      </div>

      <form class="settings-modal__form" id="settings-form" novalidate>

        <div class="settings-modal__tab-content" data-tab-content="basic">
          <div class="settings-basic">
            <!-- 抽屉打开时盖在卡片列表上的遮罩，点击即关抽屉 -->
            <div class="settings-basic__scrim" data-close-drawer></div>

            <!-- 摘要卡片列表 -->
            <div class="settings-basic__list">
              <!-- 文本识别模型 摘要卡片 -->
              <div class="settings-card settings-card--recognition" data-model-card="recognition">
                <div class="settings-card__head">
                  <span class="settings-card__title">文本识别模型</span>
                  <span class="settings-card__status is-unconfigured" data-card-status="recognition">未配置</span>
                </div>
                <div class="settings-card__meta">模型：<span data-card-model="recognition">未设置</span></div>
                <button type="button" class="settings-card__config" data-open-drawer="recognition">配置</button>
              </div>

              <!-- 文本阅读模型 摘要卡片 -->
              <div class="settings-card settings-card--reading" data-model-card="reading">
                <div class="settings-card__head">
                  <span class="settings-card__title">文本阅读模型</span>
                  <span class="settings-card__status is-unconfigured" data-card-status="reading">未配置</span>
                </div>
                <div class="settings-card__meta">模型：<span data-card-model="reading">未设置</span></div>
                <button type="button" class="settings-card__config" data-open-drawer="reading">配置</button>
              </div>

              <!-- 显示设置：保持简单内联 fieldset（仅去 Emoji） -->
              <fieldset class="settings-fieldset settings-fieldset--display">
                <legend class="settings-fieldset__legend">显示设置</legend>
                <p class="settings-fieldset__desc">调整阅读区域的字体大小。</p>
                <label class="settings-field">
                  <span class="settings-field__label">正文字号 (px)</span>
                  <input type="number" name="fontSize" min="12" max="24" step="1" value="14" />
                  <span class="settings-field__hint">12~24px，控制中栏文本和 AI 面板的字体大小。</span>
                </label>
              </fieldset>
            </div>

            <!-- 右侧滑入抽屉：两组模型字段都渲染在此 form 内，按当前抽屉只显示一组 -->
            <div class="settings-basic__drawer" aria-hidden="true">
              <div class="settings-basic__drawer-inner">
                <div class="settings-basic__drawer-header">
                  <button type="button" class="settings-basic__drawer-back" data-close-drawer aria-label="返回">←</button>
                  <span data-drawer-title>配置：文本识别模型</span>
                  <span></span>
                </div>
                <div class="settings-basic__drawer-body">
                  <!-- 文本识别模型 字段组 -->
                  <fieldset class="settings-fieldset settings-fieldset--recognition settings-drawer-group" data-model-fields="recognition">
                    <p class="settings-fieldset__desc">用于 AI 视觉识别，将 PDF 页面转为文字。需支持图片输入的视觉模型。</p>

                    <label class="settings-field">
                      <span class="settings-field__label">Base URL</span>
                      <input type="url" name="recognition.baseUrl" placeholder="https://api.openai.com/v1" />
                      <span class="settings-field__hint">OpenAI 兼容接口根地址。末尾斜杠会自动去掉。</span>
                    </label>

                    <label class="settings-field">
                      <span class="settings-field__label">API Key</span>
                      <input type="password" name="recognition.apiKey" placeholder="sk-..." autocomplete="off" spellcheck="false" />
                      <span class="settings-field__hint">仅保存在本地浏览器 localStorage。已配置时本框留空即不修改，绝不在界面回显明文。</span>
                    </label>

                    <label class="settings-field">
                      <span class="settings-field__label">模型</span>
                      <input type="text" name="recognition.model" placeholder="gpt-4o-mini" />
                    </label>

                    <label class="settings-field">
                      <span class="settings-field__label">温度</span>
                      <input type="number" name="recognition.temperature" min="0" max="2" step="0.1" value="0.3" />
                      <span class="settings-field__hint">OCR 识别始终使用温度 0 以保证转写一致性，此处仅作默认占位。</span>
                    </label>
                  </fieldset>

                  <!-- 文本阅读模型 字段组 -->
                  <fieldset class="settings-fieldset settings-fieldset--reading settings-drawer-group" data-model-fields="reading" hidden>
                    <p class="settings-fieldset__desc">用于论文总结、概念解释、批判分析和对话。需强推理能力的模型。</p>

                    <label class="settings-field">
                      <span class="settings-field__label">Base URL</span>
                      <input type="url" name="reading.baseUrl" placeholder="https://api.openai.com/v1" />
                      <span class="settings-field__hint">OpenAI 兼容接口根地址。末尾斜杠会自动去掉。</span>
                    </label>

                    <label class="settings-field">
                      <span class="settings-field__label">API Key</span>
                      <input type="password" name="reading.apiKey" placeholder="sk-..." autocomplete="off" spellcheck="false" />
                      <span class="settings-field__hint">仅保存在本地浏览器 localStorage。已配置时本框留空即不修改，绝不在界面回显明文。</span>
                    </label>

                    <label class="settings-field">
                      <span class="settings-field__label">模型</span>
                      <input type="text" name="reading.model" placeholder="gpt-4o-mini" />
                    </label>

                    <label class="settings-field">
                      <span class="settings-field__label">温度</span>
                      <input type="number" name="reading.temperature" min="0" max="2" step="0.1" value="0.3" />
                      <span class="settings-field__hint">0 更确定，1+ 更发散。结构化分析任务建议 0.2~0.4。</span>
                    </label>
                  </fieldset>
                </div>
                <div class="settings-basic__drawer-actions">
                  <button type="button" data-close-drawer>返回</button>
                  <button type="submit" class="primary">保存</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="settings-modal__tab-content settings-modal__tab-content--prompts" data-tab-content="prompts" hidden>
          <p class="settings-field__global-notice">平台级风格指令（慎用比喻、术语双重解释）为全局规则，不可修改。下方左侧编辑提示词模板，右侧实时预览渲染效果。</p>

          <div class="settings-field settings-field--prompt">
            <span class="settings-field__label">论文综述提示词</span>
            <div class="settings-field__prompt-row">
              <div class="settings-field__editor">
                <textarea name="promptSummarize" rows="12" spellcheck="false" data-prompt-textarea></textarea>
                <button type="button" class="settings-field__reset" data-target="promptSummarize">恢复默认</button>
              </div>
              <div class="settings-field__preview">
                <div class="settings-field__preview-head">预览</div>
                <div class="settings-field__preview-content md-body" data-preview="promptSummarize"></div>
              </div>
            </div>
          </div>

          <div class="settings-field settings-field--prompt">
            <span class="settings-field__label">概念解释提示词</span>
            <div class="settings-field__prompt-row">
              <div class="settings-field__editor">
                <textarea name="promptExplainConcepts" rows="12" spellcheck="false" data-prompt-textarea></textarea>
                <button type="button" class="settings-field__reset" data-target="promptExplainConcepts">恢复默认</button>
              </div>
              <div class="settings-field__preview">
                <div class="settings-field__preview-head">预览</div>
                <div class="settings-field__preview-content md-body" data-preview="promptExplainConcepts"></div>
              </div>
            </div>
          </div>

          <div class="settings-field settings-field--prompt">
            <span class="settings-field__label">批判质疑提示词</span>
            <div class="settings-field__prompt-row">
              <div class="settings-field__editor">
                <textarea name="promptCritique" rows="12" spellcheck="false" data-prompt-textarea></textarea>
                <button type="button" class="settings-field__reset" data-target="promptCritique">恢复默认</button>
              </div>
              <div class="settings-field__preview">
                <div class="settings-field__preview-head">预览</div>
                <div class="settings-field__preview-content md-body" data-preview="promptCritique"></div>
              </div>
            </div>
          </div>

          <div class="settings-field settings-field--prompt">
            <span class="settings-field__label">对话提示词</span>
            <div class="settings-field__prompt-row">
              <div class="settings-field__editor">
                <textarea name="promptChat" rows="12" spellcheck="false" data-prompt-textarea></textarea>
                <button type="button" class="settings-field__reset" data-target="promptChat">恢复默认</button>
              </div>
              <div class="settings-field__preview">
                <div class="settings-field__preview-head">预览</div>
                <div class="settings-field__preview-content md-body" data-preview="promptChat"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="settings-modal__error" id="settings-error" hidden></div>

        <div class="settings-modal__actions">
          <button type="button" data-close>取消</button>
          <button type="submit" class="primary">保存</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modalEl);

  // 遮罩 / 关闭按钮 / 取消按钮 → 关闭
  modalEl.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.hasAttribute('data-close')) closeSettings();
  });

  // 标签页切换
  const tabButtons = modalEl.querySelectorAll('.settings-modal__tab');
  const tabContents = modalEl.querySelectorAll('.settings-modal__tab-content');
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabName = btn.getAttribute('data-tab');
      tabButtons.forEach((b) => b.classList.remove('settings-modal__tab--active'));
      btn.classList.add('settings-modal__tab--active');
      tabContents.forEach((c) => {
        c.hidden = c.getAttribute('data-tab-content') !== tabName;
      });
      // 切换标签页时收起抽屉，避免 is-drawer-open 残留在已隐藏的 basic 区
      // 干扰 Esc 行为（否则在 prompts tab 上按 Esc 会先空转关一次抽屉）。
      closeDrawer();
    });
  });

  // 抽屉：打开 / 关闭（事件委托）
  modalEl.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    // 点 scrim 关抽屉（scrim 自身带 data-close-drawer，会被下面的分支捕获）
    const openBtn = target.closest('[data-open-drawer]');
    if (openBtn) {
      const m = openBtn.getAttribute('data-open-drawer');
      if (m === 'recognition' || m === 'reading') openDrawer(m);
      return;
    }
    if (target.closest('[data-close-drawer]')) {
      closeDrawer();
    }
  });

  // "恢复默认"按钮（事件委托）
  modalEl.addEventListener('click', (e) => {
    const resetBtn = /** @type {HTMLElement} */ (e.target).closest('.settings-field__reset');
    if (!resetBtn) return;
    const targetName = resetBtn.getAttribute('data-target');
    if (!targetName || !formEl) return;
    const textarea = formEl.querySelector(`textarea[name="${targetName}"]`);
    const defaultValue = DEFAULT_TEMPLATES[/** @type {keyof typeof DEFAULT_TEMPLATES} */ (targetName)];
    if (textarea instanceof HTMLTextAreaElement && defaultValue) {
      textarea.value = defaultValue;
      // 恢复默认后更新预览
      updatePreview(targetName, defaultValue);
    }
  });

  // 提示词 textarea 实时预览（防抖 300ms）
  /** @type {Record<string, number>} */
  const previewTimers = {};
  const promptTabContent = modalEl.querySelector('[data-tab-content="prompts"]');
  if (promptTabContent) {
    promptTabContent.addEventListener('input', (e) => {
      const textarea = /** @type {HTMLElement} */ (e.target).closest('textarea[data-prompt-textarea]');
      if (!(textarea instanceof HTMLTextAreaElement)) return;
      const name = textarea.getAttribute('name');
      if (!name) return;
      // 防抖
      if (previewTimers[name]) clearTimeout(previewTimers[name]);
      previewTimers[name] = window.setTimeout(() => {
        updatePreview(name, textarea.value);
      }, 300);
    });
  }

  formEl = /** @type {HTMLFormElement} */ (
    modalEl.querySelector('#settings-form')
  );
  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    void save();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !modalEl || modalEl.hidden) return;
    // 抽屉打开时 Esc 只关抽屉，不关整个面板
    const basic = modalEl.querySelector('.settings-basic');
    if (basic instanceof HTMLElement && basic.classList.contains('is-drawer-open')) {
      closeDrawer();
      return;
    }
    closeSettings();
  });
}

/**
 * 打开设置面板。会用当前 store.settings 初始化各字段；
 * apiKey 永远不回填明文（已配置时占位提示"已配置（留空则不修改）"）。
 * 提示词优先使用用户自定义值，无自定义时用 prompts.js 默认值。
 */
export function openSettings() {
  if (!modalEl) initSettings();
  syncFormFromStore();
  refreshAllPreviews();
  showError('');
  // 重置到第一个 tab
  resetToFirstTab();
  // 每次打开都回到卡片态（关抽屉），并刷新摘要卡片
  closeDrawer();
  renderSummaryCards();
  modalEl.hidden = false;
  // 卡片态下首字段在抽屉内（屏幕外），改为聚焦第一张卡片的"配置"按钮作为主入口
  setTimeout(() => {
    const firstConfig = modalEl?.querySelector('.settings-card__config');
    if (firstConfig instanceof HTMLElement) firstConfig.focus();
  }, 0);
}

/** 关闭设置面板。 */
export function closeSettings() {
  if (modalEl) modalEl.hidden = true;
}

/**
 * 把当前 store.settings 同步到表单。
 * - 模型配置从 settings.recognition / settings.reading 读取
 * - apiKey 永远置空，靠 placeholder 提示
 * - 提示词 textarea：用户自定义值优先，否则用 prompts.js 默认值
 */
function syncFormFromStore() {
  if (!formEl) return;
  const { settings } = getState();

  // ---- 文本识别模型 ----
  const rec = settings.recognition || {};
  setFieldValue('recognition.baseUrl', rec.baseUrl || '');
  setFieldValue('recognition.model', rec.model || '');
  setFieldValue('recognition.temperature', String(rec.temperature ?? 0.3));
  // API Key 永不回显明文
  syncApiKeyField('recognition.apiKey', rec.apiKey);

  // ---- 文本阅读模型 ----
  const rd = settings.reading || {};
  setFieldValue('reading.baseUrl', rd.baseUrl || '');
  setFieldValue('reading.model', rd.model || '');
  setFieldValue('reading.temperature', String(rd.temperature ?? 0.3));
  // API Key 永不回显明文
  syncApiKeyField('reading.apiKey', rd.apiKey);

  // 字体大小
  setFieldValue('fontSize', String(settings.fontSize ?? 14));

  // 提示词模板：自定义优先，无自定义则用默认值填充
  setFieldValue('promptSummarize', settings.promptSummarize || DEFAULT_TEMPLATES.promptSummarize);
  setFieldValue('promptExplainConcepts', settings.promptExplainConcepts || DEFAULT_TEMPLATES.promptExplainConcepts);
  setFieldValue('promptCritique', settings.promptCritique || DEFAULT_TEMPLATES.promptCritique);
  setFieldValue('promptChat', settings.promptChat || DEFAULT_TEMPLATES.promptChat);

  console.warn('[Config:Sync] store → form fields', {
    recognition: { model: rec.model, baseUrl: rec.baseUrl, keyLen: rec.apiKey?.length || 0 },
    reading: { model: rd.model, baseUrl: rd.baseUrl, keyLen: rd.apiKey?.length || 0 },
  });
}

/**
 * 同步单个 apiKey 输入框：值永远置空，placeholder 根据是否已配置决定。
 * @param {string} name - 表单字段名（如 "recognition.apiKey"）
 * @param {string|undefined} storedKey - localStorage 中的 apiKey 值
 */
function syncApiKeyField(name, storedKey) {
  if (!formEl) return;
  const input = /** @type {HTMLInputElement} */ (
    formEl.elements.namedItem(name)
  );
  if (!input) return;
  input.value = '';
  input.placeholder = storedKey
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
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.value = value;
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

/**
 * 更新指定提示词的实时预览。
 * @param {string} name textarea 的 name 属性
 * @param {string} markdown 原始 markdown 文本
 */
function updatePreview(name, markdown) {
  if (!modalEl) return;
  const previewEl = modalEl.querySelector(`[data-preview="${name}"]`);
  if (previewEl instanceof HTMLElement) {
    renderMarkdown(previewEl, markdown);
  }
}

/**
 * 刷新所有提示词的预览（在 openSettings 时调用）。
 */
function refreshAllPreviews() {
  if (!formEl) return;
  const textareas = formEl.querySelectorAll('textarea[data-prompt-textarea]');
  textareas.forEach((ta) => {
    if (ta instanceof HTMLTextAreaElement) {
      updatePreview(ta.name, ta.value);
    }
  });
}

/** 重置标签页到第一个（基本设置）。 */
function resetToFirstTab() {
  if (!modalEl) return;
  const tabButtons = modalEl.querySelectorAll('.settings-modal__tab');
  const tabContents = modalEl.querySelectorAll('.settings-modal__tab-content');
  tabButtons.forEach((b) => b.classList.remove('settings-modal__tab--active'));
  tabContents.forEach((c) => { c.hidden = true; });

  const firstTab = modalEl.querySelector('.settings-modal__tab[data-tab="basic"]');
  const firstContent = modalEl.querySelector('.settings-modal__tab-content[data-tab-content="basic"]');
  if (firstTab instanceof HTMLElement) firstTab.classList.add('settings-modal__tab--active');
  if (firstContent instanceof HTMLElement) firstContent.hidden = false;
}

/** 模型组 → 卡片标题与抽屉标题文案映射。 */
const MODEL_LABELS = /** @type {const} */ ({
  recognition: '文本识别模型',
  reading: '文本阅读模型',
});

/**
 * 打开右侧滑入抽屉并显示指定模型组的字段。
 * - 切换两组 data-model-fields 显隐（只显示对应模型组）
 * - 设置抽屉标题
 * - 加 is-drawer-open class 触发 CSS 滑入；aria-hidden=false
 * - 聚焦首字段
 * @param {'recognition'|'reading'} model
 */
function openDrawer(model) {
  if (!modalEl) return;
  drawerModel = model;

  // 只显示对应模型组的字段
  const groups = modalEl.querySelectorAll('.settings-drawer-group');
  groups.forEach((fs) => {
    const m = fs.getAttribute('data-model-fields');
    if (fs instanceof HTMLFieldSetElement) fs.hidden = m !== model;
  });

  // 抽屉标题
  const titleEl = modalEl.querySelector('[data-drawer-title]');
  if (titleEl instanceof HTMLElement) {
    titleEl.textContent = `配置：${MODEL_LABELS[model]}`;
  }

  // 触发滑入
  const basic = modalEl.querySelector('.settings-basic');
  if (basic instanceof HTMLElement) basic.classList.add('is-drawer-open');
  const drawer = modalEl.querySelector('.settings-basic__drawer');
  if (drawer instanceof HTMLElement) drawer.setAttribute('aria-hidden', 'false');

  // 聚焦首字段
  setTimeout(() => {
    const firstInput = modalEl?.querySelector(
      `.settings-drawer-group[data-model-fields="${model}"] input`,
    );
    if (firstInput instanceof HTMLInputElement) firstInput.focus();
  }, 0);
}

/**
 * 关闭右侧滑入抽屉，回到摘要卡片态。
 * 不丢弃已填值（字段仍在同一 form 内）。
 */
function closeDrawer() {
  if (!modalEl) return;
  drawerModel = null;
  const basic = modalEl.querySelector('.settings-basic');
  if (basic instanceof HTMLElement) basic.classList.remove('is-drawer-open');
  const drawer = modalEl.querySelector('.settings-basic__drawer');
  if (drawer instanceof HTMLElement) drawer.setAttribute('aria-hidden', 'true');
}

/**
 * 刷新两张摘要卡片：模型名 + API Key 配置状态。
 * 读 getState().settings，分别填 recognition / reading。
 * 已配置 → 成功色；未配置 → 警示色。
 */
function renderSummaryCards() {
  if (!modalEl) return;
  const { settings } = getState();
  /** @type {Array<'recognition'|'reading'>} */
  const models = ['recognition', 'reading'];
  for (const m of models) {
    const cfg = settings[m] || {};
    const modelEl = modalEl.querySelector(`[data-card-model="${m}"]`);
    if (modelEl instanceof HTMLElement) {
      modelEl.textContent = cfg.model || '未设置';
    }
    const statusEl = modalEl.querySelector(`[data-card-status="${m}"]`);
    if (statusEl instanceof HTMLElement) {
      const configured = Boolean(cfg.apiKey);
      statusEl.textContent = configured ? '已配置' : '未配置';
      statusEl.classList.toggle('is-configured', configured);
      statusEl.classList.toggle('is-unconfigured', !configured);
    }
  }
}

/**
 * 从 FormData 中收集单个模型配置组（recognition 或 reading）。
 * @param {FormData} fd
 * @param {'recognition'|'reading'} prefix
 * @returns {{ baseUrl: string, apiKey: string, model: string, temperature: number }}
 */
function collectModelConfig(fd, prefix) {
  const baseUrl = String(fd.get(`${prefix}.baseUrl`) || '').trim();
  const apiKeyRaw = String(fd.get(`${prefix}.apiKey`) || '');
  const model = String(fd.get(`${prefix}.model`) || '').trim();
  const temperatureRaw = String(fd.get(`${prefix}.temperature`) || '').trim();

  return {
    baseUrl,
    apiKey: apiKeyRaw.trim(),
    model,
    temperature: Number(temperatureRaw),
  };
}

/**
 * 校验单个模型配置组的 temperature 范围。
 * @param {{ temperature: number }} cfg
 * @returns {string|null} 错误消息，null 表示通过
 */
function validateTemperature(cfg) {
  if (!Number.isFinite(cfg.temperature) || cfg.temperature < 0 || cfg.temperature > 2) {
    return '温度需为 0~2 之间的数字。';
  }
  return null;
}

/** 校验 + 收集 + 保存。 */
async function save() {
  if (!formEl) return;
  const fd = new FormData(formEl);

  // 收集两组模型配置
  const recCfg = collectModelConfig(fd, 'recognition');
  const readCfg = collectModelConfig(fd, 'reading');

  // 提示词模板：trim 后保存；纯空白视为"使用内置默认"
  const promptSummarize = String(fd.get('promptSummarize') || '').trim();
  const promptExplainConcepts = String(fd.get('promptExplainConcepts') || '').trim();
  const promptCritique = String(fd.get('promptCritique') || '').trim();
  const promptChat = String(fd.get('promptChat') || '').trim();

  // 字体大小
  const fontSizeRaw = String(fd.get('fontSize') || '').trim();
  const fontSize = Number(fontSizeRaw);

  // 温度范围校验（两组各自校验）
  const recTempErr = validateTemperature(recCfg);
  if (recTempErr) {
    showError(`文本识别模型：${recTempErr}`);
    return;
  }
  const readTempErr = validateTemperature(readCfg);
  if (readTempErr) {
    showError(`文本阅读模型：${readTempErr}`);
    return;
  }

  // 字体大小范围校验
  if (!Number.isFinite(fontSize) || fontSize < 12 || fontSize > 24 || !Number.isInteger(fontSize)) {
    showError('正文字号需为 12~24 之间的整数。');
    return;
  }

  const current = getState().settings;
  const currentRec = current.recognition || {};
  const currentReading = current.reading || {};

  // 两组 apiKey 各自独立判断：留空则保留原值
  /** @type {import('../config/defaults.js').ModelConfig} */
  const recognition = {
    baseUrl: recCfg.baseUrl,
    apiKey: recCfg.apiKey ? recCfg.apiKey : currentRec.apiKey || '',
    model: recCfg.model,
    temperature: recCfg.temperature,
  };

  /** @type {import('../config/defaults.js').ModelConfig} */
  const reading = {
    baseUrl: readCfg.baseUrl,
    apiKey: readCfg.apiKey ? readCfg.apiKey : currentReading.apiKey || '',
    model: readCfg.model,
    temperature: readCfg.temperature,
  };

  /** @type {import('../config/defaults.js').Settings} */
  const newSettings = {
    recognition,
    reading,
    fontSize,
    promptSummarize,
    promptExplainConcepts,
    promptCritique,
    promptChat,
  };

  console.warn('[Config:Save] form → store', {
    recognition: { model: recognition.model, baseUrl: recognition.baseUrl, keyLen: recognition.apiKey?.length || 0 },
    reading: { model: reading.model, baseUrl: reading.baseUrl, keyLen: reading.apiKey?.length || 0 },
  });

  const merged = saveSettings(newSettings);
  if (!merged) {
    showError('保存失败：localStorage 写入异常（可能是隐私模式或配额超限）。');
    return;
  }
  // 使用 deep-merge 后的结果更新 store，确保与 localStorage 完全一致
  setState({ settings: merged });
  showError('');
  closeSettings();
}
