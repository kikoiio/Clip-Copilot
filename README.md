# 山间清晨短片工作流

用 TypeScript 工作流协调 LMMS 与 Kdenlive，交付一支 30–60 秒的「山间清晨」短片，
同时保留可继续编辑的配乐工程（.mmp）与剪辑工程（.kdenlive）。规格见
[spec_docs/](spec_docs/)（spec → plan → task → checklist 四份已批准文档）。

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
