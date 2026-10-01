# 山间清晨短片 Tasks

> 状态：已于 2026-10-01 获用户批准。依据已批准的 [spec.md](./spec.md) 与 [plan.md](./plan.md)。每个任务是一个聚焦的工作单元；媒体导出和人工审阅的等待时间不计入动手时间。

## 文件清单

| 操作 | 文件 | 职责 |
| --- | --- | --- |
| 新建 | `package.json`、`package-lock.json`、`tsconfig.json` | 固定 TypeScript、XML 库和命令 |
| 新建 | `README.md` | 运行、恢复与交付说明 |
| 新建 | `src/cli.ts` | 工作流命令入口 |
| 新建 | `src/domain.ts` | 核心类型、阶段与约束 |
| 新建 | `src/infra/process.ts` | AppImage、FFmpeg 进程调用 |
| 新建 | `src/workflow/coordinator.ts` | 阶段推进、检查点、恢复与反馈 |
| 新建 | `src/workspace/store.ts` | 状态原子保存、版本化产物 |
| 新建 | `src/assets/catalog.ts` | 素材登记、许可与媒体信息 |
| 新建 | `src/score/lmms.ts` | LMMS 工程与 WAV 导出 |
| 新建 | `src/video/kdenlive.ts` | Kdenlive 工程与 MP4 导出 |
| 新建 | `src/verification/media.ts` | 解码、元数据、黑帧和静音检查 |
| 新建 | `src/verification/native.ts` | 工程引用与实际观察记录 |
| 新建 | `templates/lmms/base.mmp` | 与 LMMS 1.2.2 匹配的最小模板 |
| 新建 | `templates/kdenlive/base.kdenlive` | 与 Kdenlive 26.08.1 匹配的最小模板 |
| 新建 | `tests/recovery.test.ts`、`tests/native-smoke.test.ts` | 中断恢复与原生工程集成检查 |
| 生成 | `workspaces/mountain-morning/state.json`、`handoff.md` | 样板状态与人可读进度 |
| 生成 | `workspaces/mountain-morning/assets/`、`projects/`、`checkpoints/`、`outputs/`、`evidence/` | 素材、工程、版本、导出和证据 |

## T1：建立 TypeScript 工具骨架

**文件：** `package.json`、`package-lock.json`、`tsconfig.json`、`src/cli.ts`。**依赖：** 无。

**步骤：** 1. 配置 Node 24 ESM 与严格类型检查。2. 固定 `typescript`、`@types/node`、`@xmldom/xmldom` 的安装版本。3. 配置 `build`、`check`、`test`、`cli` 脚本，其中 `cli` 执行编译后的 `dist/src/cli.js`。4. 创建能打印帮助文本的命令入口。

**验证：** 运行 `npm ci && npm run check && npm run cli -- --help`，期望依赖安装、类型检查通过并显示命令帮助。

## T2：封装本机进程调用

**文件：** `src/infra/process.ts`、`tests/native-smoke.test.ts`。**依赖：** T1。

**步骤：** 1. 实现参数数组调用、超时、退出码和日志捕获。2. 为两款 AppImage 设置 `APPIMAGE_EXTRACT_AND_RUN=1`；Kdenlive 无窗口命令设置 `QT_QPA_PLATFORM=offscreen`。3. 为 `ffmpeg`、`ffprobe` 提供同一调用入口。

**验证：** 运行 `npm test`，期望测试调用两款 AppImage 的 `--help` 和 `ffprobe -version` 均返回退出码 0，并保存可读取的输出。

## T3：制作最小 LMMS 模板

**文件：** `templates/lmms/base.mmp`。**依赖：** T2。

**步骤：** 1. 用当前 LMMS 版本建立一个只含内置乐器、四小节和少量音符的工程并保存为未压缩 `.mmp`。2. 不加入外部采样或插件。3. 记录模板使用的乐器和 LMMS 版本。

**验证：** 用 LMMS `render templates/lmms/base.mmp -f wav -o /tmp/lmms-template.wav` 导出；期望退出码 0、文件非空，`ffprobe` 能识别音频流。

## T4：确认 LMMS 模板可编辑

**文件：** `templates/lmms/base.mmp`、`workspaces/mountain-morning/evidence/`。**依赖：** T3。

**步骤：** 1. 在 LMMS 中打开模板。2. 在副本中移动一处音符并保存、关闭、重新打开。3. 记录观察结果；若当前桌面控制不可用，由创作者在检查点完成同一操作并反馈。失败时修正模板后重试，不继续后续任务。

**验证：** 观察到副本重新打开后音符位置已变化，证据记录包含操作、结果和工程副本路径。

## T5：制作最小 Kdenlive 模板

**文件：** `templates/kdenlive/base.kdenlive`、`workspaces/mountain-morning/evidence/`。**依赖：** T2、T4。

**步骤：** 1. 用 `ffmpeg` 生成仅供兼容性测试的一秒 1080p30 画面。2. 在当前 Kdenlive 版本建立包含该片段及一条音频轨的最小工程，保存为模板。3. 记录素材引用和工程版本；测试画面不进入最终作品。

**验证：** 调用 Kdenlive `--render` 将模板导出到 `/tmp/kdenlive-template.mp4`，期望退出码 0；`ffprobe` 报告一条 1920×1080、30 帧/秒的视频流。

## T6：确认 Kdenlive 模板可编辑

**文件：** `templates/kdenlive/base.kdenlive`、`workspaces/mountain-morning/evidence/`。**依赖：** T5。

**步骤：** 1. 在 Kdenlive 中打开模板。2. 在副本中修改片段长度并保存、关闭、重新打开。3. 记录观察结果；若桌面控制不可用，由创作者完成同一操作并反馈。失败时修正模板后重试，不下载正式素材。

**验证：** 观察到副本重新打开后时间线长度已变化，证据记录包含操作、结果和工程副本路径。

## T7：定义领域类型与阶段约束

**文件：** `src/domain.ts`、`tests/recovery.test.ts`。**依赖：** T1。

**步骤：** 1. 按 `plan.md` 定义 `WorkspaceState`、`AssetRecord`、`ScorePlan`、`EditPlan`、产物、检查点与验证结果。2. 定义阶段迁移表和 900–1800 帧范围。3. 拒绝引用不存在素材或已过期产物的计划。

**验证：** 运行 `npm run check`，期望类型检查通过；运行领域约束测试，期望非法阶段迁移和越界片长被拒绝。

## T8：实现状态原子读写

**文件：** `src/workspace/store.ts`、`tests/recovery.test.ts`。**依赖：** T7。

**步骤：** 1. 实现状态文件加载与结构检查。2. 写入同目录临时文件后重命名。3. 保存前比较 `expectedRevision`，成功后版本号加一。4. 加入旧版本写入与损坏文件测试。

**验证：** 运行 `npm test`，期望新状态可重载、旧版本写入被拒绝，损坏文件返回可诊断错误而不覆盖原文件。

## T9：实现检查点与产物指纹

**文件：** `src/workspace/store.ts`、`tests/recovery.test.ts`。**依赖：** T8。

**步骤：** 1. 为产物计算 SHA-256。2. 将检查点工程、预览和摘要复制到独立目录。3. 创建新版本时保留已确认目录，并检查引用的产物指纹。4. 加入重复检查点和产物篡改测试。

**验证：** 运行 `npm test`，期望旧检查点字节不变，重复调用不覆盖旧版本，指纹不符会阻止恢复。

## T10：实现素材登记与媒体检查

**文件：** `src/assets/catalog.ts`、`tests/native-smoke.test.ts`。**依赖：** T2、T7。

**步骤：** 1. 接收本地文件、来源页和许可页。2. 计算文件大小与 SHA-256，并用 `ffprobe` 读取时长、分辨率和帧率。3. 核验文件可读取、累计下载量不超过 2 GB；失败时返回可记录的原因，完整解码交给验证器。

**验证：** 用 T5 的一秒测试片段运行素材登记测试，期望得到非空指纹与正确视频元数据；用不存在文件运行测试，期望报告缺失而不登记。

## T11：读取并校验 LMMS 模板

**文件：** `src/score/lmms.ts`、`tests/native-smoke.test.ts`。**依赖：** T3、T7。

**步骤：** 1. 使用 XML DOM 读取 `base.mmp`。2. 检查工程版本、内置乐器轨和必需节点。3. 修改前复制 DOM，不直接修改模板。4. 版本或节点不符时给出明确错误。

**验证：** 运行 `npm test`，期望有效模板通过、删除必需节点的副本被拒绝，原模板指纹不变。

## T12：写入配乐编排与音符

**文件：** `src/score/lmms.ts`、`tests/native-smoke.test.ts`。**依赖：** T11。

**步骤：** 1. 将 `ScorePlan` 的速度、分段和音符转换为 LMMS 工程节点。2. 只使用模板中的内置乐器轨。3. 保存到新 `.mmp` 路径，不覆盖模板。4. 对两份不同的乐谱计划生成不同工程。

**验证：** 运行 `npm test`，期望两份工程均能被 LMMS `render` 导出且音频指纹不同，模板指纹不变。

## T13：实现 LMMS WAV 导出

**文件：** `src/score/lmms.ts`、`tests/native-smoke.test.ts`。**依赖：** T2、T12。

**步骤：** 1. 使用进程封装调用 LMMS `render`，显式指定 WAV 输出路径。2. 限制单次渲染 30 分钟，保留日志和退出码。3. 失败或输出为空时不登记产物。

**验证：** 运行原生集成测试，期望短工程产生非空 WAV；改用无效输出路径时返回失败及日志，不产生已确认产物。

## T14：建立 Kdenlive 素材箱与媒体引用

**文件：** `src/video/kdenlive.ts`、`tests/native-smoke.test.ts`。**依赖：** T5、T7、T10。

**步骤：** 1. 读取并校验 `base.kdenlive` 的版本与轨道结构。2. 移除模板中的一秒测试素材引用，对每个 `AssetRecord` 建立唯一素材标识和工作区内路径引用。3. 只修改受控节点，保留模板其他元数据。4. 缺失文件时拒绝生成。

**验证：** 运行 `npm test`，期望生成工程包含每个素材的现存路径；删除测试素材后返回缺失错误，模板指纹不变。

## T15：写入视频时间线

**文件：** `src/video/kdenlive.ts`、`tests/native-smoke.test.ts`。**依赖：** T14。

**步骤：** 1. 按 `timelineStartFrame` 与 `durationFrames` 写入片段顺序和源片段入点。2. 拒绝时间线空洞、重叠及超出 900–1800 帧的总长。3. 生成新工程而不覆盖旧版；测试时生成两段各 15 秒的临时画面。

**验证：** 用两个 15 秒测试片段生成工程并导出，期望输出顺序与计划一致、总长 900 帧；给出重叠计划时拒绝生成。

## T16：加入配乐轨与项目规格

**文件：** `src/video/kdenlive.ts`、`tests/native-smoke.test.ts`。**依赖：** T15、T13。

**步骤：** 1. 将已验证 WAV 放入独立音轨。2. 写入 1920×1080、30 帧/秒项目规格和片头片尾淡入淡出。3. 检查 WAV 与时间线时长差不超过 1 秒；测试时生成 30 秒临时 WAV。

**验证：** 导出短测试工程，期望 `ffprobe` 同时识别视频和音频流且视频为 1080p30；故意提供超出容差的 WAV 时拒绝生成。

## T17：实现 Kdenlive MP4 导出

**文件：** `src/video/kdenlive.ts`、`tests/native-smoke.test.ts`。**依赖：** T2、T16。

**步骤：** 1. 调用 Kdenlive `--render` 及默认 MP4-H264/AAC 预设。2. 使用新输出路径，记录日志、退出码和耗时。3. 命令行失败时记录需要软件内导出的状态，不生成伪造的成功结果。

**验证：** 运行原生集成测试，期望 30 秒测试工程导出可解码 MP4；给出无效目标路径时返回可诊断失败。

## T18：实现媒体元数据和完整解码检查

**文件：** `src/verification/media.ts`、`tests/native-smoke.test.ts`。**依赖：** T2。

**步骤：** 1. 用 `ffprobe` 检查时长、分辨率、帧率与流类型。2. 用 `ffmpeg` 解码完整文件并捕获错误。3. 将检查结果写成 `CheckResult`，不把进程退出码以外的信息当成功证据。

**验证：** 测试有效 WAV、MP4 与截断文件，期望有效文件通过、截断文件失败且带解码证据。

## T19：实现黑帧、静音与音量检查

**文件：** `src/verification/media.ts`、`tests/native-smoke.test.ts`。**依赖：** T18。

**步骤：** 1. 运行 FFmpeg 黑帧、静音与峰值音量分析。2. 返回带时间范围的候选异常，不直接判定审美质量。3. 用受控测试文件校准阈值并记录在代码常量中。

**验证：** 运行 `npm test`，期望含一秒黑画面和一秒静音的测试文件被标记，正常测试片段不被误报为严重故障。

## T20：实现原生工程引用与观察记录

**文件：** `src/verification/native.ts`、`tests/native-smoke.test.ts`。**依赖：** T11、T14。

**步骤：** 1. 解析 `.mmp` 与 `.kdenlive` 的媒体引用，检查本地路径是否存在。2. 将软件打开、修改副本、保存后的观察结果连同路径与说明记为证据。3. 尚未实际观察时返回 `needs_observation`，不能返回 `pass`。

**验证：** 运行 `npm test`，期望缺失媒体被报告；仅 XML 解析成功但无 GUI 记录时状态仍为 `needs_observation`。

## T21：实现阶段推进与重复调用保护

**文件：** `src/workflow/coordinator.ts`、`tests/recovery.test.ts`。**依赖：** T7、T8、T9、T10、T13、T17、T18、T20。

**步骤：** 1. 按阶段迁移表串联素材、配乐、视频与验证。2. 执行前检查依赖产物的指纹和状态。3. 重复调用已完成步骤时返回现有结果，不覆盖已确认版本。

**验证：** 运行 `npm test`，期望非法越级被拒绝，同一步重复执行后已确认工程的 SHA-256 不变。

## T22：实现审阅反馈与下游失效

**文件：** `src/workflow/coordinator.ts`、`tests/recovery.test.ts`。**依赖：** T21。

**步骤：** 1. 在配乐和视频检查点暂停阶段推进。2. 记录批准或修改意见。3. 修改配乐时使旧视频失效；修改视频片长或节奏点时重查配乐长度，并标记依赖旧方案的产物过期。

**验证：** 运行 `npm test`，期望待审阅时不能进入终版；输入修改意见后相关旧产物不能被选为终版。

## T23：实现恢复与人可读摘要

**文件：** `src/workflow/coordinator.ts`、`src/workspace/store.ts`、`tests/recovery.test.ts`。**依赖：** T21、T22。

**步骤：** 1. 从 `state.json` 和磁盘指纹重建当前阶段。2. 发现文件缺失或指纹变化时生成问题记录。3. 依据 `nextAction` 生成 `handoff.md`，列出当前结果、决定、阻塞和下一步。

**验证：** 运行 `npm test`，期望新进程恢复到原阶段，摘要内容与状态一致；删除一个依赖文件后恢复报告指出该文件。

## T24：接通命令行与操作说明

**文件：** `src/cli.ts`、`README.md`。**依赖：** T10、T21、T22、T23。

**步骤：** 1. 将 `init`、`ingest`、`score`、`edit`、`render`、`verify`、`checkpoint`、`resume`、`status` 接到协调器；`score` 和 `edit` 可用 `--plan` 读取临时 JSON 文件并将计划保存到 `state.json`。2. 每个命令输出阶段、产物路径和下一步。3. 在 README 中说明环境、命令顺序、GUI 检查点和恢复操作。

**验证：** 运行 `npm run cli -- --help`，再运行 `npm run cli -- init --workspace workspaces/mountain-morning` 和 `npm run cli -- status --workspace workspaces/mountain-morning`；期望帮助列出全部命令，状态输出与新建的 `state.json` 一致。

## T25：选择并取得公开视频素材

**文件：** `workspaces/mountain-morning/assets/`、`workspaces/mountain-morning/evidence/`。**依赖：** T6、T24。

**步骤：** 1. 复核 `spec.md` 中三段 Pexels 候选的页面、许可条件和可下载规格。2. 选择足以组成 48 秒短片的片段，通过正常网页下载到 `assets/`；不可用时寻找同条件替代并记原因。3. 记录来源 URL、许可 URL、核验日期和下载文件名，累计下载量不超过 2 GB。

**验证：** 逐个用播放器打开文件，并运行 `ffprobe`；期望每个文件可播放、有视频流，来源记录覆盖每个最终采用的文件，总下载量不超过 2 GB。

## T26：登记素材并确定画面入点

**文件：** `workspaces/mountain-morning/state.json`、`workspaces/mountain-morning/evidence/`。**依赖：** T10、T25。

**步骤：** 1. 对每段素材运行 `ingest`，写入来源、许可、指纹和媒体信息。2. 观看素材并记录可用片段的入点与可用时长。3. 排除画面不匹配、分辨率不足或音画明显损坏的片段。

**验证：** 运行 `status` 并检查 `state.json`，期望采用的每段素材有本地路径、指纹、来源与许可；逐个入点均落在对应文件时长内。

## T27：编排 48 秒配乐方案

**文件：** `workspaces/mountain-morning/state.json`。**依赖：** T12、T24、T26。

**步骤：** 1. 写入 120 BPM、4/4、24 小节的 `ScorePlan`。2. 前、中、后各八小节分别采用稀疏、叠加、增强的内置乐器与音符编排。3. 通过 `score --plan` 将计划保存到状态。

**验证：** 运行 `status`，期望状态包含 24 小节、三个连续分段和至少两个内置乐器轨；按节拍计算的目标长度为 48 秒。

## T28：生成配乐工程和 WAV

**文件：** `workspaces/mountain-morning/projects/`、`workspaces/mountain-morning/outputs/`、`workspaces/mountain-morning/evidence/`。**依赖：** T13、T18、T19、T20、T27。

**步骤：** 1. 用已保存计划生成新的 `.mmp`。2. 调用 LMMS 导出 WAV。3. 执行完整解码、长度与音量检查，听取开头、中段和结尾；异常时修改 `ScorePlan` 后重导。4. 在 LMMS 中打开生成的工程、修改副本并保存，记录实际结果。

**验证：** LMMS 工程能被原生渲染，WAV 可完整播放且时长约 48 秒；修改副本可重新打开，相应验证记录为 `pass`，主观变化有听取记录。

## T29：提交配乐检查点

**文件：** `workspaces/mountain-morning/checkpoints/`、`workspaces/mountain-morning/handoff.md`、`workspaces/mountain-morning/state.json`。**依赖：** T9、T22、T28。

**步骤：** 1. 保存配乐工程、WAV 预览和阶段摘要的不可变副本。2. 提供给创作者审阅，等待批准或修改意见。3. 若有修改，记录反馈并返回 T27–T28 生成新版本；批准后进入视频阶段。

**验证：** 运行 `status`，期望在反馈前为 `score_review` 且不能进入终版；反馈后状态、版本和 `handoff.md` 一致，旧检查点仍可访问。

## T30：编排 48 秒视频方案

**文件：** `workspaces/mountain-morning/state.json`。**依赖：** T26、T29。

**步骤：** 1. 选择至少三段已登记的素材，安排总计 1440 帧的镜头。2. 开头使用较长、平静的镜头，后段随音乐增强缩短镜头长度；标出主要节奏变化点。3. 用 `edit --plan` 写入每段素材的入点、开始帧和长度，并关联已批准 WAV。

**验证：** 运行 `status`，期望镜头连续覆盖 0–1439 帧，无空洞和重叠；各入点与长度不超出源素材，关联音频与目标时长差不超过 1 秒。

## T31：生成视频粗剪与预览

**文件：** `workspaces/mountain-morning/projects/`、`workspaces/mountain-morning/outputs/`、`workspaces/mountain-morning/evidence/`。**依赖：** T17、T18、T19、T20、T30。

**步骤：** 1. 生成新的 `.kdenlive` 工程并用 Kdenlive 导出预览 MP4。2. 检查工程引用、完整解码、1080p30 和声画起止。3. 播放开头、中段、结尾，记录画面节奏与配乐是否协调；问题明确后修改计划并重导。

**验证：** Kdenlive 工程可原生导出，预览可完整播放且长 48 秒；自动检查无未解决的缺失媒体或解码错误，观察记录覆盖三个时段。

## T32：提交视频粗剪检查点

**文件：** `workspaces/mountain-morning/checkpoints/`、`workspaces/mountain-morning/handoff.md`、`workspaces/mountain-morning/state.json`。**依赖：** T22、T31。

**步骤：** 1. 保存粗剪工程、预览和取舍摘要。2. 提供给创作者审阅，等待批准或修改意见。3. 若改变片长或主要节奏点，按依赖关系重做 LMMS WAV 和 Kdenlive 预览；保留旧版。

**验证：** 运行 `status`，期望待审阅时停在 `video_review`；收到反馈后能看到新版本与处理记录，已失效的预览不能被选为终版。

## T33：生成并核验终版

**文件：** `workspaces/mountain-morning/projects/`、`workspaces/mountain-morning/outputs/`、`workspaces/mountain-morning/evidence/`。**依赖：** T32。

**步骤：** 1. 从已批准的粗剪生成终版原生工程与 MP4，不覆盖检查点。2. 用 `ffprobe` 和完整解码检查 30–60 秒、1920×1080、30 帧/秒、音视频流。3. 在两款软件中分别打开最终工程、修改副本并保存。4. 播放成片并复查黑帧、持续静音、明显破音与情绪变化。

**验证：** 终版 MP4 可完整播放且满足规格；两个最终工程的修改副本都能重新打开，终版音频可访问，所有自动检查结果和主观观察写入 `workspaces/mountain-morning/evidence/`。

## T34：演练素材路径失效与修复

**文件：** `workspaces/mountain-morning/evidence/`、`workspaces/mountain-morning/state.json`。**依赖：** T20、T23、T33。

**步骤：** 1. 复制一个已完成检查点到演练目录。2. 只在副本中让一段素材路径失效。3. 运行工程检查并记录缺失原因，恢复正确引用后重新验证；原始检查点保持不变。

**验证：** 演练首次检查报告具体缺失文件，修复后检查通过；原始检查点的工程和素材指纹未变化。

## T35：演练导出失败与修复

**文件：** `workspaces/mountain-morning/evidence/`、`workspaces/mountain-morning/state.json`。**依赖：** T17、T23、T33。

**步骤：** 1. 在终版工程副本上使用无效输出路径触发一次 Kdenlive 导出失败。2. 保存退出码和日志，记录原因。3. 改用有效的新路径重导并运行媒体检查。

**验证：** 首次导出标记为失败且不登记最终产物；第二次导出可解码、规格正确，已确认终版指纹不变。

## T36：演练中断后的继续

**文件：** `workspaces/mountain-morning/state.json`、`workspaces/mountain-morning/handoff.md`、`workspaces/mountain-morning/evidence/`。**依赖：** T23、T33。

**步骤：** 1. 在已保存阶段记录当前 `nextAction` 和产物指纹，结束工作流进程。2. 启动新进程执行 `resume`。3. 根据状态完成下一项尚未完成的验证或摘要更新，不重跑已确认制作步骤。

**验证：** 新进程准确报告原阶段、已完成产物和下一步；继续后状态版本推进，已确认工程与预览的指纹保持不变。

## T37：完成交付说明与验收准备

**文件：** `README.md`、`workspaces/mountain-morning/handoff.md`、`workspaces/mountain-morning/evidence/`。**依赖：** T33、T34、T35、T36。

**步骤：** 1. 汇总两个可编辑工程、WAV、预览、最终 MP4 和素材来源。2. 写明实际通过与未通过的检查、故障演练结果、当前限制和继续编辑方法。3. 整理各项验收所需的证据路径，供随后按 `checklist.md` 逐项验收。

**验证：** 打开 `handoff.md` 中列出的每个本地路径，期望文件存在且可访问；验收证据索引覆盖 `spec.md` 的 AC1–AC7。

## 执行顺序

```text
T1 → T2 → T3 → T4 → T5 → T6          原生兼容性关口
  ↘ T7 → T8 → T9                     状态与版本
      ↘ T10 → T11 → T12 → T13        素材与配乐适配
             ↘ T14 → T15 → T16 → T17 视频适配
T18 → T19 → T20 → T21 → T22 → T23 → T24 工作流与验证
T25 → T26 → T27 → T28 → T29          素材与配乐检查点
T30 → T31 → T32 → T33               粗剪与终版
T34、T35、T36 → T37                  故障、中断与交付
```

实际执行以各任务的「依赖」字段为准；图示只表示主要路径。每个任务验证通过后再进入依赖它的任务。
