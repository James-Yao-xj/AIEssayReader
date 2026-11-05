/* =========================================================
 * src/archive/manager.js
 *
 * 存档业务逻辑：保存 / 恢复 / 导出 / 导入。
 *
 * - archiveCurrent()  收集当前状态写入 IndexedDB
 * - restoreArchive()  将存档数据写回 store + aiPane
 * - exportArchive()   下载存档为 .json 文件
 * - importArchive()   从 .json 文件导入到 IndexedDB
 * ========================================================= */

import { getState, setState } from '../state/store.js';
import { getSavedResults, setSavedResults, getSavedResultStatuses, setSavedResultStatuses, refreshAfterRestore } from '../ui/aiPane.js';
import * as db from './db.js';
import { parseArchive } from './schema.js';

/**
 * @typedef {{
 *   id?: number;
 *   title: string;
 *   paperMeta: { name: string; title?: string; authors?: string[]; nPages: number };
 *   savedResults: Record<string, string>;
 *   messages: Array<{ role: string; content: string }>;
 *   createdAt: string;
 * }} ArchiveRecord
 */

/**
 * 检查当前是否有可存档的内容（至少一项分析结果或一条对话）。
 * @returns {boolean}
 */
export function hasContent() {
  const sr = getSavedResults();
  const hasAnalysis = Object.values(sr).some((v) => typeof v === 'string' && v.trim());
  const state = getState();
  const hasMessages = state.messages.length > 0;
  return hasAnalysis || hasMessages || Boolean(state.paper?.fullText) || Boolean(state.segmentedTask);
}

/**
 * 保存当前所有已生成内容到 IndexedDB。
 * 调用前应先通过 hasContent() 检查。
 * @returns {Promise<ArchiveRecord>}
 */
export async function archiveCurrent() {
  const record = createSnapshot();

  const id = await db.saveArchive(record);
  return { ...record, id };
}

/**
 * 将存档恢复到当前会话。
 * @param {ArchiveRecord} record
 */
export function restoreArchive(record) {
  const snapshot = parseArchive(record);
  const interrupted = (status) => status === 'generating' ? 'interrupted' : status;
  if (snapshot.segmentedTask?.status === 'generating') snapshot.segmentedTask.status = 'interrupted';
  setState({
    paper: snapshot.paper,
    messages: snapshot.messages.map((message) => ({ ...message, ...(message.status ? { status: interrupted(message.status) } : {}) })),
    conversationSummary: snapshot.conversationSummary,
    retrievedChunkIndices: [], contextEvidence: [], chatStatus: null,
    segmentedTask: snapshot.segmentedTask,
  });
  setSavedResults(snapshot.savedResults);
  setSavedResultStatuses(Object.fromEntries(Object.entries(snapshot.resultStatuses).map(([key, status]) => [key, interrupted(status)])));

  // 刷新 UI
  refreshAfterRestore();
}

/**
 * 导出一条存档为 .json 文件并触发下载。
 * @param {ArchiveRecord} record
 */
export function exportArchive(record) {
  const { id, ...data } = record;
  const json = JSON.stringify(data, null, 2);
  const safeTitle = (record.title || '未命名').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80);
  const date = (record.createdAt || new Date().toISOString()).slice(0, 10);
  const filename = `${safeTitle}_存档_${date}.json`;

  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * 从 .json 文件导入存档到 IndexedDB。
 * @param {File} file
 * @returns {Promise<ArchiveRecord>}
 */
export function importArchive(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const raw = /** @type {string} */ (reader.result);
        const data = JSON.parse(raw);

        const record = parseArchive(data);

        const id = await db.saveArchive(record);
        resolve({ ...record, id });
      } catch (err) {
        reject(err instanceof Error ? err : new Error('导入失败：无法解析文件。'));
      }
    };
    reader.onerror = () => reject(new Error('读取文件失败。'));
    reader.readAsText(file);
  });
}

/** Capture a detached snapshot so later state changes cannot alter a write. */
export function createSnapshot() {
  const state = getState();
  const paper = state.paper;
  return parseArchive(structuredClone({
    schemaVersion: 2,
    title: (paper?.meta?.title || paper?.name || '未命名论文').trim().slice(0, 200),
    paper: paper ?? { name: '', meta: { nPages: 0 }, fullText: '', pages: [] },
    savedResults: getSavedResults(), resultStatuses: getSavedResultStatuses(),
    messages: state.messages,
    conversationSummary: state.conversationSummary,
    segmentedTask: state.segmentedTask ?? null,
    createdAt: new Date().toISOString(),
  }));
}
