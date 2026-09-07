#!/bin/sh
set -eu

REPO_ROOT="$(
    CDPATH=''
    cd "$(dirname "$0")/../../.."
    pwd
)"
MIGRATION="$REPO_ROOT/prisma/migrations/20260907090116_drop_account_label_legacy_and_source_label_id/migration.sql"
FAILED=0

fail() {
    echo "FAIL: $*" >&2
    FAILED=1
}

if [ ! -f "$MIGRATION" ]; then
    fail "missing forward migration: $MIGRATION"
else
    ACTUAL_STATEMENTS="$(grep -Ev '^[[:space:]]*(--|$)' "$MIGRATION" || true)"
    EXPECTED_STATEMENTS='BEGIN;
SET LOCAL lock_timeout = '"'"'3s'"'"';
SET LOCAL statement_timeout = '"'"'30s'"'"';
DROP TABLE "AccountLabelLegacy";
ALTER TABLE "AccountLabelChange" DROP COLUMN "sourceLabelId";
COMMIT;'
    if [ "$ACTUAL_STATEMENTS" != "$EXPECTED_STATEMENTS" ]; then
        fail 'forward migration must contain exactly the six required statements (BEGIN/SET LOCAL lock_timeout/SET LOCAL statement_timeout/DROP TABLE/ALTER TABLE DROP COLUMN/COMMIT)'
    fi
fi

if [ "$FAILED" -ne 0 ]; then
    exit 1
fi

echo 'OK: AccountLabelLegacy drop migration contains exactly the expected DDL'
