import { test, expect } from '@playwright/test';

/** Build a small real PDF with complete xref offsets for browser regression. */
function paperPdf() {
  const stream = 'BT /F1 12 Tf 40 750 Td (Reliable paper fixture) Tj 0 -24 Td (Gradient descent converges with a bounded step size.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

async function openPaper(page) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '打开 PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'fixture.pdf', mimeType: 'application/pdf', buffer: paperPdf() });
  await expect(page.locator('#text-scroll')).toContainText('Gradient descent');
  await expect(page.locator('#pdf-scroll canvas')).toHaveCount(1);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('aie:settings', JSON.stringify({ reading: { baseUrl: 'https://reader.test/v1', model: 'test', apiKey: '' } })));
  await page.route('https://reader.test/v1/chat/completions', async route => {
    const request = route.request().postDataJSON();
    expect(request).not.toHaveProperty('max_tokens');
    expect(request).not.toHaveProperty('max_completion_tokens');
    await route.fulfill({ contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"content":"Evidence [p1-c1] supports convergence."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' });
  });
  await page.goto('/');
});

test('real PDF, citation, autosave recovery, reattachment and export keyboard', async ({ page }) => {
  await openPaper(page);
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await page.locator('[data-chat-input]').fill('Explain convergence');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-bubble--assistant')).toContainText('supports convergence');
  await expect(page.locator('.paper-citation')).toHaveCount(1);
  await page.locator('.paper-citation').click();
  // Wait for the real IndexedDB autosave, then prove a reload restores usable text.
  await expect.poll(() => page.evaluate(async () => {
    const { flushAutosave } = await import('/src/archive/autosave.js');
    await flushAutosave();
    return true;
  })).toBe(true);
  await page.reload();
  await expect(page.locator('#text-scroll')).toContainText('Gradient descent');
  await expect(page.locator('.chat-bubble--assistant')).toContainText('supports convergence');
  await openPaper(page);
  await expect(page.locator('.chat-bubble--assistant')).toContainText('supports convergence');
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await page.getByRole('button', { name: '保存对话', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '保存「对话」' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存对话', exact: true })).toBeFocused();
});

test('interrupted partial reply stays visible, exportable and recoverable', async ({ page }) => {
  await page.unroute('https://reader.test/v1/chat/completions');
  await page.route('https://reader.test/v1/chat/completions', route => route.fulfill({ contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"content":"Partial answer"}}]}\n' }));
  await openPaper(page);
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await page.locator('[data-chat-input]').fill('Explain');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-bubble--assistant')).toContainText('Partial answer');
  await expect(page.locator('.chat-bubble--assistant')).toContainText('未完成');
  await page.evaluate(async () => { const { flushAutosave } = await import('/src/archive/autosave.js'); await flushAutosave(); });
  await page.reload();
  await expect(page.locator('.chat-bubble--assistant')).toContainText('Partial answer');
  await expect(page.locator('.chat-bubble--assistant')).toContainText('未完成');
});

test('segmented task requires review and preserves completed progress', async ({ page }) => {
  let calls = 0;
  page.on('request', request => { if (request.url().includes('reader.test')) calls++; });
  await openPaper(page);
  await page.getByRole('tab', { name: '翻译', exact: true }).click();
  await page.locator('[data-section="translate"] [data-action="segmented"]').click();
  await expect(page.getByRole('dialog', { name: '分段处理论文' })).toBeVisible();
  expect(calls).toBe(0);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect(calls).toBe(0);
  await page.locator('[data-section="translate"] [data-action="segmented"]').click();
  await page.getByRole('button', { name: '开始分段处理', exact: true }).click();
  await expect(page.locator('[data-section="translate"] [data-result-status]')).toContainText('已完成');
  expect(calls).toBe(1);
  await page.evaluate(async () => { const { flushAutosave } = await import('/src/archive/autosave.js'); await flushAutosave(); });
  await page.reload();
  await page.getByRole('tab', { name: '翻译', exact: true }).click();
  await page.locator('[data-section="translate"] [data-action="segmented"]').click();
  await expect(page.getByRole('button', { name: '继续分段处理', exact: true })).toBeVisible();
  expect(calls).toBe(1);
});

test('cancel pending response and replace document without stale writes', async ({ page }) => {
  await page.unroute('https://reader.test/v1/chat/completions');
  let release;
  let requested = false;
  await page.route('https://reader.test/v1/chat/completions', async route => {
    requested = true;
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"content":"Obsolete answer"},"finish_reason":"stop"}]}\n' }).catch(() => {});
  });
  await openPaper(page);
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await page.locator('[data-chat-input]').fill('Pending question');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  await page.locator('[data-section="chat"] [data-action="stop"]').click();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  release();
  await openPaper(page);
  await expect(page.locator('.chat-list')).not.toContainText('Obsolete answer');
});
