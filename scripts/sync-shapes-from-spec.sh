#!/usr/bin/env bash
# sync-shapes-from-spec.sh
# Copies SHACL shapes files from the `spec` repository into cascade-cli/src/shapes/.
#
# Run this after every vocabulary update in spec.
# Usage: ./scripts/sync-shapes-from-spec.sh [--dry-run]
#
# Assumes spec/ and cascade-cli/ are sibling directories.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SPEC_ROOT="$(cd "$CLI_ROOT/../spec" && pwd)"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "[dry-run] No files will be written."
fi

copy_file() {
  local src="$1"
  local dst="$2"
  if [[ ! -f "$src" ]]; then
    echo "  MISSING: $src"
    return
  fi
  if $DRY_RUN; then
    echo "  would copy: $src -> $dst"
  else
    cp "$src" "$dst"
    echo "  copied: $(basename "$src")"
  fi
}

VOCABS=(core health clinical coverage checkup pots)

echo ""
echo "=== Syncing SHACL shapes to src/shapes/ ==="
for vocab in "${VOCABS[@]}"; do
  copy_file "$SPEC_ROOT/ontologies/$vocab/v1/$vocab.shapes.ttl" \
            "$CLI_ROOT/src/shapes/$vocab.shapes.ttl"
done

# Also sync full ontologies if CLI uses them for validation
echo ""
echo "=== Syncing ontologies to src/shapes/ ==="
for vocab in core clinical coverage; do
  copy_file "$SPEC_ROOT/ontologies/$vocab/v1/$vocab.ttl" \
            "$CLI_ROOT/src/shapes/$vocab.ttl"
done

echo ""
echo "Done. Next steps:"
echo "  1. Review diffs: git diff src/shapes/"
echo "  2. Update VOCAB_VERSIONS file"
echo "  3. Verify: cascade validate passes all conformance fixtures"
echo "  4. Update CHANGELOG.md"
echo "  5. Bump version in package.json"
