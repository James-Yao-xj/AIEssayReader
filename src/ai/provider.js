/* =========================================================
 * src/ai/provider.js
 *
 * Provider 抽象接口（JS 无接口，仅 JSDoc 定义形状）。
 * 所有 provider 实现必须符合下列契约。新增 Anthropic、Azure 等只需
 * 增加一个实现文件，UI/client.js 不需要改。
 *
 * 契约见 design.md §5 provider 接口。
 * ========================================================= */

/**
 * @typedef {Object} ProviderConfig
 * @property {string} baseUrl    接口根地址，如 https://api.openai.com/v1（末尾斜杠无所谓）
 * @property {string} apiKey     Bearer token
 * @property {string} model      模型名
 * @property {number} temperature 取样温度
 */

/**
 * @typedef {{ role: 'system' | 'user' | 'assistant', content: string }} OpenAiMessage
 */

/**
 * @typedef {Object} Provider
 * @property {(messages: OpenAiMessage[], opts?: { signal?: AbortSignal }) => AsyncIterable<string>} chat
 *           流式：yield 每个 token 片段（字符串）。
 * @property {(messages: OpenAiMessage[], opts?: { signal?: AbortSignal }) => Promise<string>} chatOnce
 *           非流式：聚合 chat 的所有片段，返回完整字符串。
 */

/**
 * 工厂签名（仅 JSDoc，无具体实现）。
 * 实现者必须返回符合 Provider 形状的对象。
 *
 * @param {ProviderConfig} _config
 * @returns {Provider}
 */
export function createProvider(_config) {
  throw new Error(
    'provider.createProvider 是接口占位，请使用具体实现（如 ai/openai.js）。',
  );
}
