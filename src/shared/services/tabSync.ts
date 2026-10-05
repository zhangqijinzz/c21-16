/**
 * 跨标签页变更通知。IndexedDB 本身不产生变更事件，因此：
 * - 主通道 BroadcastChannel：同一浏览器同源的标签页实时互通
 * - 兜底 storage 事件：localStorage 镜像/心跳写入时天然广播，覆盖 BC 不可用的环境
 * 通知只作为“尽快去探测”的提示，真正是否冲突一律以存储里的修订号为准。
 *
 * 真实浏览器中 storage 事件只投递给“其他”窗口；但同窗口内可能存在多个信号实例
 * （集成测试用同一 jsdom 窗口模拟两个标签页），需要靠写入标记忽略本窗口自己的事件。
 */

const CHANNEL_NAME = "latency-lab-workspace";
const MIRROR_KEY = "latency-lab.workspace.v2";
const PING_KEY = "latency-lab.workspace.ping";
const SELF_IGNORE_MS = 5000;

export interface RemoteChangeSignals {
  subscribe(listener: () => void): () => void;
  notify(): void;
}

/**
 * 测试支持：关闭自动心跳后，测试可精确控制通知时机（模拟通知延迟/丢失），
 * 再用 deliverRemoteChange() 手动投递“对端通知”。生产环境保持默认 false。
 */
export const remoteChangeTestControls = {
  suppressInWindow: false,
};

let lastSelfWriteAt = 0;

/**
 * 测试辅助：把“其他标签页的写入事件”投递给当前窗口的监听者。
 * 使用独立前缀并显式清掉自我写入标记，避免被本窗口忽略逻辑吞掉。
 */
export function deliverRemoteChange(): void {
  lastSelfWriteAt = 0;
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: PING_KEY,
        newValue: `remote-${Date.now()}`,
      }),
    );
}

export function createRemoteChangeSignals(): RemoteChangeSignals {
  const listeners = new Set<() => void>();
  let channel: BroadcastChannel | null = null;
  const emit = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // 单个监听者失败不影响其余标签页同步。
      }
    }
  };
  if (
    typeof BroadcastChannel === "function" &&
    !remoteChangeTestControls.suppressInWindow
  ) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = () => emit();
  }
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === MIRROR_KEY ||
      event.key === PING_KEY
    ) {
      // 本窗口自己的写入（含心跳与镜像）不当成对端通知。
      if (Date.now() - lastSelfWriteAt < SELF_IGNORE_MS) return;
      emit();
    }
  };
  if (typeof window.addEventListener === "function")
    window.addEventListener("storage", onStorage);

  const markSelfWrite = () => {
    lastSelfWriteAt = Date.now();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify() {
      try {
        channel?.postMessage("workspace-committed");
      } catch {
        // 忽略：下面的心跳仍能通知其他标签页。
      }
      if (remoteChangeTestControls.suppressInWindow) return;
      // 兜底通道：心跳键触发其他标签页的 storage 事件（不承载数据）。
      markSelfWrite();
      try {
        localStorage.setItem(PING_KEY, String(Date.now()));
      } catch {
        // localStorage 不可用时 BroadcastChannel 已覆盖主流环境。
      }
    },
  };
}

/**
 * 供 repository 写 localStorage 镜像时调用：镜像写入同样不应被本窗口当成
 * “对端改动”，但其他窗口收到该 storage 事件后应去探测。
 */
export function markLocalStorageSelfWrite(): void {
  lastSelfWriteAt = Date.now();
}
