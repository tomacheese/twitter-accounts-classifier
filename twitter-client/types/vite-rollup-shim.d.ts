// このプロジェクトの moduleResolution ("Node10") では 'vite' が参照する
// 'rollup/parseAst' の subpath export を解決できないため、それを補うためのシムである。
declare module 'rollup/parseAst'
