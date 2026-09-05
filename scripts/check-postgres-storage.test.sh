#!/bin/sh
set -eu

REPO_ROOT="$(
    CDPATH=''
    cd "$(dirname "$0")/.."
    pwd
)"
TMP_DIR="$(mktemp -d)"
DATA_PATH="$TMP_DIR/data/postgres"
DF_BIN="$TMP_DIR/df"
GUARD="$REPO_ROOT/scripts/check-postgres-storage.sh"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT HUP INT TERM

fail() {
    echo "[check-postgres-storage.test] $*" >&2
    exit 1
}

assert_eq() {
    [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

mkdir -p "$DATA_PATH"
cat > "$DF_BIN" <<'SCRIPT'
#!/bin/sh
printf '%s\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' "$DF_STUB_ROW"
printf '%s\n' "$*" > "$DF_ARGS"
SCRIPT
chmod +x "$DF_BIN"

run_guard() {
    DF_STUB_ROW="$1"
    export DF_STUB_ROW
    if GUARD_OUTPUT="$(POSTGRES_DATA_PATH="$DATA_PATH" \
        POSTGRES_STORAGE_MIN_AVAILABLE_GIB="${2:-100}" \
        POSTGRES_STORAGE_MAX_USED_PERCENT="${3:-80}" \
        DF_BIN="$DF_BIN" \
        DF_ARGS="$TMP_DIR/df-args" \
        sh "$GUARD" 2>&1)"; then
        GUARD_STATUS=0
    else
        GUARD_STATUS=$?
    fi
}

assert_report() {
    printf '%s\n' "$GUARD_OUTPUT" | grep -Fqx \
        "[postgres-storage] path=$DATA_PATH used_percent=$1 available_gib=$2" || \
        fail "missing storage report: $GUARD_OUTPUT"
}

run_guard "testfs 209715200 52428800 157286400 25% /srv"
assert_eq "$GUARD_STATUS" 0
assert_report 25% 150.0
grep -Fqx -- "-Pk $DATA_PATH" "$TMP_DIR/df-args" || fail 'df was not called for the Postgres data path'

run_guard "testfs 209715200 104857600 103809024 50% /srv"
assert_eq "$GUARD_STATUS" 1
assert_report 50% 99.0
printf '%s\n' "$GUARD_OUTPUT" | grep -Fq 'available space is below 100 GiB' || \
    fail 'low available space was not reported'

run_guard "testfs 209715200 104857600 104857600 80% /srv"
assert_eq "$GUARD_STATUS" 1
assert_report 80% 100.0
printf '%s\n' "$GUARD_OUTPUT" | grep -Fq 'usage is at or above 80%' || \
    fail 'usage threshold boundary was not reported'

run_guard "testfs 629145600 534773760 94371840 85% /srv" 80 90
assert_eq "$GUARD_STATUS" 0
assert_report 85% 90.0

echo '[check-postgres-storage.test] ok'
