import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useLatencyLab } from "../src/features/workbench/useLatencyLab";
import { ProjectRepository } from "../src/shared/repositories/projectRepository";
import type { CommitOutcome } from "../src/shared/services/indexedDbService";
import { legacyFingerprint } from "../src/shared/domain/fingerprint";
import {
  deliverRemoteChange,
  remoteChangeTestControls,
} from "../src/shared/services/tabSync";
import {
  EXAMPLE_PROJECT,
  type StoredWorkspace,
  type WorkspaceDocument,
} from "../src/shared/domain/types";
import type { RenderHookResult } from "@testing-library/react";

type Lab = ReturnType<typeof useLatencyLab>;

/** 两个 Hook 共用同一块存储，模拟同一浏览器里的两个标签页。 */
class SharedMemoryStorage {
  value: unknown = undefined;
  async read(): Promise<unknown> {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }
  async commit(
    value: StoredWorkspace,
    expectedRevision: string | null,
  ): Promise<CommitOutcome> {
    const revision =
      this.value &&
      typeof this.value === "object" &&
      (this.value as { envelope?: unknown }).envelope === 2
        ? (this.value as StoredWorkspace).revision
        : this.value
          ? legacyFingerprint(this.value)
          : null;
    if (revision !== expectedRevision) {
      return {
        committed: false,
        current: this.value === undefined ? null : structuredClone(this.value),
      };
    }
    this.value = structuredClone(value);
    return { committed: true, current: structuredClone(value) };
  }
  async forceWrite(value: StoredWorkspace): Promise<void> {
    this.value = structuredClone(value);
  }
}

function exampleDoc(): WorkspaceDocument {
  return {
    version: 1,
    activeProjectId: EXAMPLE_PROJECT.id,
    projects: [structuredClone(EXAMPLE_PROJECT)],
  };
}

describe("useLatencyLab cross-tab concurrency", () => {
  let storage: SharedMemoryStorage;

  beforeEach(() => {
    localStorage.clear();
    // 真实浏览器不会把 storage 事件投递给写入窗口；测试里统一靠手动 ping 模拟“对端收到通知”。
    remoteChangeTestControls.suppressInWindow = true;
    storage = new SharedMemoryStorage();
    storage.value = {
      envelope: 2,
      revision: "rev-initial",
      document: exampleDoc(),
    } satisfies StoredWorkspace;
  });

  afterEach(() => {
    remoteChangeTestControls.suppressInWindow = false;
    localStorage.clear();
  });

  const mountTab = (): RenderHookResult<Lab, unknown> =>
    renderHook(() =>
      useLatencyLab({
        createRepository: () => new ProjectRepository(storage),
      }),
    );

  const nodeValue = (tab: RenderHookResult<Lab, unknown>, id: string) =>
    tab.result.current.document?.projects[0]?.nodes.find(
      (item) => item.id === id,
    )?.durationMs;
  const storedDuration = (id: string) =>
    (storage.value as StoredWorkspace).document.projects[0]?.nodes.find(
      (item) => item.id === id,
    )?.durationMs;

  const edit = (
    tab: RenderHookResult<Lab, unknown>,
    id: string,
    durationMs: number,
  ) =>
    act(() => tab.result.current.patchNode(id, { durationMs }));

  const untilSaved = (tab: RenderHookResult<Lab, unknown>) =>
    waitFor(() => expect(tab.result.current.persisted).toBe("saved"));

  /** 模拟“其他标签页收到变更通知”：测试中自动通知已抑制，由这里精确投递。 */
  const ping = () => act(() => deliverRemoteChange());

  /** 等某标签页静默跟进到指定节点耗时。 */
  const untilFollows = (
    tab: RenderHookResult<Lab, unknown>,
    id: string,
    value: number,
  ) => waitFor(() => expect(nodeValue(tab, id)).toBe(value));

  it("auto-merges disjoint fields and raises an explainable conflict on the same field", async () => {
    const a = mountTab();
    const b = mountTab();
    await untilSaved(a);
    await untilSaved(b);

    // a 改耗时并保存；b 收到通知后静默跟进。
    edit(a, "session", 999);
    await untilSaved(a);
    ping();
    await untilFollows(b, "session", 999);

    // b 改的是另一个字段（超时）→ 自动合并。
    act(() => b.result.current.patchNode("session", { timeoutMs: 444 }));
    await untilSaved(b);
    expect(b.result.current.conflict).toBeNull();
    expect(storedDuration("session")).toBe(999);

    // 同字段双方都改：b 收不到通知（通知延迟），它的保存携带旧修订号被 CAS 拒绝。
    edit(a, "session", 111);
    await untilSaved(a);
    edit(b, "session", 222);
    await waitFor(() =>
      expect(b.result.current.persisted).toBe("conflict"),
    );
    expect(b.result.current.conflict?.conflicts[0]?.fields).toContain("耗时");
    // b 的过期草稿绝不能落盘。
    expect(storedDuration("session")).toBe(111);

    // 逐项选择“保留本页”合并保存：本侧耗时 222，对端超时 444 同时保留。
    const entryId = b.result.current.conflict!.conflicts[0]!.id;
    act(() =>
      b.result.current.resolveConflict({ [entryId]: "local" }),
    );
    await untilSaved(b);
    expect(storedDuration("session")).toBe(222);
    expect(
      (storage.value as StoredWorkspace).document.projects[0]?.nodes.find(
        (item) => item.id === "session",
      )?.timeoutMs,
    ).toBe(444);
  });

  it("keeps accepting edits while the conflict panel is open and never overwrites", async () => {
    const a = mountTab();
    const b = mountTab();
    await untilSaved(a);
    await untilSaved(b);

    edit(a, "flags", 303);
    await untilSaved(a);
    // 通知延迟：b 在跟进前先编辑并保存 → CAS 拒绝。
    edit(b, "flags", 404);
    await waitFor(() =>
      expect(b.result.current.persisted).toBe("conflict"),
    );

    // 面板打开期间继续编辑无关节点：界面立即反映，存储保持对端版本。
    edit(b, "catalog", 777);
    await waitFor(() =>
      expect(nodeValue(b, "catalog")).toBe(777),
    );
    expect(b.result.current.persisted).toBe("conflict");
    expect(storedDuration("catalog")).not.toBe(777);

    // flags 采用对端，catalog 的新编辑随合并一起保存。
    const entryId = b.result.current.conflict!.conflicts[0]!.id;
    act(() =>
      b.result.current.resolveConflict({ [entryId]: "remote" }),
    );
    await untilSaved(b);
    expect(storedDuration("catalog")).toBe(777);
    expect(storedDuration("flags")).toBe(303);
  });

  it("supports discarding local edits and informed force overwrite", async () => {
    const a = mountTab();
    const b = mountTab();
    await untilSaved(a);
    await untilSaved(b);

    edit(a, "flags", 303);
    await untilSaved(a);
    edit(b, "flags", 404);
    await waitFor(() =>
      expect(b.result.current.persisted).toBe("conflict"),
    );

    act(() => b.result.current.discardLocal());
    expect(b.result.current.persisted).toBe("saved");
    expect(nodeValue(b, "flags")).toBe(303);

    edit(a, "flags", 505);
    await untilSaved(a);
    edit(b, "flags", 606);
    await waitFor(() =>
      expect(b.result.current.persisted).toBe("conflict"),
    );
    await act(async () => {
      await b.result.current.forceOverwrite();
    });
    expect(b.result.current.persisted).toBe("saved");
    expect(storedDuration("flags")).toBe(606);
  });

  it("silently follows remote on tab switch when the tab has no unsaved edits", async () => {
    const a = mountTab();
    const b = mountTab();
    await untilSaved(a);
    await untilSaved(b);

    edit(a, "flags", 818);
    await untilSaved(a);
    ping();
    await untilFollows(b, "flags", 818);
    expect(b.result.current.conflict).toBeNull();
    expect(b.result.current.persisted).toBe("saved");
  });

  it("auto-merges a stale tab's dirty edits when they touch a different node", async () => {
    const a = mountTab();
    const b = mountTab();
    await untilSaved(a);
    await untilSaved(b);

    // a 先保存 flags。
    edit(a, "flags", 202);
    await untilSaved(a);

    // b 停在旧页面、本地有未保存的 catalog 改动时切回（收到通知）：自动合并并保存。
    edit(b, "catalog", 909);
    ping();
    await untilSaved(b);
    expect(b.result.current.conflict).toBeNull();
    expect(storedDuration("flags")).toBe(202);
    expect(storedDuration("catalog")).toBe(909);
  });
});
