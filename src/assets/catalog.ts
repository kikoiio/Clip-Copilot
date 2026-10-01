import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  MAX_TOTAL_ASSET_BYTES,
  type AssetRecord,
  type CheckResult,
  type MediaInfo,
} from "../domain.ts";
import { probeMedia } from "../verification/media.ts";
import { nextId, sha256File } from "../workspace/store.ts";

export interface IngestInput {
  /** 本地视频文件（绝对路径或相对工作区）。 */
  file: string;
  sourceUrl: string;
  licenseUrl: string;
  /** 已登记素材的字节总量，用于 2 GB 上限检查。 */
  totalBytesSoFar: number;
}

export class AssetError extends Error {}

/**
 * 登记素材：存在性、许可记录、下载总量、指纹与媒体信息一次完成。
 * 只确认可读取与可解析；完整解码交给验证器（plan.md 的职责划分）。
 */
export async function ingestAsset(
  workspaceDir: string,
  assetsDir: string,
  existingIds: readonly { id: string }[],
  input: IngestInput,
): Promise<AssetRecord> {
  if (!input.sourceUrl) throw new AssetError("缺少来源 URL");
  if (!input.licenseUrl) throw new AssetError("缺少许可 URL");
  const source = path.resolve(input.file);
  const info = await stat(source).catch(() => null);
  if (!info || !info.isFile()) {
    throw new AssetError(`素材文件不存在：${source}`);
  }
  if (input.totalBytesSoFar + info.size > MAX_TOTAL_ASSET_BYTES) {
    throw new AssetError(
      `累计下载量将达 ${(input.totalBytesSoFar + info.size) / 1024 / 1024} MB，超过 2 GB 上限`,
    );
  }
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  const target = path.join(assetsDir, path.basename(source));
  if (path.resolve(target) !== source) {
    throw new AssetError(`素材必须先放入 ${assetsDir} 再登记（当前位于 ${source}）`);
  }
  const media = await probeMedia(target);
  const sha256 = await sha256File(target);
  return {
    id: nextId("asset", existingIds),
    sourceUrl: input.sourceUrl,
    licenseUrl: input.licenseUrl,
    licenseCheckedAt: new Date().toISOString(),
    localPath: path.relative(workspaceDir, target),
    sha256,
    bytes: info.size,
    media,
  };
}

/** 对已登记素材做常规检查：文件存在、指纹一致、可被 ffprobe 读取。 */
export async function checkAsset(
  workspaceDir: string,
  record: AssetRecord,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const file = path.join(workspaceDir, record.localPath);
  const info = await stat(file).catch(() => null);
  results.push({
    id: `asset:${record.id}:exists`,
    status: info && info.isFile() ? "pass" : "fail",
    evidence: info && info.isFile()
      ? `文件存在，${info.size} 字节`
      : `缺失 ${record.localPath}`,
  });
  if (info && info.isFile()) {
    const hash = await sha256File(file);
    results.push({
      id: `asset:${record.id}:sha256`,
      status: hash === record.sha256 ? "pass" : "fail",
      evidence: hash === record.sha256 ? `指纹一致 ${hash.slice(0, 12)}…` : `期望 ${record.sha256.slice(0, 12)}…，实际 ${hash.slice(0, 12)}…`,
    });
    try {
      const media = await probeMedia(file);
      results.push({
        id: `asset:${record.id}:ffprobe`,
        status: "pass",
        evidence: `${media.width}×${media.height} @${media.fps.toFixed(2)}fps ${Math.round(media.durationMs / 100) / 10}s`,
      });
    } catch (err) {
      results.push({
        id: `asset:${record.id}:ffprobe`,
        status: "fail",
        evidence: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
