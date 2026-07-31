/* =========================================================
 * src/archive/db.js
 *
 * IndexedDB CRUD 封装。数据库名 aie-archives，version 1。
 * - openDB() 打开（或创建+迁移）数据库，idempotent——内部缓存句柄
 * - saveArchive() / listArchives() / getArchive() / deleteArchive()
 * - 所有操作返回 Promise；错误抛带描述信息的 Error
 * ========================================================= */

const DB_NAME = 'aie-archives';
const DB_VERSION = 1;
const STORE_NAME = 'archives';

/** @type {IDBDatabase | null} */
let dbHandle = null;

/**
 * 打开（或创建）数据库。幂等——已打开的句柄直接返回。
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  if (dbHandle) return Promise.resolve(dbHandle);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = /** @type {IDBDatabase} */ (/** @type {any} */ (event.target).result);
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    req.onsuccess = (event) => {
      const db = /** @type {IDBDatabase} */ (/** @type {any} */ (event.target).result);
      db.onclose = () => { dbHandle = null; };
      dbHandle = db;
      resolve(db);
    };

    req.onerror = () => {
      reject(new Error(`无法打开 IndexedDB：${req.error?.message || '未知错误'}`));
    };

    req.onblocked = () => {
      reject(new Error('IndexedDB 被其他标签页阻塞，请关闭其他标签页后重试。'));
    };
  });
}

/**
 * 保存一条存档记录。
 * @param {Omit<import('./manager.js').ArchiveRecord, 'id'>} record
 * @returns {Promise<number>} 自增 id
 */
export async function saveArchive(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.add(record);
    req.onsuccess = () => resolve(/** @type {number} */ (req.result));
    req.onerror = () => reject(new Error(`存档写入失败：${req.error?.message || '未知错误'}`));
  });
}

/**
 * 列出所有存档，按创建时间倒序（最新在前）。
 * @returns {Promise<Array<import('./manager.js').ArchiveRecord>>}
 */
export async function listArchives() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('createdAt');
    const req = index.openCursor(null, 'prev');
    /** @type {Array<import('./manager.js').ArchiveRecord>} */
    const results = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        results.push(/** @type {import('./manager.js').ArchiveRecord} */ (cursor.value));
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(new Error(`读取存档列表失败：${req.error?.message || '未知错误'}`));
  });
}

/**
 * 按 id 获取单条存档。
 * @param {number} id
 * @returns {Promise<import('./manager.js').ArchiveRecord | null>}
 */
export async function getArchive(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(new Error(`读取存档失败：${req.error?.message || '未知错误'}`));
  });
}

/**
 * 按 id 删除一条存档。id 不存在时静默成功。
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function deleteArchive(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(new Error(`删除存档失败：${req.error?.message || '未知错误'}`));
  });
}
