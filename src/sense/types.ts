/**
 * 阶段 5「软件感知」类型定义（spec F1–F4；plan.md 核心数据结构）。
 * 所有状态都是「当前快照」：引擎只保留最新一份，经差分推送通知消费者。
 */

/** AT-SPI 观测到的单个 Kdenlive 实例（Python 助手原始观测，未做工作区映射）。 */
export interface SpiObservation {
  /** 实例主进程 pid。 */
  pid: number;
  /** 主窗口标题原文（形如 basename + 可选脏标记星号 + " / " + profile + " — Kdenlive"）。 */
  title: string;
  /** 窗口聚焦（Atspi StateType.ACTIVE；Xvfb 下恒 false 属预期）。 */
  focused: boolean | null;
  /** 启动命令行携带的工程路径（/proc/<pid>/cmdline 读取；无则为 null）。 */
  cmdlineProjectPath: string | null;
}

/** spi-helper.py 的协议消息（Node → Python 请求；Python → Node 事件）。 */
export type SpiRequest = { cmd: "poll" } | { cmd: "watch"; intervalMs: number };

export type SpiEvent =
  | {
      type: "instances";
      apps: { pid: number; title: string; focused: boolean | null }[];
    }
    /** 助手侧不可恢复错误（Atspi 不可用等），随后进程退出。 */
  | { type: "error"; reason: string };

/** 映射到工作区后的单个软件实例（标题解析 + 路径绑定结果）。 */
export interface SoftwareInstance {
  pid: number;
  /** 标题解析出的工程 basename（如 `final`）。 */
  projectBasename: string;
  /** 工程完整路径：cmdline 或唯一匹配可得；未知为 null（绝不猜）。 */
  projectPath: string | null;
  /** 标题脏标记（`*`）——未保存改动的主信号；不可读为 null。 */
  dirty: boolean | null;
  focused: boolean | null;
}

/** 每工作区的软件感知状态快照（F1/F3/F4 的统一产出）。 */
export interface WorkspaceSoftwareState {
  workspaceDir: string;
  /** 存在映射到本工作区的 Kdenlive 实例。 */
  running: boolean;
  instances: SoftwareInstance[];
  /** 未保存改动信号：null=不可观测（见 degraded）。 */
  unsavedSignal: boolean | null;
  /** 信号来源：title=窗口脏标记（主）；autosave=自动保存文件（次）。 */
  unsavedSource: "title" | "autosave" | null;
  /** 降级清单：如 ["autosave-unobservable","focus-unknown","atspi-unavailable"]。 */
  degraded: string[];
  observedAt: string;
}

/** 引擎差分推送事件（供 GUI IPC / 内部消费者订阅）。 */
export interface SenseUpdate {
  /** 变化的工作区目录（绝对路径）。 */
  dir: string;
  state: WorkspaceSoftwareState;
}
