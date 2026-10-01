import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DOMParser, XMLSerializer, type Document, type Element } from "@xmldom/xmldom";
import type { NoteEvent, ScorePlan } from "../domain.ts";
import { runLmms, saveRunEvidence, type RunResult } from "../infra/process.ts";
import { sha256File, sha256Text } from "../workspace/store.ts";

export class LmmsError extends Error {}

/** LMMS：192 tick = 1 小节（4 拍 × 48 tick）。 */
export const TICKS_PER_BAR = 192;
const TICKS_PER_BEAT = 48;

export interface LmmsTemplate {
  dom: Document;
  creatorVersion: string;
  trackNames: string[];
}

export const EXPECTED_LMMS_SERIES = "1.2";

/**
 * 生成工程的主音量（%）。LMMS 各轨直接相加极易顶满 0 dBFS（实测 pad 三和弦即削波），
 * 固定 50% ≈ -6dB 余量，保证 N3「无明显破音」；行为变化时递增 ADAPTER_REV 以触发重生成。
 */
export const SCORE_MASTERVOL = 42;
export const SCORE_ADAPTER_REV = 5;

/** 读取并校验模板：版本、song 结构、head、轨道。校验不过给明确错误。 */
export function loadLmmsTemplate(templateXml: string, sourceName: string): LmmsTemplate {
  const doc = new DOMParser().parseFromString(templateXml, "application/xml");
  const parseError = doc.getElementsByTagName("parsererror");
  if (parseError.length > 0) {
    throw new LmmsError(`${sourceName} 不是合法 XML`);
  }
  const root = doc.documentElement;
  if (!root || root.tagName !== "lmms-project") {
    throw new LmmsError(`${sourceName} 的根元素不是 lmms-project`);
  }
  const version = root.getAttribute("version") ?? "";
  if (!version.startsWith("1.")) {
    throw new LmmsError(`${sourceName} 工程版本 ${version} 不受支持`);
  }
  const creatorVersion = root.getAttribute("creatorversion") ?? "";
  if (!creatorVersion.startsWith(EXPECTED_LMMS_SERIES)) {
    throw new LmmsError(
      `${sourceName} 由 LMMS ${creatorVersion} 生成，期望 ${EXPECTED_LMMS_SERIES} 系列`,
    );
  }
  if (root.getAttribute("type") !== "song") {
    throw new LmmsError(`${sourceName} 必须是 song 类型工程`);
  }
  const heads = root.getElementsByTagName("head");
  if (heads.length !== 1) {
    throw new LmmsError(`${sourceName} 缺少 head 节点`);
  }
  const containers = Array.from(root.getElementsByTagName("trackcontainer")).filter(
    (el) => el.getAttribute("type") === "song",
  );
  if (containers.length !== 1) {
    throw new LmmsError(`${sourceName} 缺少 song 类型的 trackcontainer`);
  }
  const trackNames = Array.from(containers[0]!.getElementsByTagName("track")).map((t) =>
    t.getAttribute("name") ?? "",
  );
  if (trackNames.length === 0) {
    throw new LmmsError(`${sourceName} 中没有任何轨道`);
  }
  return { dom: doc, creatorVersion, trackNames };
}

function findInstrumentTrack(doc: Document, name: string): Element {
  const container = Array.from(doc.getElementsByTagName("trackcontainer")).find(
    (el) => el.getAttribute("type") === "song",
  );
  if (!container) throw new LmmsError("工程缺少 song trackcontainer");
  for (const track of Array.from(container.getElementsByTagName("track"))) {
    if (track.getAttribute("name") === name) {
      if (track.getAttribute("type") !== "0") {
        throw new LmmsError(`轨道 ${name} 不是乐器轨`);
      }
      return track;
    }
  }
  throw new LmmsError(`模板中没有名为 ${name} 的乐器轨`);
}

function childElement(parent: Element, tag: string): Element {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 1 && (child as Element).tagName === tag) return child as Element;
  }
  throw new LmmsError(`轨道 ${parent.getAttribute("name")} 缺少 ${tag} 节点`);
}

function setAttributes(el: Element, attrs: Record<string, string | number>): void {
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
  }
}

/** 把一段音符拆到各小节的 pattern：跨小节的长音按小节切开。 */
function noteChunks(note: NoteEvent): { bar: number; posInBar: number; lenTicks: number }[] {
  const startTick = Math.round(note.startBeat * TICKS_PER_BEAT);
  const totalLen = Math.max(1, Math.round(note.durationBeats * TICKS_PER_BEAT));
  const chunks: { bar: number; posInBar: number; lenTicks: number }[] = [];
  let remaining = totalLen;
  let cursor = startTick;
  while (remaining > 0) {
    const bar = Math.floor(cursor / TICKS_PER_BAR);
    const posInBar = cursor - bar * TICKS_PER_BAR;
    const len = Math.min(remaining, TICKS_PER_BAR - posInBar);
    chunks.push({ bar, posInBar, lenTicks: len });
    cursor += len;
    remaining -= len;
  }
  return chunks;
}

function buildPatternElement(
  doc: Document,
  bar: number,
  notes: { key: number; posInBar: number; lenTicks: number; vol: number }[],
): Element {
  const pattern = doc.createElement("pattern");
  setAttributes(pattern, { pos: bar * TICKS_PER_BAR, len: TICKS_PER_BAR, steps: 16, type: 1, muted: 0, name: "" });
  for (const note of notes) {
    const noteEl = doc.createElement("note");
    setAttributes(noteEl, {
      key: note.key,
      pos: note.posInBar,
      len: note.lenTicks,
      vol: Math.min(127, Math.max(1, note.vol)),
      pan: 0,
    });
    pattern.appendChild(noteEl);
  }
  return pattern;
}

export interface WriteScoreResult {
  projectPath: string;
  planFingerprint: string;
  bars: number;
}

/**
 * 按 ScorePlan 生成新的 .mmp：克隆模板 DOM，只改 head 与各轨 pattern。
 * 输出路径不得等于模板；写入前不触碰模板文件。
 */
export async function writeScoreProject(
  plan: ScorePlan,
  templatePath: string,
  outputPath: string,
): Promise<WriteScoreResult> {
  if (path.resolve(outputPath) === path.resolve(templatePath)) {
    throw new LmmsError("输出路径不能与模板相同");
  }
  const templateXml = await readFile(templatePath, "utf8");
  const template = loadLmmsTemplate(templateXml, path.basename(templatePath));
  const doc = template.dom;

  const head = doc.getElementsByTagName("head")[0]!;
  setAttributes(head, {
    bpm: plan.bpm,
    timesig_numerator: 4,
    timesig_denominator: 4,
    mastervol: SCORE_MASTERVOL,
  });

  const bars = plan.sections.reduce((sum, s) => sum + s.bars, 0);
  // 各轨各小节的音符桶：trackId → bar → notes
  const buckets = new Map<string, Map<number, { key: number; posInBar: number; lenTicks: number; vol: number }[]>>();
  for (const track of plan.tracks) {
    if (!buckets.has(track.id)) buckets.set(track.id, new Map());
    for (const note of track.notes) {
      for (const chunk of noteChunks(note)) {
        const byBar = buckets.get(track.id)!;
        if (!byBar.has(chunk.bar)) byBar.set(chunk.bar, []);
        byBar.get(chunk.bar)!.push({
          key: note.pitchMidi,
          posInBar: chunk.posInBar,
          lenTicks: chunk.lenTicks,
          vol: note.velocity,
        });
      }
    }
  }

  for (const track of plan.tracks) {
    const trackEl = findInstrumentTrack(doc, track.instrumentTemplate);
    // 移除模板自带的全部 pattern，再写入计划内容
    for (const pattern of Array.from(trackEl.getElementsByTagName("pattern"))) {
      trackEl.removeChild(pattern);
    }
    const byBar = buckets.get(track.id)!;
    const sortedBars = [...byBar.keys()].sort((a, b) => a - b);
    if (sortedBars.length > 0 && sortedBars[sortedBars.length - 1]! >= bars) {
      throw new LmmsError(`轨道 ${track.id} 有音符超出 ${bars} 小节范围`);
    }
    for (const bar of sortedBars) {
      trackEl.appendChild(buildPatternElement(doc, bar, byBar.get(bar)!));
    }
  }

  const timeline = doc.getElementsByTagName("timeline")[0];
  if (timeline) {
    setAttributes(timeline, { lp0pos: 0, lp1pos: bars * TICKS_PER_BAR, lpstate: 0 });
  }

  const serialized = new XMLSerializer().serializeToString(doc);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized.endsWith("\n") ? serialized : serialized + "\n", "utf8");
  return {
    projectPath: outputPath,
    planFingerprint: scorePlanFingerprint(plan),
    bars,
  };
}

export function scorePlanFingerprint(plan: ScorePlan): string {
  // 归一化顺序无关的键，保证相同音乐内容得到相同指纹
  const normalized = {
    bpm: plan.bpm,
    beatsPerBar: plan.beatsPerBar,
    sections: plan.sections,
    tracks: plan.tracks.map((t) => ({
      id: t.id,
      instrumentTemplate: t.instrumentTemplate,
      notes: [...t.notes].sort(
        (a, b) => a.startBeat - b.startBeat || a.pitchMidi - b.pitchMidi || a.trackId.localeCompare(b.trackId),
      ),
    })).sort((a, b) => a.id.localeCompare(b.id)),
  };
  return sha256Text(JSON.stringify(normalized)).slice(0, 16);
}

export interface RenderWavResult {
  run: RunResult;
  outputWav: string;
  outputBytes: number;
  sha256: string;
}

/** 调用 LMMS render 导出 WAV；失败或输出为空时抛错。 */
export async function renderScoreWav(
  projectPath: string,
  outputWav: string,
  evidenceDir?: string,
  timeoutMs = 30 * 60_000,
): Promise<RenderWavResult> {
  // 不自动创建父目录：输出目录由工作区 init 预先建立，
  // 无效输出路径应当原样失败，便于故障演练（T13/T35）。
  // -l（Render as a loop）：LMMS 默认会在片尾多渲染一小节垫尾，-l 让导出止于内容结尾。
  const run = await runLmms(
    ["render", projectPath, "-f", "wav", "-o", outputWav, "-s", "44100", "-l"],
    { timeoutMs },
  );
  if (evidenceDir) {
    await saveRunEvidence(evidenceDir, `lmms-render-${path.basename(outputWav, ".wav")}`, run);
  }
  const info = await stat(outputWav).catch(() => null);
  if (run.exitCode !== 0 || !info || info.isFile() === false || info.size < 44) {
    throw new LmmsError(
      `LMMS 渲染失败（退出码 ${run.exitCode}${run.timedOut ? "，超时" : ""}，输出 ${info ? `${info.size}B` : "缺失"}）：${run.stderr.slice(-800)}`,
    );
  }
  return { run, outputWav, outputBytes: info.size, sha256: await sha256File(outputWav) };
}
