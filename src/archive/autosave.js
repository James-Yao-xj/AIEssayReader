/** Keep one local recovery snapshot. Startup recovery never invokes a model. */
import { getState, setState, subscribe } from '../state/store.js';
import { createSnapshot, restoreArchive } from './manager.js';
import { loadSession, saveSession } from './db.js';

let activeSession = null;

/**
 * Restore the last session if startup state has not changed, then save changes.
 *
 * Args:
 *   options: Debounce delay in milliseconds and an optional error callback.
 * Returns:
 *   A session with flush() and dispose(). flush() rejects if persistence fails.
 */
export async function initAutosave({ debounceMs = 500, onError, canRestore = () => true } = {}) {
  activeSession?.dispose();
  const report = (error) => {
    console.error('[autosave]', error);
    setState({ autosaveStatus: { status: 'failed', text: `自动保存失败：${error.message}` } });
    onError?.(error);
  };
  const initial = getState();
  try {
    const snapshot = await loadSession();
    if (snapshot && getState() === initial && canRestore()) restoreArchive(snapshot);
  } catch (error) { report(error); }

  let timer = null;
  let maxTimer = null;
  let disposed = false;
  let writing = Promise.resolve();
  let previous = getState();
  const hasSession = () => getState().paper || getState().messages.length || Object.values(getState().savedResults || {}).some(Boolean);
  const flush = () => {
    clearTimeout(timer);
    clearTimeout(maxTimer);
    timer = null;
    maxTimer = null;
    if (disposed || !hasSession()) return writing;
    // Clone before the asynchronous queue. A later document must not change this write.
    let snapshot;
    try { snapshot = createSnapshot(); }
    catch (error) { report(error); return Promise.reject(error); }
    const next = writing.catch(() => {}).then(() => saveSession(snapshot));
    writing = next;
    return next.then(() => {
      if (!disposed) setState({ autosaveStatus: { status: 'saved', text: '会话已自动保存' } });
    }, (error) => { report(error); throw error; });
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { void flush().catch(() => {}); }, debounceMs);
    // Continuous token updates must still produce recovery points.
    maxTimer ??= setTimeout(() => { void flush().catch(() => {}); }, 2000);
  };
  const unsubscribe = subscribe((state) => {
    const changed = ['paper', 'messages', 'savedResults', 'resultStatuses', 'segmentedTask', 'conversationSummary']
      .some((key) => state[key] !== previous[key]);
    previous = state;
    if (changed && hasSession()) schedule();
  });
  const onPageHide = () => { void flush().catch(() => {}); };
  globalThis.window?.addEventListener('pagehide', onPageHide);
  const session = {
    flush,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(maxTimer);
      unsubscribe();
      globalThis.window?.removeEventListener('pagehide', onPageHide);
      if (activeSession === session) activeSession = null;
    },
  };
  activeSession = session;
  if (hasSession()) schedule();
  return session;
}

/** Persist current recovery state immediately when autosave is initialized. */
export function flushAutosave() {
  return activeSession?.flush() ?? Promise.resolve();
}
