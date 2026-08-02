import { PrismaClient } from '../generated/prisma'
import { LabelRuleRegistry } from '../labels/registry'
import { ALL_LABEL_RULES } from '../labels/all-rules'
import { runRelabelBackfill } from '../relabel'

const SEED_ACCOUNT_COUNT = Number(process.env.BENCHMARK_ACCOUNT_COUNT ?? 2000)

/**
 * 誤って本番 DB に向けて実行してしまうことを防ぐガード。このスクリプトは
 * `bench-*` の架空アカウントを大量に INSERT するため、本番相当の
 * `AccountLabel`/`Account` 件数を汚染してしまう。`localhost`/`127.0.0.1` 以外の
 * ホストへの接続はデフォルトで拒否し、どうしても別ホストで実行したい場合のみ
 * `BENCHMARK_ALLOW_NON_LOCALHOST=1` の明示指定を必須にする。
 * @param databaseUrl - 検証対象の `DATABASE_URL`
 */
function assertNotProductionDatabase(databaseUrl: string | undefined): void {
  if (process.env.BENCHMARK_ALLOW_NON_LOCALHOST === '1') return
  const host = databaseUrl ? new URL(databaseUrl).hostname : ''
  if (host === 'localhost' || host === '127.0.0.1') return
  throw new Error(
    `Refusing to run relabel-benchmark against DATABASE_URL host "${host}": this script writes synthetic bench-* accounts and must only target a disposable local Postgres. Set BENCHMARK_ALLOW_NON_LOCALHOST=1 to override.`,
  )
}

/**
 * `count` 件の架空アカウント (実在の Twitter/X データは一切含まない合成データ) を、
 * それぞれ1件のツイート付きで作成する。`runRelabelBackfill` が処理すべき stale な
 * アカウントを用意するための、ベンチマーク専用のシード処理。
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
  assertNotProductionDatabase(process.env.DATABASE_URL)
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

// 実行手順 (本番 DB には絶対に向けないこと。ローカルの使い捨て Postgres でのみ実行する。
// PR ごとの before/after 比較の記録手順は、この場所ではなく各 PR の説明に記載する):
//
// 1. compose.yaml の postgres サービスはデフォルトでホストポートを公開していないため、
//    ローカルから直接繋ぐには一時的にポートを公開する必要がある。例えば
//    `docker compose run --rm -p 5432:5432 postgres` のように起動するか、
//    `docker compose.override.yml` で一時的に `ports: ["5432:5432"]` を追加する。
// 2. DATABASE_URL=postgresql://crawler:crawler@localhost:5432/twitter_accounts_classifier \
//      pnpm --filter crawler exec prisma migrate deploy --schema=../prisma/schema.prisma
// 3. DATABASE_URL=postgresql://crawler:crawler@localhost:5432/twitter_accounts_classifier \
//      pnpm --filter crawler exec tsx scripts/relabel-benchmark.ts
// 4. DB をまっさらな状態に戻して再計測したい場合は、`./data/postgres` はコンテナ外の
//    bind mount のため `docker compose down -v` では消えない。
//    `docker compose down && rm -rf ./data/postgres` で明示的に削除してから
//    手順1に戻ること。
