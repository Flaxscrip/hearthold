#!/usr/bin/env bash
#
# KB-spaces flow in the sandbox — a shared Knowledge Base plus a per-member PRIVATE partition (a private
# DB) for each member. The visible set is computed server-side from the authenticated member (a member
# sees the shared partition ∪ their own private one, never another member's); a non-member is refused
# before any recall; and an existing shared KB can be upgraded to spaces in place, content preserved.
#
# Runs the proven flows IN-CONTAINER against the isolated node, each in its own throwaway data root.
#
#   ./deploy/sandbox/run-kb.sh           # isolation + retrofit (fast, deterministic)
#   ./deploy/sandbox/run-kb.sh recall    # live RAG recall over the partitions (Ollama — slow on 8B)
set -euo pipefail

cd "$(dirname "$0")/../.."
CF=docker-compose.hearthold.yml

flow() {
  local name="$1" desc="$2"; shift 2
  printf '\n\033[1;36m━━ %s ━━\033[0m\n   \033[2m%s\033[0m\n' "$name" "$desc"
  docker compose -f "$CF" exec -T \
    -e HEARTHOLD_DATA_ROOT="/data/flow-$name" \
    -e HEARTHOLD_PASSPHRASE="flow-$name" \
    "$@" \
    warden node --experimental-strip-types "scripts/e2e-$name.ts" 2>&1 | grep -vE 'ExperimentalWarning|trace-warning'
}

case "${1:-default}" in
  recall)
    # Real recall: embed on submit (nomic-embed-text) + RAG answer (the classifier model). Uses the
    # sandbox's ollama container. Slow on qwen3:8b — the sensitivity/answer lands in minutes, not seconds.
    flow kb "live recall — member contributes, then queries; the answer is drawn ONLY from their visible set (Ollama)"
    printf '\n\033[32m✓ KB recall verified in the isolated sandbox (Ollama-backed)\033[0m\n'
    ;;
  default | "")
    flow kb-spaces        "shared + per-member private partitions; visible-set isolation (Alice never sees Bob's private)" \
      -e HEARTHOLD_CLASSIFIER=quarantine -e HEARTHOLD_INDEX=off
    flow kb-spaces-enable "retrofit — upgrade an existing shared KB to spaces in place; content preserved, members backfilled" \
      -e HEARTHOLD_CLASSIFIER=quarantine -e HEARTHOLD_INDEX=off
    printf '\n\033[32m✓ KB-spaces flow verified in the isolated sandbox\033[0m\n'
    printf '\033[2m   live RAG recall over the partitions:  ./deploy/sandbox/run-kb.sh recall  (Ollama-backed, slow on 8B)\033[0m\n'
    ;;
  *) echo "usage: $0 [default|recall]"; exit 2 ;;
esac
