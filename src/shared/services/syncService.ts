/**
 * 跨标签页协调器。
 *
 * - BroadcastChannel：支持的浏览器里，保存成功的标签页立刻通知其他标签页。
 * - window "storage" 事件：localStorage 恢复副本写入时，其他标签页同样会收到，
 *   作为 BroadcastChannel 不可用时的兜底。
 * - 定时轮询 + visibilitychange / focus：应对错过事件（例如页面长时间挂起、
 *   浏览器节流）的情况，切回标签页时立即再同步一次。
 *
 * 所有来源的信号都去重为同一个回调，由 ViewModel 决定如何处理。
 */
export interface RemoteChangeSignal {
  /** 触发来源，仅用于调试。 */
  source: "channel" | "storage" | "poll" | "visibility" | "focus";
}

export interface SyncOptions {
  onChange: (signal: RemoteChangeSignal) => void;
  /** 轮询间隔，毫秒；测试中可调小。 */
  intervalMs?: number;
}

export class WorkspaceSync {
  private channel: BroadcastChannel | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private lastPongAt = 0;

  constructor(
    private readonly options: SyncOptions,
    private readonly channelName = "latency-lab.workspace.v1",
  ) {}

  start(): void {
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(this.channelName);
      this.channel.onmessage = (event: MessageEvent) => {
        if (event.data?.type === "workspace-saved")
          this.options.onChange({ source: "channel" });
      };
    }
    window.addEventListener("storage", this.handleStorage);
    document.addEventListener("visibilitychange", this.handleVisibility);
    window.addEventListener("focus", this.handleFocus);
    const interval = this.options.intervalMs ?? 5000;
    this.timer = setInterval(() => {
      if (!document.hidden) this.emit({ source: "poll" });
    }, interval);
  }

  /** 本标签页保存成功后通知其他标签页。 */
  notifySaved(): void {
    try {
      this.channel?.postMessage({ type: "workspace-saved", at: Date.now() });
    } catch {
      // 频道关闭等异常无需处理，对端仍有轮询兜底。
    }
  }

  private emit(signal: RemoteChangeSignal): void {
    if (this.disposed) return;
    this.options.onChange(signal);
  }

  private handleStorage = (event: StorageEvent) => {
    if (event.key && event.key.startsWith("latency-lab."))
      this.emit({ source: "storage" });
  };

  private handleVisibility = () => {
    if (!document.hidden) this.emit({ source: "visibility" });
  };

  private handleFocus = () => {
    // focus 与 visibilitychange 可能同帧触发，简单去重 300ms 内的重复信号。
    const now = Date.now();
    if (now - this.lastPongAt < 300) return;
    this.lastPongAt = now;
    this.emit({ source: "focus" });
  };

  dispose(): void {
    this.disposed = true;
    this.channel?.close();
    this.channel = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    window.removeEventListener("storage", this.handleStorage);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    window.removeEventListener("focus", this.handleFocus);
  }
}
