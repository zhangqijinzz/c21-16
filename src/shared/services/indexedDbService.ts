import { legacyFingerprint } from "../domain/fingerprint";
import type { StoredWorkspace } from "../domain/types";

const DATABASE = "latency-lab-db";
const STORE = "workspace";
const KEY = "latency-lab.workspace.v1";

export interface CommitOutcome {
  committed: boolean;
  /** 提交成功为新信封；冲突为当前存储的原始值（可能是旧版裸文档），由 repository 解析。 */
  current: unknown;
}

/** 提取当前存储记录的修订号：信封取 revision，旧版裸文档用内容指纹。 */
export function extractRevision(raw: unknown): string | null {
  if (raw && typeof raw === "object") {
    const record = raw as { envelope?: unknown; revision?: unknown };
    if (record.envelope === 2 && typeof record.revision === "string")
      return record.revision;
    if (
      (record as { version?: unknown }).version === 1 &&
      Array.isArray((record as { projects?: unknown }).projects)
    )
      return legacyFingerprint(raw);
  }
  return null;
}

export class IndexedDbService {
  async read(): Promise<unknown> {
    if (!("indexedDB" in globalThis)) throw new Error("浏览器不支持 IndexedDB");
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db
        .transaction(STORE, "readonly")
        .objectStore(STORE)
        .get(KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("读取本地项目失败"));
    });
  }

  /**
   * 原子乐观并发写入：在同一个 readwrite 事务内先读当前修订号。
   * - 期望修订号匹配（或仓库为空且期望为 null）才 put
   * - 不匹配则主动 abort 事务并返回当前存储内容，绝不覆盖对端改动
   */
  async commit(
    value: StoredWorkspace,
    expectedRevision: string | null,
  ): Promise<CommitOutcome> {
    if (!("indexedDB" in globalThis)) throw new Error("浏览器不支持 IndexedDB");
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const getRequest = store.get(KEY);
      let conflictAbort = false;
      getRequest.onsuccess = () => {
        if (extractRevision(getRequest.result) === expectedRevision) {
          store.put(value, KEY);
          return;
        }
        conflictAbort = true;
        transaction.abort();
      };
      getRequest.onerror = () =>
        reject(getRequest.error ?? new Error("读取当前修订号失败"));
      transaction.oncomplete = () => resolve({ committed: true, current: value });
      const resolveConflict = () => {
        void this.read()
          .then((current) => resolve({ committed: false, current }))
          .catch(() => resolve({ committed: false, current: null }));
      };
      transaction.onerror = () => {
        if (conflictAbort) return resolveConflict();
        reject(transaction.error ?? new Error("保存本地项目失败"));
      };
      transaction.onabort = () => {
        if (conflictAbort) return resolveConflict();
        reject(transaction.error ?? new Error("保存已中断"));
      };
    });
  }

  /** 冲突解决后用户明确选择“用我的覆盖”：无条件写入。 */
  async forceWrite(value: StoredWorkspace): Promise<void> {
    if (!("indexedDB" in globalThis)) throw new Error("浏览器不支持 IndexedDB");
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(value, KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("保存本地项目失败"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("保存已中断"));
    });
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("打开本地项目失败"));
    });
  }
}
