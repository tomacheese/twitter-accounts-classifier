#!/usr/bin/env python3
"""psql の \\timing 出力 (「Time: 1.234 ms」の行) から、件数と平均、p50、p95、最大を出す。

標準入力を読み、最初の引数をラベルとして 1 行で出力する。
"""
import re
import sys


def main() -> int:
    times = [float(m.group(1)) for m in re.finditer(r'^Time: ([0-9.]+) ms', sys.stdin.read(), re.M)]
    if not times:
        sys.stderr.write('lat-stats: no "Time:" lines found\n')
        return 1
    times.sort()

    def pct(p: float) -> float:
        return times[min(len(times) - 1, int(len(times) * p))]

    print(f'{sys.argv[1]}: n={len(times)} mean={sum(times) / len(times):.2f}ms p50={pct(0.5):.2f}ms '
          f'p95={pct(0.95):.2f}ms max={times[-1]:.2f}ms total={sum(times) / 1000:.2f}s')
    return 0


if __name__ == '__main__':
    sys.exit(main())
