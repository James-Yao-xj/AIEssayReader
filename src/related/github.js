/* =========================================================
 * src/related/github.js
 *
 * GitHub 搜索客户端（轻量「有代码」徽标）。
 *
 * - 从论文标题提取驼峰复合方法名（借鉴 literature-search 技能信号 B）
 * - 仓库名（去掉 owner 前缀）大小写不敏感匹配方法名 → 视为「有代码」
 * - 只做「宁缺毋滥」的轻量判断，不做 README 引用 arXiv 校验（信号 A）
 * - 匿名搜索限流 10/min；403/429/网络错一律静默返回 null，绝不抛
 * ========================================================= */

const GITHUB_SEARCH = 'https://api.github.com/search/repositories';

/** 常见通用词/缩写，不作为方法名候选（从源头杜绝同名热门仓库误报）。 */
const STOPWORDS = new Set([
  'Vision', 'Offline', 'Think', 'GPT', 'VLN', 'CLIP', 'YOLO', 'BERT',
  'LLM', 'CNN', 'RNN', 'GAN', 'RL', 'AI', 'ML', 'NLP', 'Deep', 'Self',
  'Meta', 'Open', 'Mini', 'Large', 'Small', 'New', 'Neural', 'Network',
  'Attention', 'Transformer', 'Model', 'Learning', 'Training', 'Data',
]);

/**
 * 从标题提取首个驼峰复合方法名候选（如 DualMap、CrossMaps、InstanceEnriched）。
 * 规则：首字母大写、含内部大写、含小写、长度 4~30、非全大写、不在停用词表。
 * @param {string} title
 * @returns {string|null}
 */
export function extractMethodName(title) {
  const tokens = String(title || '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  for (const t of tokens) {
    if (t.length < 4 || t.length > 30) continue;
    if (!/^[A-Z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(t)) continue; // 非驼峰复合
    if (/^[A-Z0-9]+$/.test(t)) continue; // 全大写缩写
    if (STOPWORDS.has(t)) continue;
    return t;
  }
  return null;
}

/**
 * 查 GitHub 仓库：仓库名匹配方法名（大小写不敏感、等于或包含）。
 * 任何失败（限流/网络/无结果）返回 null，不抛错——徽标是可降级的增强。
 * @param {string} methodName
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ repo: string, stars: number } | null>}
 */
export async function findRepo(methodName, signal) {
  const q = encodeURIComponent(`${methodName} in:name`);
  let res;
  try {
    res = await fetch(`${GITHUB_SEARCH}?q=${q}&per_page=5`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return null;
  }
  if (!res.ok) return null; // 403/429/5xx 静默跳过

  const json = await res.json().catch(() => null);
  const items = json?.items || [];
  const target = methodName.toLowerCase();
  for (const item of items) {
    const fullName = item?.full_name || '';
    const repo = fullName.split('/').pop() || '';
    if (repo.toLowerCase() === target || repo.toLowerCase().includes(target)) {
      return { repo: fullName, stars: item?.stargazers_count || 0 };
    }
  }
  return null;
}
