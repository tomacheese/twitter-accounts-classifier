#!/bin/sh
set -eu

REPO_ROOT="$(
    CDPATH=''
    cd "$(dirname "$0")/.."
    pwd
)"
SCHEMA="$REPO_ROOT/prisma/schema.prisma"
FAILED=0

fail() {
    echo "FAIL: $*" >&2
    FAILED=1
}

if grep -Eq '^model AccountLabel \{' "$SCHEMA"; then
    fail "prisma/schema.prisma still declares model AccountLabel"
fi

if grep -Eq '^model AccountLabelLegacy \{' "$SCHEMA"; then
    fail "prisma/schema.prisma already declares model AccountLabelLegacy (Release 2 scope, not Release 1)"
fi

if sed -n '/^model Account {/,/^}/p' "$SCHEMA" | grep -Eq '[[:space:]]AccountLabel\[\]'; then
    fail "model Account still has an AccountLabel[] field"
fi

if sed -n '/^model LabelDefinition {/,/^}/p' "$SCHEMA" | grep -Eq '[[:space:]]AccountLabel\[\]'; then
    fail "model LabelDefinition still has an AccountLabel[] field"
fi

# production コードのみを対象にする: *.test.ts と prisma/migrations/**・docs/** を除外する。
PRODUCTION_TS_FILES="$(
    find "$REPO_ROOT/crawler" "$REPO_ROOT/analyzer" "$REPO_ROOT/viewer" "$REPO_ROOT/blocker" \
        -type f -name '*.ts' ! -name '*.test.ts' \
        ! -path '*/node_modules/*' ! -path '*/generated/*' ! -path '*/dist/*'
)"

# raw SQL がテーブル名を引用符付き識別子として埋め込む書き方 ("AccountLabel"・'AccountLabel') のみを対象にする。
# AccountLabelLatest/AccountLabelChange/AccountLabelDefinition/CrawlAccountLabelRun は
# 閉じ引用符の直前に別の識別子文字が続くため、この正規表現では誤検出しない。
if printf '%s\n' "$PRODUCTION_TS_FILES" | xargs grep -EnH '["'"'"']AccountLabel["'"'"']' 2>/dev/null; then
    fail "production code still references the legacy AccountLabel table name as a quoted SQL identifier (see above)"
fi

if printf '%s\n' "$PRODUCTION_TS_FILES" | xargs grep -EnH '\bprisma\.accountLabel(Legacy)?\b' 2>/dev/null; then
    fail "production code still calls prisma.accountLabel/prisma.accountLabelLegacy (see above)"
fi

if printf '%s\n' "$PRODUCTION_TS_FILES" \
    | xargs grep -EnH '\brecordCrawlAccountLabel\b|\brecordAccountLabelsBulkForAccounts\b|\bRELABEL_ACCOUNT_LABEL_HISTORY_WRITE_ENABLED\b' 2>/dev/null; then
    fail "production code still references a retired AccountLabel write identifier (see above)"
fi

if [ "$FAILED" -ne 0 ]; then
    exit 1
fi

echo 'OK: no production code references the legacy AccountLabel table or its retired write paths'
