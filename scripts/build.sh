#!/bin/bash
# Build the dsh-onebot external plugin: compile src/ → lib/ (JS) and lib/types/
# (declarations) with TypeScript. The @deepseek-ai/dsh-* peer packages are
# resolved from the same install the running `dsh` binary uses (npx store or
# source checkout), so the plugin type-checks and runs against the exact
# packages the host ships. Requires `dsh` on PATH and npm-installed dev
# dependencies (`npm install` once).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Ensure the plugin runs against the host's exact @deepseek-ai packages.
"$ROOT/scripts/link-host.sh"

DSH_BIN=""
if command -v dsh &>/dev/null; then
  DSH_BIN=$(readlink -f "$(command -v dsh)" 2>/dev/null || command -v dsh)
fi
if [ -z "$DSH_BIN" ]; then
  echo "build: dsh not on PATH" >&2
  exit 1
fi

# Walk up from the dsh bin to the node_modules root holding @deepseek-ai.
DIR=$(dirname "$DSH_BIN")
NODE_MODULES=""
while [ "$DIR" != "/" ]; do
  if [ -d "$DIR/node_modules/@deepseek-ai" ]; then
    NODE_MODULES="$DIR/node_modules"
    break
  fi
  DIR=$(dirname "$DIR")
done
if [ -z "$NODE_MODULES" ]; then
  echo "build: cannot locate the dsh install (node_modules/@deepseek-ai not found above $DSH_BIN)" >&2
  exit 1
fi

TSC="node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  echo "build: tsc not found — run 'npm install' in $ROOT first" >&2
  exit 1
fi

echo "=== Compiling src → lib (tsc $("$TSC" --version), dsh install: $NODE_MODULES) ==="
"$TSC" -p tsconfig.json

echo "=== Build complete ==="
ls -la lib/ lib/types/
