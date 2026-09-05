#!/bin/sh
set -eu

SCRIPT_DIR="$(
    CDPATH=''
    cd "$(dirname "$0")"
    pwd
)"
REPO_ROOT="$(
    CDPATH=''
    cd "$SCRIPT_DIR/.."
    pwd
)"
POSTGRES_DATA_PATH="${POSTGRES_DATA_PATH:-$REPO_ROOT/data/postgres}"
POSTGRES_STORAGE_MIN_AVAILABLE_GIB="${POSTGRES_STORAGE_MIN_AVAILABLE_GIB:-100}"
POSTGRES_STORAGE_MAX_USED_PERCENT="${POSTGRES_STORAGE_MAX_USED_PERCENT:-80}"
DF_BIN="${DF_BIN:-df}"

fail() {
    echo "[postgres-storage] $*" >&2
    exit 2
}

require_nonnegative_integer() {
    case "$2" in
        '' | *[!0-9]*)
            fail "$1 must be a non-negative integer"
            ;;
    esac
}

require_nonnegative_integer POSTGRES_STORAGE_MIN_AVAILABLE_GIB "$POSTGRES_STORAGE_MIN_AVAILABLE_GIB"
require_nonnegative_integer POSTGRES_STORAGE_MAX_USED_PERCENT "$POSTGRES_STORAGE_MAX_USED_PERCENT"

DF_OUTPUT="$("$DF_BIN" -Pk "$POSTGRES_DATA_PATH")" || fail "could not inspect path: $POSTGRES_DATA_PATH"
DF_LINE="$(printf '%s\n' "$DF_OUTPUT" | awk 'NR == 2 { print; exit }')"

if [ -z "$DF_LINE" ]; then
    fail "could not parse df output for path: $POSTGRES_DATA_PATH"
fi

AVAILABLE_KIB="$(printf '%s\n' "$DF_LINE" | awk '{ print $4 }')"
USED_PERCENT="$(printf '%s\n' "$DF_LINE" | awk '{ print $5 }')"
USED_PERCENT="${USED_PERCENT%\%}"
require_nonnegative_integer available_kib "$AVAILABLE_KIB"
require_nonnegative_integer used_percent "$USED_PERCENT"

AVAILABLE_GIB="$(awk -v kib="$AVAILABLE_KIB" 'BEGIN { printf "%.1f", kib / 1048576 }')"
printf '[postgres-storage] path=%s used_percent=%s%% available_gib=%s\n' \
    "$POSTGRES_DATA_PATH" "$USED_PERCENT" "$AVAILABLE_GIB"

STATUS=0
MIN_AVAILABLE_KIB=$((POSTGRES_STORAGE_MIN_AVAILABLE_GIB * 1048576))
if [ "$AVAILABLE_KIB" -lt "$MIN_AVAILABLE_KIB" ]; then
    echo "[postgres-storage] available space is below ${POSTGRES_STORAGE_MIN_AVAILABLE_GIB} GiB" >&2
    STATUS=1
fi

if [ "$USED_PERCENT" -ge "$POSTGRES_STORAGE_MAX_USED_PERCENT" ]; then
    echo "[postgres-storage] usage is at or above ${POSTGRES_STORAGE_MAX_USED_PERCENT}%" >&2
    STATUS=1
fi

exit "$STATUS"
