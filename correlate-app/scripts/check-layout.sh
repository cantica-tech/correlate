#!/bin/sh
# Checks br-BUILD-000001 (two-part repository): product code lives only in
# app/ and server/, never at the repository root or in another top-level
# folder. Exits 1 and lists the offending files otherwise.
#
# Usage: scripts/check-layout.sh [repository root]   (default: this script's parent)

set -eu
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"

# Source files outside app/ and server/; dependency, build and tool folders are skipped.
offenders=$(cd "$ROOT" && find . \
  \( -path ./app -o -path ./server -o -name node_modules -o -name .venv -o -name .git \) -prune -o \
  -type f \( -name '*.py' -o -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.cjs' -o -name '*.mjs' \) \
  -not -path './scripts/*' -print)

missing=""
for dir in app server server/plugins; do
  [ -d "$ROOT/$dir" ] || missing="$missing $dir"
done

if [ -n "$offenders" ] || [ -n "$missing" ]; then
  [ -n "$missing" ] && echo "br-BUILD-000001: missing folder(s):$missing"
  [ -n "$offenders" ] && printf 'br-BUILD-000001: product code outside app/ and server/:\n%s\n' "$offenders"
  exit 1
fi
echo "br-BUILD-000001: layout ok (app/, server/, server/plugins/)"
