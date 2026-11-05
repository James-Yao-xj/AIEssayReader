/** Validate imported records before they enter persistent application state. */
export function parseArchive(data) {
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const fail = () => { throw new Error('文件格式不正确：存档字段类型无效。'); };
  if (!isObject(data) || (!data.title && !data.paperMeta)) fail();
  if (data.title !== undefined && typeof data.title !== 'string') fail();
  const meta = data.paperMeta ?? {};
  if (!isObject(meta)) fail();
  for (const key of ['name', 'title']) {
    if (meta[key] !== undefined && typeof meta[key] !== 'string') fail();
  }
  if (meta.nPages !== undefined && (!Number.isInteger(meta.nPages) || meta.nPages < 0)) fail();
  if (meta.authors !== undefined && (!Array.isArray(meta.authors) || !meta.authors.every((v) => typeof v === 'string'))) fail();
  const messages = data.messages ?? [];
  if (!Array.isArray(messages) || !messages.every((m) => isObject(m) && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')) fail();
  const results = data.savedResults ?? {};
  if (!isObject(results) || !Object.values(results).every((v) => typeof v === 'string')) fail();
  if (data.createdAt !== undefined && (typeof data.createdAt !== 'string' || !Number.isFinite(Date.parse(data.createdAt)))) fail();

  // Copy known fields only. Imported IDs and object prototypes are not state.
  const savedResults = {};
  for (const key of ['summarize', 'explainConcepts', 'critique', 'translate']) {
    if (Object.hasOwn(results, key)) savedResults[key] = results[key];
  }
  return {
    title: data.title || meta.title || '导入的存档',
    paperMeta: { name: meta.name ?? '', title: meta.title, authors: meta.authors, nPages: meta.nPages ?? 0 },
    messages: messages.map(({ role, content }) => ({ role, content })),
    savedResults,
    createdAt: data.createdAt ?? new Date().toISOString(),
  };
}
