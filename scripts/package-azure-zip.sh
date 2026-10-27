#!/usr/bin/env bash
# Package RealitySync for Azure single-service zip deploy (F1 app, startup
# `node server/dist/index.js`, serves client/dist when NODE_ENV=production).
#
# Azure zip deploys run NO install step, so server/node_modules MUST be in
# the zip. server/eval-results.json MUST be world-readable in the zip:
# the S7.1 deploy shipped it as -rw-rw---- (root-only), so the app's
# /api/metrics read failed silently and evalRun rendered null (W1).
# This script forces 644 on the staged copy and verifies it in the zip.
#
# Usage: scripts/package-azure-zip.sh [output.zip]
# Assumes client/dist and server/dist are already built. No secrets here.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-realitysync-azure.zip}"
STAGE=".deploy-staging"
rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE/server" "$STAGE/client" "$STAGE/fixtures"

cp -r server/dist server/node_modules server/package.json "$STAGE/server/"
cp server/eval-results.json "$STAGE/server/eval-results.json"
chmod 644 "$STAGE/server/eval-results.json"
cp -r client/dist "$STAGE/client/"
cp fixtures/seed.json "$STAGE/fixtures/"

cd "$STAGE"
zip -qr "../$OUT" server client fixtures
cd ..

python3 - "$OUT" <<'EOF'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
need = ["server/dist/index.js", "server/eval-results.json",
        "server/node_modules/express/package.json",
        "client/dist/index.html", "fixtures/seed.json"]
missing = [n for n in need if n not in names]
info = z.getinfo("server/eval-results.json")
mode = (info.external_attr >> 16) & 0o777
print(f"zip entries: {len(names)}; eval-results.json mode: {oct(mode)}")
assert not missing, f"missing from zip: {missing}"
assert mode & 0o004, "eval-results.json is not world-readable in the zip"
print("zip OK:", sys.argv[1])
EOF
rm -rf "$STAGE"
