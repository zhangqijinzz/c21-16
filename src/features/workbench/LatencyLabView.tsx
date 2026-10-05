import {
  Activity,
  Archive,
  Boxes,
  GitBranch,
  GitCompareArrows,
  Plus,
  RadioTower,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLatencyLab } from "./useLatencyLab";
import ConflictDialog from "./ConflictDialog";
import ProjectsPanel from "../projects/ProjectsPanel";
import GraphEditor from "../graph-editor/GraphEditor";
import SimulationPanel from "../simulation/SimulationPanel";
import ScenarioPanel from "../scenarios/ScenarioPanel";
import ArchivePanel from "../archive/ArchivePanel";
import Sidebar, { type NavigationItem } from "./Sidebar";

const navigation: NavigationItem[] = [
  { id: "projects", label: "链路项目", sublabel: "PROJECTS", icon: Boxes },
  { id: "graph", label: "请求编排", sublabel: "DEPENDENCIES", icon: GitBranch },
  {
    id: "simulation",
    label: "时序推演",
    sublabel: "SIMULATION",
    icon: Activity,
  },
  {
    id: "scenarios",
    label: "方案对比",
    sublabel: "SCENARIOS",
    icon: GitCompareArrows,
  },
  {
    id: "archive",
    label: "本地项目区",
    sublabel: "LOCAL ARCHIVE",
    icon: Archive,
  },
];

export default function LatencyLabView() {
  const vm = useLatencyLab();
  const [conflictOpen, setConflictOpen] = useState(true);
  // 新一轮冲突（或对端在面板打开期间再次保存）时重新展开面板。
  const conflictRevision = vm.conflict?.remoteRevision ?? "";
  const conflictCount = vm.conflict?.conflicts.length ?? 0;
  useEffect(() => {
    if (vm.conflict) setConflictOpen(true);
  }, [conflictRevision, conflictCount, vm.conflict]);
  if (
    vm.status === "loading" ||
    !vm.document ||
    !vm.activeProject ||
    !vm.result
  )
    return (
      <main className="loading-screen">
        <div className="loading-mark">
          <RadioTower size={24} />
        </div>
        <strong>LatencyLab</strong>
        <span>正在恢复本地工作区…</span>
        <div className="loading-line">
          <i />
        </div>
      </main>
    );

  const active = vm.activeProject;
  return (
    <div className="app-shell">
      <Sidebar
        activeProject={active}
        projects={vm.document.projects}
        activeModule={vm.module}
        navigation={navigation}
        onModule={vm.setModule}
        onChooseProject={vm.chooseProject}
        onNewProject={() => {
          vm.newProject();
          vm.setModule("graph");
        }}
      />
      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>LatencyLab</span>
            <b>/</b>
            <strong>
              {navigation.find((item) => item.id === vm.module)?.label}
            </strong>
          </div>
          <div className="topbar-right">
            <span
              className={`save-state ${
                vm.persisted === "error"
                  ? "save-error"
                  : vm.persisted === "conflict"
                    ? "save-conflict"
                    : ""
              }`}
            >
              <i />
              {vm.persisted === "saving"
                ? "保存中"
                : vm.persisted === "error"
                  ? "保存失败"
                  : vm.persisted === "conflict"
                    ? "存在并发冲突"
                    : "已保存"}
            </span>
            {vm.persisted === "conflict" && vm.conflict && !conflictOpen && (
              <button
                type="button"
                className="conflict-chip"
                onClick={() => setConflictOpen(true)}
              >
                <ShieldAlert size={13} />
                {vm.conflict.conflicts.length} 处改动待处理
              </button>
            )}
            <span className="topbar-divider" />
            <span className="env-pill">
              <i />
              LOCAL
            </span>
            <button
              className="top-create"
              onClick={() => {
                vm.newProject();
                vm.setModule("graph");
              }}
            >
              <Plus size={14} /> 新建项目
            </button>
          </div>
        </header>
        {vm.notice && (
          <div className="notice-banner">
            <span>
              <Sparkles size={14} /> {vm.notice}
            </span>
            <button onClick={() => vm.setNotice("")} aria-label="关闭提示">
              <X size={14} />
            </button>
          </div>
        )}
        {vm.syncBanner && (
          <div
            className={`sync-banner ${vm.syncBanner.tone === "warn" ? "sync-warn" : ""}`}
          >
            <span>
              <GitCompareArrows size={14} /> {vm.syncBanner.message}
            </span>
            <button
              onClick={() => vm.setSyncBanner(null)}
              aria-label="关闭提示"
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div className="content-scroll">
          {vm.module === "projects" && (
            <ProjectsPanel
              projects={vm.document.projects}
              activeId={active.id}
              onChoose={vm.chooseProject}
              onCreate={() => {
                vm.newProject();
                vm.setModule("graph");
              }}
              onRename={vm.renameActive}
              onDuplicate={vm.duplicateActive}
              onOpenEditor={() => vm.setModule("graph")}
            />
          )}
          {vm.module === "graph" && vm.graphAnalysis && (
            <GraphEditor
              project={active}
              graph={vm.graphAnalysis}
              onAdd={vm.addNode}
              onPatch={vm.patchNode}
              onDelete={vm.deleteNode}
              onDependency={vm.setNodeDependency}
            />
          )}
          {vm.module === "simulation" && (
            <SimulationPanel
              project={active}
              result={vm.result}
              mode={vm.mode}
              onMode={vm.setMode}
              onConcurrency={vm.setLimit}
              onRun={() => {
                vm.simulate(vm.mode);
              }}
            />
          )}
          {vm.module === "scenarios" && (
            <ScenarioPanel
              project={active}
              onSave={vm.saveSnapshot}
              onRemove={vm.removeSavedScenario}
              onRestore={vm.restoreSavedScenario}
              baseline={vm.baselineScenario}
              comparison={vm.comparisonScenario}
              comparisonResult={vm.scenarioComparison}
              onSelectBaseline={(id) =>
                vm.selectComparisonScenario("baselineId", id)
              }
              onSelectComparison={(id) =>
                vm.selectComparisonScenario("comparisonId", id)
              }
            />
          )}
          {vm.module === "archive" && (
            <ArchivePanel
              projects={vm.document.projects}
              activeId={active.id}
              storageState={vm.persisted}
              notice={vm.notice}
              onChoose={vm.chooseProject}
              onDuplicate={vm.duplicateActive}
              onDelete={vm.deleteProject}
              onRetrySave={vm.retrySave}
            />
          )}
        </div>
        <footer className="main-footer">
          <span>
            <span className="footer-pulse" />
            {vm.status === "simulating"
              ? "推演运行中"
              : vm.simulationValid
                ? "推演准备完成"
                : "等待链路配置"}
          </span>
          <span>
            LATENCYLAB <b>·</b> LOCAL FIRST <b>·</b> V1.0
          </span>
          <button onClick={() => vm.setModule("archive")}>
            <RotateCcw size={12} /> 数据保存在此设备
          </button>
        </footer>
      </main>
      {vm.conflict && conflictOpen && (
        <ConflictDialog
          conflict={vm.conflict}
          onResolve={(resolutions) => {
            vm.resolveConflict(resolutions);
            setConflictOpen(false);
          }}
          onDiscard={() => {
            vm.discardLocal();
            setConflictOpen(false);
          }}
          onForceOverwrite={() => {
            void vm.forceOverwrite();
            setConflictOpen(false);
          }}
          onContinueEdit={() => setConflictOpen(false)}
        />
      )}
    </div>
  );
}
