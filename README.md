# AI 创作工作台

让 AI 成为持续在创作工作区工作的搭档：理解创作目标，使用本机已有的创作软件推进
项目，依据实际产物（工程能否打开、媒体是否缺失、渲染是否成功）验证结果，在跨多个
工作周期的任务中保持方向，并让人随时能够查看、纠正和接手。当前以 Kdenlive 与
LMMS 为起点；长期愿景、目标体验与判断标准见 [docs/VISION.md](docs/VISION.md)。

## 当前阶段：首个完整样板「山间清晨短片」

按愿景「先用一项完整作品验证」的要求，第一阶段已经交付：TypeScript 工作流协调
LMMS 与 Kdenlive，完成一支 30–60 秒的「山间清晨」短片，保留可继续编辑的配乐
工程（.mmp）与剪辑工程（.kdenlive），并演练了素材缺失、导出失败与中断恢复。
本仓库现有的代码、模板与工作区均服务于该阶段；需求、计划与验收记录见
[docs/spec_docs/phase-1/](docs/spec_docs/phase-1/)（spec → plan → task → checklist
四份已批准文档）。后续阶段按
[docs/spec_docs/vision-phases.md](docs/spec_docs/vision-phases.md) 的分阶段愿景推进。

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
npm run cli -- init     --workspace workspaces/mountain-morning
npm run cli -- ingest   --workspace workspaces/mountain-morning \
  --file workspaces/mountain-morning/assets/<clip>.mp4 \
  --source-url <Pexels 页面> --license-url https://www.pexels.com/license/
npm run cli -- score    --workspace <ws> --plan docs/score-plan.json   # 写入配乐方案
npm run cli -- render   --workspace <ws> score                         # 生成 .mmp + WAV
npm run cli -- checkpoint --workspace <ws> --summary "配乐初稿 v1"      # 冻结检查点
npm run cli -- review   --workspace <ws> --decision approve|changes --feedback "..."
npm run cli -- edit     --workspace <ws> --plan docs/edit-plan.json    # 写入剪辑方案
npm run cli -- render   --workspace <ws> video                         # 生成 .kdenlive + 预览
npm run cli -- checkpoint --workspace <ws> --summary "粗剪 v1"
npm run cli -- review   --workspace <ws> --decision approve
npm run cli -- render   --workspace <ws> final                         # 终版 MP4
npm run cli -- verify   --workspace <ws>                               # 全量检查
npm run cli -- status   --workspace <ws>
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

- LMMS 导出使用 `-l`（Render as a loop）：LMMS 1.2.2 非 loop 导出会在片尾多渲染
  一小节垫尾（源码 `Song::getSongEndPos` 注释确认），`-l` 让时长与工程内容一致。
- Kdenlive 文档需要 `main_bin` 携带 `xml_retain="1"` 与
  `kdenlive:docproperties.profile`（MLT profile 名），否则素材箱为空、项目规格回落
  720×576 PAL。
- 渲染超时上限 30 分钟；素材下载总量上限 2 GB（`ingest` 强制检查）。

## 第一阶段样板交付（2026-10-02 验收）

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
