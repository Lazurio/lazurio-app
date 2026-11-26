#!/usr/bin/env bash
# Builds Lazurio App's tailnet helper (helpers/tailnet) for Android, unchanged, with the build tags
# its own start requires, as a static Linux binary that Android's kernel runs, and puts it where
# Android unpacks native libraries. Copies the test tailnet's CA and entry that hostenv wrote.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
hostenv_out="${1:-$here/hostenv/out}"
tags="ts_omit_c2n,ts_omit_netlog,ts_omit_peerapiserver"   # scripts/lib/helper-build.ts
overlay="$(mktemp -d)/overlay.json"
printf '{"Replace":{"%s":"%s"}}' "$repo/helpers/tailnet/androidbin_proof.go" "$here/helper-overlay/androidbin_proof.go" > "$overlay"
build() {
  local goarch="$1" abi="$2"
  mkdir -p "$here/app/src/main/jniLibs/$abi"
  (cd "$repo/helpers/tailnet" && GOOS=linux GOARCH="$goarch" CGO_ENABLED=0 \
    go build -overlay "$overlay" -trimpath -tags "$tags" -ldflags "-s -w -X main.version=0.0.1-android-proof" \
    -o "$here/app/src/main/jniLibs/$abi/liblazurio_tailnet.so" .)
}
build amd64 x86_64
build arm64 arm64-v8a
mkdir -p "$here/app/src/main/res/raw" "$here/app/src/main/assets/tailnets"
cp "$hostenv_out/ca.pem" "$here/app/src/main/res/raw/proof_ca.pem"
cp "$hostenv_out/tailnet.json" "$here/app/src/main/assets/tailnets/proof.json"
ls -l "$here"/app/src/main/jniLibs/*/
