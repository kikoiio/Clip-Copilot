#!/usr/bin/env python3
"""
spi-helper.py — Kdenlive AT-SPI 观测守护（阶段 5 软件感知；plan.md 探针契约）。

协议（与 src/sense/types.ts 的 SpiRequest/SpiEvent 对齐，NDJSON over stdio）：
  Node → Python：{"cmd":"poll"} 或 {"cmd":"watch","intervalMs":1000}
  Python → Node：{"type":"instances","apps":[{"pid":…,"title":…,"focused":…}]}
                 {"type":"error","reason":…}（随后退出）

只做原始观测；标题解析与工作区映射在 Node 侧（tests/sense-mapping.test.ts）。
调试信息一律走 stderr，stdout 必须保持严格 NDJSON。
"""

import json
import os
import sys
import time

try:
    gi_required_ok = True
    import gi  # noqa: N813

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi  # noqa: N813
except Exception as exc:  # pragma: no cover - 环境缺失路径
    sys.stdout.write(json.dumps({"type": "error", "reason": f"atspi-unavailable: {exc}"}) + "\n")
    sys.stdout.flush()
    sys.exit(0)

APP_NAME_MARK = "kdenlive"
WINDOW_TITLE_MARK = "Kdenlive"
OFFSCREEN_MARK = "Offscreen"


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def observe() -> list:
    """枚举桌面上全部 Kdenlive 实例的主窗口（过滤 Offscreen 占位帧）。"""
    apps = []
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        try:
            name = app.get_name() or ""
        except Exception:
            continue
        if APP_NAME_MARK not in name.lower():
            continue
        try:
            pid = app.get_process_id()
        except Exception:
            pid = 0
        for j in range(app.get_child_count()):
            try:
                frame = app.get_child_at_index(j)
                title = frame.get_name() or ""
            except Exception:
                continue
            if OFFSCREEN_MARK in title or WINDOW_TITLE_MARK not in title:
                continue
            try:
                focused = bool(frame.get_state_set().contains(Atspi.StateType.ACTIVE))
            except Exception:
                focused = None
            apps.append({"pid": int(pid or 0), "title": title, "focused": focused})
    return apps


def loop_once() -> None:
    try:
        emit({"type": "instances", "apps": observe()})
    except Exception as exc:
        emit({"type": "error", "reason": f"observe-failed: {exc}"})
        sys.exit(0)


def main() -> None:
    # In a bare shell/Xvfb there may be no session accessibility bus. Calling
    # Atspi.get_desktop without one can abort inside dbind instead of raising a
    # Python exception, so detect the missing prerequisite before entering GI.
    if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        emit({"type": "error", "reason": "atspi-unavailable: DBUS_SESSION_BUS_ADDRESS is not set"})
        return
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            emit({"type": "error", "reason": "bad-request: 非 NDJSON"})
            continue
        cmd = req.get("cmd")
        if cmd == "poll":
            loop_once()
        elif cmd == "watch":
            interval_ms = int(req.get("intervalMs", 1000))
            if interval_ms < 250:
                interval_ms = 250  # 资源边界（N4）：轮询下限 250ms
            while True:
                loop_once()
                time.sleep(interval_ms / 1000.0)
        else:
            emit({"type": "error", "reason": f"unknown-cmd: {cmd}"})


if __name__ == "__main__":
    main()
