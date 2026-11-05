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
