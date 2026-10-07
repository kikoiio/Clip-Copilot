#!/usr/bin/env bash
# C9 降级路径 + 场景3 逐视图：python3 缺失模拟 与 GUI_SENSE=off 的动作页。
source "$(dirname "$0")/lib.sh"

mkdir -p /tmp/fakebin
printf '#!/bin/sh\nexit 1\n' >/tmp/fakebin/python3
chmod +x /tmp/fakebin/python3

# ① 助手异常（python3 退出 1）→ 感知降级标注，其余功能照常
PATH=/tmp/fakebin:$PATH launch_gui . >"$OUT/electron-c9-stub.log" 2>&1 &
EP=$!
wait_alive "$EP" 15
shot c9-stub-python3-dashboard
kill "$EP" 2>/dev/null || true
sleep 2

# ② GUI_SENSE=off 的动作页（场景3 逐视图降级标注）
export GUI_SENSE=off GUI_TAB=actions
launch_gui . >"$OUT/electron-c9-off-actions.log" 2>&1 &
EP=$!
wait_alive "$EP" 15
shot scenario3-degraded-actions
kill "$EP" 2>/dev/null || true
echo "[drill] degraded 完成"
