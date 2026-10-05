import type { WorkspaceDocument } from "../domain/types";

const DATABASE = "latency-lab-db";
const STORE = "workspace";
const KEY = "latency-lab.workspace.v1";

/** CAS 失败：本次写入期间，另一个标签页已经先写入了新的 revision。 */
export class RevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly current: WorkspaceDocument,
  ) {
    super("工作区已在其他标签页中保存过");
    this.name = "RevisionConflictError";
  }
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
   * 乐观并发写入：仅当存储中的 revision 仍等于 expectedRevision 时才提交。
   * 读取与计数在同一个 readwrite 事务中完成，两个标签页的事务会被序列化，
   * 因此后到的一方一定能观察到先到一方写入的 revision 并中止。
   * expectedRevision 为 null 时表示要求存储为空（首次写入）。
   * 写入成功后 revision 自动加一（首次写入为 1），返回的文档带新 revision。
   */
  async conditionalWrite(
    value: WorkspaceDocument,
    expectedRevision: number | null,
  ): Promise<WorkspaceDocument> {
    if (!("indexedDB" in globalThis)) throw new Error("浏览器不支持 IndexedDB");
    const db = await this.open();
    return new Promise<WorkspaceDocument>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const countRequest = store.count(KEY);
      countRequest.onsuccess = () => {
        const getRequest = store.get(KEY);
        getRequest.onsuccess = () => {
          const stored = getRequest.result as
            (WorkspaceDocument & { revision?: unknown }) | undefined;
          const exists = (countRequest.result ?? 0) > 0;
          const storedRevision =
            typeof stored?.revision === "number" ? stored.revision : 0;
          const matches =
            expectedRevision === null
              ? !exists
              : exists && storedRevision === expectedRevision;
          if (!matches) {
            // 中止事务并把对方刚写入的文档带回给调用方做合并。
            fail(
              new RevisionConflictError(
                expectedRevision ?? 0,
                stored && stored.version === 1
                  ? (stored as WorkspaceDocument)
                  : value,
              ),
            );
            transaction.abort();
            return;
          }
          const nextRevision =
            expectedRevision === null ? 1 : expectedRevision + 1;
          const written: WorkspaceDocument = {
            ...value,
            revision: nextRevision,
          };
          store.put(written, KEY);
          transaction.oncomplete = () => {
            if (settled) return;
            settled = true;
            resolve(written);
          };
        };
        getRequest.onerror = () =>
          fail(getRequest.error ?? new Error("读取当前版本失败"));
      };
      countRequest.onerror = () =>
        fail(countRequest.error ?? new Error("读取当前版本失败"));
      transaction.onerror = () =>
        fail(transaction.error ?? new Error("保存本地项目失败"));
      transaction.onabort = () => {
        // 主动 abort（CAS 冲突）时 fail 已经带具体原因 reject；
        // 这里仅兜底事务自身异常中止的情况。
        if (!settled && transaction.error)
          fail(transaction.error ?? new Error("保存已中断"));
      };
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
