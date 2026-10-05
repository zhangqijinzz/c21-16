import type {
  LatencyProject,
  RequestNode,
  ScenarioSnapshot,
  WorkspaceDocument,
} from "./types";

/**
 * 三方合并（3-way merge）。
 *
 * base 是两个标签页共同的已保存版本，ours / theirs 分别是两侧在此基础上
 * 产生的改动。只有双方修改了同一个字段（或一方删除、另一方修改同一实体）
 * 时才产生冲突；非重叠改动自动合并，并在 autoChanges 中留下可解释清单。
 */

export type ConflictSide = "ours" | "theirs";
export type ConflictResolver = (conflict: MergeConflict) => ConflictSide;

export interface MergeConflict {
  /** 跨重算稳定的标识：项目/节点/字段路径，用户选择按此 id 记住。 */
  id: string;
  scope: "document" | "project" | "node";
  projectId: string;
  projectTitle: string;
  nodeId?: string;
  nodeName?: string;
  /** __presence 表示删除/修改之争，其余为字段键名。 */
  field: string;
  fieldLabel: string;
  oursDisplay: string;
  theirsDisplay: string;
  /** 我方动作描述，例如“删除此节点”或“改为 300 ms”。 */
  oursAction: string;
  theirsAction: string;
}

export interface MergeOutcome {
  document: WorkspaceDocument;
  conflicts: MergeConflict[];
  autoChanges: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 结构化深比较：存储内容均为可 JSON 序列化的普通数据。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length &&
      a.every((item, index) => deepEqual(item, b[index]))
    );
  }
  if (isObject(a) && isObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        deepEqual(a[key], b[key]),
    );
  }
  return false;
}

function mergeScalar<T>(
  base: T,
  ours: T,
  theirs: T,
): { value: T; conflict: boolean } {
  if (deepEqual(ours, theirs)) return { value: ours, conflict: false };
  if (deepEqual(ours, base)) return { value: theirs, conflict: false };
  if (deepEqual(theirs, base)) return { value: ours, conflict: false };
  return { value: ours, conflict: true };
}

const PROJECT_FIELD_LABELS: Record<string, string> = {
  title: "项目名称",
  concurrencyLimit: "并发上限",
};

const NODE_FIELD_LABELS: Record<keyof RequestNode, string> = {
  id: "节点标识",
  name: "节点名称",
  durationMs: "耗时",
  jitterMs: "波动",
  timeoutMs: "超时",
  dependencyIds: "前置依赖",
  retryCount: "重试次数",
  failureRate: "失败率",
  fallbackNodeId: "降级目标",
};

function formatScalar(field: string, value: unknown): string {
  if (field === "concurrencyLimit")
    return value === null || value === undefined ? "不限" : String(value);
  if (field === "durationMs" || field === "jitterMs" || field === "timeoutMs")
    return `${String(value)} ms`;
  if (field === "failureRate") return `${String(value)}%`;
  if (value === undefined || value === null || value === "") return "未设置";
  return String(value);
}

function nodeNameOf(
  project: LatencyProject | undefined,
  nodeId: string | undefined,
): string {
  if (!nodeId) return "无依赖";
  const node = project?.nodes.find((item) => item.id === nodeId);
  return node ? node.name : "未知节点";
}

function formatNodeField(
  field: string,
  value: unknown,
  project: LatencyProject,
): string {
  if (field === "fallbackNodeId")
    return nodeNameOf(project, value as string | undefined);
  if (field === "dependencyIds" && Array.isArray(value)) {
    if (value.length === 0) return "无依赖";
    return value.map((id) => nodeNameOf(project, id as string)).join("、");
  }
  return formatScalar(field, value);
}

function actionText(field: string, value: unknown, project?: LatencyProject) {
  if (project) return `改为 ${formatNodeField(field, value, project)}`;
  return `改为 ${formatScalar(field, value)}`;
}

type ProjectInfo = Omit<
  MergeConflict,
  | "field"
  | "fieldLabel"
  | "oursDisplay"
  | "theirsDisplay"
  | "oursAction"
  | "theirsAction"
>;

interface MergeContext {
  conflicts: MergeConflict[];
  autoChanges: string[];
  resolver: ConflictResolver;
}

/** 描述单个节点相对 base 的字段改动。 */
function describeNodeDiff(
  baseProject: LatencyProject,
  before: RequestNode,
  after: RequestNode,
): string[] {
  const out: string[] = [];
  const fields = Object.keys(NODE_FIELD_LABELS) as (keyof RequestNode)[];
  for (const field of fields) {
    if (field === "id" || deepEqual(before[field], after[field])) continue;
    if (field === "fallbackNodeId") {
      out.push(
        `${baseProject.title} / ${after.name} · 降级目标合入对方（${nodeNameOf(baseProject, after.fallbackNodeId)}）`,
      );
    } else if (field === "dependencyIds") {
      out.push(
        `${baseProject.title} / ${after.name} · 前置依赖合入对方（${formatNodeField(field, after[field], baseProject)}）`,
      );
    } else {
      out.push(
        `${baseProject.title} / ${after.name} · ${NODE_FIELD_LABELS[field]} 合入对方（${formatScalar(field, after[field])}）`,
      );
    }
  }
  return out;
}

/** 描述 next 相对 base 的项目级改动，用于自动合并后的解释清单。 */
function describeProjectDiff(
  base: LatencyProject,
  next: LatencyProject,
): string[] {
  const out: string[] = [];
  const label = (text: string) => `${next.title} · ${text}`;
  if (base.title !== next.title)
    out.push(label(`项目名称 ${base.title} → ${next.title}`));
  if (base.concurrencyLimit !== next.concurrencyLimit)
    out.push(
      label(
        `并发上限 ${base.concurrencyLimit ?? "不限"} → ${next.concurrencyLimit ?? "不限"}`,
      ),
    );
  const baseNodes = new Map(base.nodes.map((node) => [node.id, node]));
  const nextNodes = new Map(next.nodes.map((node) => [node.id, node]));
  for (const node of next.nodes) {
    const before = baseNodes.get(node.id);
    if (!before) {
      out.push(label(`新增节点 ${node.name}`));
      continue;
    }
    const fields = Object.keys(NODE_FIELD_LABELS) as (keyof RequestNode)[];
    for (const field of fields) {
      if (field === "id" || deepEqual(before[field], node[field])) continue;
      if (field === "fallbackNodeId") {
        out.push(
          label(
            `${node.name} · 降级目标 ${nodeNameOf(base, before.fallbackNodeId)} → ${nodeNameOf(next, node.fallbackNodeId)}`,
          ),
        );
      } else if (field === "dependencyIds") {
        out.push(label(`${node.name} · 前置依赖已调整`));
      } else {
        out.push(
          label(
            `${node.name} · ${NODE_FIELD_LABELS[field]} ${formatScalar(field, before[field])} → ${formatScalar(field, node[field])}`,
          ),
        );
      }
    }
  }
  for (const node of base.nodes) {
    if (!nextNodes.has(node.id)) out.push(label(`删除节点 ${node.name}`));
  }
  const baseScenarioNames = new Map(
    base.scenarios.map((scenario) => [scenario.id, scenario.name]),
  );
  const nextScenarioNames = new Map(
    next.scenarios.map((scenario) => [scenario.id, scenario.name]),
  );
  for (const scenario of next.scenarios) {
    if (!baseScenarioNames.has(scenario.id))
      out.push(label(`新增方案快照 ${scenario.name}`));
  }
  for (const scenario of base.scenarios) {
    if (!nextScenarioNames.has(scenario.id))
      out.push(label(`删除方案快照 ${scenario.name}`));
  }
  return out;
}

function mergeNodeFields(
  base: RequestNode | undefined,
  ours: RequestNode,
  theirs: RequestNode,
  baseProject: LatencyProject,
  info: ProjectInfo,
  ctx: MergeContext,
): RequestNode {
  const merged: RequestNode = { ...ours };
  const fields = Object.keys(NODE_FIELD_LABELS) as (keyof RequestNode)[];
  for (const field of fields) {
    if (field === "id") continue;
    const oValue = ours[field];
    const tValue = theirs[field];
    const bothSidesEqual = deepEqual(oValue, tValue);
    const oursUntouched = base !== undefined && deepEqual(oValue, base[field]);
    const theirsUntouched =
      base !== undefined && deepEqual(tValue, base[field]);
    if (bothSidesEqual || theirsUntouched) {
      (merged as unknown as Record<string, unknown>)[field] = oValue;
      continue;
    }
    if (oursUntouched) {
      (merged as unknown as Record<string, unknown>)[field] = tValue;
      ctx.autoChanges.push(
        `${baseProject.title} / ${ours.name} · ${NODE_FIELD_LABELS[field]} 合入对方（${formatNodeField(field, tValue, baseProject)}）`,
      );
      continue;
    }
    const id = `${info.id}:node:${ours.id}:${field}`;
    const entry: MergeConflict = {
      ...info,
      id,
      nodeId: ours.id,
      nodeName: ours.name,
      field,
      fieldLabel: NODE_FIELD_LABELS[field],
      oursDisplay: formatNodeField(field, oValue, baseProject),
      theirsDisplay: formatNodeField(field, tValue, baseProject),
      oursAction: actionText(field, oValue, baseProject),
      theirsAction: actionText(field, tValue, baseProject),
    };
    ctx.conflicts.push(entry);
    (merged as unknown as Record<string, unknown>)[field] =
      ctx.resolver(entry) === "ours" ? oValue : tValue;
  }
  return merged;
}

function mergeNodes(
  baseProject: LatencyProject,
  base: RequestNode[],
  ours: RequestNode[],
  theirs: RequestNode[],
  projectInfo: ProjectInfo,
  ctx: MergeContext,
): RequestNode[] {
  const oursMap = new Map(ours.map((node) => [node.id, node]));
  const theirsMap = new Map(theirs.map((node) => [node.id, node]));
  const baseIds = new Set(base.map((node) => node.id));
  const info: ProjectInfo = { ...projectInfo, scope: "node" };
  const result: RequestNode[] = [];

  const resolvePresence = (
    bNode: RequestNode,
    oNode: RequestNode | undefined,
    tNode: RequestNode | undefined,
  ) => {
    const deletedByOurs = !oNode;
    const survivor = oNode ?? tNode;
    const entry: MergeConflict = {
      ...info,
      id: `${info.id}:node:${bNode.id}:__presence`,
      nodeId: bNode.id,
      nodeName: bNode.name,
      field: "__presence",
      fieldLabel: "节点存在性",
      oursDisplay: deletedByOurs ? "已删除" : "保留（已修改）",
      theirsDisplay: deletedByOurs ? "保留（已修改）" : "已删除",
      oursAction: deletedByOurs ? "删除此节点" : "保留并采用我的修改",
      theirsAction: deletedByOurs ? "保留并采用对方的修改" : "删除此节点",
    };
    ctx.conflicts.push(entry);
    if (ctx.resolver(entry) === (deletedByOurs ? "ours" : "theirs")) return;
    if (survivor) result.push(survivor);
  };

  // 顺序：保留 base 原有顺序，再追加两侧各自新增的节点。
  for (const bNode of base) {
    const oNode = oursMap.get(bNode.id);
    const tNode = theirsMap.get(bNode.id);
    if (!oNode && !tNode) continue; // 双方都删
    if (oNode && tNode) {
      if (deepEqual(oNode, bNode)) {
        // 我方未动，对方改动直接合入。
        if (!deepEqual(tNode, bNode)) {
          result.push(tNode);
          ctx.autoChanges.push(...describeNodeDiff(baseProject, bNode, tNode));
        } else {
          result.push(bNode);
        }
      } else if (deepEqual(tNode, bNode)) {
        result.push(oNode);
      } else {
        result.push(
          mergeNodeFields(bNode, oNode, tNode, baseProject, info, ctx),
        );
      }
      continue;
    }
    const survivor = oNode ?? tNode!;
    if (deepEqual(survivor, bNode)) {
      // 一方删除、另一方原样保留 → 删除成立。
      continue;
    }
    // 一方删除、另一方修改 → 冲突。
    resolvePresence(bNode, oNode, tNode);
  }
  for (const oNode of ours) {
    if (!baseIds.has(oNode.id)) {
      const tNode = theirsMap.get(oNode.id);
      if (tNode) {
        // 两侧新增同一 id（UUID 碰撞的极端情况），字段级合并。
        if (!result.some((node) => node.id === oNode.id))
          result.push(
            mergeNodeFields(undefined, oNode, tNode, baseProject, info, ctx),
          );
      } else {
        result.push(oNode);
      }
    }
  }
  for (const tNode of theirs) {
    if (!baseIds.has(tNode.id) && !oursMap.has(tNode.id)) {
      result.push(tNode);
      ctx.autoChanges.push(
        `${baseProject.title} · 新增节点 ${tNode.name}（对方新增）`,
      );
    }
  }
  return result;
}

/** 方案快照保存后即不可变，只存在新增/删除：新增取并集，删除一方提出即成立。 */
function mergeScenarios(
  base: ScenarioSnapshot[],
  ours: ScenarioSnapshot[],
  theirs: ScenarioSnapshot[],
  ctx: MergeContext,
  projectTitle: string,
): ScenarioSnapshot[] {
  const baseIds = new Set(base.map((scenario) => scenario.id));
  const oursById = new Map(ours.map((scenario) => [scenario.id, scenario]));
  const theirsById = new Map(theirs.map((scenario) => [scenario.id, scenario]));
  const merged = new Map<string, ScenarioSnapshot>();
  for (const scenario of ours) merged.set(scenario.id, scenario);
  for (const scenario of theirs) {
    if (!merged.has(scenario.id)) merged.set(scenario.id, scenario);
  }
  const kept: ScenarioSnapshot[] = [];
  for (const [id, scenario] of merged) {
    if (!baseIds.has(id)) {
      kept.push(scenario);
      if (!oursById.has(id))
        ctx.autoChanges.push(
          `${projectTitle} · 新增方案快照 ${scenario.name}（对方新增）`,
        );
      continue;
    }
    const inOurs = oursById.has(id);
    const inTheirs = theirsById.has(id);
    if (inOurs && inTheirs) kept.push(scenario);
    else if (inOurs)
      ctx.autoChanges.push(
        `${projectTitle} · 删除方案快照 ${scenario.name}（对方删除）`,
      );
    // 我方删除、对方保留时同样删除，无需额外提示自己的动作。
  }
  return kept.sort((a, b) => b.createdAt - a.createdAt);
}

function mergeProjectFields(
  base: LatencyProject,
  ours: LatencyProject,
  theirs: LatencyProject,
  ctx: MergeContext,
): LatencyProject {
  const info: ProjectInfo = {
    id: `project:${base.id}`,
    scope: "project",
    projectId: base.id,
    projectTitle: base.title,
  };
  const merged: LatencyProject = {
    ...ours,
    nodes: mergeNodes(base, base.nodes, ours.nodes, theirs.nodes, info, ctx),
    scenarios: mergeScenarios(
      base.scenarios,
      ours.scenarios,
      theirs.scenarios,
      ctx,
      base.title,
    ),
  };
  for (const field of Object.keys(PROJECT_FIELD_LABELS)) {
    const bValue = base[field as keyof LatencyProject];
    const oValue = ours[field as keyof LatencyProject];
    const tValue = theirs[field as keyof LatencyProject];
    const { value, conflict: isConflict } = mergeScalar(bValue, oValue, tValue);
    if (!isConflict) {
      if (!deepEqual(tValue, bValue) && deepEqual(oValue, bValue)) {
        ctx.autoChanges.push(
          `${base.title} · ${PROJECT_FIELD_LABELS[field] ?? field} 合入对方（${formatScalar(field, tValue)}）`,
        );
      }
      (merged as unknown as Record<string, unknown>)[field] = value;
      continue;
    }
    const entry: MergeConflict = {
      ...info,
      id: `project:${base.id}:${field}`,
      field,
      fieldLabel: PROJECT_FIELD_LABELS[field] ?? field,
      oursDisplay: formatScalar(field, oValue),
      theirsDisplay: formatScalar(field, tValue),
      oursAction: actionText(field, oValue),
      theirsAction: actionText(field, tValue),
    };
    ctx.conflicts.push(entry);
    (merged as unknown as Record<string, unknown>)[field] =
      ctx.resolver(entry) === "ours" ? oValue : tValue;
  }
  merged.updatedAt = Math.max(ours.updatedAt, theirs.updatedAt);
  return merged;
}

function mergeProject(
  base: LatencyProject,
  ours: LatencyProject | undefined,
  theirs: LatencyProject | undefined,
  ctx: MergeContext,
): LatencyProject | undefined {
  const oursDeleted = !ours;
  const theirsDeleted = !theirs;
  if (oursDeleted && theirsDeleted) return undefined;
  if (oursDeleted || theirsDeleted) {
    const survivor = (ours ?? theirs)!;
    // 删除方 vs 未修改方 → 删除成立。
    if (deepEqual(survivor, base)) return undefined;
    // 一方删除、另一方修改 → 冲突。
    const deletedByOurs = oursDeleted;
    const entry: MergeConflict = {
      id: `project:${base.id}:__presence`,
      scope: "project",
      projectId: base.id,
      projectTitle: base.title,
      field: "__presence",
      fieldLabel: "项目存在性",
      oursDisplay: oursDeleted ? "已删除" : "保留（已修改）",
      theirsDisplay: theirsDeleted ? "已删除" : "保留（已修改）",
      oursAction: oursDeleted ? "删除项目" : "保留并采用我的修改",
      theirsAction: theirsDeleted ? "删除项目" : "保留并采用对方的修改",
    };
    ctx.conflicts.push(entry);
    const deleteWins =
      ctx.resolver(entry) === (deletedByOurs ? "ours" : "theirs");
    return deleteWins ? undefined : survivor;
  }
  if (deepEqual(ours, base)) {
    if (!deepEqual(theirs, base))
      ctx.autoChanges.push(...describeProjectDiff(base, theirs));
    return theirs;
  }
  if (deepEqual(theirs, base)) return ours;
  return mergeProjectFields(base, ours, theirs, ctx);
}

function mergeProjectList(
  base: LatencyProject[],
  ours: LatencyProject[],
  theirs: LatencyProject[],
  ctx: MergeContext,
): LatencyProject[] {
  const oursMap = new Map(ours.map((project) => [project.id, project]));
  const theirsMap = new Map(theirs.map((project) => [project.id, project]));
  const baseIds = new Set(base.map((project) => project.id));
  const result: LatencyProject[] = [];
  for (const bProject of base) {
    const merged = mergeProject(
      bProject,
      oursMap.get(bProject.id),
      theirsMap.get(bProject.id),
      ctx,
    );
    if (merged) result.push(merged);
  }
  for (const project of ours) {
    if (!baseIds.has(project.id) && !theirsMap.has(project.id))
      result.push(project);
  }
  for (const project of theirs) {
    if (!baseIds.has(project.id) && !oursMap.has(project.id)) {
      result.push(project);
      ctx.autoChanges.push(`新增项目 ${project.title}（对方新增）`);
    }
  }
  // UUID 碰撞的极端情况：两侧新增了同一 id 的项目，走字段级合并。
  for (const project of ours) {
    if (
      !baseIds.has(project.id) &&
      theirsMap.has(project.id) &&
      !result.some((item) => item.id === project.id)
    ) {
      const other = theirsMap.get(project.id)!;
      const standIn: LatencyProject = {
        ...project,
        nodes: [],
        scenarios: [],
      };
      const merged = mergeProjectFields(standIn, project, other, ctx);
      result.push(merged);
    }
  }
  return result;
}

export function mergeDocuments(
  base: WorkspaceDocument,
  ours: WorkspaceDocument,
  theirs: WorkspaceDocument,
  resolver: ConflictResolver = () => "ours",
): MergeOutcome {
  const ctx: MergeContext = {
    conflicts: [],
    autoChanges: [],
    resolver,
  };
  const projects = mergeProjectList(
    base.projects,
    ours.projects,
    theirs.projects,
    ctx,
  );
  let activeProjectId = ours.activeProjectId;
  const activeIdMerge = mergeScalar(
    base.activeProjectId,
    ours.activeProjectId,
    theirs.activeProjectId,
  );
  activeProjectId = activeIdMerge.value;
  if (activeIdMerge.conflict) {
    const entry: MergeConflict = {
      id: "document:activeProjectId",
      scope: "document",
      projectId: "",
      projectTitle: "",
      field: "activeProjectId",
      fieldLabel: "当前打开的项目",
      oursDisplay:
        ours.projects.find((project) => project.id === ours.activeProjectId)
          ?.title ?? ours.activeProjectId,
      theirsDisplay:
        theirs.projects.find((project) => project.id === theirs.activeProjectId)
          ?.title ?? theirs.activeProjectId,
      oursAction: `停留在「${
        ours.projects.find((project) => project.id === ours.activeProjectId)
          ?.title ?? ""
      }」`,
      theirsAction: `切换到「${
        theirs.projects.find((project) => project.id === theirs.activeProjectId)
          ?.title ?? ""
      }」`,
    };
    ctx.conflicts.push(entry);
    activeProjectId =
      ctx.resolver(entry) === "ours"
        ? ours.activeProjectId
        : theirs.activeProjectId;
  }
  if (!projects.some((project) => project.id === activeProjectId))
    activeProjectId = projects[0]?.id ?? "";
  return {
    document: { version: 1, revision: 0, activeProjectId, projects },
    conflicts: ctx.conflicts,
    autoChanges: ctx.autoChanges,
  };
}
