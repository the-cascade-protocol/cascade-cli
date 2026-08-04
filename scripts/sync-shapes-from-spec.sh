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

MISSING_COUNT=0

copy_file() {
  local src="$1"
  local dst="$2"
  if [[ ! -f "$src" ]]; then
    echo "  MISSING: $src" >&2
    MISSING_COUNT=$((MISSING_COUNT + 1))
    return
  fi
  if $DRY_RUN; then
    echo "  would copy: $src -> $dst"
  else
    cp "$src" "$dst"
    echo "  copied: $(basename "$src")"
  fi
}

# Sync BOTH the ontology and its shapes for every vocabulary, driven by a single
# list per maturity tier.
#
# These used to be two independent lists — every vocabulary got its
# `.shapes.ttl`, but only `core clinical coverage` got the ontology itself. The
# validator loads both (`loadShapes` reads every `*.shapes.ttl` for constraints
# and every other `*.ttl` for the vocabulary), so the split meant it could load a
# shape whose target class its own loaded vocabulary did not define. Measured
# before this change: 52 of 89 `sh:targetClass` values in Cascade namespaces
# resolved to no loaded class definition, and `src/shapes/health.ttl` had never
# been synced at all. Keeping one list per tier makes that drift impossible to
# reintroduce by omission; `tests/shapes-sync.test.ts` asserts the invariant.
STABLE_VOCABS=(core health clinical coverage checkup pots)

# Draft vocabularies (per D-PATH, NOT registered in VOCAB_VERSIONS).
# Mirrored so `cascade validate` can target the new classes while the
# vocabularies are still pre-stable. They land in VOCAB_VERSIONS at v1.0.
DRAFT_VOCABS=(genomics advisory evidence workbench)

echo ""
echo "=== Syncing stable vocabularies to src/shapes/ ==="
for vocab in "${STABLE_VOCABS[@]}"; do
  copy_file "$SPEC_ROOT/ontologies/$vocab/v1/$vocab.ttl" \
            "$CLI_ROOT/src/shapes/$vocab.ttl"
  copy_file "$SPEC_ROOT/ontologies/$vocab/v1/$vocab.shapes.ttl" \
            "$CLI_ROOT/src/shapes/$vocab.shapes.ttl"
done

echo ""
echo "=== Syncing draft vocabularies to src/shapes/ ==="
for vocab in "${DRAFT_VOCABS[@]}"; do
  copy_file "$SPEC_ROOT/ontologies/$vocab/v1-draft/$vocab.ttl" \
            "$CLI_ROOT/src/shapes/$vocab.ttl"
  copy_file "$SPEC_ROOT/ontologies/$vocab/v1-draft/$vocab.shapes.ttl" \
            "$CLI_ROOT/src/shapes/$vocab.shapes.ttl"
done

if (( MISSING_COUNT > 0 )); then
  echo "" >&2
  echo "FAILED: $MISSING_COUNT expected file(s) not found in $SPEC_ROOT." >&2
  echo "Every vocabulary listed above must ship both an ontology and a shapes" >&2
  echo "file. Fix spec/ or correct the vocabulary lists in this script; do not" >&2
  echo "leave a vocabulary half-synced." >&2
  exit 1
fi

echo ""
echo "Done. Next steps:"
echo "  1. Review diffs: git diff src/shapes/"
echo "  2. Update VOCAB_VERSIONS file"
echo "  3. npm run build && npm test  (tests/shapes-sync.test.ts checks the sync)"
echo "  4. Verify: cascade validate passes all conformance fixtures"
echo "  5. Update CHANGELOG.md"
echo "  6. Bump version in package.json"
