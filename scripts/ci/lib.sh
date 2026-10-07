# 阶段5 CI 演练共享函数。要求在 xvfb-run 提供的 DISPLAY 下执行；证据写入 $1 指定目录。
set -euo pipefail

OUT="${1:?用法: <scenario>.sh <证据目录>}"
mkdir -p "$OUT"

ELECTRON="./node_modules/.bin/electron"

# 截图并做黑屏哨兵检查：颜色数过低视为渲染失败
shot() {
  local name="$1" colors
  import -window root "$OUT/$name.png"
  colors=$(identify -format "%k" "$OUT/$name.png")
  echo "[drill] $1 colors=$colors"
  if [ "$colors" -le 20 ]; then
    echo "[drill] $1 疑似黑屏（colors=$colors）"; exit 1
  fi
}

# 进程必须存活满指定秒数，否则判失败（避免僵尸 kill -0 误报：先确认非僵尸态）
wait_alive() {
  local pid="$1" secs="$2" i=0 state
  while [ "$i" -lt "$secs" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[drill] 进程 $pid 已退出（等待 $i/$secs 秒时）"; return 1
    fi
    state=$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null || echo "X")
    if [ "$state" = "Z" ]; then
      echo "[drill] 进程 $pid 为僵尸态"; return 1
    fi
    sleep 1; i=$((i + 1))
  done
}

# 等待根窗口树里出现匹配标题的窗口，超时返回 1
wait_window() {
  local pattern="$1" timeout="${2:-120}" i=0
  while [ "$i" -lt "$timeout" ]; do
    if xwininfo -root -tree 2>/dev/null | grep -qi "$pattern"; then
      echo "[drill] 窗口出现：$pattern（等待 ${i}s）"; return 0
    fi
    sleep 2; i=$((i + 2))
  done
  echo "[drill] 等窗口超时：$pattern"; return 1
}

# Electron 统一启动参数：CI 无用户会话，沙箱关闭 + 强制 X11 + 软件渲染
launch_gui() {
  # 其余参数透传给 electron；日志重定向由调用方处理
  env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE \
    "$ELECTRON" --no-sandbox --ozone-platform=x11 --disable-gpu "$@"
}
