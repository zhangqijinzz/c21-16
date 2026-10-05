import {
  EXAMPLE_PROJECT,
  newRevision,
  type LatencyProject,
  type RequestNode,
  type ScenarioSnapshot,
  type StoredWorkspace,
  type WorkspaceDocument,
} from "../domain/types";
import { legacyFingerprint } from "../domain/fingerprint";
import { IndexedDbService, type CommitOutcome } from "../services/indexedDbService";
import { markLocalStorageSelfWrite } from "../services/tabSync";

const FALLBACK_KEY = "latency-lab.workspace.v2";
const EMERGENCY_KEY = "latency-lab.workspace.emergency.v2";
const LEGACY_FALLBACK_KEY = "latency-lab.workspace.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseNode(value: unknown): RequestNode | undefined {
  if (!isRecord(value)) return undefined;
  const {
    id,
    name,
    durationMs,
    jitterMs,
    dependencyIds,
    timeoutMs,
    retryCount,
    failureRate,
    fallbackNodeId,
  } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    !Array.isArray(dependencyIds)
  )
    return undefined;
  if (
    !isFiniteNumber(durationMs) ||
    !isFiniteNumber(jitterMs) ||
    !isFiniteNumber(timeoutMs) ||
    !isFiniteNumber(retryCount) ||
    !isFiniteNumber(failureRate)
  )
    return undefined;
  return {
    id,
    name,
    durationMs,
    jitterMs,
    dependencyIds: dependencyIds.filter(
      (id): id is string => typeof id === "string",
    ),
    timeoutMs,
    retryCount,
    failureRate,
    ...(typeof fallbackNodeId === "string" ? { fallbackNodeId } : {}),
  };
}

function parseScenario(value: unknown): ScenarioSnapshot | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.criticalPath)
  )
    return undefined;
  const { id, name, createdAt, concurrencyLimit, completionMs } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof createdAt !== "number" ||
    typeof completionMs !== "number"
  )
    return undefined;
  return {
    id,
    name,
    createdAt,
    completionMs,
    concurrencyLimit:
      typeof concurrencyLimit === "number" && concurrencyLimit > 0
        ? concurrencyLimit
        : null,
    nodes: value.nodes
      .map(parseNode)
      .filter((node): node is RequestNode => Boolean(node)),
    criticalPath: value.criticalPath.filter(
      (id): id is string => typeof id === "string",
    ),
  };
}

function parseProject(
  value: unknown,
): { project: LatencyProject; recovered: boolean } | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string"
  )
    return undefined;
  const sourceNodes = Array.isArray(value.nodes) ? value.nodes : [];
  const parsedNodes = sourceNodes.map(parseNode);
  const nodes = parsedNodes.filter((node): node is RequestNode =>
    Boolean(node),
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  let recovered =
    !Array.isArray(value.nodes) || nodes.length !== sourceNodes.length;
  const safeNodes = nodes.map((node) => {
    const dependencyIds = node.dependencyIds.filter(
      (id) => id !== node.id && nodeIds.has(id),
    );
    const validFallback =
      node.fallbackNodeId &&
      node.fallbackNodeId !== node.id &&
      nodeIds.has(node.fallbackNodeId)
        ? node.fallbackNodeId
        : undefined;
    if (
      dependencyIds.length !== node.dependencyIds.length ||
      validFallback !== node.fallbackNodeId
    )
      recovered = true;
    return {
      ...node,
      dependencyIds,
      ...(validFallback
        ? { fallbackNodeId: validFallback }
        : { fallbackNodeId: undefined }),
    };
  });
  const scenarioSource = Array.isArray(value.scenarios) ? value.scenarios : [];
  const scenarios = scenarioSource
    .map(parseScenario)
    .filter((scenario): scenario is ScenarioSnapshot => Boolean(scenario));
  if (
    !Array.isArray(value.scenarios) ||
    scenarios.length !== scenarioSource.length
  )
    recovered = true;
  const now = Date.now();
  const project: LatencyProject = {
    id: value.id,
    title: value.title,
    nodes: safeNodes,
    concurrencyLimit:
      typeof value.concurrencyLimit === "number" && value.concurrencyLimit > 0
        ? Math.floor(value.concurrencyLimit)
        : null,
    scenarios,
    createdAt:
      typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
        ? value.createdAt
        : now,
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : now,
  };
  return { project, recovered };
}

function parseWorkspace(
  value: unknown,
): { document: WorkspaceDocument; recovered: boolean } | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.projects))
    return undefined;
  const parsed = value.projects.map(parseProject);
  const projects = parsed
    .filter((entry): entry is { project: LatencyProject; recovered: boolean } =>
      Boolean(entry),
    )
    .map((entry) => entry.project);
  if (!projects.length) return undefined;
  const firstProject = projects[0];
  if (!firstProject) return undefined;
  const activeProjectId = projects.some(
    (project) => project.id === value.activeProjectId,
  )
    ? String(value.activeProjectId)
    : firstProject.id;
  const recovered =
    projects.length !== parsed.length ||
    parsed.some((entry) => entry?.recovered);
  return { document: { version: 1, activeProjectId, projects }, recovered };
}

function parseEnvelope(
  raw: unknown,
):
  | { stored: StoredWorkspace; recovered: boolean; legacy: boolean }
  | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.envelope === 2) {
    const revision = raw.revision;
    if (typeof revision !== "string") return undefined;
    const parsed = parseWorkspace(raw.document);
    if (!parsed) return undefined;
    return {
      stored: { envelope: 2, revision, document: parsed.document },
      recovered: parsed.recovered,
      legacy: false,
    };
  }
  // 升级前的裸文档：按原始内容指纹给出稳定修订号，首个写入的标签页自动升级，不产生误冲突。
  const parsed = parseWorkspace(raw);
  if (!parsed) return undefined;
  return {
    stored: {
      envelope: 2,
      revision: legacyFingerprint(raw),
      document: parsed.document,
    },
    recovered: parsed.recovered,
    legacy: true,
  };
}

export interface WorkspaceStorage {
  read(): Promise<unknown>;
  commit(
    value: StoredWorkspace,
    expectedRevision: string | null,
  ): Promise<CommitOutcome>;
  forceWrite(value: StoredWorkspace): Promise<void>;
}

export interface SaveOutcome {
  kind: "committed" | "conflict";
  revision: string;
  remote: StoredWorkspace | null;
}

function exampleStored(): StoredWorkspace {
  const document = {
    version: 1 as const,
    activeProjectId: EXAMPLE_PROJECT.id,
    projects: [structuredClone(EXAMPLE_PROJECT)],
  };
  return {
    envelope: 2,
    revision: legacyFingerprint(document),
    document,
  };
}

export class ProjectRepository {
  constructor(
    private readonly storage: WorkspaceStorage = new IndexedDbService(),
  ) {}

  async load(): Promise<{
    stored: StoredWorkspace;
    recovered: boolean;
  }> {
    let primaryError: unknown;
    try {
      const parsed = parseEnvelope(await this.storage.read());
      if (parsed)
        return { stored: parsed.stored, recovered: parsed.recovered };
    } catch (error) {
      primaryError = error;
    }
    // IndexedDB 为空/损坏/不可用时依次尝试常规镜像、应急镜像与旧版镜像。
    for (const key of [FALLBACK_KEY, EMERGENCY_KEY, LEGACY_FALLBACK_KEY]) {
      const local = localStorage.getItem(key);
      if (local) {
        try {
          const fallback = parseEnvelope(JSON.parse(local) as unknown);
          if (fallback)
            return { stored: fallback.stored, recovered: true };
        } catch {
          localStorage.removeItem(key);
        }
      }
    }
    void primaryError;
    return { stored: exampleStored(), recovered: true };
  }

  /** 不做任何写入的远端探测，供标签页重新可见/收到对端通知时使用。 */
  async peek(): Promise<StoredWorkspace | null> {
    try {
      return parseEnvelope(await this.storage.read())?.stored ?? null;
    } catch {
      return null;
    }
  }

  async save(
    document: WorkspaceDocument,
    expectedRevision: string | null,
  ): Promise<SaveOutcome> {
    const stored: StoredWorkspace = {
      envelope: 2,
      revision: newRevision(),
      document,
    };
    let outcome: CommitOutcome;
    try {
      outcome = await this.storage.commit(stored, expectedRevision);
    } catch (error) {
      // 主存储不可用（配额/事务失败）：把带版本的信封写入应急镜像，供下次启动恢复。
      this.writeEmergencyMirror(stored);
      throw error;
    }
    if (!outcome.committed) {
      // 冲突时绝不写任何镜像，避免把对端内容覆盖掉。
      const remote = parseEnvelope(outcome.current)?.stored ?? null;
      return { kind: "conflict", revision: expectedRevision ?? "", remote };
    }
    this.writeMirror(stored);
    return { kind: "committed", revision: stored.revision, remote: null };
  }

  /** 用户在冲突面板明确选择“用我的覆盖”后使用。 */
  async forceSave(document: WorkspaceDocument): Promise<string> {
    const stored: StoredWorkspace = {
      envelope: 2,
      revision: newRevision(),
      document,
    };
    try {
      await this.storage.forceWrite(stored);
    } catch (error) {
      this.writeEmergencyMirror(stored);
      throw error;
    }
    this.writeMirror(stored);
    return stored.revision;
  }

  private writeMirror(stored: StoredWorkspace): void {
    try {
      markLocalStorageSelfWrite();
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(stored));
      localStorage.removeItem(EMERGENCY_KEY);
    } catch {
      // 镜像写失败不影响主存储，下次成功保存时会再试。
    }
  }

  private writeEmergencyMirror(stored: StoredWorkspace): void {
    try {
      markLocalStorageSelfWrite();
      localStorage.setItem(EMERGENCY_KEY, JSON.stringify(stored));
    } catch {
      // 应急镜像尽力而为。
    }
  }
}

export { exampleStored };
