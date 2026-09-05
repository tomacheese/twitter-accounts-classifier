#!/bin/sh
set -eu

REPO_ROOT="$(
    CDPATH=''
    cd "$(dirname "$0")/../.."
    pwd
)"
SCHEMA="$REPO_ROOT/prisma/schema.prisma"
MIGRATION="$REPO_ROOT/prisma/migrations/20260906000000_drop_unused_account_label_history_indexes/migration.sql"
ACCOUNT_LABEL_MODEL="$(sed -n '/^model AccountLabel {/,/^}/p' "$SCHEMA")"
FAILED=0

fail() {
    echo "FAIL: $*" >&2
    FAILED=1
}

assert_model_omits() {
    if printf '%s\n' "$ACCOUNT_LABEL_MODEL" | sed 's/^[[:space:]]*//' | grep -Fqx "$1"; then
        fail "AccountLabel schema still declares obsolete index: $1"
    fi
}

assert_model_includes() {
    if ! printf '%s\n' "$ACCOUNT_LABEL_MODEL" | sed 's/^[[:space:]]*//' | grep -Fqx "$1"; then
        fail "AccountLabel schema no longer declares required index: $1"
    fi
}

assert_model_omits '@@index([labeledAt(sort: Desc), id(sort: Desc)])'
assert_model_omits '@@index([labelDefinitionId, labeledAt(sort: Desc), id(sort: Desc)])'
assert_model_omits '@@index([labelDefinitionId, accountId, labeledAt(sort: Desc), id(sort: Desc)])'
assert_model_includes '@@index([accountId])'
assert_model_includes '@@index([sourceKind, sourceId])'

if [ ! -f "$MIGRATION" ]; then
    fail "missing forward migration: $MIGRATION"
else
    ACTUAL_STATEMENTS="$(grep -Ev '^[[:space:]]*(--|$)' "$MIGRATION" || true)"
    EXPECTED_STATEMENTS='DROP INDEX IF EXISTS "AccountLabel_labelDefinitionId_accountId_labeledAt_id_idx";
DROP INDEX IF EXISTS "AccountLabel_labelDefinitionId_labeledAt_id_idx";
DROP INDEX IF EXISTS "AccountLabel_labeledAt_id_idx";'
    if [ "$ACTUAL_STATEMENTS" != "$EXPECTED_STATEMENTS" ]; then
        fail 'forward migration must contain exactly the three required DROP INDEX IF EXISTS statements'
    fi
fi

if [ "$FAILED" -ne 0 ]; then
    exit 1
fi

echo 'OK: obsolete AccountLabel history indexes are absent from the schema and dropped by a forward migration'
