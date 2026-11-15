#!/usr/bin/env bash
# The update test from build N to N+1 on Linux (docs/adr/0005, point 9), with AppImages. It starts
# N, waits for N's log line that the update is ready, and sends SIGTERM to N's main process:
# Electron quits the app, which installs the update first (main.ts, before-quit). It then waits
# until the AppImage file is N+1 and N+1 has opened the key N sealed with the system's keystore
# (KeystoreCheck.ts); the marker in the data folder must survive. Run it inside a session with an
# unlocked Secret Service. It stops only the processes it started, by PID.
#
#   update-trial.sh <AppImage of N> <folder with latest-linux.yml and the AppImage of N+1>
set -euo pipefail
image_n="$1"
feed="$2"
port=47123
timeout_seconds=360
work="${RUNNER_TEMP:-$(mktemp -d)}/lazurio-app-trial"
mkdir -p "$work"
app="$work/Lazurio-App.AppImage"
cp "$image_n" "$app"
chmod +x "$app"
expected="$(sha256sum "$feed/Lazurio-App.AppImage" | cut -d' ' -f1)"

python3 -m http.server "$port" --bind 127.0.0.1 --directory "$feed" >"$work/feed.log" 2>&1 &
server=$!
Xvfb :97 -screen 0 1280x800x24 >/dev/null 2>&1 &
display=$!
cleanup() {
  kill "$server" "$display" 2>/dev/null || true
  cat "$work/feed.log" "$work/n.log" 2>/dev/null || true
}
trap cleanup EXIT
export DISPLAY=:97

wait_until() {
  local what="$1"
  shift
  local deadline=$((SECONDS + timeout_seconds))
  until "$@"; do
    if ((SECONDS > deadline)); then
      echo "Timed out waiting until $what." >&2
      exit 1
    fi
    sleep 2
  done
}

# The data folder is fixed in code (main.ts, DATA_FOLDER).
data="$HOME/.config/Lazurio App"
mkdir -p "$data"
echo kept >"$data/update-trial-marker.txt"

"$app" >"$work/n.log" 2>&1 &
runtime=$!
echo "Started N, AppImage runtime PID $runtime"

check_is() { grep -q "\"version\":\"$1\",\"result\":\"$2\"" "$data/keystore-check.json" 2>/dev/null; }
wait_until "N has sealed its check key" check_is 0.0.1 created
echo "N sealed its check key."

# Updates.ts logs this line once the update is downloaded, verified and ready to install.
ready() { grep -q 'update ready' "$work/n.log"; }
wait_until "N has the update ready" ready
echo "N has N+1 ready."

# The app's main process: the runtime itself or a descendant of it that runs the app and is no
# Chromium child (--type=). The AppImage runtime execs the app over FUSE and forks it when it runs
# extracted.
is_main() {
  local cmdline
  cmdline="$(tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null)" || return 1
  [[ "$cmdline" == *"/lazurio-app"* && "$cmdline" != *"--type="* ]]
}
main_process() {
  local queue=("$runtime") pid child
  while ((${#queue[@]})); do
    pid="${queue[0]}"
    queue=("${queue[@]:1}")
    if is_main "$pid"; then
      echo "$pid"
      return 0
    fi
    for child in $(pgrep -P "$pid" || true); do queue+=("$child"); done
  done
  return 1
}
main="$(main_process)"
echo "Closing N through SIGTERM to its main process, PID $main"
kill -TERM "$main"
exited() { ! kill -0 "$runtime" 2>/dev/null; }
wait_until "N has exited" exited

installed() { [[ "$(sha256sum "$app" | cut -d' ' -f1)" == "$expected" ]]; }
wait_until "N+1 is installed" installed
echo "The AppImage is N+1."
wait_until "N+1 has opened the key N sealed" check_is 0.0.2 opened
echo "N+1 opened the key N sealed."

[[ -f "$data/update-trial-marker.txt" ]] || {
  echo "The data folder lost its marker in the update." >&2
  exit 1
}
echo "The data folder kept its marker."
