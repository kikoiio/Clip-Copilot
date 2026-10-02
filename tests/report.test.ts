/**
 * 深度检查报告的落盘与检索测试。对应 plan.md 模块 C（verification/report.ts）。
 * 均使用 os.tmpdir 临时目录，测完递归清理，不触碰工作区状态。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CheckResult, CheckStatus } from "../src/domain.ts";
import {
  buildReport,
  latestCheckReport,
  summarize,
  writeCheckReport,
} from "../src/verification/report.ts";

async function tempEvidenceDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "report-test-"));
}

/** 构造一条只含必填字段的检查结果，便于按 status 组合计数。 */
function result(id: string, status: CheckStatus): CheckResult {
  return { id, status, evidence: `证据：${id}` };
}

test("writeCheckReport 落盘并返回路径，latestCheckReport 取文件名时间戳最大的一份", async () => {
  const dir = await tempEvidenceDir();
  try {
    const report1 = buildReport(
      { targetArtifactId: "art-a", targetFile: "evidence/a.wav", targetKind: "audio_preview" },
      [result("deep:clip", "pass")],
      { ffmpeg: "7.1" },
    );
    // buildReport 应填 checkedAt 与 summary
    assert.ok(!Number.isNaN(Date.parse(report1.checkedAt)));
    assert.deepEqual(report1.summary, { pass: 1, warn: 0, fail: 0, needsHuman: 0 });
    assert.equal(report1.targetArtifactId, "art-a");

    const file1 = await writeCheckReport(dir, report1);
    assert.match(path.basename(file1), /^check-report-art-a-\d+\.json$/);
    assert.equal((await stat(file1)).isFile(), true);

    // 手动以更大的文件名时间戳写第二份（真实时钟间隔不保证 >1ms）
    const report2 = { ...report1, checkedAt: "2026-01-02T00:00:00.000Z" };
    const file2 = path.join(dir, `check-report-art-a-${Date.now() + 10_000}.json`);
    await writeFile(file2, JSON.stringify(report2, null, 2), "utf8");

    const latest = await latestCheckReport(dir, "art-a");
    assert.ok(latest);
    assert.equal(latest.checkedAt, "2026-01-02T00:00:00.000Z");
    // 精确匹配 artifactId：其他产物的报告不参与
    assert.equal(await latestCheckReport(dir, "art-other"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("损坏的报告文件返回 null，不抛异常", async () => {
  const dir = await tempEvidenceDir();
  try {
    await writeFile(path.join(dir, "check-report-art-b-1700000000000.json"), "{这不是JSON", "utf8");
    assert.equal(await latestCheckReport(dir, "art-b"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("summarize 按 status 计数，needs_observation 与 needs_human 都计入 needsHuman", async () => {
  const summary = summarize([
    result("a", "pass"),
    result("b", "warn"),
    result("c", "fail"),
    result("d", "needs_observation"),
    result("e", "needs_human"),
    result("f", "pass"),
  ]);
  assert.deepEqual(summary, { pass: 2, warn: 1, fail: 1, needsHuman: 2 });
});

test("目录不存在时 latestCheckReport 返回 null", async () => {
  const dir = await tempEvidenceDir();
  try {
    const missing = path.join(dir, "no-such-evidence");
    assert.equal(await latestCheckReport(missing, "art-c"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("无 targetArtifactId 时文件名用 unknown 占位", async () => {
  const dir = await tempEvidenceDir();
  try {
    const report = buildReport({ targetFile: "evidence/x.mp4", targetKind: "video_preview" }, [], {});
    assert.equal(report.targetArtifactId, undefined);
    const file = await writeCheckReport(dir, report);
    assert.match(path.basename(file), /^check-report-unknown-\d+\.json$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
