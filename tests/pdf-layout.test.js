import test from 'node:test';
import assert from 'node:assert/strict';
import { textContentToString, cleanRepeatedMargins } from '../src/pdf/layout.js';
const item = (str, x, y, width = 220) => ({ str, width, height: 12, transform: [12, 0, 0, 12, x, y] });

test('geometric lines ignore stream order and read separated prose columns', () => {
  const items = [item('Full width title', 40, 800, 520)];
  for (let line = 0; line < 3; line++) {
    items.push(item(`Left paragraph line ${line} content`, 40, 750 - line * 20));
    items.push(item(`Right paragraph line ${line} content`, 340, 750 - line * 20));
  }
  const text = textContentToString({ items: items.reverse() });
  assert.ok(text.indexOf('Full width title') < text.indexOf('Left paragraph'));
  assert.ok(text.indexOf('Left paragraph line 2') < text.indexOf('Right paragraph line 0'));
});

test('single lines preserve spaces and conservative line-end hyphens', () => {
  const text = textContentToString({ items: [item('known and state-', 40, 60), item('of the art', 40, 40),
    item('interoper-', 40, 100), item('ability', 40, 80)] });
  assert.match(text, /interoperability/);
  assert.match(text, /state-\nof the art/);
});

test('repeated headers and changing page numbers are removed only at page edges', () => {
  const pages = Array.from({ length: 4 }, (_, i) => ({ pageNum: i + 1,
    text: `Conference 2026\nBody unique ${i}\nConference 2026\nMore body ${i}\n${i + 1}` }));
  const cleaned = cleanRepeatedMargins(pages);
  assert.equal(cleaned[0].text, 'Body unique 0\nConference 2026\nMore body 0');
  assert.equal(pages[0].text.startsWith('Conference'), true);
  assert.deepEqual(cleanRepeatedMargins(pages.slice(0, 2)), pages.slice(0, 2));
});
