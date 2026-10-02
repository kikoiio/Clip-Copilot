# AI 创作工作台

让 AI 成为持续在创作工作区工作的搭档：理解创作目标，使用本机已有的创作软件推进
项目，依据实际产物（工程能否打开、媒体是否缺失、渲染是否成功）验证结果，在跨多个
工作周期的任务中保持方向，并让人随时能够查看、纠正和接手。当前以 Kdenlive 与
LMMS 为起点；长期愿景、目标体验与判断标准见 [docs/VISION.md](docs/VISION.md)。

## 当前阶段：阶段 2「可复用的同类创作流程」

阶段 1 的样板「山间清晨」已于 2026-10-02 验收，记录归档于
[docs/spec_docs/phase-1/](docs/spec_docs/phase-1/)。阶段 2 把流程泛化：新作品由
**任务配置**描述（标题、主题与情绪走向、时长范围、输出规格、素材候选），
`init --config` 据此建区；配乐/剪辑方案提交时自动校验与目标的一致性。正在用两部
新短片验证"换素材换要求、不改代码"：`workspaces/city-nightfall/`（《城市入夜》72s）
与 `workspaces/day-to-stars/`（《从日出到星空》144s）。分阶段路线见
[docs/spec_docs/vision-phases.md](docs/spec_docs/vision-phases.md)；阶段 2 的
spec/plan/task/checklist 见 [docs/spec_docs/phase-2/](docs/spec_docs/phase-2/)。

## 环境

- Node.js ≥ 24、FFmpeg 8（`ffmpeg`/`ffprobe` 在 PATH）
- `LMMS_APPIMAGE`（默认 `/home/neo/Applications/lmms-1.2.2-linux-x86_64.AppImage`）
- `KDENLIVE_APPIMAGE`（默认 `/home/neo/Applications/kdenlive-26.08.1-x86_64.AppImage`）
- AppImage 通过 `APPIMAGE_EXTRACT_AND_RUN=1` 运行；Kdenlive 命令另加
  `QT_QPA_PLATFORM=offscreen` 与 `MLT_PROFILES_PATH`（由进程封装自动定位解压目录）

## 安装与自检

```bash
npm ci          # 依赖由 package-lock.json 固定
npm run check   # TypeScript 严格类型检查
npm test        # 单元 + 原生集成测试（会实际调用两款软件渲染，约 1 分钟）
```

## 命令顺序

```bash
# 1. 写一份任务配置（参考 docs/task-configs/sample-a.json）后建区
npm run cli -- init     --workspace workspaces/<新作品> \
  --config docs/task-configs/<新作品>.json

# 2. 素材放入 workspaces/<ws>/assets/ 后逐段登记；清单外素材必须附替换原因
npm run cli -- ingest   --workspace workspaces/<ws> \
  --file workspaces/<ws>/assets/<clip>.mp4 \
  --source-url <Pexels 页面> --license-url https://www.pexels.com/license/ \
  [--reason "<替换原因>"]

# 3. 配乐方案 → 渲染 → 检查点 → 审阅
npm run cli -- score    --workspace <ws> --plan docs/plans/<作品>-score.json
npm run cli -- render   --workspace <ws> score                         # .mmp + WAV
npm run cli -- checkpoint --workspace <ws> --summary "配乐初稿 v1"
npm run cli -- review   --workspace <ws> --decision approve|changes --feedback "..."

# 4. 剪辑方案 → 粗剪 → 检查点 → 审阅 → 终版
npm run cli -- edit     --workspace <ws> --plan docs/plans/<作品>-edit.json
npm run cli -- render   --workspace <ws> video                         # .kdenlive + 预览
npm run cli -- checkpoint --workspace <ws> --summary "粗剪 v1"
npm run cli -- review   --workspace <ws> --decision approve
npm run cli -- render   --workspace <ws> final                         # 终版 MP4
npm run cli -- verify   --workspace <ws>                               # 全量检查
npm run cli -- status   --workspace <ws>
npm run cli -- reopen   --workspace <ws> --reason "<原因>"             # 重开已交付（done）工作区
```

阶段机：`assets → score_draft → score_review → video_draft → video_review → final_verify → done`。
越级、重复提交、未审阅推进都会被拒绝；`review --decision changes` 会把相关产物退回
draft 并要求附带修改意见。

## 检查点与人工审阅

- `checkpoint` 把当前产物复制到 `workspaces/<ws>/checkpoints/<id>/`（不可变），
  并写 `manifest.json`（清单 + 指纹）。
- 桌面自动化未连通时，两项 GUI 检查由创作者完成（步骤见
  `workspaces/mountain-morning/evidence/observation-*.json`）：
  1. LMMS：打开配乐工程 → 副本中移动音符 → 保存 → 重开；
  2. Kdenlive：打开剪辑工程 → 副本中调整片段长度 → 保存 → 重开。
- 审阅意见通过 `review` 记录；批准后产物转 `confirmed`，要求修改则回到草稿阶段。

## 中断恢复

进度唯一权威是 `workspaces/<ws>/state.json`（原子写入 + revision 防旧进程覆盖）。

```bash
npm run cli -- resume --workspace workspaces/mountain-morning
```

`resume` 重新核对全部产物指纹，把缺失/变动写入问题记录，并重建人可读的
`handoff.md`（当前阶段、产物清单、决定、问题、下一步）。

## 目录

```
docs/VISION.md                    项目愿景与长期判断标准
docs/spec_docs/                   分阶段愿景（vision-phases.md）与各阶段文档（phase-1/ 等）
docs/score-plan.json、edit-plan.json  样板采用的配乐与剪辑方案
templates/lmms/base.mmp           经 LMMS 1.2.2 渲染验证的最小模板
templates/kdenlive/base.kdenlive  经 Kdenlive 26.08.1 渲染验证的最小模板
testmedia/                        仅用于兼容性测试的生成画面（不进入成片）
src/                              领域类型、工作区存储、适配器、验证器、协调器、CLI
tests/                            recovery（单元）+ native-smoke（真实渲染）测试
workspaces/mountain-morning/      样板工作区（state.json 为权威进度）
```

## 已知约束

- Kdenlive 工程内的资源引用自适配器 v2（2026-10-02）起使用**相对工程文件的路径**
  （`../assets/...`），整个 `workspaces/` 目录可自由移动或改名；`reopen` 命令可把
  已交付（done）的工作区退回 `video_draft` 重新生成工程（旧终版自动归档为
  `outputs/final-superseded-<时间戳>.mp4`）。此前的工程内嵌生成时的绝对路径，
  目录移动后引用会失效——mountain-morning 的历史 a1 工程即属此类，已由
  reopen + 适配器 v2 重生成修复。
- LMMS 导出使用 `-l`（Render as a loop）：LMMS 1.2.2 非 loop 导出会在片尾多渲染
  一小节垫尾（源码 `Song::getSongEndPos` 注释确认），`-l` 让时长与工程内容一致。
- Kdenlive 文档需要 `main_bin` 携带 `xml_retain="1"` 与
  `kdenlive:docproperties.profile`（MLT profile 名），否则素材箱为空、项目规格回落
  720×576 PAL。
- 渲染超时上限 30 分钟；素材下载总量上限 2 GB（`ingest` 强制检查）。

## 阶段 2 交付（2026-10-02 验收，17/17 项通过）

用两部新短片验证「换素材换要求、不改代码」——制作期间 `src/`、`templates/`、
`tests/` 零改动，全部工作只新增数据文件（任务配置、素材、方案 JSON）：

| 作品 | 工作区 | 终版 | 规格 |
| --- | --- | --- | --- |
| 《城市入夜》 | `workspaces/city-nightfall/` | `outputs/final.mp4`（72s） | 1080p30，疏离→流动→热闹 |
| 《从日出到星空》 | `workspaces/day-to-stars/` | `outputs/final.mp4`（144s） | 1080p30，苏醒→舒展→渐缓→静谧 |

- 每部含可编辑的 `.mmp`/`.kdenlive` 工程（`projects/`）、粗剪预览（`outputs/`）、
  不可变检查点（`checkpoints/`）与素材来源记录（`evidence/`）。
- 全部新能力经实际演练：任务配置建区、非法配置拒绝（退出码 1 指明字段）、
  配乐/剪辑方案一致性闸门（越界与规格不符被拒）、素材候选核对（清单外替换
  附 `--reason`）、模板规格交叉核对、双工作区隔离、v1 旧工作区兼容（基线逐行一致）。
- 验收期间的重要输入：**创作者声明不自行创作、将创作判断委托给助手**——
  委托模式（分阶段愿景阶段 6）的需求信号提前到达，已记入阶段 3 的启动背景。
- 逐项验收证据见 [docs/spec_docs/phase-2/checklist.md](docs/spec_docs/phase-2/checklist.md)。

## 阶段 1 样板交付（2026-10-02 验收）

交付物（均在工作区 `workspaces/mountain-morning/`，交付清单与证据索引见
`evidence/index.json`）：

| 交付物 | 路径 |
| --- | --- |
| 最终视频 | `outputs/final.mp4`（48s，1920×1080@30fps，H.264/AAC） |
| 终版剪辑工程 | `projects/final.kdenlive`（Kdenlive 26.08.1） |
| 终版配乐工程 | `projects/score-08431593e80867a5-a5.mmp`（LMMS 1.2.2） |
| 无损配乐 | `outputs/score-final.wav`（48.001s，44.1kHz 立体声） |
| 粗剪预览 | `outputs/preview-0c8c2573bbeb96a1-a1.mp4` |
| 不可变检查点 | `checkpoints/checkpoint-001/`、`checkpoint-002/` |
| 素材来源与许可 | `evidence/asset-sources.json`（Pexels License，无署名义务） |

- 验收状态：checklist 19 项中 15 项通过；C2/C4（两款软件内修改副本）与
  C7/C14（真实反馈流程）待创作者执行，C11 的主观满意度待创作者复核。
  逐项证据见 [docs/spec_docs/phase-1/checklist.md](docs/spec_docs/phase-1/checklist.md)。
- 故障演练：素材缺失（T34）、导出失败（T35）、中断恢复（T36）均通过，
  已确认版本指纹未变。
- 继续编辑：直接用软件打开上述工程即可；助手侧修改请走
  `review --decision changes --feedback "…"` 重开对应版本（产物自动失效与重渲染
  由阶段机保证）。
- 声音取舍：配乐主音量固定 42% 换取消波余量；增强段存在 3 个孤立满幅样本
  （合计 <0.05ms，低于可闻阈值），如创作者认为可闻可在检查点提出。
