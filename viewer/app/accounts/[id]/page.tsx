import { notFound } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { formatDateTime } from '@/lib/format-date'
import { getPrismaClient } from '@/lib/prisma'
import { getAccountDetail } from '@/lib/queries/account-detail'
import { ErrorFallback } from '../../components/error-fallback'

const RECENT_TWEET_COUNT = 20

/**
 * @param props - ルートの `id` パスパラメータ
 * @returns アカウント詳細ページの描画結果
 */
export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<React.ReactElement> {
  const { id } = await params
  let detail: Awaited<ReturnType<typeof getAccountDetail>>
  try {
    detail = await getAccountDetail(getPrismaClient(), id, RECENT_TWEET_COUNT)
  } catch (error) {
    // エラーの詳細はサーバー側のログにのみ残し、クライアントには一般的なメッセージだけを返す。error.message には SQL 接続情報などドライバー由来の詳細が含まれうるため。
    console.error('Failed to load account detail:', error)
    return <ErrorFallback message="Failed to load the account." />
  }
  if (!detail) {
    notFound()
  }

  const { account, labels, recentTweets, following, followers } = detail

  return (
    <div className="flex flex-col gap-8">
      <Link href="/accounts" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
        ← Back to accounts
      </Link>

      <section className="rounded-lg border bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-start gap-4">
          {account.profileImageUrl && (
            <Image
              src={account.profileImageUrl}
              alt={`${account.displayName}'s avatar`}
              width={64}
              height={64}
              className="h-16 w-16 rounded-full object-cover"
            />
          )}
          <div>
            <h1 className="text-2xl font-semibold">
              {account.displayName}{' '}
              <span className="text-base font-normal text-gray-500 dark:text-gray-400">
                @{account.screenName}
              </span>
            </h1>
            {account.bio && (
              <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">{account.bio}</p>
            )}
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
          <div>
            <dt className="text-gray-500 dark:text-gray-400">Followers</dt>
            <dd>{account.followersCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">Following</dt>
            <dd>{account.followingCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">Tweets</dt>
            <dd>{account.tweetCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">Blue verified</dt>
            <dd>{account.isBlueVerified ? (account.verifiedType ?? 'Yes') : 'No'}</dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">Account created</dt>
            <dd>{formatDateTime(account.accountCreatedAt)}</dd>
          </div>
        </dl>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Labels</h2>
        {labels.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No labels recorded for this account.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {labels.map((label, index) => (
              <li
                key={index}
                className="rounded-lg border bg-white p-3 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800"
              >
                <p className="font-medium">
                  {label.labelKey}: {label.value ? 'true' : 'false'} (confidence{' '}
                  {label.confidence.toFixed(2)})
                </p>
                <p className="mt-1 text-gray-600 dark:text-gray-400">{label.reason}</p>
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  {label.method} · {label.ruleVersion} · {formatDateTime(label.labeledAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Recent tweets</h2>
        {recentTweets.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No tweets recorded for this account.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {recentTweets.map((tweet) => (
              <li
                key={tweet.id}
                className="rounded-lg border bg-white p-3 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800"
              >
                <p>{tweet.fullText}</p>
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  {formatDateTime(tweet.createdAt)} · ♻ {tweet.retweetCount} · ♥ {tweet.likeCount}
                  {tweet.isRetweet && ' · retweet'}
                  {tweet.isReply && ' · reply'}
                  {(tweet.isPromoted || tweet.isPaidPromotion) && ' · ad'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">
          Following ({following.totalCount.toLocaleString()})
        </h2>
        {following.entries.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No following data recorded for this account.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {following.entries.map((entry) => (
              <li key={entry.id}>
                <Link
                  href={`/accounts/${entry.id}`}
                  className="flex items-center gap-3 rounded-lg border bg-white p-3 text-sm shadow-sm hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700"
                >
                  {entry.profileImageUrl && (
                    <Image
                      src={entry.profileImageUrl}
                      alt={`${entry.displayName}'s avatar`}
                      width={32}
                      height={32}
                      className="h-8 w-8 rounded-full object-cover"
                    />
                  )}
                  <span>
                    {entry.displayName}{' '}
                    <span className="text-gray-500 dark:text-gray-400">@{entry.screenName}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">
          Followers ({followers.totalCount.toLocaleString()})
        </h2>
        {followers.entries.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No follower data recorded for this account.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {followers.entries.map((entry) => (
              <li key={entry.id}>
                <Link
                  href={`/accounts/${entry.id}`}
                  className="flex items-center gap-3 rounded-lg border bg-white p-3 text-sm shadow-sm hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700"
                >
                  {entry.profileImageUrl && (
                    <Image
                      src={entry.profileImageUrl}
                      alt={`${entry.displayName}'s avatar`}
                      width={32}
                      height={32}
                      className="h-8 w-8 rounded-full object-cover"
                    />
                  )}
                  <span>
                    {entry.displayName}{' '}
                    <span className="text-gray-500 dark:text-gray-400">@{entry.screenName}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
