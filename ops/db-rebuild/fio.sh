#!/bin/bash
# 新 DB のボリュームのディスク性能を fio で測る。旧 DB のボリュームには負荷をかけない。
# 使い方: ops/db-rebuild/fio.sh <計測するディレクトリ (新 DB のデータと同じファイルシステム)> [サイズ (既定 4G)]
# 結果は標準出力に出す (切り替え時間の外挿の前提にする)。計測用のファイルは終了時に消す。
set -euo pipefail

DIR="${1:?usage: $0 <directory> [size]}"
SIZE="${2:-4G}"
mkdir -p "$DIR/fio-test"

# 公式の fio イメージが無いため、alpine に fio を入れて使う。
docker run --rm -v "$DIR/fio-test":/data alpine sh -euc "
    apk add --no-cache fio >/dev/null
    cd /data
    for job in 'seqwrite --rw=write --bs=1M --iodepth=8' 'seqread --rw=read --bs=1M --iodepth=8' \
               'randread8k --rw=randread --bs=8k --iodepth=16 --numjobs=4' \
               'randrw8k --rw=randrw --rwmixread=70 --bs=8k --iodepth=16 --numjobs=2'; do
        set -- \$job
        name=\$1; shift
        echo \"== \$name\"
        fio --name=\$name --filename=/data/fio.dat --size=$SIZE --direct=1 --ioengine=libaio --runtime=30 --time_based=0 \
            --group_reporting \$@ 2>&1 | grep -E '^ *(READ|WRITE):|iops +:'
    done
    rm -f /data/fio.dat
"
rmdir "$DIR/fio-test" 2>/dev/null || true
