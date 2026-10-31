#!/usr/bin/env bash
# Bento 性能基线入口。说明见 scripts/bench/README.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

cmd="${1:-}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "$cmd" in
  fixture-10k | 10k)
    exec node scripts/bench/generate-fixture.mjs --preset 10k "$@"
    ;;
  fixture-100k | 100k)
    exec node scripts/bench/generate-fixture.mjs --preset 100k "$@"
    ;;
  measure)
    exec node scripts/bench/measure.mjs "$@"
    ;;
  record)
    exec node scripts/bench/record.mjs "$@"
    ;;
  self-check)
    exec node scripts/bench/self-check.mjs "$@"
    ;;
  *)
    cat <<'EOF'
用法（在仓库根目录）:
  ./scripts/bench/baseline.sh fixture-10k
  ./scripts/bench/baseline.sh fixture-100k
  ./scripts/bench/baseline.sh measure [--rust]
  ./scripts/bench/baseline.sh record --cold-open-ms 850

100k 会先提示磁盘和时间。自动化可加 --yes:
  ./scripts/bench/baseline.sh fixture-100k --yes
EOF
    exit 1
    ;;
esac
