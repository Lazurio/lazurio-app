#!/usr/bin/env bash
# Checks how a Mac build is signed for hardened runtime (docs/signing.md): every Mach-O in the
# bundle is signed with the runtime flag, the app carries only its own entitlements, and each
# helper in Resources/helpers carries the inherited ones, Apple Events included.
#
#   check-signature-macos.sh <path to Lazurio App.app>
set -euo pipefail
app="$1"
codesign --verify --deep --strict --verbose=2 "$app"

plist="$(mktemp)"
# The value of one entitlement of a signed file: true, false, or false when it has none.
entitlement() {
  codesign -d --entitlements - --xml "$1" >"$plist" 2>/dev/null || : >"$plist"
  /usr/libexec/PlistBuddy -c "Print :$2" "$plist" 2>/dev/null || echo false
}
has_runtime() { codesign -dv "$1" 2>&1 | grep -q "flags=.*runtime"; }

failed=0
check() {
  local path="$1" key="$2" wanted="$3"
  if ! has_runtime "$path"; then
    echo "no hardened runtime: $path" >&2
    failed=1
  fi
  local got
  got="$(entitlement "$path" "$key")"
  if [[ "$got" != "$wanted" ]]; then
    echo "$key is $got, not $wanted: $path" >&2
    failed=1
  fi
}

check "$app" com.apple.security.cs.allow-jit true
check "$app" com.apple.security.automation.apple-events false
for helper in "$app"/Contents/Resources/helpers/*; do
  check "$helper" com.apple.security.automation.apple-events true
  echo "signed: $(basename "$helper")"
done
exit "$failed"
