#!/usr/bin/env bash
# C1 软件活动感知：Kdenlive 打开工作区工程 → 感知出现运行/工程；退出 → 恢复未运行。
# 需在 dbus-run-session（a11y 总线）+ xvfb-run 下执行；SENSE_WS 指向含 projects/final.kdenlive 的工作区。
source "$(dirname "$0")/lib.sh"

WS="${SENSE_WS:?需要 SENSE_WS 工作区路径}"
PROJECT="$WS/projects/final.kdenlive"
[ -f "$PROJECT" ] || { echo "[drill] 缺少工程 $PROJECT"; exit 1; }
[ -f "$KDENLIVE_APPIMAGE" ] || { echo "[drill] 缺少 KDENLIVE_APPIMAGE"; exit 1; }

# Qt 应用强制开启无障碍桥，AT-SPI 才能读到窗口标题；GUI_SENSE_DEBUG 留感知链路日志
export QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 GUI_SENSE_DEBUG=1 APPIMAGE_EXTRACT_AND_RUN=1

"$KDENLIVE_APPIMAGE" "$PROJECT" >"$OUT/kdenlive.log" 2>&1 &
KD=$!
wait_alive "$KD" 10 || true
wait_window "kdenlive" 150 || { kill "$KD" 2>/dev/null || true; exit 1; }
sleep 8   # 工程加载与窗口标题稳定

launch_gui . >"$OUT/electron-sense.log" 2>&1 &
EP=$!
wait_alive "$EP" 15
sleep 3   # 等至少一个感知轮询周期
shot c1-kdenlive-running

kill "$KD" 2>/dev/null || true
for _ in $(seq 1 30); do kill -0 "$KD" 2>/dev/null || break; sleep 1; done
sleep 5   # 等感知差分把退出反映到看板
shot c1-kdenlive-exited

kill "$EP" 2>/dev/null || true
grep -a "spi-helper\|感知" "$OUT/electron-sense.log" 2>/dev/null | tail -20 >"$OUT/spi-helper-tail.txt" || true
echo "[drill] sense 完成"
