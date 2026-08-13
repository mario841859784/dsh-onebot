#!/bin/bash
# Link the running dsh host's @deepseek-ai packages into this plugin's
# node_modules, so the plugin runs against the SAME module instances the host
# process uses (dual-package hazard: npm copies would break instanceof-style
# identities across the plugin boundary). Requires `dsh` on PATH. Re-run
# after updating dsh. Also usable from build.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DSH_BIN=""
if command -v dsh &>/dev/null; then
  DSH_BIN=$(readlink -f "$(command -v dsh)" 2>/dev/null || command -v dsh)
fi
[ -n "$DSH_BIN" ] || { echo "link-host: dsh not on PATH" >&2; exit 1; }

DIR=$(dirname "$DSH_BIN")
NODE_MODULES=""
while [ "$DIR" != "/" ]; do
  if [ -d "$DIR/node_modules/@deepseek-ai" ]; then
    NODE_MODULES="$DIR/node_modules"
    break
  fi
  DIR=$(dirname "$DIR")
done
[ -n "$NODE_MODULES" ] || { echo "link-host: cannot locate dsh install above $DSH_BIN" >&2; exit 1; }

# The @deepseek-ai/dsh-* packages this plugin imports at runtime or whose
# types it compiles against. Transitive deps resolve from the host install.
LINK_PKGS=(
  cordis
  cosmokit
  schemastery
  dsh-agent
  dsh-brand
  dsh-invariants
  dsh-llm
  dsh-scope
  dsh-session
  dsh-system-prompt
  dsh-timeout
  dsh-tools
  dsh-typert-protocol
  dsh-user-approval
)

mkdir -p node_modules/@deepseek-ai
for p in "${LINK_PKGS[@]}"; do
  target="$NODE_MODULES/@deepseek-ai/$p"
  [ -e "$target" ] || { echo "link-host: missing host package: $target" >&2; exit 1; }
  # Remove the npm-installed copy (file or dir) before linking.
  rm -rf "node_modules/@deepseek-ai/$p"
  ln -sfn "$target" "node_modules/@deepseek-ai/$p"
done

# schemastery lives at the top level of the host install.
rm -rf node_modules/schemastery
ln -sfn "$NODE_MODULES/schemastery" node_modules/schemastery
rm -rf node_modules/cosmokit
ln -sfn "$NODE_MODULES/cosmokit" node_modules/cosmokit

echo "linked host packages from: $NODE_MODULES"
