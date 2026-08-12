#!/bin/sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "[weekly-review-agent-contract.test] $*" >&2; exit 1; }

workers='weekly-review-sample-judge weekly-review-rule-auditor weekly-review-researcher'
for name in $workers; do
  file="$ROOT/.claude/agents/$name.md"
  grep -Eq '^tools: .*SendMessage' "$file" || fail "$name must allow SendMessage"
  grep -Fq 'SendMessage' "$file" || fail "$name must require SendMessage reporting"
  grep -Fq '`team-lead`' "$file" || fail "$name must identify the exact team-lead recipient"
  grep -Fiq 'before becoming idle' "$file" || fail "$name must report before becoming idle"
done

coord="$ROOT/.claude/agents/weekly-review-coordinator.md"
grep -Eq '^tools: .*SendMessage' "$coord" || fail 'coordinator must allow SendMessage'
grep -Fq 'agent-team teammate' "$coord" || fail 'coordinator must require agent-team teammates'
grep -Fq 'idle without' "$coord" || fail 'coordinator must handle idle-without-report immediately'
grep -Fq '5 minutes' "$coord" || fail 'coordinator must define first no-response window'
grep -Fq 'another 5 minutes' "$coord" || fail 'coordinator must define second no-response window'
grep -Fq 'review_incomplete' "$coord" || fail 'coordinator must define missing-agent failure handling'

skill="$ROOT/.claude/skills/weekly-crawl-review/SKILL.md"
grep -Fq 'SendMessage' "$skill" || fail 'skill must require SendMessage liveness protocol'
grep -Fq '5 minutes' "$skill" || fail 'skill must define liveness timing'
grep -Fq 'idle without' "$skill" || fail 'skill must define idle-without-report handling'

echo '[weekly-review-agent-contract.test] ok'
