#!/bin/sh
set -eu

REPO_ROOT="$(
    CDPATH=''
    cd "$(dirname "$0")/../../.."
    pwd
)"
MIGRATION="$REPO_ROOT/prisma/migrations/20260907000000_rename_account_label_to_legacy/migration.sql"
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
ALTER TABLE "AccountLabel" RENAME TO "AccountLabelLegacy";
COMMIT;'
    if [ "$ACTUAL_STATEMENTS" != "$EXPECTED_STATEMENTS" ]; then
        fail 'forward migration must contain exactly the five required statements (BEGIN/SET LOCAL lock_timeout/SET LOCAL statement_timeout/ALTER TABLE RENAME/COMMIT)'
    fi
fi

if [ "$FAILED" -ne 0 ]; then
    exit 1
fi

echo 'OK: AccountLabel rename migration contains exactly the expected DDL'
