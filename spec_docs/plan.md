# 山间清晨短片 Plan

> 状态：已于 2026-10-01 获用户批准。依据已批准的 [spec.md](./spec.md)。

## 架构概览

采用 **TypeScript / Node.js 工作流 + 两款软件的原生工程 + 实际渲染验证**。工作流负责记录素材来源、安排剪辑与配乐、保存阶段状态、调用本机工具并汇总证据；LMMS 和 Kdenlive 工程始终是可编辑交付物。以工作区中的持久记录为恢复依据，不依赖一个持续运行的进程。

| 组件 | 职责 | 对应需求 |
| --- | --- | --- |
| 工作流协调器 | 按素材准备、配乐、粗剪、审阅、终版、验收的顺序推进；维护检查点与恢复入口 | F4、F5 |
| 工作区存储 | 原子保存目标、阶段、素材清单、版本、决定、故障和下一步；保留已确认产物 | F4、F5 |
| 素材目录 | 核验来源与许可，下载并检查公开视频，记录文件指纹和媒体信息 | F1 |
| LMMS 工程适配器 | 基于当前版本生成或更新可编辑配乐工程，调用 LMMS 导出无损音频 | F2 |
| Kdenlive 工程适配器 | 基于当前版本生成或更新可编辑剪辑工程，导入素材与配乐并导出预览和成片 | F3 |
| 验证器 | 核验原生工程引用、媒体可解码性、输出规格与异常；组织实际打开工程和播放检查 | F6、AC1–AC7 |

### 技术路线比较

| 方案 | 优点 | 风险与代价 |
| --- | --- | --- |
| **原生工程模板 + TypeScript 协调（推荐）** | 状态和步骤可重复；工程可编辑；便于中断恢复与版本留存 | 模板受软件版本影响，必须尽早做原生打开和渲染试验 |
| 纯 GUI 操作 + TypeScript 记录 | 编辑结果由软件直接产生 | 桌面自动化对窗口状态敏感，当前会话尚未连通 GUI 控制 |
| FFmpeg 先合成，再维护两份工程 | 视频导出路径简单 | 导出结果与原生工程容易分叉，难证明工程真实对应成片 |

首选方案将“工程能被当前版本打开、能修改副本、能由软件渲染”作为早期兼容性关口。如果关口失败，先修正适配器或模板，再继续内容制作；不能用一个不可编辑的合成视频替代原生工程。

### 已核验的环境事实与待验证点

- 本机有 Node.js 24、FFmpeg 8、LMMS 1.2.2 和 Kdenlive 26.08.1 AppImage。
- 两款 AppImage 在当前终端直接启动会遇到 FUSE 错误；设置 `APPIMAGE_EXTRACT_AND_RUN=1` 后，LMMS 的 `render` 帮助命令和 Kdenlive 的 `--render` 帮助命令可以运行。Kdenlive 的帮助命令还需要 `QT_QPA_PLATFORM=offscreen`。
- [Kdenlive 官方文档](https://docs.kdenlive.org/en/project_and_asset_management/file_management/project_files.html)说明 `.kdenlive` 是基于 MLT 的 XML，并主要引用外部媒体；[LMMS 源码](https://github.com/LMMS/lmms/blob/master/src/core/main.cpp)包含工程渲染命令。实际工程生成、导出与 GUI 编辑副本尚未验证，必须在开发初期实测。

## 核心数据结构与接口

### 工作区状态

`WorkspaceState` 是恢复的唯一权威记录，保存为一个 JSON 文件。每次变更先写临时文件再原子替换；保存时要求 `expectedRevision` 等于磁盘版本，再把版本号加一，防止旧进程覆盖新状态。阶段只表示工作流位置，产物是否可交付仍由验证结果决定。

```ts
type Phase =
  | "assets" | "score_draft" | "score_review"
  | "video_draft" | "video_review" | "final_verify" | "done";

interface WorkspaceState {
  schemaVersion: 1;
  revision: number;
  goal: { title: string; minFrames: 900; maxFrames: 1800; fps: 30 };
  phase: Phase;
  assets: AssetRecord[];
  scorePlan?: ScorePlan;
  editPlan?: EditPlan;
  artifacts: ArtifactRecord[];
  checkpoints: CheckpointRecord[];
  decisions: DecisionRecord[];
  issues: IssueRecord[];
  nextAction: string;
  updatedAt: string;
}

interface WorkspaceStore {
  load(): Promise<WorkspaceState>;
  save(next: WorkspaceState, expectedRevision: number): Promise<void>;
  createCheckpoint(
    phase: CheckpointRecord["phase"], artifactIds: string[],
    summary: string, nextAction: string
  ): Promise<CheckpointRecord>;
}
```

### 素材、配乐与剪辑方案

素材记录同时保留来源证据与本地媒体信息。`localPath` 相对于项目工作区；`sourceInMs` 指向原始素材位置；`timelineStartFrame` 和 `durationFrames` 均以 30 帧/秒的目标时间线为准，适配器负责换算到各软件的内部时间单位。

```ts
interface AssetRecord {
  id: string;
  sourceUrl: string;
  licenseUrl: string;
  licenseCheckedAt: string;
  localPath: string;
  sha256: string;
  bytes: number;
  media: { durationMs: number; width: number; height: number; fps: number };
}

interface NoteEvent {
  trackId: string;
  pitchMidi: number;
  startBeat: number;
  durationBeats: number;
  velocity: number;
}

interface ScorePlan {
  bpm: number;
  beatsPerBar: 4;
  sections: { name: string; startBar: number; bars: number; energy: number }[];
  tracks: { id: string; instrumentTemplate: string; notes: NoteEvent[] }[];
}

interface EditPlan {
  profile: { width: 1920; height: 1080; fps: 30 };
  clips: {
    assetId: string;
    sourceInMs: number;
    timelineStartFrame: number;
    durationFrames: number;
  }[];
  soundtrackArtifactId: string;
  fadeInFrames: number;
  fadeOutFrames: number;
}
```

### 产物、检查点与验证证据

```ts
type ArtifactKind = "lmms_project" | "audio_preview" | "audio_final"
  | "kdenlive_project" | "video_preview" | "video_final";

interface ArtifactRecord {
  id: string;
  kind: ArtifactKind;
  path: string;
  sha256: string;
  createdAt: string;
  basedOn: string[]; // 素材或其他产物的 ID
  status: "draft" | "confirmed";
}

interface CheckpointRecord {
  id: string;
  phase: "score_review" | "video_review";
  createdAt: string;
  artifactIds: string[];
  summary: string;
  nextAction: string;
  review: "pending" | "approved" | "changes_requested";
  feedback?: string;
}

interface DecisionRecord { at: string; subject: string; reason: string; effect: string }
interface IssueRecord { at: string; kind: string; evidence: string; action: string; result: string }
interface CheckResult { id: string; status: "pass" | "fail" | "needs_observation"; evidence: string }
```

### 模块接口

```ts
interface AssetCatalog {
  ingest(file: string, sourceUrl: string, licenseUrl: string): Promise<AssetRecord>;
  check(record: AssetRecord): Promise<CheckResult[]>;
}

interface LmmsAdapter {
  writeProject(plan: ScorePlan, output: string): Promise<ArtifactRecord>;
  renderWav(project: string, output: string): Promise<ArtifactRecord>;
}

interface KdenliveAdapter {
  writeProject(plan: EditPlan, assets: AssetRecord[], soundtrack: ArtifactRecord, output: string): Promise<ArtifactRecord>;
  renderMp4(project: string, output: string): Promise<ArtifactRecord>;
}

interface Verifier {
  inspectProject(project: ArtifactRecord): Promise<CheckResult[]>;
  inspectMedia(media: ArtifactRecord): Promise<CheckResult[]>;
  collectObservedReview(checkpoint: CheckpointRecord, notes: string): Promise<CheckResult[]>;
}
```

`inspectProject` 检查文件可解析、引用齐全和原生软件能否处理；GUI 中打开并修改副本属于 `needs_observation`，只有观察到结果并记录证据后才转为 `pass`。这样不会把 XML 语法正确误报为“可编辑”。

## 模块设计

### 工作流协调器

**职责：** 提供 `init`、`ingest`、`score`、`edit`、`render`、`verify`、`checkpoint`、`resume` 和 `status` 命令；读取状态后只执行当前阶段允许的动作。重复调用已完成步骤时先核对现有产物指纹，不直接覆盖。到达 `score_review` 或 `video_review` 后停在检查点，收到明确反馈再继续。

**对外接口：** 命令行入口。**依赖：** 工作区存储、素材目录、两个工程适配器、验证器。

### 工作区存储

**职责：** 原子保存 `WorkspaceState`；创建不可变的检查点目录，复制当时的工程、预览和摘要；版本冲突时拒绝旧状态写入。`resume` 仅从状态和磁盘产物重建上下文，逐项检查路径与指纹，并给出下一步。

**对外接口：** `WorkspaceStore`。**依赖：** 本地文件系统；不依赖媒体软件。

### 素材目录

**职责：** 将已取得的公开素材与来源、许可页面一起登记。先检查许可和下载总量，再使用 `ffprobe` 读取时长、分辨率、帧率，用 SHA-256 标识文件；不可用素材保留失败记录并换用符合条件的素材。获取文件可通过网页正常下载，工作流不依赖批量抓取站点。

**对外接口：** `AssetCatalog`。**依赖：** `ffprobe`、本地文件系统；由协调器负责写入状态。

### LMMS 工程适配器

**职责：** 从与 LMMS 1.2.2 匹配的最小原生模板出发，只改动所需的曲目、音符和编排节点；使用内置乐器，避免额外插件和外部采样依赖。调用 LMMS `render` 生成 WAV，保留进程日志与退出状态；音频检查通过后形成配乐检查点。

**对外接口：** `LmmsAdapter`。**依赖：** 工程模板、LMMS AppImage；由协调器在导出后调用验证器和工作区存储。

### Kdenlive 工程适配器

**职责：** 从与 Kdenlive 26.08.1 匹配的原生模板出发，按 `EditPlan` 构造素材箱、视频轨、音频轨和项目规格；引用工作区内的素材与已验证 WAV。使用 Kdenlive 自身的导出能力生成预览与终版。若命令行导出不可用，转用软件内导出并保留同样的验证步骤；不将另外合成的视频冒充为该工程的渲染结果。

**对外接口：** `KdenliveAdapter`。**依赖：** 工程模板、Kdenlive AppImage；由协调器在导出后调用验证器和工作区存储。

### 验证器与观察记录

**职责：** 检查工程引用、文件指纹、音视频元数据、完整解码、黑帧与静音候选区间；异常检测只产生待复核证据，不能独自证明审美质量。原生工程打开、修改副本并保存，以及预览的声画判断，要记下实际观察结果。故障演练在副本上进行，修复后重新运行相关检查。

**对外接口：** `Verifier`。**依赖：** `ffprobe`、`ffmpeg`、两款原生软件和观察者。

## 模块交互

```text
公开素材页面与许可 → 本地素材 → 素材目录 → WorkspaceState
                                          │
ScorePlan → LMMS 工程适配器 → .mmp → LMMS 导出 WAV → 验证 → 配乐检查点
                                                        │ 审阅/反馈
EditPlan + 已登记素材 + 已验证 WAV → Kdenlive 工程适配器 → .kdenlive
                                                     → Kdenlive 导出 MP4
                                                     → 验证 → 粗剪检查点
                                                               │ 审阅/反馈
                                                               → 终版与验收
```

每一步先生成新的草稿路径，验证成功后才登记为产物。检查点把当时的产物复制到独立目录并标为待审阅；反馈写入状态后才产生下一版本。配乐检查点要求修改时，更新 `ScorePlan`、重导 WAV 并重新提交检查点。视频检查点要求修改时，先更新 `EditPlan`；若片长或主要节奏点变化，同时更新 `ScorePlan`，重导音频后再生成视频。`ArtifactRecord.basedOn` 用于标记受旧素材或旧配乐影响的产物，过期产物不能作为终版。

中断恢复重新读取 `WorkspaceState` 和文件指纹，从 `nextAction` 继续。素材缺失时先登记故障，再替换或修复引用，并重新验证受影响的下游产物。导出失败时保留日志、修改原因明确的设置后重试；故障演练只对副本或无效输出路径操作，不破坏已确认版本。

## 文件组织

```text
spec_docs/                         已批准或待审阅的四份规格文档
package.json                       TypeScript 工具与命令
package-lock.json                  固定依赖版本
tsconfig.json                      编译配置
README.md                          运行、恢复与交付说明
src/cli.ts                         工作流命令入口
src/domain.ts                      核心类型与阶段约束
src/infra/process.ts               AppImage 与 FFmpeg 进程调用封装
src/workflow/coordinator.ts        阶段推进、检查点和恢复
src/workspace/store.ts             原子状态写入、版本化产物
src/assets/catalog.ts              素材登记、许可和媒体元数据
src/score/lmms.ts                  LMMS 工程生成与 WAV 导出
src/video/kdenlive.ts              Kdenlive 工程生成与 MP4 导出
src/verification/media.ts          ffprobe/ffmpeg 自动检查
src/verification/native.ts         原生工程检查和人工观察记录
templates/lmms/base.mmp            经 LMMS 1.2.2 验证的最小模板
templates/kdenlive/base.kdenlive   经 Kdenlive 26.08.1 验证的最小模板
tests/recovery.test.ts             中断恢复与版本冲突测试
tests/native-smoke.test.ts         模板可打开、可渲染的集成检查
workspaces/mountain-morning/       本次样板的工作区
  state.json                       权威进度与决定记录
  handoff.md                       供创作者阅读的当前结果和下一步
  assets/                          下载的原始视频与来源记录
  projects/                        配乐和剪辑的当前工程
  checkpoints/                     不可变的阶段工程、预览与摘要
  outputs/                         已验证的无损音频和最终视频
  evidence/                        渲染日志、媒体检查和观察记录
```

## 技术决策

| 决策点 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | 本机 Node.js 24、严格模式 TypeScript，使用 `tsc` 编译和 Node 内置测试运行器；依赖由锁文件固定 | 符合选定语言，减少运行时组件，确保同一工作区可重复运行 |
| 原生工程 | 以当前软件版本产生并验证的最小工程为模板，使用 [`@xmldom/xmldom`](https://github.com/xmldom/xmldom) 定点修改 XML 节点；不从零拼接整个工程 | 保留软件生成的版本字段和未知元数据，降低“能渲染但不能编辑”的风险 |
| 模板准入 | 开发第一步分别用两款软件打开最小模板、修改副本并保存，再执行一次短渲染；任一步失败就修正模板与适配器，重新验证 | 原生可编辑性是交付条件，不能等到整片完成后才发现不兼容 |
| 时间表示 | 视频计划统一用 30 帧/秒整数帧；音乐用节拍和小节；适配器负责转换并检查最终音视频时长差不超过 1 秒 | 减少累计时间误差，便于检查跨软件同步 |
| AppImage 启动 | 进程封装设置 `APPIMAGE_EXTRACT_AND_RUN=1`；无窗口的 Kdenlive 命令设置 `QT_QPA_PLATFORM=offscreen`；收集标准输出、错误输出和退出码 | 当前终端缺少可用 FUSE；上述方式已能运行两款软件的帮助命令，但实际渲染仍需早期验证 |
| 导出来源 | WAV 用 LMMS 的 `render`；MP4 优先用 Kdenlive 的 `--render`，若失败则在 Kdenlive 内导出 | 使导出结果能追溯到交付的原生工程，不用独立合成结果冒充 |
| GUI 验证 | 原生工程的打开、修改副本和主观声画检查必须留下实际观察记录；当前桌面自动化未连通时，由创作者在检查点完成简短的可编辑性检查并反馈 | CLI 解析和渲染无法单独证明 GUI 中可编辑；协作模式本来包含人的检查点 |
| 状态与版本 | 单个 `state.json` 作权威状态，原子替换、版本号检查、产物指纹和不可变检查点 | 支持中断恢复，防止旧进程或重复命令静默覆盖成果 |
| 故障演练 | 仅在副本中制造素材路径失效；用无效输出路径触发一次导出失败，并保存日志与修复证据 | 验证识别与恢复能力，同时保护已确认的工程和预览 |
| 素材获取 | 正常网页下载后登记本地文件、来源与许可核验时间；不依赖批量抓取接口 | 降低站点接口变动影响，并保留素材可用性的审计记录 |

### 技术关口与调整规则

1. 先验证 LMMS 模板能打开、编辑副本、导出 WAV，再用临时生成的一秒测试画面验证 Kdenlive 模板能打开、编辑副本、导出 MP4；测试画面不进入最终作品。
2. 如果无窗口导出失败，检查日志并尝试软件内导出；若当前环境无法完成实际打开和导出，停止内容制作，修复环境或重新审议本计划。
3. 只有两个原生工程均通过早期关口，才进入公开素材下载和完整短片制作。
