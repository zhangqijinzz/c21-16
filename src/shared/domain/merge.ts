import { analyzeGraph } from "./graph";
import { stableStringify } from "./fingerprint";
import type {
  LatencyProject,
  RequestNode,
  ScenarioSnapshot,
  WorkspaceDocument,
} from "./types";

/**
 * 跨标签页并发修改的三路合并（纯函数）。
 * base   = 本标签页上次确认保存/载入的版本
 * local  = 本标签页当前草稿
 * remote = 存储里的最新版本
 * 能解释的差异自动合并；真正撞车（同字段双方都改、一改一删）产出 ConflictEntry，
 * 解决方式通过 ResolutionMap 注入：字段级选择回退到条目级选择，再缺省保留本侧。
 */

export type ResolutionChoice = "local" | "remote";
export type ResolutionMap = Record<string, ResolutionChoice>;

export type MergeScope = "workspace" | "project" | "node" | "scenario";
export type ConflictKind = "both-changed" | "edit-delete" | "both-created";

export interface ConflictValue {
  field: string;
  local: string;
  remote: string;
}

export interface ConflictEntry {
  /** 条目稳定标识，ResolutionMap 既可用条目 id 也可用 `${id}:${field}` 索引 */
  id: string;
  scope: MergeScope;
  kind: ConflictKind;
  label: string;
  projectLabel?: string;
  /** both-changed 时撞车字段的中文名 */
  fields: string[];
  /** 撞车字段两侧取值，用于界面解释差异 */
  values: ConflictValue[];
  /** edit-delete 时执行删除的那一侧 */
  deletedBy: "local" | "remote" | null;
}

export interface MergeChange {
  scope: MergeScope;
  label: string;
  projectLabel?: string;
  detail: string;
}

export interface MergeReport {
  conflicts: ConflictEntry[];
  autoChanges: MergeChange[];
}

export interface MergeResult {
  document: WorkspaceDocument;
  report: MergeReport;
}

interface MergeContext {
  conflicts: ConflictEntry[];
  autoChanges: MergeChange[];
}

const PROJECT_SCALAR_FIELDS = ["title", "concurrencyLimit"] as const;
const NODE_SCALAR_FIELDS = [
  "name",
  "durationMs",
  "jitterMs",
  "timeoutMs",
  "retryCount",
  "failureRate",
  "fallbackNodeId",
] as const;

const FIELD_LABELS: Record<string, string> = {
  title: "标题",
  concurrencyLimit: "并发上限",
  name: "节点名称",
  durationMs: "耗时",
  jitterMs: "波动",
  timeoutMs: "超时",
  retryCount: "重试次数",
  failureRate: "失败率",
  fallbackNodeId: "降级目标",
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export function formatConflictValue(field: string, value: unknown): string {
  if (field === "concurrencyLimit")
    return value === null ? "不限" : String(value);
  if (field === "fallbackNodeId")
    return value === undefined || value === null || value === ""
      ? "无"
      : `节点 ${String(value)}`;
  if (field === "durationMs" || field === "jitterMs" || field === "timeoutMs")
    return `${String(value)} ms`;
  if (field === "retryCount") return `${String(value)} 次`;
  if (field === "failureRate") return `${String(value)}%`;
  return String(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

/** 字段级选择优先，其次条目级整体选择，缺省保留本侧。 */
function resolveChoice(
  resolutions: ResolutionMap,
  entryId: string,
  field?: string,
): ResolutionChoice {
  if (field) {
    const fieldChoice = resolutions[`${entryId}:${field}`];
    if (fieldChoice) return fieldChoice;
  }
  return resolutions[entryId] ?? "local";
}

interface ScalarOutcome<T> {
  value: T;
  conflict: boolean;
  remoteOnlyChange: boolean;
}

/**
 * 标量三路：双方一致直接取；只一侧改取那一侧；两侧改成不同值才冲突。
 * 冲突取值同时支持字段级与条目级选择（字段级优先）。
 */
function mergeScalar<T>(
  base: T,
  local: T,
  remote: T,
  resolutions: ResolutionMap,
  fieldId: string,
  entryId: string,
): ScalarOutcome<T> {
  if (sameValue(local, remote))
    return { value: local, conflict: false, remoteOnlyChange: false };
  if (sameValue(local, base))
    return { value: remote, conflict: false, remoteOnlyChange: true };
  if (sameValue(remote, base))
    return { value: local, conflict: false, remoteOnlyChange: false };
  const choice = resolutions[fieldId] ?? resolutions[entryId] ?? "local";
  return {
    value: choice === "remote" ? remote : local,
    conflict: true,
    remoteOnlyChange: false,
  };
}

type Presence = "keep" | "drop";

interface PresenceInput {
  id: string;
  scope: MergeScope;
  label: string;
  projectLabel?: string;
  existedAtBase: boolean;
  localPresent: boolean;
  remotePresent: boolean;
  /** 保留侧相对 base 是否有内容修改，用于区分“改-删”与单纯删除 */
  localChanged: boolean;
  remoteChanged: boolean;
  remoteAddedDetail?: string;
}

/**
 * 实体存在性三路。新增实体的双方内容差异由调用方登记 both-created；
 * 这里负责：双方都删→删；仅一侧删而另一侧未动→尊重删除；一改一删→冲突。
 */
function resolvePresence(
  ctx: MergeContext,
  entry: PresenceInput,
  resolutions: ResolutionMap,
): Presence {
  const {
    id,
    scope,
    label,
    projectLabel,
    existedAtBase,
    localPresent,
    remotePresent,
    localChanged,
    remoteChanged,
    remoteAddedDetail,
  } = entry;
  if (!existedAtBase) {
    if (localPresent && remotePresent) return "keep";
    if (remotePresent)
      ctx.autoChanges.push({
        scope,
        label,
        projectLabel,
        detail: remoteAddedDetail ?? "对端新增的内容已并入",
      });
    return "keep";
  }
  if (localPresent && remotePresent) return "keep";
  if (!localPresent && !remotePresent) return "drop";
  const deletingSide: "local" | "remote" = localPresent ? "remote" : "local";
  const survivingSideChanged = localPresent ? localChanged : remoteChanged;
  if (!survivingSideChanged) {
    ctx.autoChanges.push({
      scope,
      label,
      projectLabel,
      detail:
        deletingSide === "local"
          ? "你执行的删除已生效"
          : "对端的删除已并入",
    });
    return "drop";
  }
  ctx.conflicts.push({
    id,
    scope,
    kind: "edit-delete",
    label,
    projectLabel,
    fields: [],
    values: [],
    deletedBy: deletingSide,
  });
  const keepChosenSide =
    resolveChoice(resolutions, id) === "local"
      ? localPresent
      : remotePresent;
  return keepChosenSide ? "keep" : "drop";
}

/**
 * 依赖边是集合：两侧新增取并集（都会保留）；删除需两侧一致才删，
 * 避免一侧删边、另一侧改同节点别的字段时无声丢失。仍指向已删除节点的边在项目级裁剪。
 */
function mergeDependencyIds(
  base: string[],
  local: string[],
  remote: string[],
): string[] {
  const baseSet = new Set(base);
  const additions = new Set<string>();
  for (const id of local) if (!baseSet.has(id)) additions.add(id);
  for (const id of remote) if (!baseSet.has(id)) additions.add(id);
  const removedOnBoth = [...baseSet].filter(
    (id) => !local.includes(id) && !remote.includes(id),
  );
  return [...baseSet, ...additions]
    .filter((id) => !removedOnBoth.includes(id))
    .sort((left, right) => left.localeCompare(right));
}

function mergeExistingNode(
  ctx: MergeContext,
  projectId: string,
  projectLabel: string,
  base: RequestNode,
  local: RequestNode,
  remote: RequestNode,
  resolutions: ResolutionMap,
): RequestNode {
  // 节点冲突条目一律以 projectId:nodeId 为键，保证新增/删除/字段冲突可被同一选择覆盖。
  const conflictId = `node:${projectId}:${base.id}`;
  const merged: RequestNode = { ...local };
  const fields: string[] = [];
  const values: ConflictValue[] = [];
  for (const field of NODE_SCALAR_FIELDS) {
    const outcome = mergeScalar(
      base[field],
      local[field],
      remote[field],
      resolutions,
      `${conflictId}:${field}`,
      conflictId,
    );
    (merged[field] as unknown) = outcome.value;
    if (outcome.conflict) {
      fields.push(fieldLabel(field));
      values.push({
        field: fieldLabel(field),
        local: formatConflictValue(field, local[field]),
        remote: formatConflictValue(field, remote[field]),
      });
    } else if (outcome.remoteOnlyChange) {
      ctx.autoChanges.push({
        scope: "node",
        label: base.name,
        projectLabel,
        detail: `对端把${fieldLabel(field)}改为 ${formatConflictValue(field, remote[field])}，已并入`,
      });
    }
  }
  const mergedDependencies = mergeDependencyIds(
    base.dependencyIds,
    local.dependencyIds,
    remote.dependencyIds,
  );
  const edgesTouchedBoth =
    !sameValue(local.dependencyIds, base.dependencyIds) &&
    !sameValue(remote.dependencyIds, base.dependencyIds);
  merged.dependencyIds = mergedDependencies;
  if (
    edgesTouchedBoth &&
    !sameValue(mergedDependencies, local.dependencyIds)
  ) {
    ctx.autoChanges.push({
      scope: "node",
      label: base.name,
      projectLabel,
      detail: "前置依赖已合并：两侧新增均保留，仅两侧都移除的连线才删除",
    });
  }
  if (fields.length > 0) {
    ctx.conflicts.push({
      id: conflictId,
      scope: "node",
      kind: "both-changed",
      label: local.name,
      projectLabel,
      fields,
      values,
      deletedBy: null,
    });
  }
  return merged;
}

/** 远端顺序为骨架，本地独有新增追加在后。 */
function orderedUnion(localOrder: string[], remoteOrder: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of remoteOrder)
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  for (const id of localOrder)
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  return result;
}

function mergeScenarioLists(
  ctx: MergeContext,
  projectLabel: string,
  base: ScenarioSnapshot[],
  local: ScenarioSnapshot[],
  remote: ScenarioSnapshot[],
  resolutions: ResolutionMap,
): ScenarioSnapshot[] {
  const baseMap = new Map(base.map((item) => [item.id, item]));
  const localMap = new Map(local.map((item) => [item.id, item]));
  const remoteMap = new Map(remote.map((item) => [item.id, item]));
  const result: ScenarioSnapshot[] = [];
  for (const id of orderedUnion(
    local.map((item) => item.id),
    remote.map((item) => item.id),
  )) {
    const atBase = baseMap.get(id);
    const atLocal = localMap.get(id);
    const atRemote = remoteMap.get(id);
    if (!atBase) {
      if (atLocal && atRemote) {
        if (sameValue(atLocal, atRemote)) {
          result.push(atLocal);
        } else {
          // UUID 冲突在实践中几乎不会发生，仍然给出确定行为。
          ctx.conflicts.push({
            id: `scenario:${id}`,
            scope: "scenario",
            kind: "both-created",
            label: atLocal.name,
            projectLabel,
            fields: [],
            values: [],
            deletedBy: null,
          });
          result.push(
            resolveChoice(resolutions, `scenario:${id}`) === "local"
              ? atLocal
              : atRemote,
          );
        }
        continue;
      }
      const only = atLocal ?? atRemote;
      if (only) {
        result.push(only);
        if (atRemote)
          ctx.autoChanges.push({
            scope: "scenario",
            label: only.name,
            projectLabel,
            detail: "对端保存的方案快照已并入",
          });
      }
      continue;
    }
    const presence = resolvePresence(
      ctx,
      {
        id: `scenario:${id}`,
        scope: "scenario",
        label: atBase.name,
        projectLabel,
        existedAtBase: true,
        localPresent: Boolean(atLocal),
        remotePresent: Boolean(atRemote),
        localChanged: false,
        remoteChanged: false,
      },
      resolutions,
    );
    if (presence === "keep") result.push((atLocal ?? atRemote)!);
  }
  return result;
}

function mergeExistingProject(
  ctx: MergeContext,
  base: LatencyProject,
  local: LatencyProject,
  remote: LatencyProject,
  resolutions: ResolutionMap,
): LatencyProject {
  const projectConflictId = `project:${base.id}`;
  const scalarFields: string[] = [];
  const scalarValues: ConflictValue[] = [];
  const mergedProject: LatencyProject = { ...local };
  for (const field of PROJECT_SCALAR_FIELDS) {
    const outcome = mergeScalar(
      base[field],
      local[field],
      remote[field],
      resolutions,
      `${projectConflictId}:${field}`,
      projectConflictId,
    );
    (mergedProject[field] as unknown) = outcome.value;
    if (outcome.conflict) {
      scalarFields.push(fieldLabel(field));
      scalarValues.push({
        field: fieldLabel(field),
        local: formatConflictValue(field, local[field]),
        remote: formatConflictValue(field, remote[field]),
      });
    } else if (outcome.remoteOnlyChange) {
      ctx.autoChanges.push({
        scope: "project",
        label: base.title,
        detail: `对端把${fieldLabel(field)}改为 ${formatConflictValue(field, remote[field])}，已并入`,
      });
    }
  }
  if (scalarFields.length > 0) {
    ctx.conflicts.push({
      id: projectConflictId,
      scope: "project",
      kind: "both-changed",
      label: base.title,
      fields: scalarFields,
      values: scalarValues,
      deletedBy: null,
    });
  }

  const baseNodes = new Map(base.nodes.map((node) => [node.id, node]));
  const localNodes = new Map(local.nodes.map((node) => [node.id, node]));
  const remoteNodes = new Map(remote.nodes.map((node) => [node.id, node]));
  const mergedNodes: RequestNode[] = [];
  for (const nodeId of orderedUnion(
    local.nodes.map((node) => node.id),
    remote.nodes.map((node) => node.id),
  )) {
    const atBase = baseNodes.get(nodeId);
    const atLocal = localNodes.get(nodeId);
    const atRemote = remoteNodes.get(nodeId);
    if (!atBase) {
      if (atLocal && atRemote) {
        if (sameValue(atLocal, atRemote)) {
          mergedNodes.push(atLocal);
        } else {
          ctx.conflicts.push({
            id: `node:${base.id}:${nodeId}`,
            scope: "node",
            kind: "both-created",
            label: atLocal.name,
            projectLabel: local.title,
            fields: [],
            values: [],
            deletedBy: null,
          });
          mergedNodes.push(
            resolveChoice(
              resolutions,
              `node:${base.id}:${nodeId}`,
            ) === "local"
              ? atLocal
              : atRemote,
          );
        }
        continue;
      }
      const only = atLocal ?? atRemote;
      if (only) {
        mergedNodes.push(only);
        if (atRemote)
          ctx.autoChanges.push({
            scope: "node",
            label: only.name,
            projectLabel: local.title,
            detail: "对端新增的节点已并入",
          });
      }
      continue;
    }
    const presence = resolvePresence(
      ctx,
      {
        id: `node:${base.id}:${nodeId}`,
        scope: "node",
        label: atBase.name,
        projectLabel: local.title,
        existedAtBase: true,
        localPresent: Boolean(atLocal),
        remotePresent: Boolean(atRemote),
        localChanged: atLocal ? !sameValue(atLocal, atBase) : false,
        remoteChanged: atRemote ? !sameValue(atRemote, atBase) : false,
      },
      resolutions,
    );
    if (presence !== "keep") continue;
    if (atLocal && atRemote) {
      mergedNodes.push(
        mergeExistingNode(
          ctx,
          base.id,
          local.title,
          atBase,
          atLocal,
          atRemote,
          resolutions,
        ),
      );
    } else {
      const only = atLocal ?? atRemote;
      if (only) mergedNodes.push(only);
    }
  }

  // 裁剪指向已删除节点的连线与降级目标，保证合并结果仍是合法图。
  const survivingIds = new Set(mergedNodes.map((node) => node.id));
  for (const node of mergedNodes) {
    const beforeDeps = node.dependencyIds.length;
    const beforeFallback = node.fallbackNodeId;
    node.dependencyIds = node.dependencyIds.filter((id) =>
      survivingIds.has(id),
    );
    if (
      node.fallbackNodeId !== undefined &&
      !survivingIds.has(node.fallbackNodeId)
    ) {
      node.fallbackNodeId = undefined;
    }
    if (
      beforeDeps !== node.dependencyIds.length ||
      beforeFallback !== node.fallbackNodeId
    ) {
      ctx.autoChanges.push({
        scope: "node",
        label: node.name,
        projectLabel: local.title,
        detail: "已移除指向已删除节点的连线或降级目标",
      });
    }
  }

  if (analyzeGraph({ ...mergedProject, nodes: mergedNodes }).cycle.length > 0) {
    ctx.autoChanges.push({
      scope: "node",
      label: local.title,
      detail: "合并后出现循环依赖，请在请求编排中手动拆除",
    });
  }

  mergedProject.nodes = mergedNodes;
  mergedProject.scenarios = mergeScenarioLists(
    ctx,
    local.title,
    base.scenarios,
    local.scenarios,
    remote.scenarios,
    resolutions,
  );
  mergedProject.updatedAt = Math.max(
    base.updatedAt,
    local.updatedAt,
    remote.updatedAt,
  );
  return mergedProject;
}

export function mergeWorkspaces(
  base: WorkspaceDocument,
  local: WorkspaceDocument,
  remote: WorkspaceDocument,
  resolutions: ResolutionMap = {},
): MergeResult {
  const ctx: MergeContext = { conflicts: [], autoChanges: [] };
  const baseProjects = new Map(
    base.projects.map((project) => [project.id, project]),
  );
  const localProjects = new Map(
    local.projects.map((project) => [project.id, project]),
  );
  const remoteProjects = new Map(
    remote.projects.map((project) => [project.id, project]),
  );
  const mergedProjects: LatencyProject[] = [];
  for (const projectId of orderedUnion(
    local.projects.map((project) => project.id),
    remote.projects.map((project) => project.id),
  )) {
    const atBase = baseProjects.get(projectId);
    const atLocal = localProjects.get(projectId);
    const atRemote = remoteProjects.get(projectId);
    if (!atBase) {
      if (atLocal && atRemote) {
        if (sameValue(atLocal, atRemote)) {
          mergedProjects.push(atLocal);
        } else {
          ctx.conflicts.push({
            id: `project:${projectId}`,
            scope: "project",
            kind: "both-created",
            label: atLocal.title,
            fields: [],
            values: [],
            deletedBy: null,
          });
          mergedProjects.push(
            resolveChoice(resolutions, `project:${projectId}`) === "local"
              ? atLocal
              : atRemote,
          );
        }
        continue;
      }
      const only = atLocal ?? atRemote;
      if (only) {
        mergedProjects.push(only);
        if (atRemote)
          ctx.autoChanges.push({
            scope: "project",
            label: only.title,
            detail: "对端新建的项目已并入",
          });
      }
      continue;
    }
    const presence = resolvePresence(
      ctx,
      {
        id: `project:${projectId}`,
        scope: "project",
        label: atBase.title,
        existedAtBase: true,
        localPresent: Boolean(atLocal),
        remotePresent: Boolean(atRemote),
        localChanged: atLocal ? !sameValue(atLocal, atBase) : false,
        remoteChanged: atRemote ? !sameValue(atRemote, atBase) : false,
      },
      resolutions,
    );
    if (presence !== "keep") continue;
    if (atLocal && atRemote) {
      mergedProjects.push(
        mergeExistingProject(ctx, atBase, atLocal, atRemote, resolutions),
      );
    } else {
      const only = atLocal ?? atRemote;
      if (only) mergedProjects.push(only);
    }
  }

  // 项目选择不是破坏性数据：本侧主动切过就保留本侧；本侧没切才跟随对端；都没切保持原样。
  const localSwitched = local.activeProjectId !== base.activeProjectId;
  const remoteSwitched = remote.activeProjectId !== base.activeProjectId;
  let activeProjectId = localSwitched
    ? local.activeProjectId
    : remoteSwitched
      ? remote.activeProjectId
      : base.activeProjectId;
  if (!mergedProjects.some((project) => project.id === activeProjectId))
    activeProjectId = mergedProjects[0]?.id ?? "";

  return {
    document: { version: 1, activeProjectId, projects: mergedProjects },
    report: ctx,
  };
}
