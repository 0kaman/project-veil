#!/usr/bin/env bash
# evolve.sh — Continuous development loop for Project Veil
# Usage: ./scripts/evolve.sh [--max-cycles N] [--fix-only]
#
# Runs: build → test → analyze failures → auto-fix → repeat
# Exits when all tests pass or max cycles reached.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MAX_CYCLES=${1:-10}
FIX_ONLY=false
REPORT_DIR="$ROOT/.evolve"
mkdir -p "$REPORT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

log() { echo -e "${CYAN}[evolve]${RESET} $*"; }
ok()  { echo -e "${GREEN}[  OK  ]${RESET} $*"; }
fail(){ echo -e "${RED}[ FAIL ]${RESET} $*"; }
warn(){ echo -e "${YELLOW}[ WARN ]${RESET} $*"; }

# Parse args
for arg in "$@"; do
  case "$arg" in
    --max-cycles=*) MAX_CYCLES="${arg#*=}" ;;
    --fix-only) FIX_ONLY=true ;;
  esac
done

log "Starting evolution loop (max ${MAX_CYCLES} cycles)"
echo ""

for CYCLE in $(seq 1 "$MAX_CYCLES"); do
  TIMESTAMP=$(date +%Y%m%d_%H%M%S)
  CYCLE_REPORT="$REPORT_DIR/cycle-${CYCLE}-${TIMESTAMP}.log"

  echo -e "${BOLD}━━━ Cycle ${CYCLE}/${MAX_CYCLES} ━━━${RESET}"

  # Step 1: Build
  log "Building..."
  if ! pnpm build > "$CYCLE_REPORT" 2>&1; then
    fail "Build failed"
    echo ""
    echo "Build errors:"
    tail -30 "$CYCLE_REPORT"
    echo ""
    warn "Fix build errors and re-run"
    exit 1
  fi
  ok "Build passed"

  # Step 2: Test
  log "Running tests..."
  TEST_OUTPUT="$REPORT_DIR/test-${CYCLE}-${TIMESTAMP}.log"
  set +e
  pnpm test > "$TEST_OUTPUT" 2>&1
  TEST_EXIT=$?
  set -e

  if [ $TEST_EXIT -eq 0 ]; then
    ok "All tests passed!"
    echo ""

    # Extract test counts
    TOTAL=$(grep -o '[0-9]* tests' "$TEST_OUTPUT" | tail -1 || echo "? tests")
    PASSED=$(grep -o '[0-9]* passed' "$TEST_OUTPUT" | tail -1 || echo "? passed")
    echo -e "${GREEN}${BOLD}Evolution complete!${RESET} ${TOTAL}, ${PASSED}"
    echo -e "Reports: ${REPORT_DIR}/"

    # Summary report
    cat > "$REPORT_DIR/SUMMARY.md" << SUMEOF
# Evolution Summary

**Date**: $(date)
**Cycles**: ${CYCLE}/${MAX_CYCLES}
**Result**: ALL TESTS PASSING

## Final Stats
- Build: OK
- Tests: ${TOTAL}, ${PASSED}

## Cycle History
$(ls -1 "$REPORT_DIR"/cycle-*.log 2>/dev/null | while read f; do
  echo "- $(basename "$f")"
done)
SUMEOF

    exit 0
  fi

  # Tests failed — extract failure info
  fail "Tests failed (exit code: $TEST_EXIT)"
  echo ""

  # Show failed test summary
  FAILURES=$(grep -E "FAIL|AssertionError|Error:|expected|✗|×" "$TEST_OUTPUT" | head -30)
  if [ -n "$FAILURES" ]; then
    echo "Failures:"
    echo "$FAILURES"
    echo ""
  fi

  FAIL_COUNT=$(grep -c "FAIL" "$TEST_OUTPUT" 2>/dev/null || echo "?")
  PASS_COUNT=$(grep -c "✓\|PASS" "$TEST_OUTPUT" 2>/dev/null || echo "?")
  log "Passed: ~${PASS_COUNT}, Failed: ~${FAIL_COUNT}"
  echo ""

  if [ "$CYCLE" -eq "$MAX_CYCLES" ]; then
    warn "Max cycles (${MAX_CYCLES}) reached. Review remaining failures in:"
    echo "  $TEST_OUTPUT"
    exit 1
  fi

  log "Continuing to cycle $((CYCLE + 1))..."
  echo ""
done
