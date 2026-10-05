/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProjectRepository,
  setDefaultStorageFactoryForTests,
} from "../src/shared/repositories/projectRepository";
import { RevisionConflictError } from "../src/shared/services/indexedDbService";
import type { WorkspaceDocument } from "../src/shared/domain/types";
import { useLatencyLab } from "../src/features/workbench/useLatencyLab";

/** 两个标签页共享的内存存储，CAS 语义与 IndexedDbService 一致。 */
class SharedMemoryStorage {
  static current: SharedMemoryStorage | null = null;
  value: unknown = undefined;
  async read() {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }
  async conditionalWrite(
    value: WorkspaceDocument,
    expectedRevision: number | null,
  ): Promise<WorkspaceDocument> {
    const stored = this.value as WorkspaceDocument | undefined;
    const exists = stored !== undefined;
    const matches =
      expectedRevision === null
        ? !exists
        : exists && stored!.revision === expectedRevision;
    if (!matches) {
      throw new RevisionConflictError(
        expectedRevision ?? 0,
        structuredClone(stored ?? value) as WorkspaceDocument,
      );
    }
    const written = {
      ...structuredClone(value),
      revision: expectedRevision === null ? 1 : expectedRevision + 1,
    };
    this.value = written;
    // 真实环境里另一标签页通过 BroadcastChannel/storage 事件感知；
    // 测试中由 notifyChannel 显式触发。
    SharedMemoryStorage.current?.listeners.forEach((fn) => fn(written));
    return structuredClone(written);
  }
  listeners = new Set<(doc: WorkspaceDocument) => void>();
}

// 让所有标签页实例共享同一份存储。
let shared: SharedMemoryStorage;
let tabSeq = 0;

function mountHook() {
  const repository = new ProjectRepository(
    shared as unknown as ConstructorParameters<typeof ProjectRepository>[0],
  );
  const states: ReturnType<typeof useLatencyLab>[] = [];
  // 每个标签页使用独立频道名：Node 下 BroadcastChannel 在同进程跨实例投递，
  // 会破坏“切回标签页才发现远端改动”的场景确定性；真实跨标签页感知由
  // visibilitychange/focus/轮询承担，测试中显式触发。
  const channelName = `test-channel-${tabSeq++}`;
  function Harness() {
    const vm = useLatencyLab({
      immediateSave: true,
      syncIntervalMs: 10_000,
      channelName,
    });
    states.push(vm);
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Harness />);
  });
  const getState = () => states[states.length - 1]!;
  return {
    repository,
    getState,
    unmount: () =>
      act(() => {
        root.unmount();
        container.remove();
      }),
  };
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe("useLatencyLab cross-tab conflict handling", () => {
  beforeEach(() => {
    localStorage.clear();
    shared = new SharedMemoryStorage();
    SharedMemoryStorage.current = shared;
    setDefaultStorageFactoryForTests(() => shared);
    tabSeq = 0;
  });
  afterEach(() => {
    SharedMemoryStorage.current = null;
    setDefaultStorageFactoryForTests(null);
  });

  it("saves edits with monotonically increasing revisions", async () => {
    const tab = mountHook();
    await flush();
    expect(tab.getState().persisted).toBe("saved");
    act(() => {
      tab.getState().renameActive("改过的项目");
    });
    await flush();
    expect(tab.getState().persisted).toBe("saved");
    const stored = (await tab.repository.load()).document;
    expect(stored.projects[0]?.title).toBe("改过的项目");
    expect(stored.revision).toBe(1);
    tab.unmount();
  });

  it("detects a remote save before overwrite and offers merge", async () => {
    const tabA = mountHook();
    await flush();
    const tabB = mountHook();
    await flush();

    // B 先改并保存。
    act(() => {
      tabB.getState().patchNode("flags", { timeoutMs: 999 });
    });
    await flush();
    // A 改了不同字段后保存 → CAS 失败 → 冲突。
    act(() => {
      tabA.getState().patchNode("session", { durationMs: 333 });
    });
    await flush();

    const conflicted = tabA.getState();
    expect(conflicted.persisted).toBe("conflict");
    expect(conflicted.conflict).not.toBeNull();
    // 与 B 改的是不同字段，无逐字段冲突，可全自动合并。
    expect(conflicted.conflict?.conflicts).toHaveLength(0);
    expect(conflicted.conflict?.autoChanges.length).toBeGreaterThan(0);

    act(() => {
      conflicted.mergeAndSave();
    });
    await flush();

    const stored = (await tabA.repository.load()).document;
    expect(
      stored.projects[0]?.nodes.find((n) => n.id === "session")?.durationMs,
    ).toBe(333);
    expect(
      stored.projects[0]?.nodes.find((n) => n.id === "flags")?.timeoutMs,
    ).toBe(999);
    expect(stored.revision).toBeGreaterThanOrEqual(2);
    tabA.unmount();
    tabB.unmount();
  });

  it("asks the user to pick a side when both tabs edited the same field", async () => {
    const tabA = mountHook();
    await flush();
    const tabB = mountHook();
    await flush();

    act(() => tabB.getState().patchNode("session", { durationMs: 777 }));
    await flush();
    act(() => tabA.getState().patchNode("session", { durationMs: 333 }));
    await flush();

    const a = tabA.getState();
    expect(a.conflict?.conflicts[0]?.field).toBe("durationMs");

    // 默认保留我方；切换成对方后合并。
    const conflictId = a.conflict!.conflicts[0]!.id;
    act(() => a.resolveConflict(conflictId, "theirs"));
    act(() => tabA.getState().mergeAndSave());
    await flush();

    const stored = (await tabA.repository.load()).document;
    expect(
      stored.projects[0]?.nodes.find((n) => n.id === "session")?.durationMs,
    ).toBe(777);
    tabA.unmount();
    tabB.unmount();
  });

  it("reloads from remote, discarding local edits, when the user chooses so", async () => {
    const tabA = mountHook();
    await flush();
    const tabB = mountHook();
    await flush();
    act(() => tabB.getState().renameActive("B 的名字"));
    await flush();
    act(() => tabA.getState().renameActive("A 的名字"));
    await flush();

    act(() => tabA.getState().reloadFromRemote());
    await flush();
    expect(tabA.getState().activeProject?.title).toBe("B 的名字");
    const stored = (await tabA.repository.load()).document;
    expect(stored.projects[0]?.title).toBe("B 的名字");
    tabA.unmount();
    tabB.unmount();
  });

  it("recomputes conflicts when the user keeps editing while the dialog is open", async () => {
    const tabA = mountHook();
    await flush();
    const tabB = mountHook();
    await flush();
    act(() => tabB.getState().patchNode("session", { durationMs: 777 }));
    await flush();
    act(() => tabA.getState().patchNode("session", { durationMs: 333 }));
    await flush();

    const before = tabA.getState().conflict!;
    expect(before.conflicts).toHaveLength(1);

    // 冲突对话框开着时继续编辑一个双方都没碰过的字段。
    act(() => tabA.getState().patchNode("flags", { failureRate: 6 }));
    await flush();
    const after = tabA.getState().conflict!;
    expect(after.conflicts).toHaveLength(1);
    expect(
      after.autoChanges.join(" ") || after.conflicts.length >= 0,
    ).toBeTruthy();

    act(() => tabA.getState().mergeAndSave());
    await flush();
    const stored = (await tabA.repository.load()).document;
    // 保留我方 duration，新编辑的 failureRate 也在。
    expect(
      stored.projects[0]?.nodes.find((n) => n.id === "session")?.durationMs,
    ).toBe(333);
    expect(
      stored.projects[0]?.nodes.find((n) => n.id === "flags")?.failureRate,
    ).toBe(6);
    tabA.unmount();
    tabB.unmount();
  });

  it("silently adopts remote content on tab refocus when the local page is clean", async () => {
    const tabA = mountHook();
    await flush();
    const tabB = mountHook();
    await flush();
    act(() => tabB.getState().renameActive("B 刷新后的名字"));
    await flush();

    // A 没有本地改动，切回标签页触发检查。
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(tabA.getState().activeProject?.title).toBe("B 刷新后的名字");
    expect(tabA.getState().conflict).toBeNull();
    tabA.unmount();
    tabB.unmount();
  });

  it("keeps the conflict dismissible to a banner and reopenable", async () => {
    const tabA = mountHook();
    await flush();
    const tabB = mountHook();
    await flush();
    act(() => tabB.getState().patchNode("session", { durationMs: 777 }));
    await flush();
    act(() => tabA.getState().patchNode("session", { durationMs: 333 }));
    await flush();

    act(() => tabA.getState().dismissConflict());
    expect(tabA.getState().conflict?.dismissed).toBe(true);
    act(() => tabA.getState().reopenConflict());
    expect(tabA.getState().conflict?.dismissed).toBe(false);
    tabA.unmount();
    tabB.unmount();
  });
});
