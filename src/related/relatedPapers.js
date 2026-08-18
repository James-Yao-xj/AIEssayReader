/* =========================================================
 * src/related/relatedPapers.js
 *
 * 相关文献检索编排层（UI 唯一调用门面）。
 *
 * - searchRelated(input)：解析目标论文 → 串行拉取 相似推荐 / 参考文献 / 被引论文
 * - computeBadges(groups)：后台对 ≤ maxChecks 篇做轻量 GitHub 代码校验，
 *   命中即回调 onBadge；不阻塞主结果，绝不因徽标失败影响检索
 * ========================================================= */

import * as s2 from './semanticScholar.js';
import { extractMethodName, findRepo } from './github.js';

/**
 * 三路检索：解析目标论文并返回分组结果。
 * @param {string} input 用户输入（标题/DOI/arXiv/paperId/URL）
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{
 *   target: import('./semanticScholar.js').Paper,
 *   recommendations: import('./semanticScholar.js').Paper[],
 *   references: import('./semanticScholar.js').Paper[],
 *   citations: import('./semanticScholar.js').Paper[],
 * }>}
 */
export async function searchRelated(input, opts) {
  const { signal } = opts || {};
  const target = await s2.resolvePaper(input, signal);

  // 串行 + 小间隔，尊重 S2 限流（匿名极紧，退避只兜 429 瞬时）
  const recommendations = await s2.getRecommendations(target.paperId, signal);
  await s2.sleep(800, signal);
  const references = await s2.getReferences(target.paperId, signal);
  await s2.sleep(800, signal);
  const citations = await s2.getCitations(target.paperId, signal);

  return { target, recommendations, references, citations };
}

/**
 * 后台代码徽标：按 recommendations → references → citations 顺序取 ≤ maxChecks 篇，
 * 逐篇提取方法名 → GitHub 校验 → 命中回调 onBadge。间隔 ~6.5s 尊重匿名 10/min。
 * @param {{ recommendations: any[], references: any[], citations: any[] }} groups
 * @param {{ signal?: AbortSignal, onBadge?: (paperId: string|null, repo: {repo:string,stars:number}) => void, maxChecks?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function computeBadges(groups, opts) {
  const { signal, onBadge, maxChecks = 10 } = opts || {};
  const ordered = [
    ...(groups.recommendations || []),
    ...(groups.references || []),
    ...(groups.citations || []),
  ];

  const seen = new Set();
  let checked = 0;
  for (const paper of ordered) {
    if (checked >= maxChecks) break;
    if (!paper?.title) continue;
    const method = extractMethodName(paper.title);
    if (!method) continue;
    const lower = method.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    checked++;

    const repo = await findRepo(method, signal);
    if (repo && onBadge) onBadge(paper.paperId, repo);

    if (checked < maxChecks) await s2.sleep(6500, signal);
  }
}
