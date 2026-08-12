import { PrismaClient } from '../generated/prisma'
import { LabelRuleRegistry } from '../labels/registry'
import { ALL_LABEL_RULES } from '../labels/all-rules'
import { runRelabelBackfill } from '../relabel'
import { runRelabelWorkerCycleOnce } from '../relabel-worker'
import { ensureLabelDefinitionsForRules } from '../db/label-repository'

const SEED_ACCOUNT_COUNT = Number(process.env.BENCHMARK_ACCOUNT_COUNT ?? 2000)
const FOLLOW_EDGES_PER_ACCOUNT = Number(process.env.BENCHMARK_FOLLOW_EDGES_PER_ACCOUNT ?? 20)
const LABEL_TRUE_RATE = Number(process.env.BENCHMARK_LABEL_TRUE_RATE ?? 0.3)

/**
 * 本番 DB への誤実行を防ぐガード。`bench-*` の架空アカウントを大量 INSERT するため、
 * `localhost`/`127.0.0.1` 以外への接続はデフォルトで拒否する。別ホストで実行する場合は
 * `BENCHMARK_ALLOW_NON_LOCALHOST=1` を明示指定する。
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
 * `count` 件の架空アカウント (実在データを含まない合成データ) をツイート1件付きで作成する。
 * `runRelabelBackfill` が処理する stale なアカウントを用意するベンチマーク専用のシード処理。
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

/**
 * follow-graph 集計クエリ・AccountLabelLatest lookup クエリを現実的な cardinality で再現するため、
 * 各 account に Follow エッジと AccountLabelLatest 行を追加でシードする。
 * 廃止済みラベルも1件混在させ、labelDefinitionId 絞り込みの効果を計測できるようにする。
 * @param prisma - シード投入に使う Prisma クライアント
 * @param accountIds - シード済み account の id 一覧
 * @param registry - currentRuleVersion 解決に使うルールレジストリ
 */
async function seedFollowGraphAndLabels(
  prisma: PrismaClient,
  accountIds: string[],
  registry: LabelRuleRegistry,
): Promise<void> {
  const labelDefinitionIds = await ensureLabelDefinitionsForRules(prisma, registry.getAll())
  const deprecatedLabelDefinition = await prisma.labelDefinition.create({
    data: { key: 'bench_deprecated_label', description: 'benchmark deprecated label' },
  })
  const allLabelDefinitionIds = [...labelDefinitionIds.values(), deprecatedLabelDefinition.id]

  for (const [index, accountId] of accountIds.entries()) {
    const followeeIds = Array.from({ length: FOLLOW_EDGES_PER_ACCOUNT }, (_, offset) => {
      const followeeIndex = (index + offset + 1) % accountIds.length
      return accountIds[followeeIndex]
    }).filter((followeeId) => followeeId !== accountId)
    await prisma.follow.createMany({
      data: followeeIds.map((followeeId) => ({ followerId: accountId, followeeId })),
      skipDuplicates: true,
    })

    for (const labelDefinitionId of allLabelDefinitionIds) {
      await prisma.accountLabelLatest.upsert({
        where: { accountId_labelDefinitionId: { accountId, labelDefinitionId } },
        create: {
          accountId,
          labelDefinitionId,
          value: Math.random() < LABEL_TRUE_RATE,
          confidence: 1,
          reason: 'benchmark seed',
          method: 'bench',
          ruleVersion: 'bench',
          labeledAt: new Date(),
        },
        update: {},
      })
    }
  }
}

const MAX_WORKER_DRAIN_CYCLES = 10_000

/**
 * account_relabel の WorkItem queue が空になるまで runRelabelWorkerCycleOnce を回し、
 * サイクル数・経過時間・throughput を計測する。
 * chunk size を変えた比較に使う本命のベンチマークパス。
 * WorkItem は本関数の呼び出し前に enqueue 済みであることを前提とし、
 * 実行前に必ず1サイクル回してから残件数を確認する。
 * attemptCount 上限に達した WorkItem は queued/failed のまま残り得るため、
 * 上限サイクル数に達した場合は打ち切って警告を出す。
 * @param prisma - 実行に使う Prisma クライアント
 */
async function runWorkerDrainBenchmark(prisma: PrismaClient): Promise<void> {
  const start = Date.now()
  let cycles = 0
  let pending: number
  do {
    cycles++
    await runRelabelWorkerCycleOnce(prisma)
    pending = await prisma.analysisWorkItem.count({
      where: { kind: 'account_relabel', status: { in: ['queued', 'failed'] } },
    })
  } while (pending > 0 && cycles < MAX_WORKER_DRAIN_CYCLES)
  if (pending > 0) {
    console.warn(
      `Stopped after ${MAX_WORKER_DRAIN_CYCLES} cycles with ${pending} WorkItem(s) still pending (attemptCount 上限到達の可能性)`,
    )
  }
  const elapsedMinutes = (Date.now() - start) / 60_000
  console.log(
    `Drained queue in ${cycles} cycles, elapsed ${elapsedMinutes.toFixed(2)} min (${(SEED_ACCOUNT_COUNT / elapsedMinutes).toFixed(1)} accounts/min)`,
  )
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

    if (process.env.BENCHMARK_MODE === 'worker') {
      const accountIds = Array.from({ length: SEED_ACCOUNT_COUNT }, (_, i) => `bench-${i}`)
      console.log(`Seeding follow graph (${FOLLOW_EDGES_PER_ACCOUNT} edges/account) and labels...`)
      await seedFollowGraphAndLabels(prisma, accountIds, registry)
      await runWorkerDrainBenchmark(prisma)
      return
    }

    const start = Date.now()
    const result = await runRelabelBackfill(prisma, registry)
    const elapsedMinutes = (Date.now() - start) / 60_000

    console.log(
      `Scanned ${result.accountsScanned} accounts, requested ${result.accountsRequested} for reclassification`,
    )
    console.log(
      `Elapsed: ${elapsedMinutes.toFixed(2)} min (${(result.accountsScanned / elapsedMinutes).toFixed(1)} accounts/min)`,
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

// 実行手順 (本番 DB には向けないこと。ローカルの使い捨て Postgres でのみ実行する。
// PRごとの before/after 比較記録は各 PR の説明に記載する):
//
// 1. compose.yaml の postgres はデフォルトでホストポートを公開しないため、
//    `docker compose run --rm -p 5432:5432 postgres` などで一時的に公開する。
// 2. DATABASE_URL=postgresql://crawler:crawler@localhost:5432/twitter_accounts_classifier \
//      pnpm --filter crawler exec prisma migrate deploy --schema=../prisma/schema.prisma
// 3. アカウント作成 + backfill 計測のみの場合:
//    DATABASE_URL=postgresql://crawler:crawler@localhost:5432/twitter_accounts_classifier \
//      pnpm --filter crawler exec tsx scripts/relabel-benchmark.ts
//    follow-graph/AccountLabelLatest lookup を含む worker drain を計測する場合:
//    DATABASE_URL=postgresql://crawler:crawler@localhost:5432/twitter_accounts_classifier \
//      BENCHMARK_MODE=worker RELABELER_WORKER_CHUNK_SIZE=1000 RELABELER_LABEL_LOOKUP_CHUNK_SIZE=1000 \
//      pnpm --filter crawler exec tsx scripts/relabel-benchmark.ts
//    RELABELER_WORKER_CHUNK_SIZE / RELABELER_LABEL_LOOKUP_CHUNK_SIZE を変えて比較する。
// 4. 再計測のため DB をまっさらに戻す場合、`./data/postgres` はバインドマウントのため
//    `docker compose down -v` では消えない。
//    `docker compose down && rm -rf ./data/postgres` で明示的に削除してから手順1に戻る。
