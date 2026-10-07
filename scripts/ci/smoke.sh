#!/usr/bin/env bash
# 场景1 GUI 冒烟（GUI_SENSE=off）：窗口启动、总览渲染、降级标注。
source "$(dirname "$0")/lib.sh"

export GUI_SENSE=off
launch_gui . >"$OUT/electron-smoke.log" 2>&1 &
EP=$!
wait_alive "$EP" 15
shot smoke-dashboard
kill "$EP" 2>/dev/null || true
echo "[drill] smoke 完成"
