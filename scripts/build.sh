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
  # R1 逃生门: DSH_ROOT explicitly names the host node_modules root (fnOS
  # app-style hosts ship no dsh binary on PATH). Highest priority — when set
  # and valid it overrides both auto-resolution paths below; when set but
  # invalid we fail instead of silently falling back.
  if [ -n "${DSH_ROOT:-}" ]; then
    if [ -d "$DSH_ROOT/@deepseek-ai" ]; then
      echo "$DSH_ROOT"
      return 0
    fi
    echo "build: DSH_ROOT=$DSH_ROOT 下没有 @deepseek-ai/，不是宿主 node_modules 根" >&2
    return 1
  fi
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
      # npm/nvm global: the bin sits in <node>/bin and the packages live
      # INSIDE @deepseek-ai/dsh/node_modules — the location the host process
      # actually loads its services from. The plain lib/node_modules/@deepseek-ai
      # ancestor holds only the dsh package itself, so descend into the dsh
      # install's own dependency tree (the caller appends /@deepseek-ai/<pkg>).
      local global_dsh="$dir/lib/node_modules/@deepseek-ai/dsh/node_modules"
      if [ -d "$global_dsh/@deepseek-ai" ]; then
        echo "$global_dsh"
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
