import { PrismaClient } from '../generated/prisma'
import { LabelRuleRegistry } from '../labels/registry'
import { ALL_LABEL_RULES } from '../labels/all-rules'
import { runRelabelBackfill } from '../relabel'

const SEED_ACCOUNT_COUNT = Number(process.env.BENCHMARK_ACCOUNT_COUNT ?? 2000)

/**
 * `count` 件の架空アカウント (実在のTwitter/Xデータは一切含まない合成データ) を、それ
 * ぞれ1件のツイート付きで作成する。`runRelabelBackfill` が処理すべきstaleなアカウントを
 * 用意するための、ベンチマーク専用のシード処理。
 * @param prisma - シード投入に使う Prisma クライアント
 * @param count - 作成する架空アカウント数
 */
async function seed(prisma: PrismaClient, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await prisma.account.create({
      data: {
        id: `bench-${i}`,
        screenName: `bench_user_${i}`,
        displayName: `Bench User ${i}`,
        bio: 'synthetic benchmark account, not a real Twitter/X user',
        followersCount: i,
        followingCount: i,
        tweetCount: 1,
        accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
        isBlueVerified: false,
        tweets: {
          create: [
            {
              id: `bench-${i}-tweet-1`,
              fullText: 'synthetic benchmark tweet, not real content',
              createdAt: new Date(),
              retweetCount: 0,
              likeCount: 0,
              replyCount: 0,
              quoteCount: 0,
              isReply: false,
              isRetweet: false,
              isPromoted: false,
              isPaidPromotion: false,
              source: 'benchmark',
            },
          ],
        },
      },
    })
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaClient()
  try {
    console.log(`Seeding ${SEED_ACCOUNT_COUNT} synthetic accounts...`)
    await seed(prisma, SEED_ACCOUNT_COUNT)

    const registry = new LabelRuleRegistry()
    for (const rule of ALL_LABEL_RULES) {
      registry.register(rule)
    }

    const start = Date.now()
    const result = await runRelabelBackfill(prisma, registry)
    const elapsedMinutes = (Date.now() - start) / 60_000

    console.log(
      `Processed ${result.accountsProcessed} accounts, persisted ${result.labelsPersisted} labels`,
    )
    console.log(
      `Elapsed: ${elapsedMinutes.toFixed(2)} min (${(result.accountsProcessed / elapsedMinutes).toFixed(1)} accounts/min)`,
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

// 実行手順 (本番DBには絶対に向けないこと。ローカルの使い捨てPostgresでのみ実行する):
//
// 1. docker compose up -d postgres
// 2. DATABASE_URL=postgresql://crawler:crawler@localhost:5432/twitter_accounts_classifier \
//      pnpm --filter crawler exec prisma migrate deploy --schema=../prisma/schema.prisma
// 3. このIssueの変更を含まないコミット (改善前) をチェックアウトした状態で実行し、
//    出力された "Elapsed" / "accounts/min" を記録する:
//      DATABASE_URL=postgresql://crawler:crawler@localhost:5432/twitter_accounts_classifier \
//        pnpm --filter crawler exec tsx scripts/relabel-benchmark.ts
// 4. docker compose down -v postgres && docker compose up -d postgres && 手順2を再実行し、
//    DBをまっさらな状態に戻す。
// 5. このIssueの変更を含むコミット (改善後) に戻して手順3を再実行し、出力を記録する。
// 6. 両方の出力をこのIssueのPR説明に記録する。
