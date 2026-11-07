#!/usr/bin/env python3
"""Tweet の text 形式 COPY ストリームを、子パーティションごとの FIFO へ振り分ける。

標準入力の各行は「part_no<TAB>残りの列」。part_no を落とした残りを <dir>/p<part_no> へ書く。
未知の part_no (どの子パーティションにも属さない行) は、黙って捨てずに異常終了する。
使い方: python3 -I tweet-route.py <fifo のあるディレクトリ> <part_no>...
"""
import os
import sys


def main() -> int:
    directory = sys.argv[1]
    parts = [int(p) for p in sys.argv[2:]]
    outs = {p: open(os.path.join(directory, f'p{p}'), 'wb', buffering=1 << 20) for p in parts}
    counts = dict.fromkeys(parts, 0)
    for line in sys.stdin.buffer:
        i = line.find(b'\t')
        try:
            part = int(line[:i])
            out = outs[part]
        except (ValueError, KeyError):
            sys.stderr.write(f'tweet-route: unknown part_no in line starting {line[:40]!r}\n')
            return 3
        out.write(line[i + 1:])
        counts[part] += 1
    for out in outs.values():
        out.close()
    sys.stderr.write('tweet-route: rows per part ' + ' '.join(f'{p}={n}' for p, n in sorted(counts.items())) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
