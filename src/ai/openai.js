/* =========================================================
 * src/ai/openai.js
 *
 * OpenAI 兼容协议实现（provider 接口的默认实现）。
 * - 端点：${baseUrl去尾斜杠}/chat/completions
 * - 流式：stream:true，手工解析 SSE（按行读 `data:` 前缀）
 * - 取消：fetch 的 AbortSignal 透传
 * - 错误：非 2xx / 401 / 网络错 → 抛带语义 Error（含状态码与响应片段）
 *
 * 兼容：OpenAI / DeepSeek / OpenRouter / 本地 vLLM / Ollama(OpenAI 接口) 等。
 * ========================================================= */

/**
 * @param {import('./provider.js').ProviderConfig} config
 * @returns {import('./provider.js').Provider}
 */
export function createOpenAIProvider(config) {
  const baseUrl = String(config?.baseUrl || '').replace(/\/+$/, '');
  const apiKey = String(config?.apiKey || '');
  const model = String(config?.model || '');
  const temperature =
    typeof config?.temperature === 'number' ? config.temperature : 0.3;

  if (!baseUrl) {
    throw new Error('OpenAI provider：缺少 baseUrl。');
  }

  const endpoint = `${baseUrl}/chat/completions`;

  /**
   * 流式 chat。
   * @param {import('./provider.js').OpenAiMessage[]} messages
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {AsyncIterable<string>}
   */
  async function* chat(messages, opts) {
    const signal = opts?.signal;

    /** @type {Response} */
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          stream: true,
        }),
        signal,
      });
    } catch (err) {
      // 区分用户主动取消 vs 网络错误
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new Error(
        `无法连接到 AI 服务（网络错误）：${err instanceof Error ? err.message : String(err)}。请检查 Base URL 与网络。`,
      );
    }

    if (!res.ok) {
      const text = await safeReadText(res);
      throw makeError(res.status, text);
    }
    if (!res.body) {
      throw new Error('AI 服务响应没有 body（流式响应不可用）。');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        let chunk;
        try {
          const r = await reader.read();
          chunk = r;
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') throw err;
          throw new Error(
            `读取流式响应失败：${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const { done, value } = chunk;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // 按行处理 SSE
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          let line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          line = line.replace(/\r$/, '').trimEnd();
          if (!line) continue;
          // SSE 规范：data: 前缀（可有可无一个空格）
          if (!line.startsWith('data:')) {
            // 忽略 event:/id:/retry:/comment 等行
            continue;
          }
          const data = line.slice(5).trimStart();
          if (!data) continue;
          if (data === '[DONE]') return;
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            // 单行 JSON 解析失败不致命，跳过
            continue;
          }
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            yield delta;
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 非流式 chatOnce：基于 chat 聚合。
   * @param {import('./provider.js').OpenAiMessage[]} messages
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<string>}
   */
  async function chatOnce(messages, opts) {
    let full = '';
    for await (const piece of chat(messages, opts)) {
      full += piece;
    }
    return full;
  }

  return { chat, chatOnce };
}

// 给 client.js / 测试一个统一入口别名（与 provider.js 的 createProvider 同名）。
// 注意：openai.js 是 provider.js 接口的具体实现；client.js 默认从本文件 import。
export { createOpenAIProvider as createProvider };

// ---------- 内部工具 ----------

/**
 * @param {number} status
 * @param {string} bodyText
 */
function makeError(status, bodyText) {
  const snippet = (bodyText || '').slice(0, 500).trim();
  const tail = snippet ? ` 响应片段：${snippet}` : '';
  if (status === 401 || status === 403) {
    return new Error(
      `API Key 无效或未授权（HTTP ${status}）。请在设置面板检查 Key 与 Base URL。${tail}`,
    );
  }
  if (status === 404) {
    return new Error(
      `接口路径不存在（HTTP 404）。请检查 Base URL 是否正确（应类似 https://api.openai.com/v1，不要带 /chat/completions）。${tail}`,
    );
  }
  if (status === 429) {
    return new Error(
      `请求被限流（HTTP 429）。请稍后重试或检查账户额度。${tail}`,
    );
  }
  if (status >= 500) {
    return new Error(
      `AI 服务端错误（HTTP ${status}）。可稍后重试。${tail}`,
    );
  }
  return new Error(`AI 服务返回错误（HTTP ${status}）。${tail}`);
}

/**
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
