#!/usr/bin/env bash
# Checks that the Mac trial build is validly signed and actually starts (docs/adr/0005, point 7):
# packaging alone does not prove that macOS runs it. It starts the app's executable, waits for the
# app's own record of its keystore check (KeystoreCheck.ts), and stops the app by its PID.
#
#   launch-check-macos.sh <path to the app bundle>
set -euo pipefail
app="$1"
codesign --verify --deep --strict --verbose=2 "$app"
codesign --verify --strict --verbose=2 "$app/Contents/Frameworks/Electron Framework.framework"

log="$(mktemp)"
check="$HOME/Library/Application Support/Lazurio App/keystore-check.json"
rm -f "$check"
executable="$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$app/Contents/Info.plist")"
"$app/Contents/MacOS/$executable" >"$log" 2>&1 &
pid=$!
deadline=$((SECONDS + 120))
until [[ -f "$check" ]]; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "The app exited before it started." >&2
    cat "$log"
    exit 1
  fi
  if ((SECONDS > deadline)); then
    echo "Timed out waiting for the app to start." >&2
    cat "$log"
    kill "$pid"
    exit 1
  fi
  sleep 1
done
echo "The app started: $(cat "$check")"
kill "$pid"
wait "$pid" 2>/dev/null || true
