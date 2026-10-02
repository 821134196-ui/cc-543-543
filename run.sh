#!/usr/bin/env bash
# 一条本地命令启动 LeakFlow，并自带复漏演示案例。
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8000}"
HOST="${HOST:-127.0.0.1}"
DB_DIR="leakflow/data"

# 始终重建种子，保证“启动即带复漏案例”；如要保留数据请用：KEEP=1 ./run.sh
if [[ "${KEEP:-0}" != "1" ]]; then
  python3 -m leakflow.seed "$DB_DIR"
fi

echo "──────────────────────────────────────────────"
echo " LeakFlow 已启动： http://${HOST}:${PORT}/"
echo " 复漏案例：        LK-2026-0920-07（两轮协商/复验）"
echo " 停止：            Ctrl-C"
echo "──────────────────────────────────────────────"
exec python3 -m leakflow.server --db "$DB_DIR/leakflow.db" \
     --photos "$DB_DIR/photos" --host "$HOST" --port "$PORT"
