import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createResolveAdapter } from "../src/editor/resolve/adapter.ts";
import { createResolveSupportPolicy } from "../src/editor/resolve/compatibility.ts";
import { createResolveProcessBridge } from "../src/editor/resolve/bridge.ts";
import { refreshResolveWorkspace } from "../src/editor/resolve/service.ts";

const HELP = `Resolve 只读环境冒烟

用法：RESOLVE_SMOKE_WORKSPACE=<已准备工作区> RESOLVE_VERIFIED_BUILDS=<精确构建号[,构建号...]> node scripts/resolve-smoke.mjs

可选：RESOLVE_SMOKE_EVIDENCE_DIR=<本地证据目录>（默认 evidence/resolve-smoke）
只检查健康状态并读取当前项目/时间线摘要；不会创建云资源或上传证据。
`;

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const workspace = process.env.RESOLVE_SMOKE_WORKSPACE?.trim();
  const builds = (process.env.RESOLVE_VERIFIED_BUILDS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!workspace || builds.length === 0) {
    process.stderr.write("缺少 RESOLVE_SMOKE_WORKSPACE 或 RESOLVE_VERIFIED_BUILDS；未创建证据文件，也未启动 Resolve 探针。\n");
    return 2;
  }

  const adapter = createResolveAdapter({
    bridge: createResolveProcessBridge(),
    supportPolicy: createResolveSupportPolicy({ acceptedBuilds: builds, baselineEdition: "free" }),
  });
  const startedAt = Date.now();
  const result = await refreshResolveWorkspace(path.resolve(workspace), adapter, { timeoutMs: 15_000 });
  const context = result.state.editorContext;
  const snapshot = context.latestSnapshot;
  const evidence = {
    recordedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    health: context.health,
    runtime: context.runtime ?? null,
    capabilities: [
      { id: "read.health", available: context.health.state === "online", reason: context.health.reason ?? null },
      { id: "read.project_snapshot", available: context.health.state === "online" && snapshot !== null, reason: snapshot ? null : context.health.reason ?? "No successful snapshot" },
    ],
    snapshot: snapshot ? {
      fingerprint: snapshot.fingerprint,
      capturedAt: snapshot.capturedAt,
      counts: {
        tracks: snapshot.tracks.length,
        clips: snapshot.clips.length,
        markers: snapshot.markers.length,
        subtitles: snapshot.subtitles.length,
        media: snapshot.media.length,
      },
      mappingNotes: snapshot.mappingNotes,
    } : null,
  };
  const evidenceDir = path.resolve(process.env.RESOLVE_SMOKE_EVIDENCE_DIR ?? "evidence/resolve-smoke");
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, "smoke.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  return context.health.state === "online" && snapshot ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    process.stderr.write(`Resolve smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
