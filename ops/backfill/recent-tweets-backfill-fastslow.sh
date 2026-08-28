#!/bin/bash
set -u
COMPOSE_DIR=${BACKFILL_COMPOSE_DIR:-/mnt/hdd/nuts/twitter-accounts-classifier}
cd "$COMPOSE_DIR" || exit 2
FAST_WORKERS=${BACKFILL_FAST_WORKERS:-4}
SLOW_WORKER_INDEX=${BACKFILL_SLOW_WORKER_INDEX:-4}
ITEMS_PER_CHUNK=${BACKFILL_ITEMS_PER_CHUNK:-20}
SLOW_ITEMS_PER_CHUNK=${BACKFILL_SLOW_ITEMS_PER_CHUNK:-5}
PAGE_LIMIT=${BACKFILL_PAGE_LIMIT:-1000}
LOW_WATER_CHUNKS=${BACKFILL_LOW_WATER_CHUNKS:-10}
FAST_MIN_START_INTERVAL=${BACKFILL_FAST_MIN_START_INTERVAL:-45}
SLOW_MIN_START_INTERVAL=${BACKFILL_SLOW_MIN_START_INTERVAL:-45}
RATE_LIMIT_COOLDOWN=${BACKFILL_RATE_LIMIT_COOLDOWN:-900}
ERROR_RETRY_DELAY=${BACKFILL_ERROR_RETRY_DELAY:-30}
RUNTIME_FAULT_EXIT_CODE=75
OPS_RUNTIME_TARGET=${BACKFILL_OPS_TARGET:-/app/crawler/dist/scripts/recent-tweets-backfill-ops.js}

queue_pop() {
  local q=$1 lock=$2 line="" tmp
  tmp="${q}.next.$BASHPID"
  exec 9>"$lock"
  flock 9
  if IFS= read -r line < "$q"; then
    tail -n +2 "$q" > "$tmp"
    mv "$tmp" "$q"
  fi
  flock -u 9
  exec 9>&-
  printf '%s' "$line"
}
queue_append() {
  local q=$1 lock=$2 line=$3
  exec 9>"$lock"
  flock 9
  printf '%s\n' "$line" >> "$q"
  flock -u 9
  exec 9>&-
}

queue_depth() {
  local q=$1 lock=$2 n
  exec 9>"$lock"
  flock 9
  n=$(wc -l < "$q")
  flock -u 9
  exec 9>&-
  printf '%s' "$n"
}

append_csv_chunks() {
  local q=$1 lock=$2 csv=$3 size=$4 chunk
  [ -n "$csv" ] || return 0
  while IFS= read -r chunk; do
    [ -n "$chunk" ] && queue_append "$q" "$lock" "$chunk"
  done < <(jq -rn --arg csv "$csv" --argjson n "$size" \
    '$csv|split(",") as $a | range(0;($a|length);$n) as $i | $a[$i:$i+$n]|join(",")')
}
append_metric() {
  exec 8>"$metric_lock"
  flock 8
  printf '%s\n' "$1" >> "$metric_file"
  flock -u 8
  exec 8>&-
}

append_candidates() {
  local json=$1 chunk
  while IFS= read -r chunk; do
    [ -n "$chunk" ] && queue_append "$fast_queue" "$fast_lock" "$chunk"
  done < <(printf '%s\n' "$json" | jq -r --argjson n "$ITEMS_PER_CHUNK" \
    '.accountIds as $a | range(0;($a|length);$n) as $i | $a[$i:$i+$n]|join(",")')
}

chunk_count() {
  awk -F',' '{print NF}' <<<"$1"
}

if [ "${1:-}" = '--self-test' ]; then
  t=$(mktemp -d /tmp/backfill-fastslow-test.XXXXXX)
  fast_queue="$t/fast"; fast_lock="$t/fast.lock"
  slow_queue="$t/slow"; slow_lock="$t/slow.lock"
  metric_file="$t/metrics"; metric_lock="$t/metrics.lock"
  : > "$fast_queue"; : > "$slow_queue"; : > "$metric_file"
  fast_csv=$(seq -s, 1 40)
  slow_csv=$(seq -s, 101 112)
  append_csv_chunks "$fast_queue" "$fast_lock" "$fast_csv" 20
  append_csv_chunks "$slow_queue" "$slow_lock" "$slow_csv" 5
  fd=$(queue_depth "$fast_queue" "$fast_lock")
  sd=$(queue_depth "$slow_queue" "$slow_lock")
  all=$(cat "$fast_queue" "$slow_queue" | tr ',' '\n' | sort -n)
  total=$(printf '%s\n' "$all" | sed '/^$/d' | wc -l)
  unique=$(printf '%s\n' "$all" | sed '/^$/d' | uniq | wc -l)
  rm -rf "$t"
  if [ "$fd" -ne 2 ] || [ "$sd" -ne 3 ] || [ "$total" -ne 52 ] || [ "$unique" -ne 52 ]; then
    echo "FASTSLOW_SELF_TEST_FAIL fast=$fd slow=$sd total=$total unique=$unique"
    exit 1
  fi
  echo 'FASTSLOW_SELF_TEST_OK fast_chunks=2 slow_chunks=3 total=52 unique=52'
  exit 0
fi

mapfile -t usernames < <(jq -r '.accounts[].username // empty' data/config.json)
if ! [[ "$FAST_WORKERS" =~ ^[1-9][0-9]*$ ]] || ! [[ "$SLOW_WORKER_INDEX" =~ ^[0-9]+$ ]] || \
   [ "${#usernames[@]}" -le "$SLOW_WORKER_INDEX" ] || [ "$FAST_WORKERS" -gt "$SLOW_WORKER_INDEX" ]; then
  echo "FATAL configured_accounts=${#usernames[@]} fast_workers=$FAST_WORKERS slow_worker_index=$SLOW_WORKER_INDEX" >&2
  exit 2
fi

tmpdir=$(mktemp -d /tmp/recent-tweets-backfill-fastslow.XXXXXX) || exit 2
fast_queue="$tmpdir/fast.queue"; fast_lock="$tmpdir/fast.lock"
slow_queue="$tmpdir/slow.queue"; slow_lock="$tmpdir/slow.lock"
metric_file="$tmpdir/metrics"
metric_lock="$tmpdir/metrics.lock"
stop_file="$tmpdir/stop"; complete_file="$tmpdir/complete"
runtime_fault_file="$tmpdir/runtime-fault"
: > "$fast_queue"; : > "$slow_queue"; : > "$metric_file"
child_pids=()

# shellcheck disable=SC2329
cleanup() {
  touch "$stop_file" 2>/dev/null || true
  for pid in "${child_pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  requeue_inflight_work
  docker compose exec -T crawler sh -lc \
    "pkill -f '^node dist/scripts/recent-tweets-backfill-ops.js' || true" >/dev/null 2>&1 || true
  rm -rf "$tmpdir"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

pending_ids() {
  local ids=$1
  [[ "$ids" =~ ^[0-9]+(,[0-9]+)*$ ]] || { printf ''; return 1; }
  docker compose exec -T postgres sh -lc \
    "psql -At -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"SELECT COALESCE(string_agg(id, ',' ORDER BY id), '') FROM \\\"Account\\\" WHERE id = ANY(string_to_array('$ids', ',')) AND \\\"lastRecentTweetsAttemptedAt\\\" IS NULL;\"" \
    2>/dev/null | tail -1
}
cooldown_wait() {
  local seconds=$1
  local end=$(( $(date +%s) + seconds )) now remain
  while [ ! -f "$stop_file" ] && [ ! -f "$complete_file" ]; do
    now=$(date +%s)
    [ "$now" -ge "$end" ] && break
    remain=$((end - now))
    [ "$remain" -gt 5 ] && remain=5
    sleep "$remain"
  done
}

is_runtime_fault() {
  local rc=$1 err_file=$2
  [ "$rc" -ne 0 ] || return 1
  grep -Fq "$OPS_RUNTIME_TARGET" "$err_file" || \
    grep -Eq 'No such container|is not running|is restarting|OCI runtime exec failed|Cannot connect to the Docker daemon' "$err_file"
}

mark_runtime_fault() {
  local lane=$1 rc=$2 err_file=$3
  is_runtime_fault "$rc" "$err_file" || return 1
  printf 'RUNTIME_FAULT lane=%s exit=%s helper=%s\n' "$lane" "$rc" "$OPS_RUNTIME_TARGET" \
    > "$runtime_fault_file"
  touch "$stop_file"
  return 0
}

# shellcheck disable=SC2329
requeue_inflight_work() {
  local inflight chunk pending
  for inflight in "$tmpdir"/inflight-fast-*; do
    [ -f "$inflight" ] || continue
    chunk=$(cat "$inflight")
    pending=$(pending_ids "$chunk" || true)
    append_csv_chunks "$fast_queue" "$fast_lock" "$pending" "$ITEMS_PER_CHUNK"
  done
  if [ -f "$tmpdir/inflight-slow" ]; then
    chunk=$(cat "$tmpdir/inflight-slow")
    pending=$(pending_ids "$chunk" || true)
    append_csv_chunks "$slow_queue" "$slow_lock" "$pending" "$SLOW_ITEMS_PER_CHUNK"
  fi
}

fast_worker() {
  local idx=$1 username=${usernames[$1]} last_start=0 job=0
  local chunk count now wait_s start rc failed pending pending_count completed success elapsed
  while [ ! -f "$stop_file" ] && [ ! -f "$complete_file" ]; do
    chunk=$(queue_pop "$fast_queue" "$fast_lock")
    if [ -z "$chunk" ]; then sleep 1; continue; fi
    count=$(chunk_count "$chunk")
    now=$(date +%s)
    wait_s=$((FAST_MIN_START_INTERVAL - (now - last_start)))
    if [ "$last_start" -gt 0 ] && [ "$wait_s" -gt 0 ]; then cooldown_wait "$wait_s"; fi
    if [ -f "$stop_file" ] || [ -f "$complete_file" ]; then
      queue_append "$fast_queue" "$fast_lock" "$chunk"
      break
    fi
    job=$((job + 1)); start=$(date +%s); last_start=$start
    printf '%s' "$chunk" > "$tmpdir/inflight-fast-$idx"
    out="$tmpdir/fast-$idx-$job.out"; err="$tmpdir/fast-$idx-$job.err"
    : > "$out"; : > "$err"
    docker compose exec -T -e TWITTER_REQUEST_TIMEOUT_MS=15000 \
      -e BACKFILL_DEFER_TIMEOUT=1 -e BACKFILL_FORCED_IDS="$chunk" crawler \
      node dist/scripts/recent-tweets-backfill-ops.js --limit 1 --execute \
      --username "$username" >"$out" 2>"$err"
    rc=$?
    if mark_runtime_fault "fast-$idx" "$rc" "$err"; then
      return
    fi
    rm -f "$tmpdir/inflight-fast-$idx"
    elapsed=$(( $(date +%s) - start ))
    failed=$(grep -c 'Recent tweets backfill fetch failed for ' "$err" || true)
    pending=$(pending_ids "$chunk" || true)
    pending_count=0
    [ -n "$pending" ] && pending_count=$(chunk_count "$pending")
    completed=$((count - pending_count)); success=$((completed - failed))
    if [ "$rc" -ne 0 ]; then
      if grep -q '^BACKFILL_RATE_LIMIT$' "$err"; then
        append_csv_chunks "$fast_queue" "$fast_lock" "$pending" "$ITEMS_PER_CHUNK"
        append_metric "event=fast_rate_limit ts=$(date +%s) worker=$idx completed=$completed success=$success terminal_failed=$failed requeued=$pending_count elapsed_s=$elapsed"
        cooldown_wait "$RATE_LIMIT_COOLDOWN"
        continue
      fi
      append_csv_chunks "$fast_queue" "$fast_lock" "$pending" "$ITEMS_PER_CHUNK"
      append_metric "event=fast_worker_error ts=$(date +%s) worker=$idx exit=$rc requeued=$pending_count elapsed_s=$elapsed"
      cooldown_wait "$ERROR_RETRY_DELAY"
      continue
    fi
    if [ "$pending_count" -gt 0 ]; then
      append_csv_chunks "$slow_queue" "$slow_lock" "$pending" "$SLOW_ITEMS_PER_CHUNK"
    fi
    append_metric "event=fast_batch ts=$(date +%s) worker=$idx attempted=$count completed=$completed success=$success terminal_failed=$failed deferred_timeout=$pending_count elapsed_s=$elapsed"
    rm -f "$out" "$err"
  done
}

slow_worker() {
  local idx=$SLOW_WORKER_INDEX username=${usernames[$SLOW_WORKER_INDEX]} last_start=0 job=0
  local chunk count now wait_s start rc failed pending pending_count completed success elapsed
  while [ ! -f "$stop_file" ] && [ ! -f "$complete_file" ]; do
    chunk=$(queue_pop "$slow_queue" "$slow_lock")
    if [ -z "$chunk" ]; then sleep 1; continue; fi
    count=$(chunk_count "$chunk")
    now=$(date +%s)
    wait_s=$((SLOW_MIN_START_INTERVAL - (now - last_start)))
    if [ "$last_start" -gt 0 ] && [ "$wait_s" -gt 0 ]; then cooldown_wait "$wait_s"; fi
    if [ -f "$stop_file" ] || [ -f "$complete_file" ]; then
      queue_append "$slow_queue" "$slow_lock" "$chunk"
      break
    fi
    job=$((job + 1)); start=$(date +%s); last_start=$start
    printf '%s' "$chunk" > "$tmpdir/inflight-slow"
    out="$tmpdir/slow-$job.out"; err="$tmpdir/slow-$job.err"
    : > "$out"; : > "$err"
    docker compose exec -T -e TWITTER_REQUEST_TIMEOUT_MS=60000 \
      -e BACKFILL_FORCED_IDS="$chunk" crawler \
      node dist/scripts/recent-tweets-backfill-ops.js --limit 1 --execute \
      --username "$username" >"$out" 2>"$err"
    rc=$?
    if mark_runtime_fault 'slow' "$rc" "$err"; then
      return
    fi
    rm -f "$tmpdir/inflight-slow"
    elapsed=$(( $(date +%s) - start ))
    failed=$(grep -c 'Recent tweets backfill fetch failed for ' "$err" || true)
    pending=$(pending_ids "$chunk" || true)
    pending_count=0
    [ -n "$pending" ] && pending_count=$(chunk_count "$pending")
    completed=$((count - pending_count)); success=$((completed - failed))
    if [ "$rc" -ne 0 ]; then
      if grep -q '^BACKFILL_RATE_LIMIT$' "$err"; then
        append_csv_chunks "$slow_queue" "$slow_lock" "$pending" "$SLOW_ITEMS_PER_CHUNK"
        append_metric "event=slow_rate_limit ts=$(date +%s) completed=$completed success=$success terminal_failed=$failed requeued=$pending_count elapsed_s=$elapsed"
        cooldown_wait "$RATE_LIMIT_COOLDOWN"
        continue
      fi
      append_csv_chunks "$slow_queue" "$slow_lock" "$pending" "$SLOW_ITEMS_PER_CHUNK"
      append_metric "event=slow_worker_error ts=$(date +%s) exit=$rc requeued=$pending_count elapsed_s=$elapsed"
      cooldown_wait "$ERROR_RETRY_DELAY"
      continue
    fi
    if [ "$pending_count" -gt 0 ]; then
      append_csv_chunks "$slow_queue" "$slow_lock" "$pending" "$SLOW_ITEMS_PER_CHUNK"
    fi
    append_metric "event=slow_batch ts=$(date +%s) attempted=$count completed=$completed success=$success terminal_failed=$failed requeued=$pending_count elapsed_s=$elapsed"
    rm -f "$out" "$err"
  done
}

for ((i=0; i<FAST_WORKERS; i++)); do
  fast_worker "$i" &
  child_pids+=("$!")
done
slow_worker &
child_pids+=("$!")

cursor=""
sweep=1
page=0
producer_done=0
selected_total=0
while [ ! -f "$stop_file" ]; do
  if [ -f "$runtime_fault_file" ]; then
    cat "$runtime_fault_file"
    exit "$RUNTIME_FAULT_EXIT_CODE"
  fi
  fast_depth=$(queue_depth "$fast_queue" "$fast_lock")
  slow_depth=$(queue_depth "$slow_queue" "$slow_lock")
  fast_inflight=$(find "$tmpdir" -maxdepth 1 -name 'inflight-fast-*' -type f 2>/dev/null | wc -l)
  slow_inflight=0; [ -f "$tmpdir/inflight-slow" ] && slow_inflight=1
  if [ "$producer_done" -eq 0 ] && [ "$fast_depth" -lt "$LOW_WATER_CHUNKS" ]; then
    page=$((page + 1)); select_err="$tmpdir/select-$sweep-$page.err"
    if [ -n "$cursor" ]; then
      select_out=$(docker compose exec -T crawler node dist/scripts/recent-tweets-backfill-ops.js \
        --limit "$PAGE_LIMIT" --after-id "$cursor" --dry-run 2>"$select_err")
    else
      select_out=$(docker compose exec -T crawler node dist/scripts/recent-tweets-backfill-ops.js \
        --limit "$PAGE_LIMIT" --dry-run 2>"$select_err")
    fi
    rc=$?
    if [ "$rc" -ne 0 ]; then
      if mark_runtime_fault 'selector' "$rc" "$select_err"; then
        continue
      fi
      echo "RETRY selector sweep=$sweep page=$page exit=$rc"
      append_metric "event=selector_error ts=$(date +%s) sweep=$sweep page=$page exit=$rc"
      page=$((page - 1))
      cooldown_wait "$ERROR_RETRY_DELAY"
      continue
    fi
    json=$(printf '%s\n' "$select_out" | grep -m1 '^{')
    selected=$(printf '%s\n' "$json" | jq '.accountIds | length')
    if [ "$selected" -eq 0 ]; then
      producer_done=1
      echo "producer sweep=$sweep page=$page selected=0 end=1"
      continue
    fi
    append_candidates "$json"
    selected_total=$((selected_total + selected))
    cursor=$(printf '%s\n' "$json" | jq -r '.nextAfterId // empty')
    fast_depth=$(queue_depth "$fast_queue" "$fast_lock")
    echo "producer sweep=$sweep page=$page selected=$selected fast_chunks=$fast_depth selected_total=$selected_total"
    if [ -z "$cursor" ]; then producer_done=1; fi
    continue
  fi

  if [ "$producer_done" -eq 1 ] && [ "$fast_depth" -eq 0 ] && \
     [ "$slow_depth" -eq 0 ] && [ "$fast_inflight" -eq 0 ] && [ "$slow_inflight" -eq 0 ]; then
    verify_err="$tmpdir/verify-$sweep.err"
    verify_out=$(docker compose exec -T crawler node dist/scripts/recent-tweets-backfill.js \
      --limit 1 --dry-run 2>"$verify_err")
    rc=$?
    if [ "$rc" -ne 0 ]; then
      if mark_runtime_fault 'verifier' "$rc" "$verify_err"; then
        continue
      fi
      echo "RETRY verifier sweep=$sweep exit=$rc"
      append_metric "event=verifier_error ts=$(date +%s) sweep=$sweep exit=$rc"
      cooldown_wait "$ERROR_RETRY_DELAY"
      continue
    fi
    verify_json=$(printf '%s\n' "$verify_out" | grep -m1 '^{')
    verify_count=$(printf '%s\n' "$verify_json" | jq '.accountIds | length')
    if [ "$verify_count" -eq 0 ]; then
      touch "$complete_file"
      echo "COMPLETE candidates=0 sweeps=$sweep selected_total=$selected_total"
      break
    fi
    sweep=$((sweep + 1)); page=0; cursor=""; producer_done=0
    echo "RESCAN sweep=$sweep reason=remaining-candidates"
    continue
  fi
  sleep 2
done
[ -f "$runtime_fault_file" ] && {
  cat "$runtime_fault_file"
  exit "$RUNTIME_FAULT_EXIT_CODE"
}
for pid in "${child_pids[@]}"; do wait "$pid" 2>/dev/null || true; done

fast_attempted=$(awk '$1=="event=fast_batch" {for(i=1;i<=NF;i++) if($i~/^attempted=/){split($i,a,"=");s+=a[2]}} END{print s+0}' "$metric_file")
fast_success=$(awk '$1=="event=fast_batch" {for(i=1;i<=NF;i++) if($i~/^success=/){split($i,a,"=");s+=a[2]}} END{print s+0}' "$metric_file")
fast_deferred=$(awk '$1=="event=fast_batch" {for(i=1;i<=NF;i++) if($i~/^deferred_timeout=/){split($i,a,"=");s+=a[2]}} END{print s+0}' "$metric_file")
slow_attempted=$(awk '$1=="event=slow_batch" {for(i=1;i<=NF;i++) if($i~/^attempted=/){split($i,a,"=");s+=a[2]}} END{print s+0}' "$metric_file")
slow_success=$(awk '$1=="event=slow_batch" {for(i=1;i<=NF;i++) if($i~/^success=/){split($i,a,"=");s+=a[2]}} END{print s+0}' "$metric_file")
rate_limits=$(grep -Ec '^event=(fast|slow)_rate_limit ' "$metric_file" || true)
worker_errors=$(grep -Ec '^event=(fast|slow)_worker_error ' "$metric_file" || true)
control_errors=$(grep -Ec '^event=(selector|verifier)_error ' "$metric_file" || true)
echo "SUMMARY fast_attempted=$fast_attempted fast_success=$fast_success deferred_timeout=$fast_deferred slow_attempted=$slow_attempted slow_success=$slow_success rate_limits=$rate_limits worker_errors=$worker_errors control_errors=$control_errors"

[ -f "$complete_file" ] && exit 0
exit 1
