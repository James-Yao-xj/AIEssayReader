/** Recover ordinary horizontal prose. Rotated text and tables need visual review. */

/** Join positioned PDF items into lines and read a clear two-column gutter. */
export function textContentToString({ items }, pageWidth = 600) {
  const positioned = items.filter((item) => typeof item.str === 'string' && item.str.trim() && item.transform)
    .map((item) => ({ text: item.str, x: item.transform[4], y: item.transform[5],
      width: item.width || 0, height: Math.abs(item.height) || 12 }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const item of positioned) {
    const row = rows.at(-1);
    if (row && Math.abs(row.y - item.y) <= Math.min(row.height, item.height) * 0.45) row.items.push(item);
    else rows.push({ y: item.y, height: item.height, items: [item] });
  }
  const gaps = new Map();
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.items.length; i++) {
      const left = row.items[i - 1];
      const right = row.items[i];
      const end = left.x + left.width;
      const center = (end + right.x) / 2;
      // Require prose on each side to avoid treating numeric tables as columns.
      if (right.x - end > pageWidth * 0.08 && center > pageWidth * 0.3 && center < pageWidth * 0.7 &&
          row.items.slice(0, i).map((part) => part.text).join('').length >= 20 &&
          row.items.slice(i).map((part) => part.text).join('').length >= 20) {
        const bucket = Math.round(center / 20) * 20;
        gaps.set(bucket, (gaps.get(bucket) || 0) + 1);
      }
    }
  }
  const gutter = [...gaps].sort((a, b) => b[1] - a[1]).find(([, count]) => count >= 3)?.[0];
  const join = (parts) => parts.reduce((text, item, index) => {
    const previous = parts[index - 1];
    const space = previous && item.x - previous.x - previous.width > item.height * 0.25;
    return text + (space ? ' ' : '') + item.text;
  }, '');
  const lines = [];
  let left = [], right = [];
  const flush = () => { lines.push(...left, ...right); left = []; right = []; };
  for (const row of rows) {
    if (!gutter) { lines.push(join(row.items)); continue; }
    if (row.items.some((item) => item.x < gutter && item.x + item.width > gutter)) {
      flush(); lines.push(join(row.items)); continue;
    }
    const l = row.items.filter((item) => item.x < gutter);
    const r = row.items.filter((item) => item.x >= gutter);
    if (l.length) left.push(join(l));
    if (r.length) right.push(join(r));
  }
  flush();
  return lines.join('\n').replace(/\0/g, '').replace(/\u00ad\n(?=[a-z])/g, '')
    .replace(/([a-z]{5,})-\n([a-z]{3,})/g, '$1$2').trim();
}

/** Remove repeated boundary lines only when at least three pages agree. */
export function cleanRepeatedMargins(pages) {
  if (pages.length < 3) return pages;
  const split = pages.map((page) => page.text.split('\n').filter((line) => line.trim()));
  const normalized = (line) => line.trim().replace(/\d+/g, '#');
  const candidates = new Map();
  for (const lines of split) {
    if (lines.length < 4) continue;
    const boundaries = new Set([lines[0], lines.at(-1)].map(normalized));
    for (const line of boundaries) candidates.set(line, (candidates.get(line) || 0) + 1);
  }
  const repeated = new Set([...candidates].filter(([, count]) => count >= Math.max(3, Math.ceil(pages.length * 0.6))).map(([line]) => line));
  return pages.map((page, pageIndex) => ({ ...page, text: split[pageIndex].filter((line, index, lines) =>
    !(index === 0 || index === lines.length - 1) || !repeated.has(normalized(line))).join('\n') }));
}
