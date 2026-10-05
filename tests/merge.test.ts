import { describe, expect, it } from "vitest";
import { deepEqual, mergeDocuments } from "../src/shared/domain/merge";
import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type RequestNode,
  type WorkspaceDocument,
} from "../src/shared/domain/types";

function doc(projects: LatencyProject[], revision = 1): WorkspaceDocument {
  return {
    version: 1,
    revision,
    activeProjectId: projects[0]?.id ?? "",
    projects,
  };
}

function cloneProject(): LatencyProject {
  return structuredClone(EXAMPLE_PROJECT);
}

function nodePatch(
  project: LatencyProject,
  nodeId: string,
  patch: Partial<RequestNode>,
): LatencyProject {
  return {
    ...project,
    nodes: project.nodes.map((node) =>
      node.id === nodeId ? { ...node, ...patch } : node,
    ),
  };
}

describe("deepEqual", () => {
  it("compares nested arrays and objects", () => {
    expect(deepEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
    expect(deepEqual([1, { x: 1 }], [1, { x: 1 }])).toBe(true);
  });
});

describe("three-way document merge", () => {
  it("keeps the other side verbatim when one side is untouched", () => {
    const base = doc([cloneProject()]);
    const theirs = doc(
      [nodePatch(cloneProject(), "session", { durationMs: 900 })],
      2,
    );
    const outcome = mergeDocuments(base, base, theirs);
    expect(outcome.conflicts).toHaveLength(0);
    expect(outcome.document.projects[0]?.nodes[0]?.durationMs).toBe(900);
    expect(outcome.autoChanges.join(" ")).toContain("耗时");
  });

  it("auto-merges non-overlapping node edits on the two sides", () => {
    const project = cloneProject();
    const base = doc([project]);
    const ours = doc(
      [nodePatch(cloneProject(), "session", { durationMs: 333 })],
      2,
    );
    const theirs = doc(
      [nodePatch(cloneProject(), "flags", { timeoutMs: 999 })],
      3,
    );
    const outcome = mergeDocuments(base, ours, theirs);
    expect(outcome.conflicts).toHaveLength(0);
    const mergedProject = outcome.document.projects[0]!;
    expect(
      mergedProject.nodes.find((node) => node.id === "session")?.durationMs,
    ).toBe(333);
    expect(
      mergedProject.nodes.find((node) => node.id === "flags")?.timeoutMs,
    ).toBe(999);
  });

  it("auto-merges when the same field ends up with the same value", () => {
    const base = doc([cloneProject()]);
    const ours = doc(
      [nodePatch(cloneProject(), "session", { durationMs: 500 })],
      2,
    );
    const theirs = doc(
      [nodePatch(cloneProject(), "session", { durationMs: 500 })],
      3,
    );
    const outcome = mergeDocuments(base, ours, theirs);
    expect(outcome.conflicts).toHaveLength(0);
    expect(outcome.document.projects[0]?.nodes[0]?.durationMs).toBe(500);
  });

  it("reports a single field conflict when both sides change the same field", () => {
    const base = doc([cloneProject()]);
    const ours = doc(
      [nodePatch(cloneProject(), "session", { durationMs: 333 })],
      2,
    );
    const theirs = doc(
      [nodePatch(cloneProject(), "session", { durationMs: 777 })],
      3,
    );
    const outcome = mergeDocuments(base, ours, theirs);
    expect(outcome.conflicts).toHaveLength(1);
    const conflict = outcome.conflicts[0]!;
    expect(conflict.field).toBe("durationMs");
    expect(conflict.nodeId).toBe("session");
    expect(conflict.oursDisplay).toContain("333");
    expect(conflict.theirsDisplay).toContain("777");
  });

  it("resolves conflicts per resolver choice and keeps conflict ids stable across recompute", () => {
    const base = doc([cloneProject()]);
    const makeEdits = (duration: number, timeout: number) =>
      doc(
        [
          nodePatch(
            nodePatch(cloneProject(), "session", { durationMs: duration }),
            "session",
            { timeoutMs: timeout },
          ),
        ],
        2,
      );
    const ours = makeEdits(333, 800);
    const theirs = makeEdits(777, 1200);
    const first = mergeDocuments(base, ours, theirs, () => "ours");
    const second = mergeDocuments(base, ours, theirs, () => "theirs");
    expect(first.conflicts.map((c) => c.id)).toEqual(
      second.conflicts.map((c) => c.id),
    );
    expect(first.document.projects[0]?.nodes[0]?.durationMs).toBe(333);
    expect(second.document.projects[0]?.nodes[0]?.durationMs).toBe(777);
    expect(second.document.projects[0]?.nodes[0]?.timeoutMs).toBe(1200);
  });

  it("merges a node added on one side with an edit on the other", () => {
    const project = cloneProject();
    const base = doc([project]);
    const added: RequestNode = {
      id: "new-node",
      name: "新增节点",
      durationMs: 100,
      jitterMs: 0,
      dependencyIds: [],
      timeoutMs: 500,
      retryCount: 0,
      failureRate: 0,
    };
    const oursProject = cloneProject();
    oursProject.nodes = [...oursProject.nodes, added];
    const ours = doc([oursProject], 2);
    const theirs = doc(
      [nodePatch(cloneProject(), "flags", { failureRate: 4 })],
      3,
    );
    const outcome = mergeDocuments(base, ours, theirs);
    expect(outcome.conflicts).toHaveLength(0);
    const merged = outcome.document.projects[0]!;
    expect(merged.nodes.some((node) => node.id === "new-node")).toBe(true);
    expect(merged.nodes.find((node) => node.id === "flags")?.failureRate).toBe(
      4,
    );
  });

  it("deletes cleanly when one side deletes a node the other side left untouched", () => {
    const base = doc([cloneProject()]);
    const oursProject = cloneProject();
    oursProject.nodes = oursProject.nodes.filter((node) => node.id !== "flags");
    const ours = doc([oursProject], 2);
    const theirs = doc([cloneProject()], 3);
    const outcome = mergeDocuments(base, ours, theirs);
    expect(outcome.conflicts).toHaveLength(0);
    expect(
      outcome.document.projects[0]?.nodes.some((node) => node.id === "flags"),
    ).toBe(false);
  });

  it("conflicts when one side deletes a node the other side modified", () => {
    const base = doc([cloneProject()]);
    const oursProject = cloneProject();
    oursProject.nodes = oursProject.nodes.filter(
      (node) => node.id !== "session",
    );
    const ours = doc([oursProject], 2);
    const theirs = doc(
      [nodePatch(cloneProject(), "session", { durationMs: 100 })],
      3,
    );
    const deleted = mergeDocuments(base, ours, theirs, () => "ours");
    expect(deleted.conflicts[0]?.field).toBe("__presence");
    expect(
      deleted.document.projects[0]?.nodes.some((node) => node.id === "session"),
    ).toBe(false);
    const kept = mergeDocuments(base, ours, theirs, () => "theirs");
    expect(
      kept.document.projects[0]?.nodes.find((node) => node.id === "session")
        ?.durationMs,
    ).toBe(100);
  });

  it("takes the union of scenario snapshots added on different sides", () => {
    const base = doc([cloneProject()]);
    const oursProject = cloneProject();
    oursProject.scenarios = [
      {
        id: "s-ours",
        name: "我方快照",
        createdAt: 10,
        concurrencyLimit: null,
        nodes: [],
        completionMs: 100,
        criticalPath: [],
      },
    ];
    const theirsProject = cloneProject();
    theirsProject.scenarios = [
      {
        id: "s-theirs",
        name: "对方快照",
        createdAt: 20,
        concurrencyLimit: null,
        nodes: [],
        completionMs: 200,
        criticalPath: [],
      },
    ];
    const outcome = mergeDocuments(
      base,
      doc([oursProject], 2),
      doc([theirsProject], 3),
    );
    const ids = outcome.document.projects[0]?.scenarios.map((s) => s.id);
    expect(ids).toContain("s-ours");
    expect(ids).toContain("s-theirs");
  });

  it("unions projects added separately on the two sides", () => {
    const projectA = cloneProject();
    const projectB: LatencyProject = {
      ...cloneProject(),
      id: "project-other",
      title: "另一个项目",
    };
    const base = doc([projectA]);
    const ours = doc([{ ...cloneProject(), title: "我方改名" }], 2);
    const theirs = doc([cloneProject(), projectB], 3);
    const outcome = mergeDocuments(base, ours, theirs);
    expect(outcome.conflicts).toHaveLength(0);
    expect(outcome.document.projects.map((p) => p.id).sort()).toEqual(
      [EXAMPLE_PROJECT.id, "project-other"].sort(),
    );
    expect(outcome.document.projects[0]?.title).toBe("我方改名");
  });

  it("keeps local edits while continuing to edit during conflict resolution", () => {
    // 冲突出现后用户继续在本地改了第三个字段，重算必须包含新改动。
    const base = doc([cloneProject()]);
    const conflictOurs = doc(
      [nodePatch(cloneProject(), "session", { durationMs: 333 })],
      2,
    );
    const theirs = doc(
      [nodePatch(cloneProject(), "session", { durationMs: 777 })],
      3,
    );
    const first = mergeDocuments(base, conflictOurs, theirs);
    expect(first.conflicts).toHaveLength(1);

    const continued = doc(
      [
        nodePatch(
          nodePatch(cloneProject(), "session", { durationMs: 333 }),
          "flags",
          { retryCount: 2 },
        ),
      ],
      2,
    );
    const recomputed = mergeDocuments(base, continued, theirs);
    expect(recomputed.conflicts).toHaveLength(1);
    expect(
      recomputed.document.projects[0]?.nodes.find((n) => n.id === "flags")
        ?.retryCount,
    ).toBe(2);
  });
});
