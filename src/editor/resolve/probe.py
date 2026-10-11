#!/usr/bin/env python3
"""Read-only Resolve probe used by the Node process bridge.

The script accepts one JSON request on stdin and emits one JSON response on
stdout. Resolve's scripting module is imported lazily so protocol tests run
without Resolve installed.
"""

from __future__ import annotations

import json
import os
import platform
import sys
import traceback
from typing import Any

PROTOCOL_VERSION = 1


def main() -> int:
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict) or request.get("protocolVersion") != PROTOCOL_VERSION:
            return emit_error("protocol", "unsupported protocol version", False)
        operation = request.get("operation")
        if operation not in ("health", "project_snapshot"):
            return emit_error("unsupported", f"unsupported probe operation: {operation}", False)

        resolve = connect_resolve()
        runtime = runtime_info(resolve)
        if operation == "health":
            return emit({"ok": True, "runtime": runtime})

        summary = project_summary(resolve)
        return emit({"ok": True, "runtime": runtime, "summary": summary})
    except ResolveOffline as error:
        return emit_error("offline", str(error), True)
    except ResolveUnsupported as error:
        return emit_error("unsupported", str(error), True)
    except Exception as error:  # Keep stdout machine-readable; diagnostics go to stderr.
        print(traceback.format_exc(), file=sys.stderr)
        return emit_error("protocol", str(error), False)


class ResolveOffline(Exception):
    pass


class ResolveUnsupported(Exception):
    pass


def connect_resolve() -> Any:
    module_path = os.environ.get("RESOLVE_SCRIPT_API")
    if module_path and module_path not in sys.path:
        sys.path.insert(0, module_path)
    try:
        import DaVinciResolveScript  # type: ignore
    except Exception as error:
        raise ResolveOffline("DaVinciResolveScript is unavailable") from error
    try:
        resolve = DaVinciResolveScript.scriptapp("Resolve")
    except Exception as error:
        raise ResolveOffline(f"Resolve script connection failed: {error}") from error
    if resolve is None:
        raise ResolveOffline("Resolve is not running")
    return resolve


def runtime_info(resolve: Any) -> dict[str, Any]:
    version = call_first(resolve, ("GetVersionString", "GetVersion"), default="unknown")
    if isinstance(version, (list, tuple)):
        version = ".".join(str(part) for part in version)
    version_text = str(version)
    build = os.environ.get("RESOLVE_BUILD", version_text)
    edition = edition_from(resolve)
    return {
        "version": version_text,
        "build": build,
        "edition": edition,
        "platform": "linux-x64" if platform.machine().lower() in ("x86_64", "amd64") else "linux-x64",
        "compatibility": "unknown",
        "checkedAt": os.environ.get("RESOLVE_CHECKED_AT", "") or iso_now(),
    }


def edition_from(resolve: Any) -> str:
    value = call_first(resolve, ("GetProductName",), default="")
    text = str(value).lower()
    if "studio" in text:
        return "studio"
    if text:
        return "free"
    return os.environ.get("RESOLVE_EDITION", "unknown")


def project_summary(resolve: Any) -> dict[str, Any]:
    manager = call_first(resolve, ("GetProjectManager",), default=None)
    project = call_first(manager, ("GetCurrentProject",), default=None)
    if project is None:
        raise ResolveUnsupported("no active Resolve project")
    timeline = call_first(project, ("GetCurrentTimeline",), default=None)
    if timeline is None:
        raise ResolveUnsupported("no active Resolve timeline")

    return {
        "project": {
            "id": call_first(project, ("GetUniqueId",), default=None),
            "name": call_first(project, ("GetName",), default=None),
            "database": {"id": None, "name": None},
        },
        "timeline": timeline_summary(timeline),
        "media": media_summary(project),
    }


def timeline_summary(timeline: Any) -> dict[str, Any]:
    settings = call_first(timeline, ("GetSetting",), default=None)
    frame_rate = parse_rate(
        call_first(timeline, ("GetSetting",), "timelineFrameRate", default="")
        if callable(getattr(timeline, "GetSetting", None))
        else ""
    )
    if frame_rate is None:
        frame_rate = {"numerator": 1, "denominator": 1}
    width = to_int(call_first(timeline, ("GetSetting",), "timelineResolutionWidth", default=None))
    height = to_int(call_first(timeline, ("GetSetting",), "timelineResolutionHeight", default=None))
    result: dict[str, Any] = {
        "id": call_first(timeline, ("GetUniqueId",), default=None),
        "name": call_first(timeline, ("GetName",), default=None),
        "frameRate": frame_rate,
        "resolution": {"width": width, "height": height},
        "videoTracks": tracks(timeline, "video"),
        "audioTracks": tracks(timeline, "audio"),
        "markers": markers(timeline),
        "subtitles": [],
    }
    if settings is not None and not isinstance(settings, (dict, str, int, float, bool)):
        result["futureProbeObject"] = str(settings)
    return result


def tracks(timeline: Any, kind: str) -> list[dict[str, Any]]:
    count = to_int(call_first(timeline, ("GetTrackCount",), kind, default=0)) or 0
    result: list[dict[str, Any]] = []
    for index in range(1, count + 1):
        track_items = call_first(timeline, ("GetItemListInTrack",), kind, index, default=[]) or []
        clips: list[dict[str, Any]] = []
        for position, item in enumerate(track_items):
            clips.append(clip_summary(item, position))
        result.append({"id": f"{kind}-track-{index}", "index": index, "name": f"{kind.title()} {index}", "clips": clips})
    return result


def clip_summary(item: Any, position: int) -> dict[str, Any]:
    media_item = call_first(item, ("GetMediaPoolItem",), default=None)
    return {
        "id": call_first(item, ("GetUniqueId",), default=f"clip-{position + 1}"),
        "mediaId": call_first(media_item, ("GetMediaId", "GetUniqueId"), default=None),
        "sourceInFrame": to_int(call_first(item, ("GetSourceStartFrame",), default=0)) or 0,
        "sourceOutFrame": to_int(call_first(item, ("GetSourceEndFrame",), default=0)) or 0,
        "timelineStartFrame": to_int(call_first(item, ("GetStart",), default=0)) or 0,
        "durationFrames": to_int(call_first(item, ("GetDuration",), default=0)) or 0,
    }


def markers(timeline: Any) -> list[dict[str, Any]]:
    raw = call_first(timeline, ("GetMarkers",), default={}) or {}
    if not isinstance(raw, dict):
        return []
    result = []
    for frame, marker in raw.items():
        marker = marker if isinstance(marker, dict) else {}
        result.append({
            "id": str(marker.get("customData") or f"marker-{frame}"),
            "frame": to_int(frame) or 0,
            "name": str(marker.get("name") or "Marker"),
            "note": marker.get("note"),
        })
    return result


def media_summary(project: Any) -> list[dict[str, Any]]:
    pool = call_first(project, ("GetMediaPool",), default=None)
    root = call_first(pool, ("GetRootFolder",), default=None)
    items = call_first(root, ("GetClipList",), default=[]) or []
    result = []
    for index, item in enumerate(items):
        properties = call_first(item, ("GetClipProperty",), default={}) or {}
        location = properties.get("File Path") if isinstance(properties, dict) else None
        result.append({
            "id": call_first(item, ("GetMediaId", "GetUniqueId"), default=f"media-{index + 1}"),
            "location": location,
            "durationFrames": None,
            "availability": "online" if location else "unknown",
        })
    return result


def call_first(target: Any, methods: tuple[str, ...], *args: Any, default: Any = None) -> Any:
    if target is None:
        return default
    for method in methods:
        function = getattr(target, method, None)
        if not callable(function):
            continue
        try:
            return function(*args)
        except Exception:
            continue
    return default


def parse_rate(value: Any) -> dict[str, int] | None:
    try:
        rate = float(value)
        if rate <= 0:
            return None
        denominator = 1000
        numerator = round(rate * denominator)
        return {"numerator": numerator, "denominator": denominator}
    except (TypeError, ValueError):
        return None


def to_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def iso_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def emit(value: dict[str, Any]) -> int:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    return 0


def emit_error(kind: str, reason: str, retryable: bool) -> int:
    return emit({"ok": False, "error": {"kind": kind, "reason": reason, "retryable": retryable}})


if __name__ == "__main__":
    raise SystemExit(main())
