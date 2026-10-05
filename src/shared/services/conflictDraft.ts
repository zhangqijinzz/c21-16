import type { WorkspaceDocument } from "../domain/types";

/**
 * 冲突期间的本地草稿兜底。IndexedDB CAS 会阻止覆盖，但冲突对话框若被
 * 刷新/崩溃打断，未保存的一方仍可能丢失。检测到冲突时把本地草稿写入
 * localStorage；下次启动若发现草稿与存储内容不一致，提示用户恢复。
 */
const DRAFT_KEY = "latency-lab.conflict-draft.v1";

export interface DraftRecord {
  savedAt: number;
  baseRevision: number;
  /** 三方合并所需的共同祖先（冲突发生时的最后已知已保存版本）。 */
  base: WorkspaceDocument;
  document: WorkspaceDocument;
}

export const conflictDraft = {
  save(record: DraftRecord): void {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(record));
    } catch {
      // 草稿写不进 localStorage（配额/隐私模式）不应阻断冲突处理流程。
    }
  },
  load(): DraftRecord | undefined {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as DraftRecord;
      if (
        typeof parsed?.savedAt === "number" &&
        typeof parsed?.baseRevision === "number" &&
        parsed.document &&
        parsed.document.version === 1
      )
        return parsed;
    } catch {
      // 损坏的草稿直接删除。
    }
    localStorage.removeItem(DRAFT_KEY);
    return undefined;
  },
  clear(): void {
    localStorage.removeItem(DRAFT_KEY);
  },
};
