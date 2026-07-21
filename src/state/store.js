/* =========================================================
 * src/state/store.js
 *
 * 极简 pub/sub store。原生 ES Modules，无框架。
 * - 形状见 design.md §5 store 形状。
 * - setState 浅合并顶层字段（不深递归）。
 *   修改 messages 数组时请传一个新数组引用，触发订阅。
 * - 订阅回调出错时打印但不影响其他订阅者。
 * ========================================================= */

/**
 * @typedef {{
 *   role: 'user' | 'assistant',
 *   content: string,
 * }} ChatMessage
 *
 * @typedef {{
 *   name: string,
 *   meta: { title?: string, authors?: string[], nPages: number },
 *   fullText: string,
 *   pages: Array<{ pageNum: number, text: string }>,
 * }} Paper
 *
 * @typedef {{
 *   paper: Paper | null,
 *   settings: import('../config/defaults.js').Settings,
 *   messages: ChatMessage[],
 *   ui: { activeTab: 'summarize' | 'explainConcepts' | 'critique' | 'chat', busy: boolean, quickAsk: string | null },
 * }} State
 */

/** @type {State} */
let state = {
  paper: null,
  settings: {
    recognition: {
      baseUrl: '',
      apiKey: '',
      model: '',
      temperature: 0.3,
    },
    reading: {
      baseUrl: '',
      apiKey: '',
      model: '',
      temperature: 0.3,
    },
  },
  messages: [],
  ui: { activeTab: 'summarize', busy: false, quickAsk: null },
};

/** @type {Set<(s: State) => void>} */
const listeners = new Set();

/**
 * 取当前状态的快照（只读，不要直接修改其字段）。
 * @returns {State}
 */
export function getState() {
  return state;
}

/**
 * 浅合并顶层字段，触发所有订阅者。
 * 修改数组/对象字段时，请传新引用。
 * @param {Partial<State>} partial
 */
export function setState(partial) {
  state = { ...state, ...partial };
  notify();
}

/**
 * 订阅状态变化。返回取消订阅函数。
 * @param {(s: State) => void} fn
 * @returns {() => void}
 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify() {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (err) {
      console.error('[store] 订阅回调抛错：', err);
    }
  }
}
