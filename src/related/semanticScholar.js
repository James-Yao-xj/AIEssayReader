/* =========================================================
 * src/related/semanticScholar.js
 *
 * Semantic Scholar Graph API 客户端（论文检索 · 相关文献）。
 *
 * - 端点：https://api.semanticscholar.org/graph/v1
 * - 认证：可选 x-api-key（settings.s2ApiKey），缺省匿名（易 429）
 * - 限流：429 时指数退避重试（≤ retries 次），退避期间响应 AbortSignal
 * - 归一化：所有端点返回统一 Paper 形状，供 UI / 编排层消费
 * ========================================================= */

import { getState } from '../state/store.js';

const S2_BASE = 'https://api.semanticscholar.org/graph/v1';

/** 统一请求的论文字段（title/authors/venue/year/citationCount/摘要/链接/DOI/arXiv）。 */
const PAPER_FIELDS =
  'title,abstract,year,authors,venue,citationCount,externalIds,openAccessPdf,url';

/**
 * @typedef {{
 *   paperId: string|null,
 *   title: string,
 *   abstract: string,
 *   year: number|null,
 *   authors: string[],
 *   venue: string,
 *   citationCount: number,
 *   doi: string|null,
 *   arxiv: string|null,
 *   openAccessPdf: string|null,
 *   url: string|null,
 * }} Paper
 */

/**
 * 把 S2 原始 paper 对象归一化为统一形状。
 * @param {any} raw
 * @returns {Paper|null}
 */
function normalizePaper(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const authors = Array.isArray(raw.authors)
    ? raw.authors.map((a) => a?.name).filter(Boolean)
    : [];
  const doi = raw.externalIds?.DOI || null;
  const arxiv = raw.externalIds?.ArXiv || null;
  const url =
    (typeof raw.url === 'string' && raw.url) ||
    (doi ? `https://doi.org/${doi}` : null) ||
    (raw.paperId
      ? `https://www.semanticscholar.org/paper/${raw.paperId}`
      : null);
  return {
    paperId: raw.paperId || null,
    title: typeof raw.title === 'string' ? raw.title : '',
    abstract: typeof raw.abstract === 'string' ? raw.abstract : '',
    year: raw.year || null,
    authors,
    venue: typeof raw.venue === 'string' ? raw.venue : '',
    citationCount: raw.citationCount || 0,
    doi,
    arxiv,
    openAccessPdf: raw.openAccessPdf?.url || null,
    url,
  };
}

/**
 * 可中止的延时。abort 时以 AbortError 拒绝，避免退避期间无法取消。
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    }
  });
}

/**
 * 读取响应体文本（失败返回空串，绝不抛）。
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * 带认证 + 429 退避的 GET JSON 请求。
 * @param {string} path 以 / 开头的相对路径（含 query）
 * @param {{ signal?: AbortSignal, retries?: number }} [opts]
 * @returns {Promise<any>}
 */
async function fetchJson(path, opts) {
  const { signal, retries = 3 } = opts || {};
  const { settings } = getState();
  const key = (settings?.s2ApiKey || '').trim();
  const headers = { Accept: 'application/json' };
  if (key) headers['x-api-key'] = key;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    let res;
    try {
      res = await fetch(`${S2_BASE}${path}`, { headers, signal });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new Error(
        '无法访问 Semantic Scholar（网络或跨域限制）。请检查网络，或在设置中配置 S2 API Key。',
      );
    }

    if (res.status === 429) {
      if (attempt < retries) {
        await sleep(1200 * 2 ** attempt, signal);
        continue;
      }
      throw new Error(
        'Semantic Scholar 限流（HTTP 429）。请稍后重试，或在设置中配置 S2 API Key 以提升配额。',
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('Semantic Scholar API Key 无效（HTTP 401/403），请检查设置。');
    }
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(
        `Semantic Scholar 返回错误（HTTP ${res.status}）。${body.slice(0, 200)}`,
      );
    }
    return await res.json();
  }
  // 理论上不可达（循环内已抛），防御返回
  throw new Error('Semantic Scholar 请求失败。');
}

/**
 * 解析用户输入为检索标识类型。
 * @param {string} raw
 * @returns {{ type: 'paperId'|'doi'|'arxiv'|'title', value: string }}
 */
export function resolveInput(raw) {
  const s = String(raw || '').trim();

  // S2 论文链接 → paperId
  const s2m = s.match(/semanticscholar\.org\/paper\/([0-9a-f]{40})/i);
  if (s2m) return { type: 'paperId', value: s2m[1].toLowerCase() };

  // 纯 40 位十六进制 paperId
  if (/^[0-9a-f]{40}$/i.test(s)) {
    return { type: 'paperId', value: s.toLowerCase() };
  }

  // DOI
  const doiM = s.match(/doi\.org\/(.+)$/i);
  if (doiM) return { type: 'doi', value: doiM[1] };
  if (/^10\.\d{4,9}\//i.test(s)) return { type: 'doi', value: s };

  // arXiv
  const arxivM = s.match(
    /(?:arxiv\.org\/abs\/|arxiv:)(\d{4}\.\d{4,5}(?:v\d+)?)/i,
  );
  if (arxivM) return { type: 'arxiv', value: arxivM[1] };
  if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(s)) return { type: 'arxiv', value: s };

  // 其余按标题搜索
  return { type: 'title', value: s };
}

/**
 * 解析目标论文：把输入标识解析为一条具体的 S2 论文。
 * @param {string} input 用户输入（标题/DOI/arXiv/paperId/URL）
 * @param {AbortSignal} [signal]
 * @returns {Promise<Paper>}
 */
export async function resolvePaper(input, signal) {
  const { type, value } = resolveInput(input);
  let json;

  switch (type) {
    case 'paperId':
      json = await fetchJson(`/paper/${value}?fields=${PAPER_FIELDS}`, { signal });
      break;
    case 'doi':
      json = await fetchJson(`/paper/DOI:${value}?fields=${PAPER_FIELDS}`, { signal });
      break;
    case 'arxiv':
      json = await fetchJson(`/paper/arXiv:${value}?fields=${PAPER_FIELDS}`, { signal });
      break;
    default: {
      const q = encodeURIComponent(value);
      const res = await fetchJson(
        `/paper/search?query=${q}&fields=${PAPER_FIELDS}&limit=1`,
        { signal },
      );
      json = res?.data?.[0];
      if (!json) {
        throw new Error('未找到匹配论文，请核对标题/DOI/arXiv。');
      }
    }
  }

  const paper = normalizePaper(json);
  if (!paper || !paper.paperId) {
    throw new Error('未找到匹配论文，请核对标题/DOI/arXiv。');
  }
  return paper;
}

/**
 * 官方相似推荐（recommendations）。
 * @param {string} paperId
 * @param {AbortSignal} [signal]
 * @returns {Promise<Paper[]>}
 */
export async function getRecommendations(paperId, signal) {
  const res = await fetchJson(
    `/paper/${paperId}/recommendations?fields=${PAPER_FIELDS}&limit=10`,
    { signal },
  );
  return (res?.recommendedPapers || [])
    .map((p) => normalizePaper(p))
    .filter(Boolean);
}

/**
 * 参考文献（references，前人工作）。
 * @param {string} paperId
 * @param {AbortSignal} [signal]
 * @returns {Promise<Paper[]>}
 */
export async function getReferences(paperId, signal) {
  const res = await fetchJson(
    `/paper/${paperId}/references?fields=${PAPER_FIELDS}&limit=10`,
    { signal },
  );
  return (res?.data || [])
    .map((d) => normalizePaper(d?.citedPaper))
    .filter(Boolean);
}

/**
 * 被引论文（citations，后续工作）。
 * @param {string} paperId
 * @param {AbortSignal} [signal]
 * @returns {Promise<Paper[]>}
 */
export async function getCitations(paperId, signal) {
  const res = await fetchJson(
    `/paper/${paperId}/citations?fields=${PAPER_FIELDS}&limit=10`,
    { signal },
  );
  return (res?.data || [])
    .map((d) => normalizePaper(d?.citingPaper))
    .filter(Boolean);
}
