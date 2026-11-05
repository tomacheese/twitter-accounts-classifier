#!/bin/bash
# 切り替え後の本番 compose の操作を、必ず現行の override を付けて行うための薄いラッパー。
# 使い方: ops/db-rebuild/cutover/compose.sh <docker compose の引数>   例: compose.sh ps、compose.sh logs --tail 50 relabeler
#
# override を付けずに docker compose up を実行すると、DATABASE_URL が旧 DB に戻り、migrate サービスが旧 DB に対して動く。
# 起動系のコマンド (up、start、restart、run) は、依存サービスを巻き込まないよう --no-deps が付いていることを要求する。
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

need PROD_COMPOSE_DIR
if step_done switch_started; then
    override="$STATE_DIR/compose.new.yaml"
else
    override="$STATE_DIR/compose.old.yaml"
    [ -f "$override" ] || override=""
fi
if [ "${1:-}" = up ] || [ "${1:-}" = run ]; then
    case " $* " in *" --no-deps "*) ;; *) die "'$1' without --no-deps would start the old postgres and the migrate service" ;; esac
fi
if [ -n "$override" ]; then
    log "using override: $override"
    prod_compose -o "$override" "$@"
else
    log "no override in use"
    prod_compose "$@"
fi
