import { beforeEach, describe, expect, it } from "vitest";
import { ProjectRepository } from "../src/shared/repositories/projectRepository";
import type { CommitOutcome } from "../src/shared/services/indexedDbService";
import {
  EXAMPLE_PROJECT,
  newRevision,
  type StoredWorkspace,
  type WorkspaceDocument,
} from "../src/shared/domain/types";
import { legacyFingerprint } from "../src/shared/domain/fingerprint";

class MemoryStorage {
  value: unknown = undefined;
  failWrite = false;

  async read(): Promise<unknown> {
    return this.value === undefined
      ? undefined
      : structuredClone(this.value);
  }

  async commit(
    value: StoredWorkspace,
    expectedRevision: string | null,
  ): Promise<CommitOutcome> {
    if (this.failWrite) throw new Error("simulated IndexedDB quota failure");
    const currentRevision =
      this.value &&
      typeof this.value === "object" &&
      (this.value as { envelope?: unknown }).envelope === 2
        ? (this.value as StoredWorkspace).revision
        : this.value
          ? legacyFingerprint(this.value)
          : null;
    if (currentRevision !== expectedRevision) {
      return {
        committed: false,
        current: this.value === undefined ? null : structuredClone(this.value),
      };
    }
    this.value = structuredClone(value);
    return { committed: true, current: structuredClone(value) };
  }

  async forceWrite(value: StoredWorkspace): Promise<void> {
    if (this.failWrite) throw new Error("simulated IndexedDB quota failure");
    this.value = structuredClone(value);
  }
}

function envelope(document: WorkspaceDocument): StoredWorkspace {
  return { envelope: 2, revision: newRevision(), document };
}

describe("project repository recovery", () => {
  beforeEach(() => localStorage.clear());

  it("provides a usable example when both stores are empty or damaged", async () => {
    const storage = new MemoryStorage();
    storage.value = { version: 99, projects: "broken" };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.stored?.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.stored?.document.projects[0]?.nodes.length).toBeGreaterThan(
      0,
    );
  });

  it("restores the local recovery copy when IndexedDB data is malformed", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const stored = envelope({
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [structuredClone(EXAMPLE_PROJECT)],
    });
    const first = await repository.save(stored.document, null);
    expect(first.kind).toBe("committed");
    storage.value = { version: 1, projects: [{ id: 5, nodes: [] }] };
    const loaded = await repository.load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.stored?.document.projects[0]?.nodes).toHaveLength(
      EXAMPLE_PROJECT.nodes.length,
    );
  });

  it("keeps readable projects while dropping malformed project rows and broken edges", async () => {
    const storage = new MemoryStorage();
    storage.value = {
      envelope: 2,
      revision: "rev-1",
      document: {
        version: 1,
        activeProjectId: EXAMPLE_PROJECT.id,
        projects: [
          {
            ...EXAMPLE_PROJECT,
            nodes: [
              { ...EXAMPLE_PROJECT.nodes[0], dependencyIds: ["missing"] },
              { damaged: true },
            ],
          },
          { id: 9, title: null },
        ],
      },
    };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.stored?.document.projects).toHaveLength(1);
    expect(loaded.stored?.document.projects[0]?.nodes).toHaveLength(1);
    expect(
      loaded.stored?.document.projects[0]?.nodes[0]?.dependencyIds,
    ).toEqual([]);
    expect(loaded.recovered).toBe(true);
  });

  it("keeps a local recovery copy when IndexedDB saving fails", async () => {
    const storage = new MemoryStorage();
    storage.failWrite = true;
    const repository = new ProjectRepository(storage);
    const document: WorkspaceDocument = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [structuredClone(EXAMPLE_PROJECT)],
    };
    await expect(repository.save(document, null)).rejects.toThrow(
      "IndexedDB quota failure",
    );
    storage.failWrite = false;
    const loaded = await repository.load();
    // 主存储失败时写入应急镜像，数据仍可恢复。
    expect(loaded.stored.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.recovered).toBe(true);
  });
});

describe("optimistic concurrency", () => {
  beforeEach(() => localStorage.clear());

  it("commits against the expected revision and rejects stale writes", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const initial: WorkspaceDocument = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [structuredClone(EXAMPLE_PROJECT)],
    };
    const first = await repository.save(initial, null);
    expect(first.kind).toBe("committed");

    const remoteDoc: WorkspaceDocument = {
      ...initial,
      projects: [{ ...initial.projects[0]!, title: "对端改过的标题" }],
    };
    const remote = await repository.save(remoteDoc, first.revision);
    expect(remote.kind).toBe("committed");

    // 拿着旧修订号的过期写入必须被拒绝，并带回对端最新内容。
    const staleDoc: WorkspaceDocument = {
      ...initial,
      projects: [{ ...initial.projects[0]!, title: "本端过期改动" }],
    };
    const rejected = await repository.save(staleDoc, first.revision);
    expect(rejected.kind).toBe("conflict");
    expect(rejected.remote?.revision).toBe(remote.revision);
    expect(rejected.remote?.document.projects[0]?.title).toBe(
      "对端改过的标题",
    );
    // 存储内容没有被过期写入覆盖。
    const stored = storage.value as StoredWorkspace;
    expect(stored.document.projects[0]?.title).toBe("对端改过的标题");
  });

  it("upgrades legacy bare documents transparently using a content fingerprint", async () => {
    const storage = new MemoryStorage();
    const legacyDoc: WorkspaceDocument = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [structuredClone(EXAMPLE_PROJECT)],
    };
    storage.value = structuredClone(legacyDoc);
    const repository = new ProjectRepository(storage);
    const loaded = await repository.load();
    expect(loaded.stored?.revision).toBe(legacyFingerprint(legacyDoc));

    // 以指纹为期望修订号写入，自动升级为信封，不报冲突。
    const nextDoc: WorkspaceDocument = {
      ...legacyDoc,
      projects: [{ ...legacyDoc.projects[0]!, title: "升级后的标题" }],
    };
    const outcome = await repository.save(
      nextDoc,
      loaded.stored?.revision ?? null,
    );
    expect(outcome.kind).toBe("committed");
    expect((storage.value as StoredWorkspace).envelope).toBe(2);
  });

  it("forceSave overwrites regardless of the current revision", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const initial: WorkspaceDocument = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [structuredClone(EXAMPLE_PROJECT)],
    };
    const first = await repository.save(initial, null);
    expect(first.kind).toBe("committed");
    await repository.save(
      {
        ...initial,
        projects: [{ ...initial.projects[0]!, title: "对端" }],
      },
      first.revision,
    );
    const revision = await repository.forceSave({
      ...initial,
      projects: [{ ...initial.projects[0]!, title: "强制覆盖" }],
    });
    expect((storage.value as StoredWorkspace).revision).toBe(revision);
    expect((storage.value as StoredWorkspace).document.projects[0]?.title).toBe(
      "强制覆盖",
    );
  });
});
