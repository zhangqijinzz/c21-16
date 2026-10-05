import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ProjectRepository,
  SaveConflictError,
} from "../../shared/repositories/projectRepository";
import { conflictDraft } from "../../shared/services/conflictDraft";
import { WorkspaceSync } from "../../shared/services/syncService";
import type {
  LatencyProject,
  SimulationMode,
  WorkspaceDocument,
} from "../../shared/domain/types";
import {
  deepEqual,
  mergeDocuments,
  type ConflictSide,
  type MergeConflict,
} from "../../shared/domain/merge";
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
export type PersistState = "saving" | "saved" | "error" | "conflict";

export interface ConflictView {
  /** 对方保存的最新文档。 */
  remote: WorkspaceDocument;
  /** 以当前本地草稿 + 当前取舍实时重算出的合并结果。 */
  conflicts: MergeConflict[];
  autoChanges: string[];
  choices: Record<string, ConflictSide>;
  /** 模态框被用户暂时关闭，但冲突仍未解决（横幅仍在）。 */
  dismissed: boolean;
  remoteSavedAt: number;
}

const SAVE_DEBOUNCE_MS = 400;

export interface LatencyLabOptions {
  /** 同步轮询间隔，测试可调小。 */
  syncIntervalMs?: number;
  /** 关闭自动保存防抖，保存立即触发（测试用）。 */
  immediateSave?: boolean;
  /** BroadcastChannel 频道名；测试中每个实例使用不同名称以隔离。 */
  channelName?: string;
}

export function useLatencyLab(options: LatencyLabOptions = {}) {
  const repository = useMemo(() => new ProjectRepository(), []);
  const [document, setDocument] = useState<WorkspaceDocument | null>(null);
  const documentRef = useRef<WorkspaceDocument | null>(null);
  /** 最后一次确认一致的已保存版本，也是三方合并的 base。 */
  const baseRef = useRef<WorkspaceDocument | null>(null);
  /** 下一次 CAS 写入的期望 revision；null 表示要求存储为空（首次写入）。 */
  const expectedRevisionRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());

  const [status, setStatus] = useState<LabStatus>("loading");
  const [module, setModule] = useState<LabModule>("simulation");
  const [mode, setMode] = useState<SimulationMode>("expected");
  const [comparisonIds, setComparisonIds] = useState<{
    baselineId: string;
    comparisonId: string;
  }>({ baselineId: "", comparisonId: "" });
  const [notice, setNotice] = useState("");
  const [persisted, setPersisted] = useState<PersistState>("saved");
  const [conflict, setConflict] = useState<ConflictView | null>(null);
  const conflictRef = useRef<ConflictView | null>(null);
  const syncRef = useRef<WorkspaceSync | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const setConflictBoth = useCallback((next: ConflictView | null) => {
    conflictRef.current = next;
    setConflict(next);
  }, []);

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

  const selectComparisonScenario = useCallback(
    (side: "baselineId" | "comparisonId", id: string) => {
      setComparisonIds((current) => ({ ...current, [side]: id }));
    },
    [],
  );

  const isDirty = useCallback(
    () =>
      Boolean(
        documentRef.current &&
        baseRef.current &&
        !deepEqual(documentRef.current, baseRef.current),
      ),
    [],
  );

  /** 实时合并预览：本地继续编辑时冲突列表随之重算。 */
  const conflictPreview = useMemo(() => {
    if (!conflict || !baseRef.current || !documentRef.current) return null;
    const choices = conflict.choices;
    return mergeDocuments(
      baseRef.current,
      documentRef.current,
      conflict.remote,
      (entry) => choices[entry.id] ?? "ours",
    );
    // document 变更（继续编辑）与 conflict 变更（取舍/远端刷新）都触发重算；
    // documentRef 自身不变，因此显式依赖 document 状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflict, document]);

  // ---- 冲突进入 / 退出 -------------------------------------------------

  const enterConflict = useCallback(
    (
      remote: WorkspaceDocument,
      local: WorkspaceDocument,
      base: WorkspaceDocument,
    ) => {
      if (deepEqual(remote, local)) {
        // 两侧内容恰好一致：无需打扰用户，直接以远端版本对齐。
        expectedRevisionRef.current = remote.revision;
        baseRef.current = remote;
        documentRef.current = structuredClone(remote);
        setDocument(structuredClone(remote));
        setPersisted("saved");
        conflictDraft.clear();
        setConflictBoth(null);
        return;
      }
      conflictDraft.save({
        savedAt: Date.now(),
        baseRevision: base.revision,
        base,
        document: local,
      });
      setConflictBoth({
        remote,
        conflicts: [],
        autoChanges: [],
        choices: {},
        dismissed: false,
        remoteSavedAt: Date.now(),
      });
      setPersisted("conflict");
      setNotice("另一个标签页已经保存了改动。请选择如何合并，保存已暂停。");
    },
    [setConflictBoth],
  );

  const closeConflict = useCallback(() => {
    // 草稿在合并保存成功或显式重新载入后才清除；这里只关 UI。
    setConflictBoth(null);
  }, [setConflictBoth]);

  // ---- 保存管线 --------------------------------------------------------

  const flushSave = useCallback(async (): Promise<void> => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (savingRef.current) return;
    const local = documentRef.current;
    const base = baseRef.current;
    if (!local || !base) return;
    if (conflictRef.current) {
      setPersisted("conflict");
      return;
    }
    if (!isDirty()) {
      setPersisted("saved");
      return;
    }
    savingRef.current = true;
    setPersisted("saving");
    try {
      const expected = expectedRevisionRef.current;
      const written = await repository.save(
        { ...local, revision: expected ?? 0 },
        expected,
      );
      expectedRevisionRef.current = written.revision;
      baseRef.current = written;
      // 把存储分配的新 revision 回写到本地草稿（内容不变），否则
      // 本地文档与 base 永远差一个 revision，会触发无限递归保存。
      const latestLocal = documentRef.current;
      if (!latestLocal || latestLocal === local) {
        documentRef.current = written;
        setDocument(written);
      } else {
        const rebased: WorkspaceDocument = {
          ...latestLocal,
          revision: written.revision,
        };
        documentRef.current = rebased;
        setDocument(rebased);
      }
      savingRef.current = false;
      syncRef.current?.notifySaved();
      if (conflictRef.current) {
        // 极端情况下保存途中打开了冲突（不会在当前流程发生），保持冲突态。
        return;
      }
      // 冲突合并保存成功后才清除本地草稿。
      conflictDraft.clear();
      // 保存往返期间用户可能又改了内容，继续落盘最新版本。
      if (isDirty()) {
        setPersisted("saving");
        void flushSave();
      } else {
        setPersisted("saved");
        setStatus((current) => (current === "editing" ? "completed" : current));
      }
    } catch (error) {
      savingRef.current = false;
      if (error instanceof SaveConflictError) {
        const remote = error.remote as WorkspaceDocument;
        enterConflict(remote, documentRef.current ?? local, base);
        return;
      }
      setPersisted("error");
      setStatus("error");
      setNotice("保存失败。数据仍保留在当前页面，请重试保存。");
    }
  }, [repository, enterConflict, isDirty]);

  const scheduleSave = useCallback(() => {
    if (conflictRef.current) {
      setPersisted("conflict");
      return;
    }
    setPersisted("saving");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (optionsRef.current.immediateSave) {
      void flushSave();
      return;
    }
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void flushSave();
    }, SAVE_DEBOUNCE_MS);
  }, [flushSave]);

  // ---- 远端变更处理（切回标签页 / 事件 / 轮询） -------------------------

  const adoptRemote = useCallback(
    (remote: WorkspaceDocument, announce: boolean) => {
      expectedRevisionRef.current = remote.revision;
      baseRef.current = remote;
      documentRef.current = structuredClone(remote);
      setDocument(structuredClone(remote));
      setPersisted("saved");
      if (announce)
        setNotice("检测到另一个标签页的新改动，已自动载入最新工作区。");
    },
    [],
  );

  const handleRemoteChange = useCallback(async () => {
    if (status === "loading" || !baseRef.current) return;
    if (savingRef.current) return; // 进行中的 CAS 自己会给出结论
    if (conflictRef.current) {
      // 冲突还开着又有新版本：刷新远端，让用户基于最新内容取舍。
      const loaded = await repository.load();
      const current = conflictRef.current;
      if (loaded.document.revision !== current.remote.revision) {
        setConflictBoth({
          ...current,
          remote: loaded.document,
          dismissed: false,
        });
      }
      return;
    }
    const loaded = await repository.load();
    if (loaded.storeEmpty) return;
    const expected = expectedRevisionRef.current;
    if (loaded.document.revision === expected) return;
    if (isDirty()) {
      // 本地有未保存改动，远端也更新了：立即进入冲突，不必等保存失败。
      enterConflict(loaded.document, documentRef.current!, baseRef.current);
    } else {
      // 干净页面（切换标签页回来、长时间停留）：直接静默/提示载入。
      adoptRemote(
        loaded.document,
        globalThis.document.visibilityState === "visible",
      );
    }
  }, [
    repository,
    status,
    isDirty,
    adoptRemote,
    enterConflict,
    setConflictBoth,
  ]);

  const queueRemoteCheck = useCallback(() => {
    syncQueueRef.current = syncQueueRef.current
      .then(() => handleRemoteChange())
      .catch(() => undefined);
  }, [handleRemoteChange]);

  // 同步器在启动 effect 中创建，但回调必须始终调用最新的处理函数，
  // 否则闭包里会永远是首渲染时 status="loading" 的旧版本。
  const remoteHandlerRef = useRef(queueRemoteCheck);
  remoteHandlerRef.current = queueRemoteCheck;

  // ---- 启动载入 + 草稿恢复 ---------------------------------------------

  useEffect(() => {
    let mounted = true;
    const sync = new WorkspaceSync(
      {
        onChange: () => remoteHandlerRef.current(),
        intervalMs: options.syncIntervalMs,
      },
      options.channelName,
    );
    syncRef.current = sync;
    void repository
      .load()
      .then((loaded) => {
        if (!mounted) return;
        baseRef.current = loaded.document;
        expectedRevisionRef.current = loaded.storeEmpty
          ? null
          : loaded.document.revision;
        documentRef.current = structuredClone(loaded.document);
        setDocument(structuredClone(loaded.document));
        sync.start();

        // 冲突草稿恢复：刷新/崩溃后仍能找回未解决的本地改动。
        const draft = conflictDraft.load();
        if (draft && !deepEqual(draft.document, loaded.document)) {
          if (draft.baseRevision === loaded.document.revision) {
            // 远端之后没有新保存：恢复本地草稿继续编辑即可。
            baseRef.current = loaded.document;
            documentRef.current = draft.document;
            setDocument(draft.document);
            setPersisted("saving");
            setNotice("已恢复上次尚未保存的本地改动。");
            conflictDraft.clear();
            scheduleSave();
          } else {
            // 远端在冲突之后又有新保存：以草稿记录的共同祖先继续走三方合并。
            enterConflict(loaded.document, draft.document, draft.base);
          }
          setStatus("ready");
          return;
        }
        if (draft) conflictDraft.clear();
        setStatus("ready");
        if (loaded.recovered)
          setNotice("已载入示例工作区；后续修改会自动保存到此设备。");
      })
      .catch(() => {
        if (!mounted) return;
        setStatus("error");
        setNotice("本地项目读取失败，刷新页面可再次尝试。");
      });
    return () => {
      mounted = false;
      sync.dispose();
      syncRef.current = null;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
    // 仅启动时执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repository]);

  // ---- 本地编辑入口 ----------------------------------------------------

  const commit = useCallback(
    (next: WorkspaceDocument, nextStatus: LabStatus = "editing") => {
      documentRef.current = next;
      setDocument(next);
      setStatus(nextStatus);
      setNotice("");
      scheduleSave();
    },
    [scheduleSave],
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
    void flushSave();
  }, [flushSave]);

  // ---- 冲突解决动作 ----------------------------------------------------

  const resolveConflict = useCallback(
    (id: string, side: ConflictSide) => {
      setConflictBoth(
        conflictRef.current
          ? {
              ...conflictRef.current,
              choices: { ...conflictRef.current.choices, [id]: side },
            }
          : null,
      );
    },
    [setConflictBoth],
  );

  const resolveAllConflicts = useCallback(
    (side: ConflictSide) => {
      const current = conflictRef.current;
      if (!current || !conflictPreview) return;
      const choices: Record<string, ConflictSide> = {};
      for (const entry of conflictPreview.conflicts) choices[entry.id] = side;
      setConflictBoth({ ...current, choices });
    },
    [conflictPreview, setConflictBoth],
  );

  const mergeAndSave = useCallback(() => {
    const current = conflictRef.current;
    const preview = conflictPreview;
    if (!current || !preview) return;
    const merged = preview.document;
    expectedRevisionRef.current = current.remote.revision;
    baseRef.current = current.remote;
    documentRef.current = merged;
    setDocument(merged);
    closeConflict();
    setPersisted("saving");
    setNotice(
      preview.autoChanges.length
        ? `已合并两侧改动（自动合入 ${preview.autoChanges.length} 处对方修改），正在保存…`
        : "已合并两侧改动，正在保存…",
    );
    void flushSave();
  }, [conflictPreview, closeConflict, flushSave]);

  const reloadFromRemote = useCallback(() => {
    const current = conflictRef.current;
    if (!current) return;
    adoptRemote(current.remote, false);
    conflictDraft.clear();
    closeConflict();
    setNotice("已放弃本标签页未保存的改动，并重新载入另一标签页的版本。");
  }, [adoptRemote, closeConflict]);

  const dismissConflict = useCallback(() => {
    const current = conflictRef.current;
    if (current) setConflictBoth({ ...current, dismissed: true });
  }, [setConflictBoth]);

  const reopenConflict = useCallback(() => {
    const current = conflictRef.current;
    if (current) setConflictBoth({ ...current, dismissed: false });
  }, [setConflictBoth]);

  // 把实时合并预览的结果投影到冲突视图上。
  const conflictView: ConflictView | null = conflict
    ? {
        ...conflict,
        conflicts: conflictPreview?.conflicts ?? [],
        autoChanges: conflictPreview?.autoChanges ?? [],
      }
    : null;

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
    conflict: conflictView,
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
    resolveAllConflicts,
    mergeAndSave,
    reloadFromRemote,
    dismissConflict,
    reopenConflict,
    scenarioList,
    baselineScenario,
    comparisonScenario,
    scenarioComparison,
    selectComparisonScenario,
  };
}
