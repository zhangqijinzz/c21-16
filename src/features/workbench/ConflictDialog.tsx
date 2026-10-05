import { useEffect, useState } from "react";
import { AlertTriangle, GitMerge, RefreshCw, ShieldAlert } from "lucide-react";
import type { ConflictState } from "./useLatencyLab";
import { fieldLabel, type ConflictEntry, type ResolutionMap } from "../../shared/domain/merge";

interface ConflictDialogProps {
  conflict: ConflictState;
  onResolve: (resolutions: ResolutionMap) => void;
  onDiscard: () => void;
  onForceOverwrite: () => void;
  onContinueEdit: () => void;
}

function scopePrefix(scope: ConflictEntry["scope"]): string {
  switch (scope) {
    case "project":
      return "项目";
    case "node":
      return "节点";
    case "scenario":
      return "方案快照";
    default:
      return "工作区";
  }
}

function describeKind(entry: ConflictEntry): string {
  if (entry.kind === "edit-delete")
    return entry.deletedBy === "local"
      ? "你删除了它，另一标签页修改了它"
      : "另一标签页删除了它，你修改了它";
  if (entry.kind === "both-created") return "两侧各自创建了同名内容";
  return `两侧同时修改了：${entry.fields.map(fieldLabel).join("、")}`;
}

function formatTime(ms: number): string {
  if (!ms) return "未知时间";
  try {
    return new Date(ms).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "未知时间";
  }
}

export default function ConflictDialog({
  conflict,
  onResolve,
  onDiscard,
  onForceOverwrite,
  onContinueEdit,
}: ConflictDialogProps) {
  const [resolutions, setResolutions] = useState<ResolutionMap>(
    conflict.resolutions,
  );
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  // 对端在面板打开期间又保存时，父级会带着已选项重开；同步本地选择状态。
  useEffect(() => {
    setResolutions(conflict.resolutions);
  }, [conflict.resolutions, conflict.remoteRevision, conflict.conflicts.length]);

  const setChoice = (entry: ConflictEntry, choice: "local" | "remote") => {
    setResolutions((current) => ({ ...current, [entry.id]: choice }));
  };

  const allResolved = conflict.conflicts.every(
    (entry) => resolutions[entry.id] !== undefined,
  );

  return (
    <div className="dialog-backdrop conflict-backdrop" role="presentation">
      <section
        className="confirm-dialog conflict-dialog"
        role="dialog"
        aria-modal="false"
        aria-labelledby="conflict-title"
      >
        <div className="dialog-icon conflict-icon">
          <ShieldAlert size={18} />
        </div>
        <h2 id="conflict-title">检测到其他标签页的改动</h2>
        <p className="conflict-lead">
          另一个标签页在 {formatTime(conflict.remoteUpdatedAt)} 保存过同一工作区。
          为避免任何一侧的改动被静默覆盖，保存已暂停。你可以继续在页面上编辑，
          下列条目逐项决定保留哪一侧后再合并保存。
        </p>

        {conflict.autoChanges.length > 0 && (
          <div className="conflict-auto">
            <div className="conflict-section-title">
              <GitMerge size={13} /> 已可自动合并（{conflict.autoChanges.length}
              ）
            </div>
            <ul>
              {conflict.autoChanges.slice(0, 6).map((change, index) => (
                <li key={`${change.scope}-${change.label}-${index}`}>
                  <b>{change.label}</b>
                  <span>{change.detail}</span>
                </li>
              ))}
              {conflict.autoChanges.length > 6 && (
                <li className="conflict-more">
                  另有 {conflict.autoChanges.length - 6} 条合并说明…
                </li>
              )}
            </ul>
          </div>
        )}

        <div className="conflict-manual">
          <div className="conflict-section-title">
            <AlertTriangle size={13} /> 需要你决定（{conflict.conflicts.length}
            ）
          </div>
          <ul>
            {conflict.conflicts.map((entry) => {
              const choice = resolutions[entry.id] ?? "local";
              return (
                <li key={entry.id} className="conflict-item">
                  <div className="conflict-item-head">
                    <span className="conflict-tag">
                      {scopePrefix(entry.scope)}
                    </span>
                    <b>{entry.label}</b>
                    {entry.projectLabel &&
                      entry.scope !== "project" && (
                        <em>（{entry.projectLabel}）</em>
                      )}
                  </div>
                  <p>{describeKind(entry)}</p>
                  {entry.values.length > 0 && (
                    <dl className="conflict-values">
                      {entry.values.map((value) => (
                        <div key={value.field}>
                          <dt>{value.field}</dt>
                          <dd className="value-local">本页：{value.local}</dd>
                          <dd className="value-remote">
                            对端：{value.remote}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  <div className="conflict-choices">
                    <button
                      type="button"
                      className={
                        choice === "local"
                          ? "conflict-pick picked-local"
                          : "conflict-pick"
                      }
                      onClick={() => setChoice(entry, "local")}
                    >
                      {entry.kind === "edit-delete" &&
                      entry.deletedBy === "local"
                        ? "维持删除"
                        : "保留本页"}
                    </button>
                    <button
                      type="button"
                      className={
                        choice === "remote"
                          ? "conflict-pick picked-remote"
                          : "conflict-pick"
                      }
                      onClick={() => setChoice(entry, "remote")}
                    >
                      {entry.kind === "edit-delete" &&
                      entry.deletedBy === "remote"
                        ? "维持删除"
                        : "采用对端"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {confirmOverwrite ? (
          <div className="conflict-overwrite-confirm">
            <p>
              确定用本页内容整体覆盖？另一标签页的全部改动将丢失，此操作不可撤销。
            </p>
            <div>
              <button
                type="button"
                className="button-neutral"
                onClick={() => setConfirmOverwrite(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="button-danger"
                onClick={() => {
                  setConfirmOverwrite(false);
                  onForceOverwrite();
                }}
              >
                确认覆盖
              </button>
            </div>
          </div>
        ) : (
          <div className="conflict-actions">
            <button
              type="button"
              className="button-neutral"
              onClick={onContinueEdit}
              title="不关闭编辑能力，稍后再回来处理"
            >
              <RefreshCw size={13} /> 继续编辑
            </button>
            <button
              type="button"
              className="button-neutral"
              onClick={onDiscard}
            >
              放弃本页改动
            </button>
            <button
              type="button"
              className="button-neutral conflict-overwrite"
              onClick={() => setConfirmOverwrite(true)}
            >
              用我的覆盖
            </button>
            <button
              type="button"
              className="conflict-resolve"
              disabled={!allResolved}
              onClick={() => onResolve(resolutions)}
            >
              <GitMerge size={13} />
              {allResolved
                ? "合并并保存"
                : `还剩 ${conflict.conflicts.filter((entry) => resolutions[entry.id] === undefined).length} 项待决定`}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
