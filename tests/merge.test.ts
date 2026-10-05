import { describe, expect, it } from "vitest";
import { mergeWorkspaces } from "../src/shared/domain/merge";
import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type WorkspaceDocument,
} from "../src/shared/domain/types";

function doc(project: LatencyProject): WorkspaceDocument {
  return {
    version: 1,
    activeProjectId: project.id,
    projects: [project],
  };
}

const base = (): WorkspaceDocument => doc(structuredClone(EXAMPLE_PROJECT));

function withProject(
  document: WorkspaceDocument,
  patch: Partial<LatencyProject>,
): WorkspaceDocument {
  const project = document.projects[0]!;
  return doc({ ...project, ...patch, updatedAt: project.updatedAt + 10 });
}

describe("three-way workspace merge", () => {
  it("takes the only side that changed for scalar fields, without conflicts", () => {
    const local = withProject(base(), { title: "本端标题" });
    const remote = withProject(base(), { concurrencyLimit: 4 });
    const result = mergeWorkspaces(base(), local, remote);
    expect(result.report.conflicts).toHaveLength(0);
    const merged = result.document.projects[0]!;
    expect(merged.title).toBe("本端标题");
    expect(merged.concurrencyLimit).toBe(4);
  });

  it("flags both-changed on the same field and defaults to the local value", () => {
    const local = withProject(base(), { title: "本端标题" });
    const remote = withProject(base(), { title: "对端标题" });
    const result = mergeWorkspaces(base(), local, remote);
    expect(result.report.conflicts).toHaveLength(1);
    expect(result.report.conflicts[0]?.scope).toBe("project");
    expect(result.report.conflicts[0]?.fields).toContain("标题");
    expect(result.document.projects[0]?.title).toBe("本端标题");

    const remoteWins = mergeWorkspaces(base(), local, remote, {
      "project:project-latency-demo": "remote",
    });
    expect(remoteWins.document.projects[0]?.title).toBe("对端标题");
  });

  it("resolves field-level choices independently within the same node", () => {
    const tweak = (
      document: WorkspaceDocument,
      durationMs: number,
      timeoutMs: number,
    ): WorkspaceDocument =>
      withProject(document, {
        nodes: document.projects[0]!.nodes.map((node) =>
          node.id === "session"
            ? { ...node, durationMs, timeoutMs }
            : node,
        ),
      });
    // base 耗时 280/超时 800：两侧同时改这两个字段为不同值。
    const local = tweak(base(), 999, 801);
    const remote = tweak(base(), 281, 400);
    const result = mergeWorkspaces(base(), local, remote, {
      "node:project-latency-demo:session:durationMs": "local",
      "node:project-latency-demo:session:timeoutMs": "remote",
    });
    const node = result.document.projects[0]?.nodes.find(
      (item) => item.id === "session",
    );
    expect(node?.durationMs).toBe(999);
    expect(node?.timeoutMs).toBe(400);
    const entry = result.report.conflicts.find(
      (conflict) => conflict.id === "node:project-latency-demo:session",
    );
    expect(entry?.fields).toEqual(expect.arrayContaining(["耗时", "超时"]));
  });

  it("unions dependency edges added on both sides and honors deletions agreed by both", () => {
    const editDeps = (
      document: WorkspaceDocument,
      fn: (ids: string[]) => string[],
    ): WorkspaceDocument =>
      withProject(document, {
        nodes: document.projects[0]!.nodes.map((node) =>
          node.id === "profile"
            ? { ...node, dependencyIds: fn(node.dependencyIds) }
            : node,
        ),
      });
    // base: profile -> [session]。本端新增 flags；对端新增 catalog。
    const local = editDeps(base(), (ids) => [...ids, "flags"]);
    const remote = editDeps(base(), (ids) => [...ids, "catalog"]);
    const result = mergeWorkspaces(base(), local, remote);
    expect(result.report.conflicts).toHaveLength(0);
    const profile = result.document.projects[0]?.nodes.find(
      (node) => node.id === "profile",
    );
    expect(profile?.dependencyIds.slice().sort()).toEqual([
      "catalog",
      "flags",
      "session",
    ]);

    // 两侧都删除 session 边才真正删除。
    const localRemoved = editDeps(base(), () => ["flags"]);
    const remoteRemoved = editDeps(base(), () => ["catalog"]);
    const union = mergeWorkspaces(base(), localRemoved, remoteRemoved);
    expect(
      union.document.projects[0]?.nodes.find((node) => node.id === "profile")
        ?.dependencyIds.sort(),
    ).toEqual(["catalog", "flags"]);
  });

  it("reports edit-delete when one side deletes a node the other side edited", () => {
    const local = withProject(base(), {
      nodes: base().projects[0]!.nodes.filter((node) => node.id !== "flags"),
    });
    const remote = withProject(base(), {
      nodes: base().projects[0]!.nodes.map((node) =>
        node.id === "flags" ? { ...node, durationMs: 333 } : node,
      ),
    });
    const result = mergeWorkspaces(base(), local, remote);
    expect(result.report.conflicts).toHaveLength(1);
    const entry = result.report.conflicts[0]!;
    expect(entry.kind).toBe("edit-delete");
    expect(entry.deletedBy).toBe("local");
    // 默认保留本侧 → 节点保持删除
    expect(
      result.document.projects[0]?.nodes.some((node) => node.id === "flags"),
    ).toBe(false);
    // 选择对端 → 编辑内容回来
    const keep = mergeWorkspaces(base(), local, remote, {
      "node:project-latency-demo:flags": "remote",
    });
    const restored = keep.document.projects[0]?.nodes.find(
      (node) => node.id === "flags",
    );
    expect(restored?.durationMs).toBe(333);
  });

  it("respects a single-side delete when the other side did not touch the node", () => {
    const local = withProject(base(), {
      nodes: base().projects[0]!.nodes.filter((node) => node.id !== "flags"),
    });
    const result = mergeWorkspaces(base(), local, base());
    expect(result.report.conflicts).toHaveLength(0);
    expect(
      result.document.projects[0]?.nodes.some((node) => node.id === "flags"),
    ).toBe(false);
  });

  it("merges nodes added independently on each side", () => {
    const local = withProject(base(), {
      nodes: [
        ...base().projects[0]!.nodes,
        {
          id: "local-only",
          name: "本端新增",
          durationMs: 100,
          jitterMs: 0,
          dependencyIds: [],
          timeoutMs: 500,
          retryCount: 0,
          failureRate: 0,
        },
      ],
    });
    const remote = withProject(base(), {
      nodes: [
        ...base().projects[0]!.nodes,
        {
          id: "remote-only",
          name: "对端新增",
          durationMs: 200,
          jitterMs: 0,
          dependencyIds: [],
          timeoutMs: 500,
          retryCount: 0,
          failureRate: 0,
        },
      ],
    });
    const result = mergeWorkspaces(base(), local, remote);
    expect(result.report.conflicts).toHaveLength(0);
    const ids = result.document.projects[0]?.nodes.map((node) => node.id);
    expect(ids).toContain("local-only");
    expect(ids).toContain("remote-only");
    expect(result.report.autoChanges.some((c) => c.detail.includes("新增"))).toBe(
      true,
    );
  });

  it("merges whole projects added independently and resolves project edit-delete", () => {
    const extra = (title: string): LatencyProject => ({
      id: `project-${title}`,
      title,
      nodes: [],
      concurrencyLimit: null,
      scenarios: [],
      createdAt: 1,
      updatedAt: 1,
    });
    const local: WorkspaceDocument = {
      ...base(),
      projects: [...base().projects, extra("本端项目")],
    };
    const remote: WorkspaceDocument = {
      ...base(),
      projects: [...base().projects, extra("对端项目")],
    };
    const merged = mergeWorkspaces(base(), local, remote);
    expect(merged.report.conflicts).toHaveLength(0);
    expect(merged.document.projects.map((p) => p.title).sort()).toEqual([
      EXAMPLE_PROJECT.title,
      "对端项目",
      "本端项目",
    ]);

    // 一侧删项目，另一侧改了它 → edit-delete
    const deleted = { ...base(), projects: [] };
    const edited = withProject(base(), { title: "对端改过" });
    const conflict = mergeWorkspaces(base(), deleted, edited);
    expect(conflict.report.conflicts[0]?.kind).toBe("edit-delete");
  });

  it("prunes edges that point at nodes removed on one side", () => {
    // 对端删除 profile；本端没动 recommend 的依赖（仍引用 profile）。
    const remote = withProject(base(), {
      nodes: base().projects[0]!.nodes.filter((node) => node.id !== "profile"),
    });
    const local = withProject(base(), { title: "本端只改标题" });
    const result = mergeWorkspaces(base(), local, remote);
    expect(result.report.conflicts).toHaveLength(0);
    const recommend = result.document.projects[0]?.nodes.find(
      (node) => node.id === "recommend",
    );
    expect(recommend?.dependencyIds).not.toContain("profile");
  });

  it("keeps local active project selection without surfacing a conflict", () => {
    const extra: LatencyProject = {
      id: "project-other",
      title: "另一个",
      nodes: [],
      concurrencyLimit: null,
      scenarios: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const shared: WorkspaceDocument = {
      ...base(),
      activeProjectId: "project-other",
      projects: [extra, ...base().projects],
    };
    // 共同祖先停在 extra：本侧切到示例项目，对端保持原选择 → 应跟随本侧。
    const local = { ...shared, activeProjectId: EXAMPLE_PROJECT.id };
    const remote = { ...shared, activeProjectId: "project-other" };
    const result = mergeWorkspaces(shared, local, remote);
    expect(result.report.conflicts).toHaveLength(0);
    expect(result.document.activeProjectId).toBe(EXAMPLE_PROJECT.id);
  });
});
