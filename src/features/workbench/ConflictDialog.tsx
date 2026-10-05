import { AlertTriangle, GitMerge, RefreshCw, X } from "lucide-react";
import type { ConflictView } from "./useLatencyLab";
import type { MergeConflict } from "../../shared/domain/merge";

interface Props {
  conflict: ConflictView;
  onChoose: (id: string, side: "ours" | "theirs") => void;
  onChooseAll: (side: "ours" | "theirs") => void;
  onMerge: () => void;
  onReload: () => void;
  onDismiss: () => void;
}

function groupConflicts(conflicts: MergeConflict[]) {
  const groups = new Map<string, { title: string; items: MergeConflict[] }>();
  for (const entry of conflicts) {
    const key =
      entry.scope === "document"
        ? "document"
        : `${entry.projectId}:${entry.nodeId ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        title:
          entry.scope === "document"
            ? "工作区"
            : entry.nodeName
              ? `${entry.projectTitle} / ${entry.nodeName}`
              : entry.projectTitle,
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(entry);
  }
  return [...groups.values()];
}

export default function ConflictDialog({
  conflict,
  onChoose,
  onChooseAll,
  onMerge,
  onReload,
  onDismiss,
}: Props) {
  const groups = groupConflicts(conflict.conflicts);
  return (
    <div className="dialog-backdrop conflict-backdrop" role="presentation">
      <div
        className="confirm-dialog conflict-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="conflict-title"
      >
        <div className="conflict-head">
          <span className="dialog-icon conflict-icon">
            <AlertTriangle size={18} />
          </span>
          <div>
            <h2 id="conflict-title">另一个标签页已经保存了改动</h2>
            <p>
              两侧修改的是同一份工作区，直接保存会覆盖对方。请逐处选择保留哪一侧；
              未冲突的改动会自动合并。
            </p>
          </div>
          <button
            className="conflict-close"
            onClick={onDismiss}
            aria-label="暂不处理，稍后再决定"
            title="稍后再处理"
          >
            <X size={15} />
          </button>
        </div>

        {conflict.autoChanges.length > 0 && (
          <div className="conflict-auto">
            <strong>
              <GitMerge size={13} /> 可自动合并的改动（
              {conflict.autoChanges.length}）
            </strong>
            <ul>
              {conflict.autoChanges.slice(0, 6).map((line, index) => (
                <li key={index}>{line}</li>
              ))}
              {conflict.autoChanges.length > 6 && (
                <li>…其余 {conflict.autoChanges.length - 6} 处</li>
              )}
            </ul>
          </div>
        )}

        {conflict.conflicts.length > 0 ? (
          <div className="conflict-groups">
            <div className="conflict-bulk">
              <span>{conflict.conflicts.length} 处需要选择</span>
              <div>
                <button
                  className="text-action"
                  onClick={() => onChooseAll("ours")}
                >
                  全部保留我的
                </button>
                <button
                  className="text-action"
                  onClick={() => onChooseAll("theirs")}
                >
                  全部采用对方
                </button>
              </div>
            </div>
            <div className="conflict-scroll">
              {groups.map((group) => (
                <fieldset className="conflict-group" key={group.title}>
                  <legend>{group.title}</legend>
                  {group.items.map((entry) => {
                    const choice = conflict.choices[entry.id] ?? "ours";
                    return (
                      <div className="conflict-row" key={entry.id}>
                        <span className="conflict-field">
                          {entry.fieldLabel}
                        </span>
                        <button
                          className={`conflict-option ${choice === "ours" ? "is-picked" : ""}`}
                          onClick={() => onChoose(entry.id, "ours")}
                          aria-pressed={choice === "ours"}
                        >
                          <em>我的</em>
                          <b>{entry.oursDisplay}</b>
                        </button>
                        <button
                          className={`conflict-option theirs ${choice === "theirs" ? "is-picked" : ""}`}
                          onClick={() => onChoose(entry.id, "theirs")}
                          aria-pressed={choice === "theirs"}
                        >
                          <em>另一标签页</em>
                          <b>{entry.theirsDisplay}</b>
                        </button>
                      </div>
                    );
                  })}
                </fieldset>
              ))}
            </div>
          </div>
        ) : (
          <div className="conflict-clean">
            两侧改动没有重叠，全部可以自动合并。
          </div>
        )}

        <div className="conflict-actions">
          <button className="button button-neutral" onClick={onReload}>
            <RefreshCw size={13} /> 重新载入（放弃我的改动）
          </button>
          <button
            className="button button-primary conflict-save"
            onClick={onMerge}
          >
            <GitMerge size={13} /> 合并并保存
          </button>
        </div>
      </div>
    </div>
  );
}
