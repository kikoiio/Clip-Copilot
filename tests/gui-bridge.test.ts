import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  enqueueAction,
  monitorConfigAction,
  reviewAction,
  runAction,
  verifyAction,
  waiveAction,
} from "../src/gui/bridge.ts";
import { taskConfigToGoal, type TaskConfig } from "../src/workflow/taskConfig.ts";
import { emptyState, saveState, stateExists } from "../src/workspace/store.ts";

function sampleTaskConfig(): TaskConfig {
  return {
    schemaVersion: 1,
    title: "桥接测试样板",
    theme: "临时工作区",
    moodArc: [{ name: "平静", energy: 0 }],
    duration: { minSeconds: 30, maxSeconds: 60 },
    outputSpec: { width: 1920, height: 1080, fps: 30 },
    assets: [
      { sourceUrl: "https://www.pexels.com/video/bridge-test/", licenseUrl: "https://www.pexels.com/license/" },
    ],
  };
}

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "gui-bridge-"));
  await saveState(dir, emptyState(taskConfigToGoal(sampleTaskConfig())), 0);
  return dir;
}

test("T2：runAction 成功路径捕获退出码与输出行", async () => {
  const dir = await makeWorkspace();
  try {
    const result = await runAction(monitorConfigAction(dir));
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.ok(result.lines.some((line) => line.includes('"notificationLevel"')), `输出行应含配置 JSON：${result.lines.join(" | ")}`);
    assert.equal(result.error, undefined);
    assert.ok(await stateExists(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T2：错误透传为 error 字段且文案与 CLI 一致", async () => {
  const missing = path.join(tmpdir(), "gui-bridge-missing-工作区");
  const verify = await runAction(verifyAction(missing));
  assert.equal(verify.ok, false);
  assert.match(verify.error ?? "", /还没有初始化/);
  assert.deepEqual(verify.lines, []);

  const dir = await makeWorkspace();
  try {
    const waive = await runAction(waiveAction(dir, "deep:video:black", ""));
    assert.equal(waive.ok, false);
    assert.match(waive.error ?? "", /豁免必须说明原因/);
    const review = await runAction(reviewAction(dir, "approve", ""));
    assert.equal(review.ok, false);
    assert.match(review.error ?? "", /没有待审阅的检查点/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T2：同一工作区的动作串行执行，失败不阻塞后续", async () => {
  const events: string[] = [];
  const first = new Promise<void>((resolve) => {
    events.push("first-start");
    setTimeout(() => {
      events.push("first-end");
      resolve();
    }, 30);
  });
  const firstRun = enqueueAction("ws-x", () => first);
  const secondRun = enqueueAction("ws-x", async () => {
    events.push("second-start");
  });
  await Promise.all([firstRun, secondRun]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start"]);

  await assert.rejects(
    () => enqueueAction("ws-x", async () => {
      throw new Error("前序失败");
    }),
    /前序失败/,
  );
  const after = await enqueueAction("ws-x", async () => "recovered");
  assert.equal(after, "recovered");
});

test("T2：不同工作区的动作并行执行", async () => {
  let running = 0;
  let maxConcurrent = 0;
  const run = (name: string) =>
    enqueueAction(name, async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running--;
    });
  await Promise.all([run("ws-a"), run("ws-b"), run("ws-c")]);
  assert.ok(maxConcurrent > 1, `不同工作区应并行（实际最大并发 ${maxConcurrent}）`);
});

test("T2：执行结束后 console 还原", async () => {
  const originalLog = console.log;
  const dir = await makeWorkspace();
  try {
    await runAction(monitorConfigAction(dir, { notification: "silent" }));
    const failed = await runAction(verifyAction(path.join(dir, "nope")));
    assert.equal(failed.ok, false);
    assert.equal(console.log, originalLog, "console.log 应在成功与失败路径后都还原");
  } finally {
    console.log = originalLog;
    await rm(dir, { recursive: true, force: true });
  }
});
