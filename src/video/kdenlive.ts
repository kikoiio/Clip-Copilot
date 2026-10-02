import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DOMParser, XMLSerializer, type Document, type Element } from "@xmldom/xmldom";
import {
  AV_TOLERANCE_MS,
  type AssetRecord,
  type EditPlan,
  type Goal,
  validateClipLayout,
} from "../domain.ts";
import { runKdenlive, saveRunEvidence, type RunResult } from "../infra/process.ts";
import { sha256File, sha256Text } from "../workspace/store.ts";

export class KdenliveError extends Error {}

/** 适配器版本：v2 起资源引用使用相对工程文件的路径（工作区可整体移动）。 */
export const KDENLIVE_ADAPTER_REV = 2;

export interface KdenliveTemplate {
  dom: Document;
  /** 从模板 profile 节点读出的实际规格，用于与工作区目标交叉核对。 */
  profile: { width: number; height: number; fps: number };
}

function firstElement(doc: Document, tag: string, attr?: { name: string; value: string }): Element | undefined {
  for (const el of Array.from(doc.getElementsByTagName(tag))) {
    if (!attr || el.getAttribute(attr.name) === attr.value) return el;
  }
  return undefined;
}

function childElement(parent: Element, tag: string): Element {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 1 && (child as Element).tagName === tag) return child as Element;
  }
  throw new KdenliveError(`缺少 ${tag} 节点`);
}

function setAttributes(el: Element, attrs: Record<string, string | number>): void {
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
  }
}

function addProperty(doc: Document, parent: Element, name: string, value: string): void {
  const prop = doc.createElement("property");
  prop.setAttribute("name", name);
  prop.appendChild(doc.createTextNode(value));
  parent.appendChild(prop);
}

/** 读取并校验 .kdenlive 模板：MLT 根节点、profile 规格、两条时间线轨与 tractor。 */
export function loadKdenliveTemplate(xml: string, sourceName: string): KdenliveTemplate {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const parseError = doc.getElementsByTagName("parsererror");
  if (parseError.length > 0) {
    throw new KdenliveError(`${sourceName} 不是合法 XML`);
  }
  const root = doc.documentElement;
  if (!root || root.tagName !== "mlt") {
    throw new KdenliveError(`${sourceName} 的根元素不是 mlt`);
  }
  const profile = firstElement(doc, "profile");
  if (!profile) throw new KdenliveError(`${sourceName} 缺少 profile`);
  const width = Number(profile.getAttribute("width"));
  const height = Number(profile.getAttribute("height"));
  const fps = Number(profile.getAttribute("frame_rate_num"));
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(fps) || fps <= 0) {
    throw new KdenliveError(`${sourceName} 的 profile 规格不完整`);
  }
  for (const id of ["main_bin", "timeline_track0", "timeline_track1"]) {
    if (!firstElement(doc, "playlist", { name: "id", value: id })) {
      throw new KdenliveError(`${sourceName} 缺少 playlist ${id}`);
    }
  }
  if (!firstElement(doc, "tractor", { name: "id", value: "tractor0" })) {
    throw new KdenliveError(`${sourceName} 缺少 tractor0`);
  }
  const transitions = doc.getElementsByTagName("transition");
  if (transitions.length < 2) {
    throw new KdenliveError(`${sourceName} 缺少视频合成或音频混合 transition`);
  }
  return { dom: doc, profile: { width, height, fps } };
}

export function editPlanFingerprint(plan: EditPlan): string {
  return sha256Text(JSON.stringify(plan)).slice(0, 16);
}

function framesFromMs(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}

interface ClipProducerInfo {
  producerId: string;
  entryIn: number;
  entryOut: number;
  asset: AssetRecord;
}

function buildAssetProducer(
  doc: Document,
  clipIndex: number,
  projectDir: string,
  resourceAbs: string,
  asset: AssetRecord,
  totalAssetFrames: number,
): Element {
  const producer = doc.createElement("producer");
  setAttributes(producer, { id: `producer_clip${clipIndex}`, in: 0, out: totalAssetFrames - 1 });
  addProperty(doc, producer, "length", String(totalAssetFrames));
  addProperty(doc, producer, "eof", "pause");
  // 相对工程文件书写（MLT/Kdenlive 按工程位置解析），保证工作区整体可移动。
  const resource = path.relative(projectDir, resourceAbs);
  addProperty(doc, producer, "resource", resource);
  addProperty(doc, producer, "mlt_service", "avformat");
  addProperty(doc, producer, "seekable", "1");
  addProperty(doc, producer, "mute_on_pause", "0");
  addProperty(doc, producer, "kdenlive:clipname", path.basename(asset.localPath));
  addProperty(doc, producer, "kdenlive:id", String(clipIndex + 1));
  addProperty(doc, producer, "kdenlive:folderid", "-1");
  addProperty(doc, producer, "kdenlive:duration", String(totalAssetFrames));
  addProperty(doc, producer, "meta.media.width", String(asset.media.width));
  addProperty(doc, producer, "meta.media.height", String(asset.media.height));
  return producer;
}

function addFadeFilter(
  doc: Document,
  producer: Element,
  kind: "in" | "out",
  fadeFrames: number,
  producerOut: number,
): void {
  if (fadeFrames <= 0) return;
  const filter = doc.createElement("filter");
  const start = kind === "in" ? 0 : Math.max(0, producerOut + 1 - fadeFrames);
  const end = kind === "in" ? fadeFrames : producerOut + 1;
  setAttributes(filter, { id: `filter_fade_${kind}_${producer.getAttribute("id")}`, in: start, out: end });
  addProperty(doc, filter, "kdenlive_id", kind === "in" ? "fade_from_black" : "fade_to_black");
  addProperty(doc, filter, "mlt_service", "brightness");
  addProperty(doc, filter, "alpha", kind === "in" ? `0=0;${fadeFrames}=1` : `0=1;${fadeFrames}=0`);
  addProperty(doc, filter, "background", "colour:black");
  producer.appendChild(filter);
}

export interface WriteEditResult {
  projectPath: string;
  planFingerprint: string;
  totalFrames: number;
}

/**
 * 按 EditPlan 生成新的 .kdenlive：克隆模板 DOM，替换时间线条目并写入素材 producer。
 * 计划规格必须等于工作区目标规格，模板实际规格必须经过目标规格验证（交叉核对），
 * 不一致在生成工程之前报错；模板中的一秒测试引用会被移除；素材文件缺失时拒绝生成。
 */
export async function writeEditProject(
  plan: EditPlan,
  workspaceDir: string,
  assets: AssetRecord[],
  soundtrackPath: string,
  soundtrackDurationMs: number,
  templatePath: string,
  outputPath: string,
  goal: Goal,
): Promise<WriteEditResult> {
  if (path.resolve(outputPath) === path.resolve(templatePath)) {
    throw new KdenliveError("输出路径不能与模板相同");
  }
  const spec = goal.outputSpec;
  if (
    plan.profile.width !== spec.width ||
    plan.profile.height !== spec.height ||
    plan.profile.fps !== spec.fps
  ) {
    throw new KdenliveError(
      `剪辑计划规格 ${plan.profile.width}×${plan.profile.height}@${plan.profile.fps} 与工作区目标规格 ${spec.width}×${spec.height}@${spec.fps} 不一致`,
    );
  }
  const layout = validateClipLayout(plan.clips, goal.minFrames, goal.maxFrames);
  if (!layout.ok) throw new KdenliveError(layout.reason);
  const fps = spec.fps;
  const totalFrames = layout.totalFrames;
  const targetDurationMs = Math.round((totalFrames / fps) * 1000);
  const drift = Math.abs(soundtrackDurationMs - targetDurationMs);
  if (drift > AV_TOLERANCE_MS) {
    throw new KdenliveError(
      `配乐时长 ${soundtrackDurationMs}ms 与时间线 ${targetDurationMs}ms 相差 ${drift}ms，超过 ${AV_TOLERANCE_MS}ms 容差`,
    );
  }
  const wavInfo = await stat(soundtrackPath).catch(() => null);
  if (!wavInfo || !wavInfo.isFile()) {
    throw new KdenliveError(`配乐文件缺失：${soundtrackPath}`);
  }
  const byId = new Map(assets.map((a) => [a.id, a]));
  for (const clip of plan.clips) {
    const asset = byId.get(clip.assetId);
    if (!asset) throw new KdenliveError(`片段引用了不存在的素材 ${clip.assetId}`);
    const file = path.resolve(workspaceDir, asset.localPath);
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) {
      throw new KdenliveError(`素材文件缺失：${asset.localPath}`);
    }
  }

  const templateXml = await readFile(templatePath, "utf8");
  const template = loadKdenliveTemplate(templateXml, path.basename(templatePath));
  if (
    template.profile.width !== spec.width ||
    template.profile.height !== spec.height ||
    template.profile.fps !== spec.fps
  ) {
    throw new KdenliveError(
      `模板 ${path.basename(templatePath)} 的规格 ${template.profile.width}×${template.profile.height}@${template.profile.fps} 与目标规格 ${spec.width}×${spec.height}@${spec.fps} 不一致：模板未验证该规格，拒绝生成工程`,
    );
  }
  const { dom: doc } = template;

  const root = doc.documentElement;
  if (!root) throw new KdenliveError(`${templatePath} 缺少文档根节点`);
  // 1. 移除模板占位 producer 与时间线条目
  const placeholders: Element[] = [];
  for (const producer of Array.from(doc.getElementsByTagName("producer"))) {
    const id = producer.getAttribute("id") ?? "";
    if (id.startsWith("template_clip")) placeholders.push(producer);
  }
  for (const el of placeholders) root.removeChild(el);
  for (const playlistId of ["timeline_track0", "timeline_track1"]) {
    const playlist = firstElement(doc, "playlist", { name: "id", value: playlistId })!;
    for (const entry of Array.from(playlist.getElementsByTagName("entry"))) {
      playlist.removeChild(entry);
    }
  }
  const mainBin = firstElement(doc, "playlist", { name: "id", value: "main_bin" })!;
  for (const entry of Array.from(mainBin.getElementsByTagName("entry"))) {
    mainBin.removeChild(entry);
  }

  // 2. 每个片段一个 producer 实例（同一素材可用多次，滤镜互不影响）
  const projectDir = path.dirname(path.resolve(outputPath));
  const clipInfos: ClipProducerInfo[] = [];
  plan.clips.forEach((clip, index) => {
    const asset = byId.get(clip.assetId)!;
    const assetFrames = Math.max(1, framesFromMs(asset.media.durationMs, fps));
    const resourceAbs = path.resolve(workspaceDir, asset.localPath);
    const producer = buildAssetProducer(doc, index, projectDir, resourceAbs, asset, assetFrames);
    if (index === 0) addFadeFilter(doc, producer, "in", plan.fadeInFrames, assetFrames - 1);
    if (index === plan.clips.length - 1) {
      addFadeFilter(doc, producer, "out", plan.fadeOutFrames, assetFrames - 1);
    }
    root.insertBefore(producer, mainBin);
    const entryIn = framesFromMs(clip.sourceInMs, fps);
    const entryOut = entryIn + clip.durationFrames - 1;
    if (entryOut > assetFrames - 1) {
      throw new KdenliveError(`片段 ${clip.assetId} 的出点超出素材长度`);
    }
    clipInfos.push({ producerId: `producer_clip${index}`, entryIn, entryOut, asset });
    const binEntry = doc.createElement("entry");
    binEntry.setAttribute("producer", `producer_clip${index}`);
    mainBin.appendChild(binEntry);
  });

  // 3. 视频轨条目
  const v1 = firstElement(doc, "playlist", { name: "id", value: "timeline_track0" })!;
  for (const info of clipInfos) {
    const entry = doc.createElement("entry");
    entry.setAttribute("producer", info.producerId);
    entry.setAttribute("in", String(info.entryIn));
    entry.setAttribute("out", String(info.entryOut));
    v1.appendChild(entry);
  }

  // 4. 配乐轨：整条 WAV 铺满时间线
  const wavFrames = framesFromMs(soundtrackDurationMs, fps);
  const audioProducer = doc.createElement("producer");
  setAttributes(audioProducer, { id: "producer_soundtrack", in: 0, out: Math.max(0, wavFrames - 1) });
  addProperty(doc, audioProducer, "length", String(wavFrames));
  addProperty(doc, audioProducer, "eof", "pause");
  addProperty(doc, audioProducer, "resource", path.relative(projectDir, path.resolve(soundtrackPath)));
  addProperty(doc, audioProducer, "mlt_service", "avformat");
  addProperty(doc, audioProducer, "seekable", "1");
  addProperty(doc, audioProducer, "kdenlive:clipname", path.basename(soundtrackPath));
  addProperty(doc, audioProducer, "kdenlive:id", String(plan.clips.length + 1));
  addProperty(doc, audioProducer, "kdenlive:folderid", "-1");
  root.insertBefore(audioProducer, mainBin);
  const binEntry = doc.createElement("entry");
  binEntry.setAttribute("producer", "producer_soundtrack");
  mainBin.appendChild(binEntry);
  const a1 = firstElement(doc, "playlist", { name: "id", value: "timeline_track1" })!;
  const audioEntry = doc.createElement("entry");
  audioEntry.setAttribute("producer", "producer_soundtrack");
  audioEntry.setAttribute("in", "0");
  audioEntry.setAttribute("out", String(totalFrames - 1));
  a1.appendChild(audioEntry);

  // 5. 背景与 tractor 覆盖全片
  const blackTrack = firstElement(doc, "producer", { name: "id", value: "black_track" });
  if (blackTrack) {
    setAttributes(blackTrack, { in: 0, out: totalFrames - 1 });
    for (const prop of Array.from(blackTrack.getElementsByTagName("property"))) {
      if (prop.getAttribute("name") === "length") {
        while (prop.firstChild) prop.removeChild(prop.firstChild);
        prop.appendChild(doc.createTextNode(String(totalFrames)));
      }
    }
  }
  const background = firstElement(doc, "playlist", { name: "id", value: "background" });
  if (background) {
    for (const entry of Array.from(background.getElementsByTagName("entry"))) {
      entry.setAttribute("out", String(totalFrames - 1));
    }
  }
  const tractor = firstElement(doc, "tractor", { name: "id", value: "tractor0" })!;
  setAttributes(tractor, { in: 0, out: totalFrames - 1 });

  const serialized = new XMLSerializer().serializeToString(doc);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized.endsWith("\n") ? serialized : serialized + "\n", "utf8");
  return { projectPath: outputPath, planFingerprint: editPlanFingerprint(plan), totalFrames };
}

export interface RenderMp4Result {
  run: RunResult;
  outputMp4: string;
  outputBytes: number;
  sha256: string;
  seconds: number;
}

/** 调用 Kdenlive --render 导出 MP4（默认 MP4-H264/AAC 预设）。 */
export async function renderVideoMp4(
  projectPath: string,
  outputMp4: string,
  evidenceDir?: string,
  preset?: string,
  timeoutMs = 30 * 60_000,
): Promise<RenderMp4Result> {
  // 不自动创建父目录：无效输出路径应当原样失败（T17/T35）。
  const args = [projectPath, outputMp4, "--render"];
  if (preset) args.push("--render-preset", preset);
  const started = Date.now();
  const run = await runKdenlive(args, { timeoutMs });
  if (evidenceDir) {
    await saveRunEvidence(evidenceDir, `kdenlive-render-${path.basename(outputMp4, ".mp4")}`, run);
  }
  const info = await stat(outputMp4).catch(() => null);
  if (run.exitCode !== 0 || !info || !info.isFile() || info.size === 0) {
    throw new KdenliveError(
      `Kdenlive 导出失败（退出码 ${run.exitCode}${run.timedOut ? "，超时" : ""}，输出 ${info ? `${info.size}B` : "缺失"}）：${run.stderr.slice(-800) || run.stdout.slice(-800)}`,
    );
  }
  return {
    run,
    outputMp4,
    outputBytes: info.size,
    sha256: await sha256File(outputMp4),
    seconds: (Date.now() - started) / 1000,
  };
}
