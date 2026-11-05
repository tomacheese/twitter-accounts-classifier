// 生成済み Prisma Client の型宣言 (index.d.ts) の bigint を string に書き換える。
//
// 実行時の変換は id-boundary が境界で行うため、型だけを実行時の値 (string) に合わせる。
// 引数なしの場合は、各パッケージの generated/prisma のうち存在するものを対象にする。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MARKER = '/* id-boundary: bigint is rewritten to string */'

const PACKAGES = ['crawler', 'viewer', 'analyzer', 'blocker']

/**
 * 型宣言の bigint を string に置き換える。置き換え済みなら何もしない。
 * @param {string} text index.d.ts の内容
 * @returns {{ text: string, replaced: number }} 置き換え後の内容と、置き換えた箇所の数
 */
export function stringifyBigintTypes(text) {
  if (text.startsWith(MARKER)) return { text, replaced: 0 }
  let replaced = 0
  const rewrite = (pattern, value) => {
    text = text.replace(pattern, () => {
      replaced += 1
      return value
    })
  }
  rewrite(/\bbigint\[\] \| number\[\]/g, 'string[]')
  rewrite(/\bbigint \| number\b/g, 'string')
  rewrite(/\bbigint\b/g, 'string')
  return { text: `${MARKER}\n${text}`, replaced }
}

/**
 * 1 つの生成先を書き換える。
 * @param {string} outputDir `index.d.ts` を含む生成先
 * @returns {number} 置き換えた箇所の数。置き換え済みなら 0
 */
export function patchGeneratedClient(outputDir) {
  const file = path.join(outputDir, 'index.d.ts')
  const original = fs.readFileSync(file, 'utf8')
  const { text, replaced } = stringifyBigintTypes(original)
  if (text === original) return 0
  if (replaced === 0) {
    throw new Error(
      `No bigint found in ${file}; the generated client layout changed and this patch must be reviewed`,
    )
  }
  fs.writeFileSync(file, text)
  return replaced
}

function defaultTargets() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  return PACKAGES.map((name) => path.join(root, name, 'generated', 'prisma')).filter((dir) =>
    fs.existsSync(path.join(dir, 'index.d.ts')),
  )
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  for (const dir of args.length > 0 ? args : defaultTargets()) {
    const replaced = patchGeneratedClient(dir)
    console.log(`stringify-bigint-types: ${dir} (${replaced} replaced)`)
  }
}
