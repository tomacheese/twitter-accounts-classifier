// デフォルトの生成先はこのファイルのパッケージ構成からは解決できないため、
// crawler が生成したクライアントを直接 import している。
import { PrismaClient } from '../crawler/generated/prisma'
import { ensureLabelDefinitionsForRules } from '../crawler/db/label-repository'
import { ALL_LABEL_RULES } from '../crawler/labels/all-rules'

const prisma = new PrismaClient()

async function main() {
  await ensureLabelDefinitionsForRules(prisma, ALL_LABEL_RULES)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
