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

# Locate the dsh install's node_modules root: via the dsh binary on PATH,
# else via the npm/npx store pattern (works in restricted shells).
resolve_dsh_root() {
  local bin=""
  if command -v dsh >/dev/null 2>&1; then
    bin=$(command -v dsh)
  fi
  if [ -n "$bin" ]; then
    local dir
    dir=$(dirname "$bin")
    while [ "$dir" != "/" ]; do
      if [ -d "$dir/node_modules/@deepseek-ai" ]; then
        echo "$dir/node_modules"
        return 0
      fi
      dir=$(dirname "$dir")
    done
  fi
  local cand
  for cand in "$HOME"/.npm/_npx/*/node_modules; do
    if [ -d "$cand/@deepseek-ai" ]; then
      echo "$cand"
      return 0
    fi
  done
  return 1
}

NODE_MODULES=$(resolve_dsh_root) || { echo "build: cannot locate the dsh install (dsh not on PATH, no npx store found)" >&2; exit 1; }

TSC="node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  echo "build: tsc not found — run 'npm install' in $ROOT first" >&2
  exit 1
fi

echo "=== Compiling src → lib (tsc $("$TSC" --version), dsh install: $NODE_MODULES) ==="
"$TSC" -p tsconfig.json

echo "=== Build complete ==="
ls -la lib/ lib/types/
