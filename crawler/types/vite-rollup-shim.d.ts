// vitest の型定義は 'vite' を import しており、
// 'vite' はさらに 'rollup/parseAst' を参照する。
// この subpath export は moduleResolution が node16/nodenext/bundler でしか解決できないが、
// 本プロジェクトの moduleResolution は CommonJS ツールチェイン全体の都合で "Node10" のため、
// 'vitest' を import するファイルの型チェックで tsc がエラーになってしまう。
// このアンビエントシムは、
// 実際には使われない re-export のためだけにモジュール解決を成立させるものであり、
// このプロジェクトのコードが `rollup/parseAst` を直接 import することはない。
declare module 'rollup/parseAst'
