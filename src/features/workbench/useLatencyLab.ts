import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ProjectRepository,
  exampleStored,
} from "../../shared/repositories/projectRepository";
import type {
  LatencyProject,
  SimulationMode,
  StoredWorkspace,
  WorkspaceDocument,
} from "../../shared/domain/types";
import {
  mergeWorkspaces,
  type ConflictEntry,
  type MergeChange,
  type ResolutionMap,
} from "../../shared/domain/merge";
import { createRemoteChangeSignals } from "../../shared/services/tabSync";
import {
  createProject,
  duplicateProject,
  renameProject,
  selectProject,
} from "../projects/projectViewModel";
import {
  addRequestNode,
  patchRequestNode,
  removeRequestNode,
  setConcurrency,
  toggleDependency,
  getGraphAnalysis,
} from "../graph-editor/graphViewModel";
import {
  compareScenarios,
  removeScenario,
  restoreScenario,
  saveScenario,
  type ScenarioComparison,
} from "../scenarios/scenarioViewModel";
import { removeProject, updateProject } from "../projects/projectViewModel";
import { simulateProject } from "../../shared/domain/simulation";

export type LabStatus =
  "loading" | "ready" | "editing" | "simulating" | "error" | "completed";
export type LabModule =
  "projects" | "graph" | "simulation" | "scenarios" | "archive";
export type SavePhase = "saving" | "saved" | "error" | "conflict";

/** 一次写入撞车的完整上下文：三方文档 + 撞车条目与可自动合并说明。 */
export interface ConflictState {
  base: WorkspaceDocument;
  local: WorkspaceDocument;
  remote: WorkspaceDocument;
  remoteRevision: string;
  remoteUpdatedAt: number;
  conflicts: ConflictEntry[];
  autoChanges: MergeChange[];
  resolutions: ResolutionMap;
}

export interface SyncBanner {
  tone: "info" | "warn";
  message: string;
}

const REBASE_ROUNDS = 2;

function isSameDocument(
  left: WorkspaceDocument | null,
  right: WorkspaceDocument | null,
): boolean {
  if (!left || !right) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface LatencyLabOptions {
  /** 测试注入点：生产环境省略，使用默认 IndexedDB 仓储。 */
  createRepository?: () => ProjectRepository;
}

export function useLatencyLab(options?: LatencyLabOptions) {
  const repository = useMemo(
    () =>
      options?.createRepository
        ? options.createRepository()
        : new ProjectRepository(),
    // 只在挂载时创建一次；options 不参与响应式更新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const signals = useMemo(() => createRemoteChangeSignals(), []);
  const [document, setDocument] = useState<WorkspaceDocument | null>(null);
  const documentRef = useRef<WorkspaceDocument | null>(null);
  // baseRef：本标签页最后一次“确认”的文档（载入、保存成功或确认合并）；
  // remoteRef：存储侧最新文档与修订号。
  const baseRef = useRef<WorkspaceDocument | null>(null);
  const baseRevisionRef = useRef<string | null>(null);
  const remoteRef = useRef<StoredWorkspace | null>(null);
  const [status, setStatus] = useState<LabStatus>("loading");
  const [module, setModule] = useState<LabModule>("simulation");
  const [mode, setMode] = useState<SimulationMode>("expected");
  const [comparisonIds, setComparisonIds] = useState<{
    baselineId: string;
    comparisonId: string;
  }>({ baselineId: "", comparisonId: "" });
  const [notice, setNotice] = useState("");
  const [persisted, setPersisted] = useState<SavePhase>("saved");
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const conflictRef = useRef<ConflictState | null>(null);
  const [syncBanner, setSyncBanner] = useState<SyncBanner | null>(null);
  const chain = useRef(Promise.resolve());
  const scheduled = useRef(false);
  const sequence = useRef(0);
  const syncing = useRef(false);

  const activeProject =
    document?.projects.find(
      (project) => project.id === document.activeProjectId,
    ) ?? document?.projects[0];
  const result = useMemo(
    () => (activeProject ? simulateProject(activeProject, mode) : undefined),
    [activeProject, mode],
  );
  const graphAnalysis = useMemo(
    () => (activeProject ? getGraphAnalysis(activeProject) : undefined),
    [activeProject],
  );
  const scenarioList = activeProject?.scenarios ?? [];
  const baselineScenario =
    scenarioList.find((scenario) => scenario.id === comparisonIds.baselineId) ??
    scenarioList[1] ??
    scenarioList[0];
  const comparisonScenario =
    scenarioList.find(
      (scenario) => scenario.id === comparisonIds.comparisonId,
    ) ?? scenarioList[0];
  const scenarioComparison: ScenarioComparison | undefined =
    baselineScenario && comparisonScenario
      ? compareScenarios(baselineScenario, comparisonScenario)
      : undefined;
  const simulationValid =
    Boolean(activeProject) &&
    result?.entries.length === activeProject?.nodes.length;

  const applyLoaded = useCallback(
    (stored: StoredWorkspace, recovered: boolean, seeded: boolean) => {
      baseRef.current = stored.document;
      baseRevisionRef.current = stored.revision;
      remoteRef.current = stored;
      documentRef.current = stored.document;
      conflictRef.current = null;
      setConflict(null);
      setDocument(stored.document);
      setStatus("ready");
      setPersisted("saved");
      setNotice(recovered || seeded ? "已载入示例工作区；后续修改会自动保存到此设备。" : "");
    },
    [],
  );

  useEffect(() => {
    let mounted = true;
    void repository
      .load()
      .then(({ stored, recovered }) => {
        if (!mounted) return;
        applyLoaded(stored, recovered, false);
      })
      .catch(() => {
        if (!mounted) return;
        // load 本身已内置示例回落；走到这里说明存储 API 不可用，仍给可编辑的内存工作区。
        applyLoaded(exampleStored(), true, true);
        setStatus("ready");
      });
    return () => {
      mounted = false;
    };
  }, [repository, applyLoaded]);

  const adoptRemote = useCallback((remote: StoredWorkspace) => {
    baseRef.current = remote.document;
    baseRevisionRef.current = remote.revision;
    remoteRef.current = remote;
    documentRef.current = remote.document;
    conflictRef.current = null;
    setConflict(null);
    setDocument(remote.document);
    setPersisted("saved");
  }, []);

  const openConflict = useCallback(
    (
      local: WorkspaceDocument,
      remote: StoredWorkspace,
      resolutions: ResolutionMap = {},
    ) => {
      const base = baseRef.current ?? local;
      const { report } = mergeWorkspaces(
        base,
        local,
        remote.document,
        resolutions,
      );
      const next: ConflictState = {
        base,
        local,
        remote: remote.document,
        remoteRevision: remote.revision,
        remoteUpdatedAt: remote.document.projects.reduce(
          (latest, project) => Math.max(latest, project.updatedAt),
          0,
        ),
        conflicts: report.conflicts,
        autoChanges: report.autoChanges,
        resolutions,
      };
      conflictRef.current = next;
      setConflict(next);
      setPersisted("conflict");
    },
    [],
  );

  /** 串行化的自动保存链：快速连续编辑只保留最后一个草稿，冲突时在同一轮内重算。 */
  const persist = useCallback(() => {
    if (scheduled.current) return;
    scheduled.current = true;
    chain.current = chain.current.then(async () => {
      scheduled.current = false;
      const local = documentRef.current;
      if (!local || !baseRef.current) return;
      // 冲突面板已打开：新编辑只更新冲突视图，不做覆盖式写入。
      if (conflictRef.current) {
        openConflict(local, remoteRef.current ?? {
          envelope: 2,
          revision: conflictRef.current.remoteRevision,
          document: conflictRef.current.remote,
        }, conflictRef.current.resolutions);
        return;
      }
      const token = ++sequence.current;
      setPersisted("saving");
      // 共同祖先固定为本次保存开始时的基线；自动 rebase 只更新期望修订号与草稿。
      const ancestor = baseRef.current;
      let expected = baseRevisionRef.current;
      let draft = local;
      for (let round = 0; round <= REBASE_ROUNDS; round += 1) {
        const outcome = await repository.save(draft, expected);
        if (outcome.kind === "committed") {
          // 提交内容就是新的三方共同祖先（已包含本轮自动并入的远端改动）。
          baseRef.current = draft;
          baseRevisionRef.current = outcome.revision;
          remoteRef.current = {
            envelope: 2,
            revision: outcome.revision,
            document: draft,
          };
          signals.notify();
          if (sequence.current === token) {
            setPersisted("saved");
            setStatus((current) =>
              current === "editing" ? "completed" : current,
            );
          }
          return;
        }
        if (!outcome.remote) {
          if (sequence.current === token) {
            setPersisted("error");
            setStatus("error");
            setNotice(
              "保存被拒绝且无法读取对端数据，请稍后重试；本页改动不会丢失。",
            );
          }
          return;
        }
        remoteRef.current = outcome.remote;
        const { document: merged, report } = mergeWorkspaces(
          ancestor,
          draft,
          outcome.remote.document,
        );
        if (report.conflicts.length > 0 || round === REBASE_ROUNDS) {
          if (sequence.current === token)
            openConflict(draft, outcome.remote);
          return;
        }
        // 没有真正撞车：以远端为新期望修订号自动重放，继续尝试提交（祖先不变）。
        draft = merged;
        documentRef.current = merged;
        setDocument(merged);
        expected = outcome.remote.revision;
        if (sequence.current === token)
          setSyncBanner({
            tone: "info",
            message:
              "已自动并入其他标签页的改动并继续保存，未发生字段冲突。",
          });
      }
      // 循环耗尽（远端连续多轮推进）：下一轮编辑会再次触发，这里保留草稿不丢。
    });
  }, [openConflict, repository, signals]);

  const commit = useCallback(
    (next: WorkspaceDocument, nextStatus: LabStatus = "editing") => {
      documentRef.current = next;
      setDocument(next);
      setStatus(nextStatus);
      setNotice("");
      persist();
    },
    [persist],
  );

  const editProject = useCallback(
    (project: LatencyProject) => {
      const current = documentRef.current;
      if (current) commit(updateProject(current, project));
    },
    [commit],
  );

  const chooseProject = useCallback(
    (id: string) => {
      const current = documentRef.current;
      if (current) commit(selectProject(current, id), "ready");
    },
    [commit],
  );

  const newProject = useCallback(() => {
    const current = documentRef.current;
    if (current) commit(createProject(current), "editing");
  }, [commit]);

  const renameActive = useCallback(
    (title: string) => {
      if (activeProject) editProject(renameProject(activeProject, title));
    },
    [activeProject, editProject],
  );

  const duplicateActive = useCallback(() => {
    const current = documentRef.current;
    if (current && activeProject)
      commit(duplicateProject(current, activeProject), "editing");
  }, [activeProject, commit]);

  const deleteProject = useCallback(
    (id: string) => {
      const current = documentRef.current;
      if (current && current.projects.length > 1)
        commit(removeProject(current, id), "editing");
      else setNotice("至少保留一个链路项目。");
    },
    [commit],
  );

  const addNode = useCallback(() => {
    if (activeProject) editProject(addRequestNode(activeProject));
  }, [activeProject, editProject]);
  const patchNode = useCallback(
    (id: string, patch: Parameters<typeof patchRequestNode>[2]) => {
      if (activeProject)
        editProject(patchRequestNode(activeProject, id, patch));
    },
    [activeProject, editProject],
  );
  const deleteNode = useCallback(
    (id: string) => {
      if (activeProject) editProject(removeRequestNode(activeProject, id));
    },
    [activeProject, editProject],
  );
  const setNodeDependency = useCallback(
    (id: string, dependencyId: string) => {
      if (!activeProject) return;
      const outcome = toggleDependency(activeProject, id, dependencyId);
      if (outcome.error) setNotice(outcome.error);
      else editProject(outcome.project);
    },
    [activeProject, editProject],
  );
  const setLimit = useCallback(
    (limit: number | null) => {
      if (activeProject) editProject(setConcurrency(activeProject, limit));
    },
    [activeProject, editProject],
  );

  const simulate = useCallback(
    (nextMode = mode) => {
      if (!activeProject) return undefined;
      setStatus("simulating");
      const result = simulateProject(activeProject, nextMode);
      setMode(nextMode);
      setStatus(
        result.warnings.some((warning) => warning.includes("循环"))
          ? "error"
          : "completed",
      );
      return result;
    },
    [activeProject, mode],
  );

  const saveSnapshot = useCallback(
    (name: string): boolean => {
      if (!activeProject) return false;
      const result = simulateProject(activeProject, mode);
      if (result.entries.length !== activeProject.nodes.length) {
        setNotice(result.warnings[0] ?? "请先修复链路配置再保存方案。");
        return false;
      }
      const next = saveScenario(activeProject, result, name);
      editProject(next);
      setComparisonIds({
        baselineId: next.scenarios[1]?.id ?? next.scenarios[0]?.id ?? "",
        comparisonId: next.scenarios[0]?.id ?? "",
      });
      setNotice("方案快照已保存。");
      return true;
    },
    [activeProject, editProject, mode],
  );

  const removeSavedScenario = useCallback(
    (id: string) => {
      if (activeProject) editProject(removeScenario(activeProject, id));
    },
    [activeProject, editProject],
  );
  const restoreSavedScenario = useCallback(
    (id: string) => {
      if (activeProject) editProject(restoreScenario(activeProject, id));
    },
    [activeProject, editProject],
  );

  const retrySave = useCallback(() => {
    persist();
  }, [persist]);

  // ---- 冲突面板的三个出路 ----

  /** 带着逐项选择执行合并保存；远端若又推进，最多自动 rebase REBASE_ROUNDS 轮。 */
  const resolveConflict = useCallback(
    (resolutions: ResolutionMap = conflictRef.current?.resolutions ?? {}): void => {
      const current = conflictRef.current;
      const local = documentRef.current;
      if (!current || !local) return;
      setPersisted("saving");
      void (async () => {
      // 第一轮必须复用冲突面板的同一组三方输入（base/local/remote），
      // 否则“采用对端”的字段选择会被误判成本侧独有改动。
      let baseInput: WorkspaceDocument = current.base;
      let remoteInput: WorkspaceDocument = current.remote;
      let expected = current.remoteRevision;
      let draft: WorkspaceDocument = local;
      for (let round = 0; round <= REBASE_ROUNDS; round += 1) {
        const merged = mergeWorkspaces(
          baseInput,
          draft,
          remoteInput,
          resolutions,
        );
        const outcome = await repository.save(merged.document, expected);
        if (outcome.kind === "committed") {
          baseRef.current = merged.document;
          baseRevisionRef.current = outcome.revision;
          remoteRef.current = {
            envelope: 2,
            revision: outcome.revision,
            document: merged.document,
          };
          documentRef.current = merged.document;
          setDocument(merged.document);
          conflictRef.current = null;
          setConflict(null);
          setPersisted("saved");
          setSyncBanner({ tone: "info", message: "两侧改动已合并保存。" });
          signals.notify();
          return;
        }
        if (!outcome.remote) {
          setPersisted("error");
          setNotice("保存失败：无法读取最新数据，请重试。");
          return;
        }
        // 远端在处理期间又推进：以刚合并过的远端为新共同祖先重放一次。
        const retry = mergeWorkspaces(
          remoteInput,
          merged.document,
          outcome.remote.document,
          resolutions,
        );
        remoteRef.current = outcome.remote;
        if (retry.report.conflicts.length > 0 || round === REBASE_ROUNDS) {
          // 又撞了新的字段：带着已有选择重新打开面板。
          openConflict(merged.document, outcome.remote, resolutions);
          return;
        }
        baseInput = remoteInput;
        remoteInput = outcome.remote.document;
        expected = outcome.remote.revision;
        draft = retry.document;
      }
    })();
  }, [openConflict, repository, signals, setNotice]);

  /** 放弃本侧未保存改动，整体采用对端版本。 */
  const discardLocal = useCallback(() => {
    const current = conflictRef.current;
    if (!current) return;
    adoptRemote({
      envelope: 2,
      revision: current.remoteRevision,
      document: current.remote,
    });
    setSyncBanner({
      tone: "info",
      message: "已放弃本页未保存的改动，载入其他标签页保存的最新版本。",
    });
  }, [adoptRemote]);

  /** 明确知情地用本侧草稿整体覆盖对端（界面需二次确认）。 */
  const forceOverwrite = useCallback(async () => {
    const local = documentRef.current;
    if (!local) return;
    setPersisted("saving");
    try {
      const revision = await repository.forceSave(local);
      baseRef.current = local;
      baseRevisionRef.current = revision;
      remoteRef.current = { envelope: 2, revision, document: local };
      conflictRef.current = null;
      setConflict(null);
      setPersisted("saved");
      setSyncBanner({
        tone: "warn",
        message: "已按你的选择覆盖其他标签页的改动；对方再次操作时会看到最新版本。",
      });
      signals.notify();
    } catch {
      setPersisted("error");
      setNotice("覆盖保存失败，请重试；本页改动不会丢失。");
    }
  }, [repository, signals]);

  // ---- 切标签页 / 重新可见 / 收到对端通知：主动探测 ----

  const reconcile = useCallback(async () => {
    if (syncing.current) return;
    const local = documentRef.current;
    if (!local || !baseRef.current) return;
    syncing.current = true;
    try {
      const remote = await repository.peek();
      if (!remote) return;
      const known = remoteRef.current;
      if (known && remote.revision === known.revision) return;
      remoteRef.current = remote;

      const dirty = !isSameDocument(local, baseRef.current);
      if (!dirty) {
        // 本页没有未保存改动：静默跟随，不打断推演视图。
        adoptRemote(remote);
        setSyncBanner({
          tone: "info",
          message: "检测到其他标签页已保存，本页已自动切换为最新版本。",
        });
        return;
      }
      const { document: rebased, report } = mergeWorkspaces(
        baseRef.current,
        local,
        remote.document,
      );
      if (report.conflicts.length > 0) {
        openConflict(local, remote, conflictRef.current?.resolutions);
        return;
      }
      // 有未保存改动但可自动合并：立即以远端为共同祖先重放草稿，
      // 更新页面内容后走正常保存链；下一次保存携带远端修订号，不会覆盖任何一方。
      baseRef.current = remote.document;
      baseRevisionRef.current = remote.revision;
      documentRef.current = rebased;
      setDocument(rebased);
      setSyncBanner({
        tone: "info",
        message:
          "其他标签页的改动与你当前编辑不冲突，已自动合并到本页并保存。",
      });
      persist();
    } finally {
      syncing.current = false;
    }
  }, [adoptRemote, openConflict, persist, repository]);

  useEffect(() => {
    const unsubscribe = signals.subscribe(() => {
      void reconcile();
    });
    const onVisible = () => {
      if (window.document.visibilityState === "visible") void reconcile();
    };
    const onFocus = () => void reconcile();
    window.document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      unsubscribe();
      window.document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [reconcile, signals]);

  // 冲突未解决时离开/刷新页面，给出最后一道保护。
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (conflictRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const selectComparisonScenario = useCallback(
    (side: "baselineId" | "comparisonId", id: string) => {
      setComparisonIds((current) => ({ ...current, [side]: id }));
    },
    [],
  );

  return {
    document,
    activeProject,
    result,
    graphAnalysis,
    simulationValid,
    status,
    module,
    setModule,
    mode,
    setMode,
    notice,
    setNotice,
    persisted,
    conflict,
    syncBanner,
    setSyncBanner,
    chooseProject,
    newProject,
    renameActive,
    duplicateActive,
    deleteProject,
    addNode,
    patchNode,
    deleteNode,
    setNodeDependency,
    setLimit,
    simulate,
    saveSnapshot,
    removeSavedScenario,
    restoreSavedScenario,
    retrySave,
    resolveConflict,
    discardLocal,
    forceOverwrite,
    scenarioList,
    baselineScenario,
    comparisonScenario,
    scenarioComparison,
    selectComparisonScenario,
  };
}
