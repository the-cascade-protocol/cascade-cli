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
# SPEC_ROOT may be overridden via env (useful when running from a worktree
# whose parent is not the development root). Default: sibling of CLI_ROOT.
if [[ -z "${SPEC_ROOT:-}" ]]; then
  if [[ -d "$CLI_ROOT/../spec" ]]; then
    SPEC_ROOT="$(cd "$CLI_ROOT/../spec" && pwd)"
  elif [[ -d "$HOME/Development/spec" ]]; then
    SPEC_ROOT="$(cd "$HOME/Development/spec" && pwd)"
  else
    echo "Error: cannot locate spec/ — set SPEC_ROOT env var" >&2
    exit 1
  fi
fi

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

# Draft vocabularies (per D-PATH, NOT registered in VOCAB_VERSIONS).
# Mirror the shapes file so cascade validate can target the new classes
# while drafts are still pre-stable.
echo ""
echo "=== Syncing draft shapes to src/shapes/ ==="
DRAFT_VOCABS=(genomics advisory)
for vocab in "${DRAFT_VOCABS[@]}"; do
  copy_file "$SPEC_ROOT/ontologies/$vocab/v1-draft/$vocab.shapes.ttl" \
            "$CLI_ROOT/src/shapes/$vocab.shapes.ttl"
done

echo ""
echo "Done. Next steps:"
echo "  1. Review diffs: git diff src/shapes/"
echo "  2. Update VOCAB_VERSIONS file"
echo "  3. Verify: cascade validate passes all conformance fixtures"
echo "  4. Update CHANGELOG.md"
echo "  5. Bump version in package.json"
