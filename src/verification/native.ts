import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { CheckResult } from "../domain.ts";
import { mkdir, writeFile } from "node:fs/promises";

/** .kdenlive 中的外部媒体引用来自 <property name="resource">。 */
interface ResourceRef {
  /** 工程内书写的形式（绝对路径或相对路径）。 */
  raw: string;
  resolved: string;
}

async function collectKdenliveResources(projectFile: string): Promise<ResourceRef[]> {
  const text = await readFile(projectFile, "utf8");
  const refs: ResourceRef[] = [];
  const re = /<property name="resource">([^<]+)<\/property>/g;
  for (const match of text.matchAll(re)) {
    const raw = match[1]?.trim() ?? "";
    if (raw === "" || raw === "black" || raw.startsWith("colour:")) continue;
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(projectFile), raw);
    refs.push({ raw, resolved });
  }
  return refs;
}

/**
 * .mmp 的外部引用：audiofileprocessor 的 src 子节点与各乐器的
 * userwavefile* 属性；空值表示使用内置波形，不算外部引用。
 */
async function collectMmpResources(projectFile: string): Promise<ResourceRef[]> {
  const text = await readFile(projectFile, "utf8");
  const refs: ResourceRef[] = [];
  for (const match of text.matchAll(/<audiofileprocessor[^>]*\bsrc="([^"]+)"/g)) {
    const raw = match[1] ?? "";
    if (raw === "") continue;
    refs.push({ raw, resolved: path.isAbsolute(raw) ? raw : path.resolve(path.dirname(projectFile), raw) });
  }
  for (const match of text.matchAll(/\buserwavefile\d*="([^"]+)"/g)) {
    const raw = match[1] ?? "";
    if (raw === "") continue;
    refs.push({ raw, resolved: path.isAbsolute(raw) ? raw : path.resolve(path.dirname(projectFile), raw) });
  }
  return refs;
}

/** 解析工程并检查全部本地媒体引用是否存在。XML 解析失败也算 fail。 */
export async function checkProjectReferences(
  projectFile: string,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  let refs: ResourceRef[];
  try {
    refs = projectFile.endsWith(".kdenlive")
      ? await collectKdenliveResources(projectFile)
      : await collectMmpResources(projectFile);
  } catch (err) {
    return [{
      id: "project:parse",
      status: "fail",
      evidence: `无法解析工程：${err instanceof Error ? err.message : String(err)}`,
    }];
  }
  results.push({
    id: "project:parse",
    status: "pass",
    evidence: `解析成功，发现 ${refs.length} 个外部媒体引用`,
  });
  for (const ref of refs) {
    const exists = await stat(ref.resolved).then((s) => s.isFile()).catch(() => false);
    results.push({
      id: `project:resource:${ref.resolved}`,
      status: exists ? "pass" : "fail",
      evidence: exists ? `存在：${ref.raw}` : `缺失：${ref.raw}（解析为 ${ref.resolved}）`,
    });
  }
  return results;
}

export interface ObservationInput {
  action: string;
  observedResult: string;
  /** 观察到的工程副本路径；无则说明尚未实际操作。 */
  projectCopyPath?: string;
  observer: string;
  observedAt?: string;
}

/**
 * 把一次真实的软件内观察（打开、修改副本、保存、重开）记录为证据文件。
 * 没有观察到结果时返回 needs_observation——绝不能仅凭 XML 正确就给 pass。
 */
export async function recordObservation(
  evidenceDir: string,
  name: string,
  subject: string,
  observation?: ObservationInput,
): Promise<CheckResult> {
  if (!observation || observation.observedResult.trim() === "") {
    return {
      id: `observation:${name}`,
      status: "needs_observation",
      evidence: `${subject}：尚未有软件内的实际观察记录。需要在 LMMS/Kdenlive 中打开、修改副本并保存后，用观察结果更新本项。`,
    };
  }
  await mkdir(evidenceDir, { recursive: true });
  const file = path.join(evidenceDir, `observation-${name}.json`);
  const record = {
    subject,
    ...observation,
    observedAt: observation.observedAt ?? new Date().toISOString(),
  };
  await writeFile(file, JSON.stringify(record, null, 2), "utf8");
  return {
    id: `observation:${name}`,
    status: "pass",
    evidence: `${subject}：${observation.observedResult}（操作：${observation.action}；副本：${observation.projectCopyPath ?? "未记录"}；记录：${file}）`,
  };
}
