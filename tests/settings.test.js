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
