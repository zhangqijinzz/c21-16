import { beforeEach, describe, expect, it } from "vitest";
import {
  ProjectRepository,
  SaveConflictError,
} from "../src/shared/repositories/projectRepository";
import { RevisionConflictError } from "../src/shared/services/indexedDbService";
import {
  EXAMPLE_PROJECT,
  type WorkspaceDocument,
} from "../src/shared/domain/types";

class MemoryStorage {
  value: unknown = undefined;
  failWrite = false;
  async read(): Promise<unknown> {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }
  /** 模拟 IndexedDB 单事务 compare-and-set。 */
  async conditionalWrite(
    value: WorkspaceDocument,
    expectedRevision: number | null,
  ): Promise<WorkspaceDocument> {
    if (this.failWrite) throw new Error("simulated IndexedDB quota failure");
    const stored = this.value as
      (WorkspaceDocument & { revision?: number }) | undefined;
    const exists = stored !== undefined;
    const matches =
      expectedRevision === null
        ? !exists
        : exists && (stored.revision ?? 0) === expectedRevision;
    if (!matches) {
      throw new RevisionConflictError(
        expectedRevision ?? 0,
        structuredClone(stored ?? value) as WorkspaceDocument,
      );
    }
    const revision = expectedRevision === null ? 1 : expectedRevision + 1;
    const written = { ...structuredClone(value), revision };
    this.value = written;
    return structuredClone(written);
  }
}

// MemoryStorage 与 RevisionConflictError 都在测试内模拟；让 repository 接受它。
const asStorage = (storage: MemoryStorage) =>
  storage as unknown as ConstructorParameters<typeof ProjectRepository>[0];

describe("project repository recovery", () => {
  beforeEach(() => localStorage.clear());

  it("provides a usable example when both stores are empty or damaged", async () => {
    const storage = new MemoryStorage();
    storage.value = { version: 99, projects: "broken" };
    const loaded = await new ProjectRepository(asStorage(storage)).load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.storeEmpty).toBe(false);
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.document.projects[0]?.nodes.length).toBeGreaterThan(0);
  });

  it("reports an empty store so the first save uses a null expected revision", async () => {
    const repository = new ProjectRepository(asStorage(new MemoryStorage()));
    const loaded = await repository.load();
    expect(loaded.storeEmpty).toBe(true);
    expect(loaded.document.revision).toBe(0);
    const written = await repository.save(loaded.document, null);
    expect(written.revision).toBe(1);
  });

  it("restores the local recovery copy when IndexedDB data is malformed", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(asStorage(storage));
    const document: WorkspaceDocument = {
      version: 1,
      revision: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [structuredClone(EXAMPLE_PROJECT)],
    };
    await repository.save(document, null);
    storage.value = { version: 1, projects: [{ id: 5, nodes: [] }] };
    const loaded = await repository.load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.document.projects[0]?.nodes).toHaveLength(
      EXAMPLE_PROJECT.nodes.length,
    );
  });

  it("keeps readable projects while dropping malformed project rows and broken edges", async () => {
    const storage = new MemoryStorage();
    storage.value = {
      version: 1,
      revision: 3,
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
    };
    const loaded = await new ProjectRepository(asStorage(storage)).load();
    expect(loaded.document.projects).toHaveLength(1);
    expect(loaded.document.projects[0]?.nodes).toHaveLength(1);
    expect(loaded.document.projects[0]?.nodes[0]?.dependencyIds).toEqual([]);
    expect(loaded.recovered).toBe(true);
  });

  it("keeps a local recovery copy when IndexedDB saving fails", async () => {
    const storage = new MemoryStorage();
    storage.failWrite = true;
    const repository = new ProjectRepository(asStorage(storage));
    const document: WorkspaceDocument = {
      version: 1,
      revision: 0,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [structuredClone(EXAMPLE_PROJECT)],
    };
    await expect(repository.save(document, null)).rejects.toThrow(
      "IndexedDB quota failure",
    );
    storage.failWrite = false;
    const loaded = await repository.load();
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.recovered).toBe(true);
  });
});

describe("optimistic concurrency", () => {
  beforeEach(() => localStorage.clear());

  it("migrates legacy documents without a revision and treats them as revision 0", async () => {
    const storage = new MemoryStorage();
    storage.value = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [structuredClone(EXAMPLE_PROJECT)],
    };
    const repository = new ProjectRepository(asStorage(storage));
    const loaded = await repository.load();
    expect(loaded.document.revision).toBe(0);
    expect(loaded.storeEmpty).toBe(false);
    const written = await repository.save(loaded.document, 0);
    expect(written.revision).toBe(1);
  });

  it("rejects a save based on a stale revision and returns the remote document", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(asStorage(storage));
    const first = await repository.load();
    await repository.save(first.document, null);

    // 另一个标签页先保存了 revision 2。
    const remote: WorkspaceDocument = {
      version: 1,
      revision: 1,
      activeProjectId: first.document.activeProjectId,
      projects: [
        {
          ...first.document.projects[0]!,
          title: "另一个标签页改过的名字",
        },
      ],
    };
    await repository.save(remote, 1);

    // 当前标签页仍基于 revision 1 保存旧内容 → 冲突。
    const stale: WorkspaceDocument = {
      ...first.document,
      revision: 1,
      projects: [{ ...first.document.projects[0]!, title: "当前标签页的名字" }],
    };
    await expect(repository.save(stale, 1)).rejects.toBeInstanceOf(
      SaveConflictError,
    );
    try {
      await repository.save(stale, 1);
      throw new Error("应当抛出冲突");
    } catch (error) {
      expect(error).toBeInstanceOf(SaveConflictError);
      const remoteDoc = (error as SaveConflictError)
        .remote as WorkspaceDocument;
      expect(remoteDoc.projects[0]?.title).toBe("另一个标签页改过的名字");
      expect(remoteDoc.revision).toBe(2);
    }
  });

  it("rejects the second first-save when the store was empty for both tabs", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(asStorage(storage));
    const doc = (await repository.load()).document;
    const written = await repository.save(doc, null);
    expect(written.revision).toBe(1);
    // 另一个同样看到空库的标签页也用 null 期望保存 → 必须失败。
    await expect(repository.save(doc, null)).rejects.toBeInstanceOf(
      SaveConflictError,
    );
  });

  it("accepts sequential saves that chain the returned revision", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(asStorage(storage));
    let current = (await repository.load()).document;
    current = await repository.save(current, null);
    current = await repository.save(
      { ...current, projects: [{ ...current.projects[0]!, title: "第二步" }] },
      current.revision,
    );
    expect(current.revision).toBe(2);
    const reloaded = await repository.load();
    expect(reloaded.document.projects[0]?.title).toBe("第二步");
  });
});
