#!/usr/bin/env bash
# dsh-plugin release script: freezes the release recipe into mechanical steps plus hard
# checks — the script aborts the moment any invariant fails.
#
# Artifact shape: a single-file esbuild bundle that inlines **only the packages not
# published to npm** (@openagentnetwork/*: protocol/client-js/connector-core — a leftover
# bare import of these would break every install); real published npm packages
# (socket.io-client, schemastery) stay external and become real dependencies —
# `dsh plugin add` forwards to pnpm, so normal dependency resolution works and
# self-containment is unnecessary.
#
# Why not inline everything (learned from a real-world load failure in an early release):
# full inlining drags socket.io-client's CJS dependency chain (engine.io-client →
# xmlhttprequest-ssl, which calls require('fs') at module top level) into the ESM output,
# and the __require shim esbuild generates then throws "Dynamic require of fs is not
# supported" at runtime — the plugin fails right at load. schemastery has a second reason to
# stay external: it must share a single instance with the host, so Standard Schema
# validation never runs into two copies.
#
# Host APIs carry zero runtime dependencies (type-only, erased at compile time).
#
# Usage:
#   bash scripts/release.sh pack      # produce an installable .tgz (dsh plugin add ./x.tgz)
#   bash scripts/release.sh publish   # same build + checks, then publish to npm (the official channel)
#   Single source of truth for the version: package.json (bump it manually first; there is no second manifest).

set -euo pipefail

MODE="${1:?Usage: bash scripts/release.sh pack|publish}"
if [[ "$MODE" != "pack" && "$MODE" != "publish" ]]; then
  echo "❌ Unknown mode \"$MODE\" (expected: pack or publish)" >&2
  exit 1
fi
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PLUGIN_DIR"

PKG_VERSION="$(node -p "require('./package.json').version")"
PKG_NAME="$(node -p "require('./package.json').name")"

# ---------- publish prechecks: npm login + version not already taken (fail fast — don't discover this after the build) ----------
if [[ "$MODE" == "publish" ]]; then
  npm whoami >/dev/null 2>&1 || { echo "❌ Not logged in to npm (run npm login first)" >&2; exit 1; }
  if [[ -n "$(npm view "${PKG_NAME}@${PKG_VERSION}" version 2>/dev/null)" ]]; then
    echo "❌ ${PKG_NAME}@${PKG_VERSION} already exists on npm — bump the version in package.json first" >&2
    exit 1
  fi
fi

# ---------- Check 1: all tests green ----------
pnpm vitest run

# ---------- Build: tsc (emits .d.ts) + esbuild bundle (inlining only unpublished packages) ----------
# EXTERNALS is the single source of truth: it feeds esbuild and also validates that the
# artifact's dependencies and the bundle's bare imports all agree. Adding an external means
# changing this one place only.
EXTERNALS=(socket.io-client @deepseek-ai/schemastery)
ESBUILD_EXTERNAL_FLAGS=()
for dep in "${EXTERNALS[@]}"; do ESBUILD_EXTERNAL_FLAGS+=("--external:$dep"); done

# Rebuild the inlined workspace dependencies first: esbuild resolves them through their
# dist/ per node resolution — with a stale dist it silently bundles old code into the
# artifact (seen on a live release: core copy changed, yet the tgz sha256 did not move)
pnpm --filter @openagentnetwork/protocol --filter @openagentnetwork/client-js \
  --filter @openagentnetwork/connector-core build
pnpm build
npx esbuild src/index.ts --bundle --format=esm --platform=node --target=node22 \
  --outdir=dist-bundle "${ESBUILD_EXTERNAL_FLAGS[@]}"

# ---------- Assemble the artifact (scratch directory, isolated from the workspace) ----------
STAGE="$(mktemp -d)/oan-dsh-plugin-${PKG_VERSION}"
mkdir -p "$STAGE/dist"
cp dist-bundle/index.js "$STAGE/dist/"
cp dist/index.d.ts "$STAGE/dist/"
cp cordis.patch.yml README.md LICENSE "$STAGE/"
# package.json: drop devDependencies; from dependencies strip only workspace:* entries
# (those are already inlined into the bundle), keeping real npm dependencies for the
# installer's pnpm to resolve. After stripping it must match EXTERNALS exactly (checked below)
node -e "
const fs = require('fs');
const d = require('./package.json');
delete d.devDependencies;
d.dependencies = Object.fromEntries(
  Object.entries(d.dependencies ?? {}).filter(([, spec]) => !String(spec).startsWith('workspace:')),
);
fs.writeFileSync('$STAGE/package.json', JSON.stringify(d, null, 2) + '\n');
"

# ---------- Check 2: artifact invariants ----------
fail() { echo "❌ $1" >&2; exit 1; }
[[ -z "$(find "$STAGE" -name '__tests__' -o -name '*.test.*' -o -name '*.map')" ]] \
  || fail "artifact contains test files or sourcemaps"
! grep -q 'workspace:' "$STAGE/package.json" || fail "artifact package.json still contains workspace: protocol references"
! grep -rq 'workspace:\*' "$STAGE/dist" || fail "artifact dist still contains workspace: protocol references"
[[ "$(find "$STAGE/dist" -type f | wc -l | tr -d ' ')" == "2" ]] \
  || fail "dist/ must contain exactly two files: index.js and index.d.ts"
# Host APIs (cordis and dsh-*) must carry zero runtime dependencies (type-only imports are
# erased at compile time; a leftover means someone wrote a value import).
# @deepseek-ai/schemastery is exempt — it is an ordinary validation library that stays
# external as a real dependency, and sharing a single instance with the host is exactly
# what we want
! grep -Eq "from ?['\"]@deepseek-ai/(cordis|dsh-)" "$STAGE/dist/index.js" \
  || fail "bundle still imports host APIs at runtime (@deepseek-ai/cordis or dsh-* must be type-only)"
# @openagentnetwork/* must all be inlined (not on npm; a leftover bare import breaks every install)
! grep -Eq "from ?['\"]@openagentnetwork/" "$STAGE/dist/index.js" \
  || fail "bundle still has bare @openagentnetwork/* imports (unpublished packages must be inlined)"
# The bundle's bare imports must equal EXTERNALS exactly and map one-to-one onto the artifact's dependencies
node -e "
const fs = require('fs');
const bundle = fs.readFileSync('$STAGE/dist/index.js', 'utf8');
const declared = Object.keys(require('$STAGE/package.json').dependencies ?? {}).sort();
const bare = [...bundle.matchAll(/^import[^;]*? from ?['\"]([^'\"]+)['\"]/gm)]
  .map((m) => m[1])
  .filter((s) => !s.startsWith('node:'))
  .map((s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]));
const used = [...new Set(bare)].sort();
const missing = used.filter((d) => !declared.includes(d));
if (missing.length) {
  console.error('bare imports in the bundle are not declared in dependencies: ' + missing.join(', '));
  process.exit(1);
}
" || fail "bundle bare imports do not match the artifact dependencies"
# CJS inlining shim: the __require esbuild generates when converting a CJS dependency to ESM
# throws at runtime (a real-world incident: socket.io-client → xmlhttprequest-ssl calling
# require('fs') at top level made the plugin fail to load). A hit means a CJS package was
# inlined by mistake — add it to EXTERNALS instead of papering over it with a createRequire banner
! grep -q 'Dynamic require of' "$STAGE/dist/index.js" \
  || fail "bundle contains an esbuild __require shim (a CJS package got inlined — add it to EXTERNALS)"
# Function-plugin shape: no default export allowed (the Loader replaces the whole namespace with default)
! grep -Eq '^export default|^export \{[^}]* as default' "$STAGE/dist/index.js" \
  || fail "bundle has a default export (the host Loader would swallow the plugin namespace)"
# Bundle detection requires: the dsh.bundle.patch declaration + the patch file inside the package
node -e "
const d = require('$STAGE/package.json');
if (!d.dsh || !d.dsh.bundle || d.dsh.bundle.patch !== './cordis.patch.yml') process.exit(1);
" || fail "package.json is missing the dsh.bundle.patch declaration"
[[ -f "$STAGE/cordis.patch.yml" ]] || fail "artifact is missing cordis.patch.yml"

# ---------- Check 3: load smoke test (actually import the artifact once) ----------
# The direct lesson from a real-world load failure: everything above is static — the
# artifact had never been executed, so a __require shim that only blows up at runtime
# sailed through the release. Here the bundle is placed back inside the plugin directory
# (letting Node resolve the external dependencies up through node_modules, equivalent to
# the installer's resolution environment), imported for real, and its export shape asserted.
SMOKE="$PLUGIN_DIR/dist-bundle/.smoke.mjs"
cp "$STAGE/dist/index.js" "$SMOKE"
trap 'rm -f "$SMOKE"' EXIT
node --input-type=module -e "
const m = await import('file://$SMOKE');
const keys = Object.keys(m).sort().join(',');
if (keys !== 'Config,apply,inject,name') {
  console.error('unexpected export shape: ' + keys + ' (expected Config,apply,inject,name)');
  process.exit(1);
}
if (typeof m.apply !== 'function') { console.error('apply is not a function'); process.exit(1); }
if (m.name !== 'oan') { console.error('plugin name is not oan: ' + m.name); process.exit(1); }
if (!Array.isArray(m.inject)) { console.error('inject is not an array'); process.exit(1); }
" || fail "artifact load smoke test failed (the output cannot be imported in a real resolution environment)"
rm -f "$SMOKE"
trap - EXIT

# ---------- Output ----------
cd "$STAGE"
if [[ "$MODE" == "publish" ]]; then
  # publish shares the same STAGE contents and every invariant check with pack — the published files are the exact pack artifact set
  npm publish --access public
  echo "✅ Published: ${PKG_NAME}@${PKG_VERSION}"
  echo "   Install with: dsh plugin --profile web add ${PKG_NAME}"
else
  npm pack --quiet >/dev/null
  TGZ="$(ls ./*.tgz)"
  cp "$TGZ" "$HOME/Downloads/"
  echo "✅ Installable artifact: $HOME/Downloads/$(basename "$TGZ")"
  shasum -a 256 "$HOME/Downloads/$(basename "$TGZ")"
fi
