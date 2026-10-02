import { mkdir, readFile, cp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AV_TOLERANCE_MS,
  canTransition,
  type ArtifactRecord,
  type CheckResult,
  type DecisionRecord,
  type EditPlan,
  type IssueRecord,
  type Phase,
  type ScorePlan,
  type WorkspaceState,
  artifactById,
  validateEditPlan,
  validateScorePlan,
  validateScorePlanAgainstGoal,
  scoreDurationMs,
} from "../domain.ts";
import { ingestAsset, checkAsset } from "../assets/catalog.ts";
import {
  checkAssetAgainstCandidates,
  loadTaskConfig,
  taskConfigToGoal,
} from "./taskConfig.ts";
import { SCORE_ADAPTER_REV, renderScoreWav, scorePlanFingerprint, writeScoreProject } from "../score/lmms.ts";
import { editPlanFingerprint, renderVideoMp4, writeEditProject } from "../video/kdenlive.ts";
import { saveRunEvidence } from "../infra/process.ts";
import {
  checkMediaBasics,
  detectBlackSegments,
  detectSilenceSegments,
  measurePeakVolume,
  probeMedia,
} from "../verification/media.ts";
import { checkProjectReferences } from "../verification/native.ts";
import {
  WorkspaceError,
  auditArtifacts,
  emptyState,
  loadState,
  registerArtifact,
  saveState,
  stateExists,
  workspacePath,
  createCheckpoint,
} from "../workspace/store.ts";

/** 仓库根目录（包含 package.json 的最近祖先），保证模板路径不依赖进程 CWD 与源码/dist 布局差异。 */
function findRepoRoot(start: string): string {
  let current = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(current, "package.json"))) return current;
    current = path.dirname(current);
  }
  return start;
}
const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

const WORKSPACE_SUBDIRS = ["assets", "projects", "checkpoints", "outputs", "evidence"] as const;

interface Loaded {
  dir: string;
  state: WorkspaceState;
}

async function loadWorkspace(dir: string): Promise<Loaded> {
  if (!(await stateExists(dir))) {
    throw new WorkspaceError(`工作区 ${dir} 还没有初始化（先运行 init）`);
  }
  return await loadState(dir);
}

async function persist(loaded: Loaded): Promise<void> {
  const expected = loaded.state.revision;
  await saveState(loaded.dir, loaded.state, expected);
}

function addDecision(loaded: Loaded, subject: string, reason: string, effect: string): void {
  const record: DecisionRecord = { at: new Date().toISOString(), subject, reason, effect };
  loaded.state.decisions.push(record);
}

function addIssue(loaded: Loaded, kind: string, evidence: string, action: string, result: string): void {
  const record: IssueRecord = { at: new Date().toISOString(), kind, evidence, action, result };
  loaded.state.issues.push(record);
}

function latestArtifact(state: WorkspaceState, kind: ArtifactRecord["kind"]): ArtifactRecord | undefined {
  return [...state.artifacts]
    .filter((a) => a.kind === kind)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
}

function findArtifactByTag(state: WorkspaceState, tag: string): ArtifactRecord | undefined {
  return state.artifacts.find((a) => a.basedOn.includes(tag));
}

async function checkPhaseTransition(loaded: Loaded, to: Phase): Promise<void> {
  if (!canTransition(loaded.state.phase, to)) {
    throw new WorkspaceError(`不允许从阶段 ${loaded.state.phase} 迁移到 ${to}`);
  }
}

async function readPlanFile<T>(file: string): Promise<T> {
  const raw = await readFile(file, "utf8");
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new WorkspaceError(`计划文件 ${file} 不是合法 JSON`);
  }
}

/* ---------- handoff ---------- */

export async function writeHandoff(loaded: Loaded): Promise<string> {
  const { state } = loaded;
  const lines: string[] = [];
  lines.push(`# 山间清晨——当前进度与下一步`, "");
  lines.push(`- **更新时间：** ${state.updatedAt}`);
  lines.push(`- **阶段：** ${state.phase}（revision ${state.revision}）`);
  lines.push(`- **目标：** ${state.goal.title}——${state.goal.theme}`);
  lines.push(
    `- **规格：** ${state.goal.outputSpec.width}×${state.goal.outputSpec.height}@${state.goal.outputSpec.fps}，时长目标 ${state.goal.minFrames}–${state.goal.maxFrames} 帧`,
  );
  if (state.goal.moodArc.length > 0) {
    lines.push(`- **情绪走向：** ${state.goal.moodArc.map((n) => `${n.name}(${n.energy})`).join(" → ")}`);
  }
  lines.push(`- **下一步：** ${state.nextAction}`, "");
  if (state.assetCandidates && state.assetCandidates.length > 0) {
    const registered = new Set(state.assets.map((a) => a.sourceUrl));
    lines.push(`## 素材候选（任务配置：${state.taskConfigPath ?? "未知"}）`, "");
    for (const candidate of state.assetCandidates) {
      lines.push(`- ${registered.has(candidate.sourceUrl) ? "[已登记]" : "[待登记]"} ${candidate.sourceUrl}`);
    }
    lines.push("", `## 已登记素材（${state.assets.length} 段）`, "");
  } else {
    lines.push(`## 素材（${state.assets.length} 段）`, "");
  }
  lines.push(`| ID | 本地文件 | 来源 | 许可 | 核验日期 | 大小 |`, "|---|---|---|---|---|---|");
  for (const a of state.assets) {
    lines.push(
      `| ${a.id} | ${a.localPath} | ${a.sourceUrl} | ${a.licenseUrl} | ${a.licenseCheckedAt.slice(0, 10)} | ${(a.bytes / 1024 / 1024).toFixed(1)} MB |`,
    );
  }
  lines.push("", `## 产物（${state.artifacts.length} 件）`, "");
  lines.push(`| ID | 类型 | 文件 | 状态 | SHA-256 前 12 位 |`, "|---|---|---|---|---|");
  for (const art of state.artifacts) {
    lines.push(`| ${art.id} | ${art.kind} | ${art.path} | ${art.status} | ${art.sha256.slice(0, 12)} |`);
  }
  lines.push("", `## 检查点（${state.checkpoints.length} 个）`, "");
  for (const c of state.checkpoints) {
    lines.push(`- **${c.id}**（${c.phase}，${c.createdAt}，审阅：${c.review}）`);
    lines.push(`  - 摘要：${c.summary}`);
    lines.push(`  - 下一步：${c.nextAction}`);
    if (c.feedback) lines.push(`  - 反馈：${c.feedback}`);
  }
  lines.push("", `## 重要决定（${state.decisions.length} 条）`, "");
  for (const d of state.decisions) {
    lines.push(`- ${d.at}【${d.subject}】${d.reason} → ${d.effect}`);
  }
  lines.push("", `## 未解决问题（${state.issues.length} 条）`, "");
  for (const i of state.issues) {
    lines.push(`- ${i.at}【${i.kind}】证据：${i.evidence}；处理：${i.action}；结果：${i.result}`);
  }
  lines.push("", `## 恢复说明`, "");
  lines.push(
    `在仓库根目录运行 \`npm run cli -- resume --workspace ${loaded.dir}\` 即可核对指纹并重建本文件；进度以 state.json 为唯一权威。`,
    "",
  );
  const file = path.join(loaded.dir, "handoff.md");
  await mkdir(loaded.dir, { recursive: true });
  await writeFile(file, lines.join("\n"), "utf8");
  return file;
}

/* ---------- 命令实现 ---------- */

function printStateSummary(loaded: Loaded): void {
  const { state } = loaded;
  console.log(`阶段: ${state.phase}（revision ${state.revision}）`);
  console.log(`目标: ${state.goal.title}——${state.goal.theme}`);
  console.log(
    `规格: ${state.goal.outputSpec.width}×${state.goal.outputSpec.height}@${state.goal.outputSpec.fps}，时长目标 ${state.goal.minFrames}–${state.goal.maxFrames} 帧`,
  );
  if (state.goal.moodArc.length > 0) {
    console.log(`情绪走向: ${state.goal.moodArc.map((n) => `${n.name}(${n.energy})`).join(" → ")}`);
  }
  console.log(`素材: ${state.assets.length} 段 / 产物: ${state.artifacts.length} 件 / 检查点: ${state.checkpoints.length} 个`);
  console.log(`下一步: ${state.nextAction}`);
}

export async function cmdInit(args: string[]): Promise<number> {
  const dir = requireWorkspaceArg(args);
  const configFile = getOption(args, "--config");
  if (!configFile) {
    throw new WorkspaceError("缺少 --config 参数：新工作区必须依据任务配置创建（见 --help）");
  }
  const config = await loadTaskConfig(configFile);
  if (await stateExists(dir)) {
    throw new WorkspaceError(`工作区 ${dir} 已初始化，拒绝覆盖（如需继续请使用 resume 或 status）`);
  }
  for (const sub of WORKSPACE_SUBDIRS) {
    await mkdir(path.join(dir, sub), { recursive: true });
  }
  const state = emptyState(taskConfigToGoal(config));
  state.assetCandidates = config.assets.map((a) => ({ ...a }));
  state.taskConfigPath = path.resolve(configFile);
  state.nextAction = `登记素材（ingest）：任务配置列出 ${config.assets.length} 个候选，见 handoff；登记清单外的素材需附替换原因。`;
  const loaded: Loaded = { dir, state };
  await saveState(dir, state, 0);
  addDecision(
    loaded,
    "初始化工作区",
    `依据任务配置 ${path.resolve(configFile)}：${state.goal.outputSpec.width}×${state.goal.outputSpec.height}@${state.goal.outputSpec.fps}、${state.goal.minFrames}–${state.goal.maxFrames} 帧`,
    "进入素材阶段",
  );
  await persist(loaded);
  await writeHandoff(loaded);
  console.log(`工作区已初始化：${path.resolve(dir)}（任务配置：${path.resolve(configFile)}）`);
  printStateSummary({ dir, state: (await loadState(dir)).state });
  return 0;
}

function requireWorkspaceArg(args: string[]): string {
  const index = args.indexOf("--workspace");
  if (index === -1 || args[index + 1] === undefined) {
    throw new WorkspaceError("缺少 --workspace 参数");
  }
  // 统一为绝对路径：后续所有 join/resolve 都以此为基准。
  return path.resolve(args[index + 1]!);
}

function getOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

export async function cmdIngest(args: string[]): Promise<number> {
  const dir = requireWorkspaceArg(args);
  const file = getOption(args, "--file");
  const sourceUrl = getOption(args, "--source-url") ?? "";
  const licenseUrl = getOption(args, "--license-url")
    ?? "https://www.pexels.com/license/";
  const reason = getOption(args, "--reason");
  if (!file) throw new WorkspaceError("缺少 --file 参数");
  const loaded = await loadWorkspace(dir);
  // 候选清单核对（spec F3）：清单外素材必须附带替换原因。
  let replacement = false;
  if (loaded.state.assetCandidates && loaded.state.assetCandidates.length > 0) {
    const check = checkAssetAgainstCandidates(loaded.state.assetCandidates, sourceUrl, reason);
    if (!check.allowed) throw new WorkspaceError(check.message);
    replacement = check.replacement;
  }
  const totalBytes = loaded.state.assets.reduce((sum, a) => sum + a.bytes, 0);
  const record = await ingestAsset(loaded.dir, path.join(loaded.dir, "assets"), loaded.state.assets, {
    file,
    sourceUrl,
    licenseUrl,
    totalBytesSoFar: totalBytes,
  });
  loaded.state.assets.push(record);
  if (replacement) {
    addDecision(
      loaded,
      "素材替换",
      reason ?? "",
      `登记清单外素材 ${record.id}（${sourceUrl}），替代候选清单中的选择`,
    );
  }
  loaded.state.nextAction =
    loaded.state.assets.length >= 3
      ? "素材充足：用 score --plan 保存配乐方案。"
      : "继续登记素材（ingest），至少需要三段。";
  await persist(loaded);
  await writeHandoff(loaded);
  console.log(`已登记 ${record.id}: ${record.localPath}（${(record.bytes / 1024 / 1024).toFixed(1)} MB，${(record.media.durationMs / 1000).toFixed(2)}s，${record.media.width}×${record.media.height}@${record.media.fps.toFixed(2)}）`);
  printStateSummary(loaded);
  return 0;
}

export async function cmdScore(args: string[]): Promise<number> {
  const dir = requireWorkspaceArg(args);
  const planFile = getOption(args, "--plan");
  const loaded = await loadWorkspace(dir);
  if (!planFile) {
    console.log(JSON.stringify(loaded.state.scorePlan ?? {}, null, 2));
    return 0;
  }
  if (loaded.state.phase !== "assets" && loaded.state.phase !== "score_draft"
    && !(loaded.state.phase === "score_review" && !hasPendingCheckpoint(loaded, "score_review"))) {
    throw new WorkspaceError(`当前阶段 ${loaded.state.phase} 不允许写入配乐方案`);
  }
  if (loaded.state.assets.length === 0) {
    throw new WorkspaceError("还没有任何素材，先完成 ingest");
  }
  const plan = await readPlanFile<ScorePlan>(planFile);
  const errors = validateScorePlan(plan);
  errors.push(...validateScorePlanAgainstGoal(plan, loaded.state.goal));
  if (errors.length > 0) {
    const prefix = validateScorePlan(plan).length > 0 ? "配乐方案无效" : "配乐方案与任务目标不一致";
    throw new WorkspaceError(`${prefix}：${errors.join("；")}`);
  }
  loaded.state.scorePlan = plan;
  if (loaded.state.phase === "assets") {
    await checkPhaseTransition(loaded, "score_draft");
    loaded.state.phase = "score_draft";
  }
  loaded.state.nextAction = "运行 render score 生成配乐工程与 WAV。";
  await persist(loaded);
  await writeHandoff(loaded);
  console.log(`配乐方案已保存：${plan.sections.length} 个分段，${plan.sections.reduce((s, x) => s + x.bars, 0)} 小节，目标时长 ${(scoreDurationMs(plan) / 1000).toFixed(1)}s`);
  printStateSummary(loaded);
  return 0;
}

export async function cmdEdit(args: string[]): Promise<number> {
  const dir = requireWorkspaceArg(args);
  const planFile = getOption(args, "--plan");
  const loaded = await loadWorkspace(dir);
  if (!planFile) {
    console.log(JSON.stringify(loaded.state.editPlan ?? {}, null, 2));
    return 0;
  }
  if (loaded.state.phase !== "video_draft") {
    throw new WorkspaceError(`当前阶段 ${loaded.state.phase} 不允许写入剪辑方案（需先通过配乐检查点）`);
  }
  const plan = await readPlanFile<EditPlan>(planFile);
  const errors = validateEditPlan(plan, loaded.state.assets, loaded.state.artifacts, loaded.state.goal);
  if (errors.length > 0) throw new WorkspaceError(`剪辑方案无效：${errors.join("；")}`);
  loaded.state.editPlan = plan;
  loaded.state.nextAction = "运行 render video 生成粗剪工程与预览。";
  await persist(loaded);
  await writeHandoff(loaded);
  console.log(`剪辑方案已保存：${plan.clips.length} 个片段，共 ${plan.clips.reduce((s, c) => s + c.durationFrames, 0)} 帧`);
  printStateSummary(loaded);
  return 0;
}

function hasPendingCheckpoint(loaded: Loaded, phase: "score_review" | "video_review"): boolean {
  return loaded.state.checkpoints.some((c) => c.phase === phase && c.review === "pending");
}

async function runScoreRender(loaded: Loaded): Promise<number> {
  // 检查点提交前允许重新渲染（例如削波修正）；提交后必须走 review 流程。
  const phase = loaded.state.phase;
  if (phase !== "score_draft" && !(phase === "score_review" && !hasPendingCheckpoint(loaded, "score_review"))) {
    throw new WorkspaceError(`当前阶段 ${phase} 不允许渲染配乐（需要在 score_draft 或未提交检查点的 score_review）`);
  }
  const plan = loaded.state.scorePlan;
  if (!plan) throw new WorkspaceError("还没有配乐方案，先运行 score --plan");
  const fingerprint = scorePlanFingerprint(plan);
  const tag = `scoreplan:${fingerprint}:a${SCORE_ADAPTER_REV}`;
  const existingProject = findArtifactByTag(loaded.state, tag);
  if (existingProject) {
    console.log(`配乐方案未变化，已有产物：${existingProject.id}（${existingProject.path}）`);
    printStateSummary(loaded);
    return 0;
  }
  const evidenceDir = path.join(loaded.dir, "evidence");
  const projectPath = path.join(loaded.dir, "projects", `score-${fingerprint}-a${SCORE_ADAPTER_REV}.mmp`);
  const templatePath = path.join(REPO_ROOT, "templates", "lmms", "base.mmp");
  await writeScoreProject(plan, templatePath, projectPath);
  const projectArtifact = await registerArtifact(loaded, {
    kind: "lmms_project",
    file: projectPath,
    basedOn: [tag, "template:lmms-base"],
  });
  const wavPath = path.join(loaded.dir, "outputs", `score-${fingerprint}-a${SCORE_ADAPTER_REV}.wav`);
  const rendered = await renderScoreWav(projectPath, wavPath, evidenceDir);
  const targetMs = scoreDurationMs(plan);
  const wavMedia = await probeMedia(wavPath);
  const drift = Math.abs(wavMedia.durationMs - targetMs);
  const wavChecks = await checkMediaBasics(wavPath, {
    hasVideo: false,
    hasAudio: true,
    minDurationMs: targetMs - AV_TOLERANCE_MS,
  });
  const allPass = wavChecks.every((c) => c.status === "pass");
  // 逐件入列：nextId 依赖已登记列表，先推后注册避免 ID 重复。
  loaded.state.artifacts.push(projectArtifact);
  const wavArtifact = await registerArtifact(loaded, {
    kind: "audio_preview",
    file: wavPath,
    basedOn: [projectArtifact.id, tag],
  });
  loaded.state.artifacts.push(wavArtifact);
  if (!allPass) {
    const failed = wavChecks.filter((c) => c.status === "fail");
    addIssue(loaded, "render_score_failed", failed.map((c) => `${c.id}: ${c.evidence}`).join("；"), "保留日志，等待方案修正后重试", "未登记为可交付状态，阶段未推进");
    await persist(loaded);
    await writeHandoff(loaded);
    console.error(`配乐渲染检查未通过：${failed.map((c) => c.id).join(", ")}`);
    return 1;
  }
  if (loaded.state.phase === "score_draft") {
    await checkPhaseTransition(loaded, "score_review");
    loaded.state.phase = "score_review";
  }
  loaded.state.nextAction = "用 checkpoint 提交配乐检查点，然后请创作者审阅。";
  addDecision(loaded, `配乐 ${fingerprint} 渲染完成（a${SCORE_ADAPTER_REV}）`, `时长漂移 ${drift}ms ≤ ${AV_TOLERANCE_MS}ms`, "进入 score_review，等待检查点与审阅");
  await persist(loaded);
  await writeHandoff(loaded);
  console.log(`配乐工程: ${projectArtifact.path}`);
  console.log(`WAV: ${wavArtifact.path}（${rendered.outputBytes} 字节，时长漂移 ${drift}ms）`);
  printStateSummary(loaded);
  return 0;
}

async function runVideoRender(loaded: Loaded, kind: "preview" | "final"): Promise<number> {
  if (kind === "preview") {
    const phase = loaded.state.phase;
    if (phase !== "video_draft" && !(phase === "video_review" && !hasPendingCheckpoint(loaded, "video_review"))) {
      throw new WorkspaceError(`当前阶段 ${phase} 不允许渲染视频预览`);
    }
  } else if (loaded.state.phase !== "final_verify") {
    throw new WorkspaceError(`当前阶段 ${loaded.state.phase} 不允许渲染视频终版`);
  }
  const plan = loaded.state.editPlan;
  if (!plan) throw new WorkspaceError("还没有剪辑方案，先运行 edit --plan");
  const evidenceDir = path.join(loaded.dir, "evidence");
  if (kind === "preview") {
    const fingerprint = editPlanFingerprint(plan);
    const tag = `editplan:${fingerprint}:a1`;
    const existing = findArtifactByTag(loaded.state, tag);
    if (existing) {
      console.log(`剪辑方案未变化，已有产物：${existing.id}（${existing.path}）`);
      printStateSummary(loaded);
      return 0;
    }
    const soundtrack = artifactById(loaded.state, plan.soundtrackArtifactId);
    if (!soundtrack || soundtrack.status !== "confirmed") {
      throw new WorkspaceError(`配乐产物 ${plan.soundtrackArtifactId} 不存在或未确认`);
    }
    const wavFile = workspacePath(loaded.dir, soundtrack.path);
    const wavMedia = await probeMedia(wavFile);
    const projectPath = path.join(loaded.dir, "projects", `edit-${fingerprint}-a1.kdenlive`);
    const templatePath = path.join(REPO_ROOT, "templates", "kdenlive", "base.kdenlive");
    await writeEditProject(
      plan, loaded.dir, loaded.state.assets, wavFile, wavMedia.durationMs, templatePath, projectPath,
      loaded.state.goal,
    );
    const basedOn = [tag, soundtrack.id, ...plan.clips.map((c) => c.assetId)];
    const projectArtifact = await registerArtifact(loaded, {
      kind: "kdenlive_project", file: projectPath, basedOn,
    });
    loaded.state.artifacts.push(projectArtifact);
    const mp4Path = path.join(loaded.dir, "outputs", `preview-${fingerprint}-a1.mp4`);
    const rendered = await renderVideoMp4(projectPath, mp4Path, evidenceDir);
    const mp4Checks = await checkMediaBasics(mp4Path, {
      hasVideo: true, hasAudio: true,
      width: loaded.state.goal.outputSpec.width,
      height: loaded.state.goal.outputSpec.height,
      fps: loaded.state.goal.outputSpec.fps,
    });
    const allPass = mp4Checks.every((c) => c.status === "pass");
    const mp4Artifact = await registerArtifact(loaded, {
      kind: "video_preview", file: mp4Path, basedOn: [projectArtifact.id, tag],
    });
    loaded.state.artifacts.push(mp4Artifact);
    if (!allPass) {
      const failed = mp4Checks.filter((c) => c.status === "fail");
      addIssue(loaded, "render_video_failed", failed.map((c) => `${c.id}: ${c.evidence}`).join("；"), "保留日志，等待方案修正后重试", "未登记为可交付状态，阶段未推进");
      await persist(loaded);
      await writeHandoff(loaded);
      console.error(`粗剪渲染检查未通过：${failed.map((c) => c.id).join(", ")}`);
      return 1;
    }
    if (loaded.state.phase === "video_draft") {
      await checkPhaseTransition(loaded, "video_review");
      loaded.state.phase = "video_review";
    }
    loaded.state.nextAction = "用 checkpoint 提交粗剪检查点，然后请创作者审阅。";
    addDecision(loaded, `粗剪 ${fingerprint} 渲染完成（a1）`, `Kdenlive 导出耗时 ${rendered.seconds.toFixed(1)}s`, "进入 video_review，等待检查点与审阅");
    await persist(loaded);
    await writeHandoff(loaded);
    console.log(`剪辑工程: ${projectArtifact.path}`);
    console.log(`预览: ${mp4Artifact.path}（${rendered.outputBytes} 字节，导出 ${rendered.seconds.toFixed(1)}s）`);
    printStateSummary(loaded);
    return 0;
  }
  // final：使用已批准检查点对应的方案重新生成终版工程与 MP4
  const videoCheckpoint = [...loaded.state.checkpoints]
    .filter((c) => c.phase === "video_review")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  if (!videoCheckpoint || videoCheckpoint.review !== "approved") {
    throw new WorkspaceError("终版只能基于已批准的粗剪检查点生成");
  }
  const soundtrack = artifactById(loaded.state, plan.soundtrackArtifactId);
  if (!soundtrack) throw new WorkspaceError(`配乐产物 ${plan.soundtrackArtifactId} 不存在`);
  const wavFile = workspacePath(loaded.dir, soundtrack.path);
  const wavMedia = await probeMedia(wavFile);
  const finalWav = path.join(loaded.dir, "outputs", "score-final.wav");
  await cp(wavFile, finalWav);
  const finalWavArtifact = await registerArtifact(loaded, {
    kind: "audio_final", file: finalWav, basedOn: [soundtrack.id], status: "confirmed",
  });
  loaded.state.artifacts.push(finalWavArtifact);
  const projectPath = path.join(loaded.dir, "projects", "final.kdenlive");
  const templatePath = path.join(REPO_ROOT, "templates", "kdenlive", "base.kdenlive");
  await writeEditProject(plan, loaded.dir, loaded.state.assets, finalWav, wavMedia.durationMs, templatePath, projectPath, loaded.state.goal);
  const projectArtifact = await registerArtifact(loaded, {
    kind: "kdenlive_project", file: projectPath,
    basedOn: [videoCheckpoint.id, ...plan.clips.map((c) => c.assetId)], status: "confirmed",
  });
  loaded.state.artifacts.push(projectArtifact);
  const mp4Path = path.join(loaded.dir, "outputs", "final.mp4");
  const rendered = await renderVideoMp4(projectPath, mp4Path, evidenceDir);
  const mp4Checks = await checkMediaBasics(mp4Path, {
    hasVideo: true, hasAudio: true,
    width: loaded.state.goal.outputSpec.width,
    height: loaded.state.goal.outputSpec.height,
    fps: loaded.state.goal.outputSpec.fps,
    minDurationMs: loaded.state.goal.minFrames / loaded.state.goal.outputSpec.fps * 1000 - AV_TOLERANCE_MS,
  });
  const black = await detectBlackSegments(mp4Path);
  const silence = await detectSilenceSegments(mp4Path);
  const peak = await measurePeakVolume(mp4Path);
  const allPass = mp4Checks.every((c) => c.status === "pass");
  const mp4Artifact = await registerArtifact(loaded, {
    kind: "video_final", file: mp4Path, basedOn: [projectArtifact.id, finalWavArtifact.id], status: "confirmed",
  });
  loaded.state.artifacts.push(mp4Artifact);
  const analysisFile = path.join(evidenceDir, "final-quality-analysis.json");
  await writeFile(
    analysisFile,
    JSON.stringify({ blackSegments: black, silenceSegments: silence, peakVolumeDb: peak }, null, 2),
    "utf8",
  );
  if (!allPass) {
    const failed = mp4Checks.filter((c) => c.status === "fail");
    addIssue(loaded, "render_final_failed", failed.map((c) => `${c.id}: ${c.evidence}`).join("；"), "保留日志", "未登记为可交付状态，阶段未推进");
    await persist(loaded);
    await writeHandoff(loaded);
    console.error(`终版检查未通过：${failed.map((c) => c.id).join(", ")}`);
    return 1;
  }
  await checkPhaseTransition(loaded, "done");
  loaded.state.phase = "done";
  loaded.state.nextAction = "已交付。如需修改，参照 README 的反馈流程重开对应版本。";
  addDecision(loaded, "终版交付", `峰值音量 ${peak.maxVolumeDb}dB，黑帧候选 ${black.length} 段，静音候选 ${silence.length} 段`, "进入 done，等待创作者最终确认");
  await persist(loaded);
  await writeHandoff(loaded);
  console.log(`终版工程: ${projectArtifact.path}`);
  console.log(`终版 MP4: ${mp4Artifact.path}（${rendered.outputBytes} 字节）`);
  console.log(`峰值音量 ${peak.maxVolumeDb} dB；黑帧候选 ${black.length} 段；静音候选 ${silence.length} 段（详见 evidence/final-quality-analysis.json）`);
  printStateSummary(loaded);
  return 0;
}

export async function cmdRender(args: string[]): Promise<number> {
  const dir = requireWorkspaceArg(args);
  const target = args.find((a) => a === "score" || a === "video" || a === "final");
  if (!target) {
    throw new WorkspaceError("render 需要 score|video|final 目标");
  }
  const loaded = await loadWorkspace(dir);
  if (target === "score") return await runScoreRender(loaded);
  return await runVideoRender(loaded, target === "video" ? "preview" : "final");
}

export async function cmdVerify(args: string[]): Promise<number> {
  const dir = requireWorkspaceArg(args);
  const loaded = await loadWorkspace(dir);
  const results: CheckResult[] = [];
  for (const asset of loaded.state.assets) {
    results.push(...(await checkAsset(loaded.dir, asset)));
  }
  for (const artifact of loaded.state.artifacts) {
    if (artifact.kind === "lmms_project" || artifact.kind === "kdenlive_project") {
      results.push(...(await checkProjectReferences(workspacePath(loaded.dir, artifact.path))));
    }
    if (artifact.kind === "audio_preview" || artifact.kind === "audio_final"
      || artifact.kind === "video_preview" || artifact.kind === "video_final") {
      results.push(
        ...(await checkMediaBasics(workspacePath(loaded.dir, artifact.path), {
          hasVideo: artifact.kind.startsWith("video"),
          hasAudio: true,
        })),
      );
    }
  }
  results.push(...(await auditArtifacts(loaded)).map((p) => ({
    id: `artifact:${p.artifact.id}`,
    status: "fail" as const,
    evidence: p.problem,
  })));
  const file = path.join(loaded.dir, "evidence", `verify-${Date.now()}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(results, null, 2), "utf8");
  const failed = results.filter((r) => r.status === "fail");
  const pending = results.filter((r) => r.status === "needs_observation");
  console.log(`检查 ${results.length} 项：通过 ${results.length - failed.length - pending.length}，失败 ${failed.length}，待观察 ${pending.length}。证据：${file}`);
  for (const f of failed) console.log(`  [失败] ${f.id}: ${f.evidence}`);
  for (const p of pending) console.log(`  [待观察] ${p.id}: ${p.evidence}`);
  return failed.length > 0 ? 1 : 0;
}

export async function cmdCheckpoint(args: string[]): Promise<number> {
  const dir = requireWorkspaceArg(args);
  const summary = getOption(args, "--summary") ?? "";
  if (summary.trim() === "") throw new WorkspaceError("缺少 --summary 检查点摘要");
  const loaded = await loadWorkspace(dir);
  const phase = loaded.state.phase;
  if (phase !== "score_review" && phase !== "video_review") {
    throw new WorkspaceError(`当前阶段 ${phase} 不是检查点阶段`);
  }
  const alreadyPending = loaded.state.checkpoints.some((c) => c.phase === phase && c.review === "pending");
  if (alreadyPending) {
    throw new WorkspaceError("当前检查点已提交且待审阅；请用 review 记录意见（不覆盖已提交检查点）");
  }
  const kinds: ArtifactRecord["kind"][] = phase === "score_review"
    ? ["lmms_project", "audio_preview"]
    : ["kdenlive_project", "video_preview"];
  const artifactIds = kinds
    .map((k) => latestArtifact(loaded.state, k)?.id)
    .filter((id): id is string => id !== undefined);
  if (artifactIds.length === 0) throw new WorkspaceError("没有可提交的产物");
  const { checkpoint, directory } = await createCheckpoint(loaded, {
    phase,
    artifactIds,
    summary,
    nextAction: "等待创作者审阅（review --decision approve|changes）。",
  });
  loaded.state.nextAction = checkpoint.nextAction;
  addDecision(loaded, `提交检查点 ${checkpoint.id}`, summary, `产物已冻结到 ${directory}`);
  await persist(loaded);
  await writeHandoff(loaded);
  console.log(`检查点 ${checkpoint.id} 已提交（副本目录 ${directory}）：`);
  for (const id of checkpoint.artifactIds) {
    const art = artifactById(loaded.state, id);
    if (art) console.log(`  - ${art.kind}: ${art.path}`);
  }
  printStateSummary(loaded);
  return 0;
}

export async function cmdReview(args: string[]): Promise<number> {
  const dir = requireWorkspaceArg(args);
  const decision = getOption(args, "--decision");
  const feedback = getOption(args, "--feedback") ?? "";
  if (decision !== "approve" && decision !== "changes") {
    throw new WorkspaceError("--decision 必须是 approve 或 changes");
  }
  const loaded = await loadWorkspace(dir);
  const phase = loaded.state.phase;
  if (phase !== "score_review" && phase !== "video_review") {
    throw new WorkspaceError(`当前阶段 ${phase} 没有待审阅的检查点`);
  }
  const checkpoint = [...loaded.state.checkpoints]
    .filter((c) => c.phase === phase && c.review === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  if (!checkpoint) {
    throw new WorkspaceError("没有 pending 检查点，先运行 checkpoint 提交");
  }
  checkpoint.review = decision === "approve" ? "approved" : "changes_requested";
  if (feedback) checkpoint.feedback = feedback;
  const drafts: Phase = phase === "score_review" ? "score_draft" : "video_draft";
  const next: Phase = phase === "score_review" ? "video_draft" : "final_verify";
  if (decision === "approve") {
    for (const id of checkpoint.artifactIds) {
      const art = artifactById(loaded.state, id);
      if (art) art.status = "confirmed";
    }
    await checkPhaseTransition(loaded, next);
    loaded.state.phase = next;
    loaded.state.nextAction = phase === "score_review"
      ? "用 edit --plan 保存剪辑方案，然后 render video。"
      : "用 render final 生成并核验终版。";
    addDecision(loaded, `检查点 ${checkpoint.id} 批准`, feedback || "创作者批准", `产物转 confirmed，进入 ${next}`);
  } else {
    if (feedback.trim() === "") {
      throw new WorkspaceError("要求修改时必须提供 --feedback 说明具体意见");
    }
    for (const id of checkpoint.artifactIds) {
      const art = artifactById(loaded.state, id);
      if (art) art.status = "draft";
    }
    await checkPhaseTransition(loaded, drafts);
    loaded.state.phase = drafts;
    loaded.state.nextAction = phase === "score_review"
      ? "按反馈更新配乐方案（score --plan）后重新 render score。"
      : "按反馈更新剪辑方案（edit --plan）后重新 render video；若片长或节奏点变化需同步更新配乐。";
    addDecision(loaded, `检查点 ${checkpoint.id} 要求修改`, feedback, `相关产物回到 draft，回到 ${drafts}`);
  }
  await persist(loaded);
  await writeHandoff(loaded);
  console.log(`检查点 ${checkpoint.id} 已记录：${decision}${feedback ? `（${feedback}）` : ""}`);
  printStateSummary(loaded);
  return 0;
}

export async function cmdResume(args: string[]): Promise<number> {
  const dir = requireWorkspaceArg(args);
  const loaded = await loadWorkspace(dir);
  const problems = await auditArtifacts(loaded);
  for (const problem of problems) {
    addIssue(loaded, "artifact_integrity", problem.problem, "记录问题，等待人工处理或重新渲染", "未自动修改任何文件");
  }
  await persist(loaded);
  const handoff = await writeHandoff(loaded);
  console.log(`恢复完成：阶段 ${loaded.state.phase}（revision ${loaded.state.revision}）`);
  if (problems.length > 0) {
    console.log(`发现 ${problems.length} 个产物完整性问题：`);
    for (const p of problems) console.log(`  - ${p.artifact.id}: ${p.problem}`);
  } else {
    console.log("全部产物指纹核对一致。");
  }
  console.log(`下一步: ${loaded.state.nextAction}`);
  console.log(`摘要已更新: ${handoff}`);
  return 0;
}

export async function cmdStatus(args: string[]): Promise<number> {
  const dir = requireWorkspaceArg(args);
  const loaded = await loadWorkspace(dir);
  printStateSummary(loaded);
  if (loaded.state.scorePlan) {
    const plan = loaded.state.scorePlan;
    console.log(`配乐方案: ${plan.bpm} BPM，${plan.sections.reduce((s, x) => s + x.bars, 0)} 小节，${plan.tracks.length} 条轨道`);
  }
  if (loaded.state.editPlan) {
    const plan = loaded.state.editPlan;
    console.log(`剪辑方案: ${plan.clips.length} 个片段，共 ${plan.clips.reduce((s, c) => s + c.durationFrames, 0)} 帧`);
  }
  return 0;
}

export const commands: Record<string, (args: string[]) => Promise<number>> = {
  init: cmdInit,
  ingest: cmdIngest,
  score: cmdScore,
  edit: cmdEdit,
  render: cmdRender,
  verify: cmdVerify,
  checkpoint: cmdCheckpoint,
  review: cmdReview,
  resume: cmdResume,
  status: cmdStatus,
};
