#!/usr/bin/env bash
# Runs the iOS proof on a macOS runner: the test tailnet on the loopback, Lazurio App's tailnet
# helper linked into a Swift app as a C archive, the app on an iOS simulator, once with the
# password in the proxy's configuration and once answering WebKit's challenge. Needs no Apple
# account: the simulator runs an app signed ad hoc.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="$here/out"
build="$out/build"
mkdir -p "$out" "$build"

echo "::group::test tailnet"
(cd "$repo/proofs/android-tailnet-webview/hostenv" && go build -o "$build/hostenv" .)
"$build/hostenv" -bind 127.0.0.1 -no-auth -out "$out/tailnet" > "$out/hostenv.log" 2>&1 &
for _ in $(seq 1 90); do grep -aq 'ready:' "$out/hostenv.log" && break; sleep 1; done
grep -a 'ready:' "$out/hostenv.log"
echo "::endgroup::"

echo "::group::helper as a C archive for the simulator"
sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
flags="-isysroot $sdk -target arm64-apple-ios17.0-simulator"
overlay="$build/overlay.json"
printf '{"Replace":{"%s":"%s"}}' "$repo/helpers/tailnet/ios_export.go" "$here/helper-overlay/ios_export.go" > "$overlay"
(cd "$repo/helpers/tailnet" && GOOS=ios GOARCH=arm64 CGO_ENABLED=1 CC="$(xcrun --sdk iphonesimulator -f clang)" \
  CGO_CFLAGS="$flags" CGO_LDFLAGS="$flags" \
  go build -buildmode=c-archive -overlay "$overlay" -trimpath \
  -tags ts_omit_c2n,ts_omit_netlog,ts_omit_peerapiserver -o "$build/libtailnet.a" .)
ls -l "$build/libtailnet.a"
echo "::endgroup::"

echo "::group::Swift app"
app="$build/LazurioProof.app"
mkdir -p "$app"
cp "$here/App/Info.plist" "$app/Info.plist"
cp "$out/tailnet/tailnet.json" "$app/tailnet.json"
xcrun --sdk iphonesimulator swiftc -parse-as-library -target arm64-apple-ios17.0-simulator \
  -import-objc-header "$build/libtailnet.h" "$here/App/main.swift" \
  -L "$build" -ltailnet -lresolv -framework Security -framework CoreFoundation -framework Foundation \
  -framework SystemConfiguration -framework Network -framework WebKit -framework UIKit \
  -o "$app/LazurioProof"
codesign --force --sign - "$app"
echo "::endgroup::"

echo "::group::simulator"
udid="$(xcrun simctl list devices available -j | python3 -c '
import json, sys
devices = json.load(sys.stdin)["devices"]
for runtime, items in sorted(devices.items(), reverse=True):
    if "iOS" in runtime:
        for d in items:
            if d["name"].startswith("iPhone"):
                print(d["udid"]); sys.exit(0)
sys.exit(1)')"
xcrun simctl list devices | grep "$udid"
xcrun simctl boot "$udid" || true
xcrun simctl bootstatus "$udid" -b
xcrun simctl keychain "$udid" add-root-cert "$out/tailnet/ca.pem"
xcrun simctl install "$udid" "$app"
echo "::endgroup::"

status=0
for mode in credential challenge; do
  echo "::group::mode $mode"
  xcrun simctl terminate "$udid" io.lazurio.app.proof 2>/dev/null || true
  xcrun simctl launch "$udid" io.lazurio.app.proof "$mode"
  data="$(xcrun simctl get_app_container "$udid" io.lazurio.app.proof data)"
  for _ in $(seq 1 90); do grep -q '^DONE' "$data/Documents/result.txt" 2>/dev/null && break; sleep 1; done
  sleep 2
  xcrun simctl io "$udid" screenshot "$out/$mode.png" || true
  cp "$data/Documents/result.txt" "$out/result-$mode.txt" 2>/dev/null || echo "no result" > "$out/result-$mode.txt"
  sed -E 's/"password":"[^"]+"/"password":"<hidden>"/' "$out/result-$mode.txt"
  grep -q '^DONE PASS' "$out/result-$mode.txt" || status=1
  echo "::endgroup::"
done
grep -a 'Environment page served' "$out/hostenv.log" || true
for mode in credential challenge; do echo "$mode: $(grep '^DONE' "$out/result-$mode.txt" || echo 'no result')"; done
exit "$status"
