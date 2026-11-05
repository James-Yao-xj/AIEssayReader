import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSettings, saveSettings } from '../src/config/storage.js';

test('settings migrate old credentials and keep model groups independent', () => {
  let raw = JSON.stringify({ baseUrl: 'https://example.test/v1', apiKey: 'secret', model: 'old' });
  globalThis.localStorage = { getItem: () => raw, setItem: (_, value) => { raw = value; } };
  const settings = loadSettings();
  assert.equal(settings.reading.model, 'old');
  assert.equal(settings.recognition.apiKey, 'secret');
  settings.reading.model = 'new';
  assert.equal(settings.recognition.model, 'old');
  const saved = saveSettings(settings);
  assert.equal(loadSettings().reading.model, saved.reading.model);
  delete globalThis.localStorage;
});

test('unavailable and corrupt storage do not prevent application startup', () => {
  globalThis.localStorage = { getItem: () => '{', setItem: () => { throw new Error('quota'); } };
  assert.equal(loadSettings().fontSize, 14);
  assert.equal(saveSettings({}), null);
  delete globalThis.localStorage;
});

test('saved model temperatures remain in the supported range', () => {
  let stored;
  globalThis.localStorage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  const settings = saveSettings({ recognition: { temperature: -4 }, reading: { temperature: 8 } });
  assert.equal(settings.recognition.temperature, 0);
  assert.equal(settings.reading.temperature, 2);
  assert.equal(loadSettings().reading.temperature, 2);
});

test('legacy settings migration clamps temperature and preserves keyless setup', () => {
  let stored = JSON.stringify({ baseUrl: 'http://192.168.1.2/v1', apiKey: '', model: 'local', temperature: 9 });
  globalThis.localStorage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  const settings = loadSettings();
  assert.equal(settings.reading.temperature, 2);
  assert.equal(settings.recognition.temperature, 2);
  assert.equal(settings.reading.apiKey, '');
  assert.equal(settings.reading.baseUrl, 'http://192.168.1.2/v1');
});

test('input budget defaults survive old and malformed storage', () => {
  let stored;
  globalThis.localStorage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  assert.equal(loadSettings().reading.contextTokens, 24000);
  for (const value of [null, '32000', {}, [], NaN, Infinity]) {
    assert.equal(saveSettings({ reading: { contextTokens: value } }).reading.contextTokens, 24000);
  }
  stored = JSON.stringify({ reading: { model: 'custom' } });
  assert.equal(loadSettings().reading.contextTokens, 24000);
  assert.equal(loadSettings().reading.model, 'custom');
});

test('input budget persists, rounds, clamps and stays reading-only', () => {
  let stored;
  globalThis.localStorage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  const saved = saveSettings({ reading: { contextTokens: 32123.6, model: 'reader' }, recognition: { model: 'ocr', contextTokens: 1 } });
  assert.equal(saved.reading.contextTokens, 32124);
  assert.equal(loadSettings().reading.contextTokens, 32124);
  assert.equal(saved.recognition.model, 'ocr');
  assert.equal(Object.hasOwn(saved.recognition, 'contextTokens'), false);
  assert.equal(saveSettings({ reading: { contextTokens: -1 } }).reading.contextTokens, 2000);
  assert.equal(saveSettings({ reading: { contextTokens: 999999 } }).reading.contextTokens, 200000);
});

test('flat settings migrate a valid input budget and default a missing budget', () => {
  let stored = JSON.stringify({ baseUrl: 'http://localhost:11434/v1', contextTokens: 64000 });
  globalThis.localStorage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  assert.equal(loadSettings().reading.contextTokens, 64000);
  assert.equal(JSON.parse(stored).reading.contextTokens, 64000);
  stored = JSON.stringify({ baseUrl: 'http://localhost:11434/v1' });
  assert.equal(loadSettings().reading.contextTokens, 24000);
});

test('old default word caps upgrade while custom prompts remain unchanged', async () => {
  const { DEFAULT_SETTINGS } = await import('../src/config/defaults.js');
  const old = DEFAULT_SETTINGS.promptSummarize.replace(
    '- 根据论文内容充分展开，不设置固定字数上限。', '- 总字数控制在 800~1200 字。');
  let raw = JSON.stringify({ promptSummarize: old });
  globalThis.localStorage = { getItem: () => raw };
  assert.equal(loadSettings().promptSummarize, DEFAULT_SETTINGS.promptSummarize);
  raw = JSON.stringify({ promptSummarize: 'My custom prompt' });
  assert.equal(loadSettings().promptSummarize, 'My custom prompt');
  delete globalThis.localStorage;
});
