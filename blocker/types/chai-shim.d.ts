// vitest.config.mts が読み込む型定義は reporters 関連の型を通じて 'chai' を直接 import する。
// 通常は vitest 本体の型 (@vitest/expect 経由) が 'chai' のアンビエント型を提供するが、
// このパッケージにはまだテストファイルが存在せず、その型がコンパイル対象に含まれない。
// そのため 'chai' の型定義が見つからず tsc がエラーになってしまう。
// このアンビエントシムは、その解決を成立させるためだけのものである。
declare module 'chai'
