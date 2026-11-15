#!/usr/bin/env bash
# The update test from build N to N+1 on Linux (docs/adr/0005, point 9), with AppImages. It starts
# N, waits until N has downloaded N+1 from the loopback feed, sends SIGTERM to N's main process
# (which closes the windows as a person does, main.ts), and waits until the AppImage file is N+1.
# The marker in the data folder must survive. It stops only the processes it started, by PID.
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
  cat "$work/feed.log" || true
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

"$app" &
runtime=$!
echo "Started N, AppImage runtime PID $runtime"

# electron-updater writes update-info.json into its pending folder once the download passed its
# SHA-512 check, just before it reports update-downloaded.
downloaded() { compgen -G "$HOME/.cache/*-updater/pending/update-info.json" >/dev/null; }
wait_until "N has downloaded N+1" downloaded
echo "N downloaded N+1."
# The download's event reaches the updater's state right after the file is written.
sleep 5

# The app's main process: the descendant of the runtime that is no Chromium child (--type=).
main_process() {
  local queue=("$runtime") pid child
  while ((${#queue[@]})); do
    pid="${queue[0]}"
    queue=("${queue[@]:1}")
    for child in $(pgrep -P "$pid" || true); do
      if [[ "$(tr '\0' ' ' <"/proc/$child/cmdline")" == *"/lazurio-app"* ]] &&
        ! tr '\0' ' ' <"/proc/$child/cmdline" | grep -q -- '--type='; then
        echo "$child"
        return 0
      fi
      queue+=("$child")
    done
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

[[ -f "$data/update-trial-marker.txt" ]] || {
  echo "The data folder lost its marker in the update." >&2
  exit 1
}
echo "The data folder kept its marker."
