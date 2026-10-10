import { readFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mapResolveProjectSummary } from "../src/editor/resolve/mapping.ts";
import type { ResolveProjectSummaryResponse } from "../src/editor/resolve/mapping.ts";

const fixture = JSON.parse(
  readFileSync(path.join(process.cwd(), "tests/fixtures/resolve/project-summary.json"), "utf8"),
) as ResolveProjectSummaryResponse;

test("Resolve 摘要映射：身份、规格、帧位置和媒体引用进入通用快照", () => {
  const snapshot = mapResolveProjectSummary(fixture, { capturedAt: "2026-10-11T00:00:00.000Z" });

  assert.deepEqual(snapshot.identity, {
    projectId: "fixture-project-001",
    databaseId: "fixture-database-001",
    projectName: "Synthetic Resolve Project",
    timelineId: "fixture-timeline-001",
    timelineName: "Synthetic Main Timeline",
  });
  assert.deepEqual(snapshot.timeBase, { numerator: 24000, denominator: 1001 });
  assert.equal(snapshot.width, 1920);
  assert.equal(snapshot.height, 1080);
  assert.deepEqual(snapshot.tracks.map(({ id, index, kind, name }) => ({ id, index, kind, name })), [
    { id: "fixture-video-track-1", index: 1, kind: "video", name: "Video 1" },
    { id: "fixture-audio-track-1", index: 1, kind: "audio", name: "Audio 1" },
  ]);
  assert.deepEqual(snapshot.clips, [
    {
      id: "fixture-video-clip-1",
      trackId: "fixture-video-track-1",
      mediaId: "fixture-media-video-1",
      sourceInFrame: 24,
      sourceOutFrame: 143,
      timelineStartFrame: 0,
      durationFrames: 120,
    },
    {
      id: "fixture-audio-clip-1",
      trackId: "fixture-audio-track-1",
      mediaId: "fixture-media-audio-1",
      sourceInFrame: 0,
      sourceOutFrame: 239,
      timelineStartFrame: 0,
      durationFrames: 240,
    },
  ]);
  assert.equal(snapshot.markers[0]?.timelineFrame, 120);
  assert.deepEqual(snapshot.subtitles[0], {
    id: "fixture-subtitle-1",
    startFrame: 24,
    endFrame: 72,
    text: "Synthetic subtitle entry",
    trackId: "fixture-subtitle-track-1",
  });
  assert.equal(snapshot.media[0]?.location, "fixture://media/video-001");
});

test("Resolve 摘要映射：未知字段进入 mappingNotes，缺失字段有明确说明", () => {
  const withMissing = structuredClone(fixture) as ResolveProjectSummaryResponse;
  delete withMissing.timeline!.markers;
  const snapshot = mapResolveProjectSummary(withMissing, { capturedAt: "2026-10-11T00:00:00.000Z" });

  assert.ok(snapshot.mappingNotes.some((note) => note.sourceField === "futureProtocolField"));
  assert.ok(snapshot.mappingNotes.some((note) => note.sourceField === "timeline.markers"));
  assert.deepEqual(snapshot.markers, []);
});

test("Resolve 摘要映射：相同语义输入的指纹不受对象键顺序和采集时间影响", () => {
  const first = mapResolveProjectSummary(fixture, { capturedAt: "2026-10-11T00:00:00.000Z" });
  const reordered = JSON.parse(JSON.stringify(fixture, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).reverse());
    }
    return value;
  })) as ResolveProjectSummaryResponse;
  const second = mapResolveProjectSummary(reordered, { capturedAt: "2026-10-12T00:00:00.000Z" });

  assert.equal(first.fingerprint, second.fingerprint);
  assert.notEqual(first.capturedAt, second.capturedAt);
});
