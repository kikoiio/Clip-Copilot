/**
 * T12 集成测试（阶段 3）：渲染 → 深度检查报告 → 检查点冻结报告 → 门禁拦截 → waive 放行全路径。
 *
 * 对应 checklist：C7（报告冻结进检查点——用例 A 前置 + 用例 B 的成功检查点）、
 * C11（checkpoint 门禁——用例 B 前半）、C12（豁免放行且留痕——用例 B 后半）、
 * C20（自动测试——用例 C 的 verify 汇总全绿）。
 *
 * 三个用例在同一临时工作区上顺序执行，AppImage 全程只渲染一次（用例 A 的 render score）。
 * 用例 B 在渲染产物上手工注入含 fail 的检查报告 → checkpoint 被门禁拦截 → waive 留痕 →
 * 再次 checkpoint 成功。由于同一阶段同时只允许一个待审检查点、门禁又必须发生在成功提交
 * 之前，用例 A 的「checkpoint 提交 + 报告冻结」断言在用例 B 放行后的成功检查点上一并验证。
 *
 * 沿用 recovery.test.ts 的构建方式：直接 import 协调器 cmd* 函数（不跑 CLI 子进程），
 * 合成素材用 ffmpeg lavfi（参照 native-smoke / headless 的做法），断言以返回值、
 * state.json 与文件系统为准。真实 AppImage 慢速用例：LMMS 缺失时整组跳过，预期 1–2 分钟。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { waiversOf, type CheckResult, type ScorePlan } from "../src/domain.ts";
import { LMMS_APPIMAGE, runFfmpeg } from "../src/infra/process.ts";
import { applyWaivers } from "../src/verification/deep.ts";
import {
  buildReport,
  latestCheckReport,
  latestCheckReportWithFile,
  writeCheckReport,
} from "../src/verification/report.ts";
import { WorkspaceError, loadState, sha256File } from "../src/workspace/store.ts";
import {
  cmdCheckpoint,
  cmdInit,
  cmdIngest,
  cmdRender,
  cmdScore,
  cmdVerify,
  cmdWaive,
} from "../src/workflow/coordinator.ts";
import type { TaskConfig } from "../src/workflow/taskConfig.ts";

const LMMS_PRESENT = await stat(LMMS_APPIMAGE).then(() => true).catch(() => false);

/* ---------- 三个用例共享的同一临时工作区 ---------- */

let wsDir: string | undefined;
let evidenceDir: string | undefined;
/** 配乐 WAV 产物 ID：渲染深度检查报告、注入报告与门禁的共同对象。 */
let wavArtifactId: string | undefined;
/** 用例 B 注入的 fail 报告文件（绝对路径）。 */
let injectedReportFile: string | undefined;

after(async () => {
  if (wsDir) await rm(wsDir, { recursive: true, force: true });
});

/* ---------- 样板数据 ---------- */

/** 任务配置：时长范围 4–8s，正好覆盖 2 小节 @120bpm 的合成配乐。 */
function integrationTaskConfig(): TaskConfig {
  return {
    schemaVersion: 1,
    title: "深度检查集成测试",
    theme: "T12 集成测试：合成素材与合成配乐，不进入任何成片",
    moodArc: [{ name: "平稳", energy: 1 }],
    duration: { minSeconds: 4, maxSeconds: 8 },
    outputSpec: { width: 1920, height: 1080, fps: 30 },
    assets: [
      {
        sourceUrl: "https://example.com/integration-deep/clip",
        licenseUrl: "https://example.com/integration-deep/license",
      },
    ],
  };
}

/** 2 小节 @120bpm = 4s 配乐方案：与任务配置时长匹配，pad 轨每小节一个全音符。 */
function twoBarScorePlan(): ScorePlan {
  const notes: ScorePlan["tracks"][number]["notes"] = [];
  for (let bar = 0; bar < 2; bar++) {
    notes.push({ trackId: "pad", pitchMidi: 60, startBeat: bar * 4, durationBeats: 4, velocity: 70 });
  }
  return {
    bpm: 120,
    beatsPerBar: 4,
    sections: [{ name: "主线", startBar: 0, bars: 2, energy: 1 }],
    tracks: [{ id: "pad", instrumentTemplate: "Pad", notes }],
  };
}

/* ---------- 用例 A：全绿路径（渲染 → 深度检查报告） ---------- */

test("T12 用例 A：init→ingest→score→render score 全绿，报告 fail=0、进入 score_review", { skip: !LMMS_PRESENT }, async () => {
  wsDir = await mkdtemp(path.join(tmpdir(), "mm-integration-deep-"));
  evidenceDir = path.join(wsDir, "evidence");
  // init：任务配置写入临时目录，工作区据此创建
  const configFile = path.join(wsDir, "task.json");
  await writeFile(configFile, JSON.stringify(integrationTaskConfig()), "utf8");
  assert.equal(await cmdInit(["--workspace", wsDir, "--config", configFile]), 0);
  // ingest：lavfi 合成素材先放入 assets/（登记要求），来源与候选清单一致
  const clipPath = path.join(wsDir, "assets", "clip.mp4");
  const synth = await runFfmpeg(
    [
      "-f", "lavfi", "-i", "testsrc=duration=4:size=1920x1080:rate=30",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p",
      "-y", clipPath,
    ],
    { timeoutMs: 2 * 60_000 },
  );
  assert.equal(synth.exitCode, 0, `合成素材失败：${synth.stderr.slice(-500)}`);
  assert.equal(
    await cmdIngest([
      "--workspace", wsDir,
      "--file", clipPath,
      "--source-url", "https://example.com/integration-deep/clip",
      "--license-url", "https://example.com/integration-deep/license",
    ]),
    0,
  );
  // score --plan → score_draft
  const planFile = path.join(wsDir, "score-plan.json");
  await writeFile(planFile, JSON.stringify(twoBarScorePlan()), "utf8");
  assert.equal(await cmdScore(["--workspace", wsDir, "--plan", planFile]), 0);
  assert.equal((await loadState(wsDir)).state.phase, "score_draft");
  // render score（全程唯一一次 AppImage 渲染）→ score_review
  assert.equal(await cmdRender(["--workspace", wsDir, "score"]), 0, "render score 应成功");
  const afterRender = await loadState(wsDir);
  assert.equal(afterRender.state.phase, "score_review");
  const wavArtifact = afterRender.state.artifacts.find((a) => a.kind === "audio_preview");
  assert.ok(wavArtifact, "渲染后应登记 audio_preview 产物");
  wavArtifactId = wavArtifact.id;
  // evidence/ 出现该 WAV 产物的 check-report-*.json，且最新报告 fail=0
  const files = await readdir(evidenceDir);
  assert.ok(
    files.some((f) => f.startsWith(`check-report-${wavArtifactId}-`) && f.endsWith(".json")),
    `evidence/ 应出现 check-report-<产物ID>-*.json（实际：${files.join("、")}）`,
  );
  const report = await latestCheckReport(evidenceDir, wavArtifactId);
  assert.ok(report, "应能取到渲染深度检查报告");
  assert.equal(report.targetArtifactId, wavArtifactId);
  assert.equal(report.summary.fail, 0, `渲染深度检查不应有 fail：${JSON.stringify(report.summary)}`);
  const ids = report.results.map((r) => r.id);
  for (const id of ["deep:audio:duration", "deep:audio:silence", "deep:audio:clip", "deep:audio:loudness"]) {
    const item = report.results.find((r) => r.id === id);
    assert.ok(item, `报告应含检查项 ${id}（实际：${ids.join("、")}）`);
    assert.notEqual(item.status, "fail", `${id} 不应 fail：${item.evidence}`);
  }
});

/* ---------- 用例 B：门禁拦截与豁免（C11/C12 + C7 的冻结断言） ---------- */

test("T12 用例 B：fail 报告阻断 checkpoint → waive 留痕 → 放行并冻结报告", { skip: !LMMS_PRESENT }, async () => {
  const dir = wsDir;
  const evDir = evidenceDir;
  const wavId = wavArtifactId;
  assert.ok(dir, "用例 A 应先建立工作区");
  assert.ok(evDir, "用例 A 应先建立工作区");
  assert.ok(wavId, "用例 A 应先渲染出配乐产物");
  const wavArtifact = (await loadState(dir)).state.artifacts.find((a) => a.id === wavId);
  assert.ok(wavArtifact, "配乐产物应仍在状态中");
  const before = await loadState(dir);
  const decisionsBefore = before.state.decisions.length;
  const waiversBefore = waiversOf(before.state).length;

  // 1. 制造硬伤：手工构造含 fail 的检查报告（时间戳晚于渲染报告，成为该产物最新报告）
  const injected = buildReport(
    { targetArtifactId: wavId, targetFile: wavArtifact.path, targetKind: wavArtifact.kind },
    [{ id: "deep:audio:silence", status: "fail", evidence: "测试注入：中段静音 2s" }],
    {},
  );
  injectedReportFile = await writeCheckReport(evDir, injected);
  const latest = await latestCheckReport(evDir, wavId);
  assert.equal(latest?.results[0]?.evidence, "测试注入：中段静音 2s", "注入报告应成为该产物最新报告");

  // 2. checkpoint 被深度检查硬伤阻断，错误信息含阻断原因与 waive 处置提示
  await assert.rejects(
    () => cmdCheckpoint(["--workspace", dir, "--summary", "门禁前提交"]),
    (err: unknown) =>
      err instanceof WorkspaceError &&
      err.message.includes("深度检查硬伤阻断") &&
      err.message.includes("waive"),
  );

  // 3. waive 留痕：state.waivers 新增记录，decisions 新增一条且含原因
  assert.equal(
    await cmdWaive([
      "--workspace", dir,
      "--check", "deep:audio:silence",
      "--reason", "测试豁免：该静音为设计意图",
    ]),
    0,
  );
  const afterWaive = await loadState(dir);
  const waivers = waiversOf(afterWaive.state);
  assert.equal(waivers.length, waiversBefore + 1);
  assert.equal(waivers.at(-1)?.checkId, "deep:audio:silence");
  assert.match(waivers.at(-1)?.reason ?? "", /测试豁免：该静音为设计意图/);
  assert.equal(afterWaive.state.decisions.length, decisionsBefore + 1);
  const waiveDecision = afterWaive.state.decisions.at(-1);
  assert.match(waiveDecision?.reason ?? "", /deep:audio:silence/);
  assert.match(waiveDecision?.reason ?? "", /测试豁免：该静音为设计意图/);

  // 4. 豁免后再 checkpoint 成功；报告副本冻结进检查点目录，manifest.reports 指纹与源文件一致
  assert.equal(await cmdCheckpoint(["--workspace", dir, "--summary", "配乐检查点（豁免后放行）"]), 0);
  const afterCheckpoint = await loadState(dir);
  assert.equal(afterCheckpoint.state.checkpoints.length, 1);
  const checkpoint = afterCheckpoint.state.checkpoints[0]!;
  assert.equal(checkpoint.phase, "score_review");
  assert.ok(checkpoint.artifactIds.includes(wavId), "检查点应引用配乐 WAV 产物");
  const checkpointDir = path.join(dir, "checkpoints", checkpoint.id);
  const manifest = JSON.parse(
    await readFile(path.join(checkpointDir, "manifest.json"), "utf8"),
  ) as {
    artifacts: { id: string; file: string; sha256: string }[];
    reports: { file: string; sha256: string }[];
  };
  assert.equal(manifest.reports.length, 1, "被引用产物中只有配乐 WAV 有检查报告");
  assert.equal(manifest.reports[0]!.file, path.basename(injectedReportFile));
  for (const entry of manifest.reports) {
    const sourceHash = await sha256File(path.join(evDir, entry.file));
    assert.equal(entry.sha256, sourceHash, "manifest 登记指纹应与源报告一致");
    assert.equal(await sha256File(path.join(checkpointDir, entry.file)), sourceHash, "报告副本指纹应与源一致");
  }
  // 被引用产物本体同样冻结在检查点目录
  for (const entry of manifest.artifacts) {
    assert.equal((await stat(path.join(checkpointDir, entry.file))).isFile(), true, `产物副本 ${entry.file} 应存在`);
  }

  // 5. 豁免只影响门禁重评，不改写历史报告：原始报告仍 fail，按当前豁免重评后降级 warn
  const raw = await latestCheckReportWithFile(evDir, wavId);
  assert.ok(raw, "最新报告仍可取到");
  assert.equal(raw.file, injectedReportFile, "门禁冻结的正是豁免重评通过的那份报告");
  const rawSilence = raw.report.results.find((r) => r.id === "deep:audio:silence");
  assert.equal(rawSilence?.status, "fail", "原始报告必须保持 fail（豁免不改写历史报告）");
  const reevaluated = applyWaivers(raw.report.results, waiversOf(afterCheckpoint.state), wavId);
  assert.ok(reevaluated.every((r) => r.status !== "fail"), "按当前豁免重评后不应再有 fail");
  const waived = reevaluated.find((r) => r.id === "deep:audio:silence");
  assert.equal(waived?.status, "warn");
  assert.match(waived?.evidence ?? "", /已豁免：测试豁免：该静音为设计意图/);
});

/* ---------- 用例 C：verify 汇总（C20） ---------- */

test("T12 用例 C：verify 退出码 0，汇总含 deep:audio:* 与 headless:lmms pass", { skip: !LMMS_PRESENT }, async () => {
  const dir = wsDir;
  const evDir = evidenceDir;
  assert.ok(dir, "用例 A 应先建立工作区");
  assert.ok(evDir, "用例 A 应先建立工作区");
  // 该工作区干净：豁免的注入报告只影响门禁，verify 对真实文件重新检查，应全绿
  assert.equal(await cmdVerify(["--workspace", dir]), 0, "干净工作区 verify 应退出 0");
  const files = await readdir(evDir);
  const verifyFiles = files.filter((f) => /^verify-\d+\.json$/.test(f)).sort();
  assert.ok(verifyFiles.length > 0, "evidence/ 应有 verify-*.json 汇总");
  const summary = JSON.parse(
    await readFile(path.join(evDir, verifyFiles.at(-1)!), "utf8"),
  ) as CheckResult[];
  const byId = (id: string): CheckResult | undefined => summary.find((r) => r.id === id);
  for (const id of ["deep:audio:duration", "deep:audio:silence", "deep:audio:clip"]) {
    assert.equal(byId(id)?.status, "pass", `${id} 应 pass（汇总：${JSON.stringify(summary.map((r) => [r.id, r.status]))}）`);
  }
  const loudness = byId("deep:audio:loudness");
  assert.ok(loudness, "汇总应含 deep:audio:loudness");
  assert.notEqual(loudness.status, "fail", `loudness 不应 fail：${loudness.evidence}`);
  assert.equal(byId("headless:lmms")?.status, "pass", "LMMS 工程无界面验证应 pass");
  // state.json 的 issues 不含 deep_check_fail
  const state = await loadState(dir);
  const deepFails = state.state.issues.filter((i) => i.kind === "deep_check_fail");
  assert.deepEqual(deepFails, [], `不应有 deep_check_fail 问题记录：${JSON.stringify(deepFails)}`);
});
