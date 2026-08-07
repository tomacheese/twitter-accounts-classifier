import type { PrismaClient } from '../generated/prisma'

/**
 * 旧 Run 詳細ページから対応する OperationCycle を逆引きし、
 * 新 Operations 詳細ページの URL を組み立てる。対応する Cycle がまだ存在しない場合は、
 * Operations 一覧の該当種別 filter へのリンクにフォールバックする。
 * @param prisma - Prisma クライアント
 * @param input - 逆引きに使う `sourceType`/`sourceId`、リンク先の組み立てに使うパス・フォールバック
 * @returns リダイレクト先の URL
 */
export async function resolveOperationCycleRedirectTarget(
  prisma: PrismaClient,
  input: {
    sourceType: string
    sourceId: string
    detailPathPrefix: string
    fallbackHref: string
  },
): Promise<string> {
  const cycle = await prisma.operationCycle.findUnique({
    where: { sourceType_sourceId: { sourceType: input.sourceType, sourceId: input.sourceId } },
  })
  return cycle ? `${input.detailPathPrefix}/${cycle.id}` : input.fallbackHref
}
