import type { Account, Tweet } from '../generated/prisma'
import type { AccountFeatureBundle } from './types'
import type { buildDuplicateReplyIndex } from './duplicate-reply-index'
import type { buildReplyHijackIndex } from './reply-hijack-index'
import type { FollowGraphLabelIndex } from './follow-graph-label-index'

/**
 * Account と Tweet の DB 確定値(merge 後の状態)から AccountFeatureBundle を組み立てる。
 * crawl 時の atomic 評価と relabel worker の両方から呼ばれる唯一の bundle 組み立て経路にすることで、
 * 経路ごとに参照するフィールドが drift しないようにする。
 * @param account - バンドルを組み立てる対象アカウントの DB 確定値
 * @param recentTweets - このアカウント自身の直近ツイートの DB 確定値
 * @param duplicateReplyIndex - アカウント横断で共有する重複返信インデックス
 * @param replyHijackIndex - アカウント横断で共有するリプライハイジャック群インデックス
 * @param followGraphLabelIndex - アカウント横断で共有するフォローグラフラベルインデックス
 * @returns アカウントの feature bundle
 */
export function buildAccountFeatureBundle(
  account: Account,
  recentTweets: Tweet[],
  duplicateReplyIndex: ReturnType<typeof buildDuplicateReplyIndex>,
  replyHijackIndex: ReturnType<typeof buildReplyHijackIndex>,
  followGraphLabelIndex: FollowGraphLabelIndex,
): AccountFeatureBundle {
  // 複数の異なるテンプレ返信ネットワーク・リプライハイジャック群に属することがあるため、
  // 合計や平均ではなく最大値を最も強いシグナルとして採用する。
  let templatedReplyNetworkSize = 0
  let replyHijackSwarmSize = 0
  for (const tweet of recentTweets) {
    if (!tweet.isReply) continue
    templatedReplyNetworkSize = Math.max(
      templatedReplyNetworkSize,
      duplicateReplyIndex.countOtherAccounts(tweet.fullText, account.id),
    )
    if (tweet.inReplyToTweetId !== null) {
      replyHijackSwarmSize = Math.max(
        replyHijackSwarmSize,
        replyHijackIndex.swarmSizeFor(account.id, tweet.inReplyToTweetId),
      )
    }
  }

  return {
    account: {
      id: account.id,
      screenName: account.screenName,
      displayName: account.displayName,
      bio: account.bio,
      followersCount: account.followersCount,
      followingCount: account.followingCount,
      tweetCount: account.tweetCount,
      accountCreatedAt: account.accountCreatedAt,
      isBlueVerified: account.isBlueVerified,
      verifiedType: account.verifiedType,
      professionalType: account.professionalType,
      parodyCommentaryFanLabel: account.parodyCommentaryFanLabel,
      recentTweetsFetchStatus: account.recentTweetsFetchStatus,
    },
    recentTweets: recentTweets.map((tweet) => ({
      id: tweet.id,
      fullText: tweet.fullText,
      createdAt: tweet.createdAt,
      retweetCount: tweet.retweetCount,
      likeCount: tweet.likeCount,
      isReply: tweet.isReply,
      isRetweet: tweet.isRetweet,
      isPromoted: tweet.isPromoted,
      isPaidPromotion: tweet.isPaidPromotion,
      expandedUrls: tweet.expandedUrls,
      hasAiGeneratedMedia: tweet.hasAiGeneratedMedia,
      aiGeneratedDetectionSource: tweet.aiGeneratedDetectionSource,
      foreignVideoSourceCount: tweet.foreignVideoSourceCount,
      inReplyToTweetId: tweet.inReplyToTweetId,
      quotedTweetAuthorId: tweet.quotedTweetAuthorId,
      quotedTweetHasVideo: tweet.quotedTweetHasVideo,
    })),
    templatedReplyNetworkSize,
    replyHijackSwarmSize,
    followGraphLabelSignals: followGraphLabelIndex.signalsFor(account.id),
  }
}
