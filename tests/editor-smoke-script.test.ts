import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = path.resolve("scripts/resolve-smoke.mjs");

test("真实 Resolve 冒烟脚本帮助和缺少配置路径不连接 Resolve、不创建证据", async () => {
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /只读环境冒烟/u);

  const dir = await mkdtemp(path.join(tmpdir(), "resolve-smoke-script-"));
  const evidence = path.join(dir, "must-not-exist");
  try {
    const env = { ...process.env };
    delete env.RESOLVE_SMOKE_WORKSPACE;
    delete env.RESOLVE_VERIFIED_BUILDS;
    env.RESOLVE_SMOKE_EVIDENCE_DIR = evidence;
    const missing = spawnSync(process.execPath, [script], { encoding: "utf8", env });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /未创建证据文件/u);
    await assert.rejects(() => stat(evidence), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
