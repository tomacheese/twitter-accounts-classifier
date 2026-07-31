// vitest's own type declarations import from 'vite', which in turn references
// 'rollup/parseAst' — a subpath export only resolvable under moduleResolution
// "node16"/"nodenext"/"bundler". This project's moduleResolution is "Node10"
// (required by the rest of the CommonJS toolchain), so tsc otherwise fails
// with TS2307 while type-checking any file that imports from 'vitest'. This
// ambient shim only satisfies module resolution for that unused re-export —
// no code in this project imports 'rollup/parseAst' directly.
declare module 'rollup/parseAst'
