import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type RequestNode,
  type ScenarioSnapshot,
  type WorkspaceDocument,
} from "../domain/types";
import {
  IndexedDbService,
  RevisionConflictError,
} from "../services/indexedDbService";

const FALLBACK_KEY = "latency-lab.workspace.v1";

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
  // 旧版本数据没有 revision，按 0 处理，后续第一次保存会升级为新版本。
  const revision =
    typeof value.revision === "number" && Number.isFinite(value.revision)
      ? Math.max(0, Math.floor(value.revision))
      : 0;
  return {
    document: { version: 1, revision, activeProjectId, projects },
    recovered,
  };
}

export interface WorkspaceStorage {
  read(): Promise<unknown>;
  conditionalWrite(
    value: WorkspaceDocument,
    expectedRevision: number | null,
  ): Promise<WorkspaceDocument>;
}

export interface LoadResult {
  document: WorkspaceDocument;
  recovered: boolean;
  /** IndexedDB 中没有任何数据；首次保存需用 null 期望值占位。 */
  storeEmpty: boolean;
}

/**
 * 默认存储工厂可在测试中替换（jsdom 没有 IndexedDB）。
 * 生产环境始终使用 IndexedDbService。
 */
let defaultStorageFactory: () => WorkspaceStorage = () =>
  new IndexedDbService();

export function createDefaultStorage(): WorkspaceStorage {
  return defaultStorageFactory();
}

export function setDefaultStorageFactoryForTests(
  factory: (() => WorkspaceStorage) | null,
): void {
  defaultStorageFactory = factory ?? (() => new IndexedDbService());
}

export class ProjectRepository {
  constructor(
    private readonly storage: WorkspaceStorage = createDefaultStorage(),
  ) {}

  private readFallback(): { document: WorkspaceDocument } | undefined {
    const local = localStorage.getItem(FALLBACK_KEY);
    if (!local) return undefined;
    try {
      const fallback = parseWorkspace(JSON.parse(local) as unknown);
      return fallback ? { document: fallback.document } : undefined;
    } catch {
      localStorage.removeItem(FALLBACK_KEY);
      return undefined;
    }
  }

  async load(): Promise<LoadResult> {
    let raw: unknown;
    try {
      raw = await this.storage.read();
    } catch {
      const fallback = this.readFallback();
      if (fallback)
        return {
          document: fallback.document,
          recovered: true,
          storeEmpty: false,
        };
      return {
        document: this.exampleDocument(),
        recovered: true,
        storeEmpty: true,
      };
    }
    const stored = parseWorkspace(raw);
    if (stored) {
      return {
        document: stored.document,
        recovered: stored.recovered,
        storeEmpty: false,
      };
    }
    // 存储里有数据但解析失败：不是空库，走恢复副本；都没有则给示例，
    // 但 storeEmpty 必须为 false，避免后续用 null 期望去覆盖损坏数据。
    const fallback = this.readFallback();
    if (fallback)
      return {
        document: fallback.document,
        recovered: true,
        storeEmpty: false,
      };
    if (raw !== undefined && raw !== null)
      return {
        document: this.exampleDocument(),
        recovered: true,
        storeEmpty: false,
      };
    return {
      document: this.exampleDocument(),
      recovered: true,
      storeEmpty: true,
    };
  }

  private exampleDocument(): WorkspaceDocument {
    return {
      version: 1,
      revision: 0,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [structuredClone(EXAMPLE_PROJECT)],
    };
  }

  /**
   * 乐观并发保存：只有存储中的 revision 仍等于 expectedRevision 时才写入
   * （expectedRevision 为 null 表示要求存储为空，用于首次写入）。
   * 不一致时抛出 SaveConflictError，并带回对方刚保存的远端文档用于三方合并。
   * localStorage 恢复副本只在 CAS 成功后更新，不会把未决冲突固化进去。
   * 返回带新 revision 的已保存文档。
   */
  async save(
    document: WorkspaceDocument,
    expectedRevision: number | null,
  ): Promise<WorkspaceDocument> {
    let written: WorkspaceDocument | undefined;
    let indexedDbError: unknown;
    try {
      written = await this.storage.conditionalWrite(document, expectedRevision);
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        const remote = parseWorkspace(error.current);
        throw new SaveConflictError(
          error.expectedRevision,
          remote?.document ?? error.current,
        );
      }
      indexedDbError = error;
    }
    const persisted = written ?? document;
    try {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(persisted));
    } catch (error) {
      if (!indexedDbError) throw error;
    }
    if (indexedDbError) throw indexedDbError;
    return persisted;
  }
}

/** 保存时发现存储已被另一个标签页更新。remote 是对方写入的最新文档。 */
export class SaveConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly remote: unknown,
  ) {
    super("工作区已在其他标签页中被修改");
    this.name = "SaveConflictError";
  }
}
