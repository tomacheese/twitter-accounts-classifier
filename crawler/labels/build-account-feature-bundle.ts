import type { Account, Tweet } from '../generated/prisma'
import type { AccountFeatureBundle } from './types'
import type { buildDuplicateReplyIndex } from './duplicate-reply-index'
import type { buildBioDuplicateIndex } from './bio-duplicate-index'
import type { buildReplyHijackIndex } from './reply-hijack-index'
import type { FollowGraphLabelIndex } from './follow-graph-label-index'
import type { buildSelfReplyPromoIndex } from './self-reply-promo-index'

/**
 * Account と Tweet の DB 確定値(merge 後の状態)から AccountFeatureBundle を組み立てる。
 * crawl 時の atomic 評価と relabel worker の両方から呼ばれる唯一の bundle 組み立て経路にすることで、
 * 経路ごとに参照するフィールドが drift しないようにする。
 * @param account - バンドルを組み立てる対象アカウントの DB 確定値
 * @param recentTweets - このアカウント自身の直近ツイートの DB 確定値
 * @param duplicateReplyIndex - アカウント横断で共有する重複返信インデックス
 * @param bioDuplicateIndex - アカウント横断で共有する bio 複製インデックス
 * @param replyHijackIndex - アカウント横断で共有するリプライハイジャック群インデックス
 * @param followGraphLabelIndex - アカウント横断で共有するフォローグラフラベルインデックス
 * @param selfReplyPromoIndex - アカウント横断で共有する self-reply promo chain インデックス
 * @param parentTweetTextById - リプライ先ツイート ID から本文を引くための共有マップ
 * @returns アカウントの feature bundle
 */
export function buildAccountFeatureBundle(
  account: Account,
  recentTweets: Tweet[],
  duplicateReplyIndex: ReturnType<typeof buildDuplicateReplyIndex>,
  bioDuplicateIndex: ReturnType<typeof buildBioDuplicateIndex>,
  replyHijackIndex: ReturnType<typeof buildReplyHijackIndex>,
  followGraphLabelIndex: FollowGraphLabelIndex,
  selfReplyPromoIndex: ReturnType<typeof buildSelfReplyPromoIndex>,
  parentTweetTextById: Map<string, string>,
  parentTweetAuthorIdById = new Map<string, string>(),
): AccountFeatureBundle {
  // 複数の異なるテンプレ返信ネットワーク・リプライハイジャック群に属することがあるため、
  // 合計や平均ではなく最大値を最も強いシグナルとして採用する。
  let templatedReplyNetworkSize = 0
  let replyHijackSwarmSize = 0
  let replyHijackEvidence: AccountFeatureBundle['replyHijackEvidence']
  for (const tweet of recentTweets) {
    if (!tweet.isReply) continue
    templatedReplyNetworkSize = Math.max(
      templatedReplyNetworkSize,
      duplicateReplyIndex.countOtherAccounts(tweet.fullText, account.id),
    )
    if (tweet.inReplyToTweetId !== null) {
      const evidence = replyHijackIndex.evidenceFor(account.id, tweet.inReplyToTweetId)
      if (
        evidence &&
        (evidence.swarmSize > replyHijackSwarmSize ||
          (evidence.swarmSize === replyHijackSwarmSize &&
            (replyHijackEvidence === undefined ||
              evidence.targetTweetId < replyHijackEvidence.targetTweetId)))
      ) {
        replyHijackSwarmSize = evidence.swarmSize
        replyHijackEvidence = evidence
      }
    }
  }

  const bioDuplicateNetworkSize =
    account.bio == null ? 0 : bioDuplicateIndex.countOtherAccounts(account.bio, account.id)

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
      profileImageUrl: account.profileImageUrl,
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
      cardDestinationUrls: tweet.cardDestinationUrls,
      cardDestinationUrlsEvaluated: tweet.cardDestinationUrlsEvaluated,
      hasAiGeneratedMedia: tweet.hasAiGeneratedMedia,
      aiGeneratedDetectionSource: tweet.aiGeneratedDetectionSource,
      foreignVideoSourceCount: tweet.foreignVideoSourceCount,
      inReplyToTweetId: tweet.inReplyToTweetId,
      quotedTweetAuthorId: tweet.quotedTweetAuthorId,
      quotedTweetHasVideo: tweet.quotedTweetHasVideo,
      parentTweetFullText:
        tweet.inReplyToTweetId === null
          ? null
          : (parentTweetTextById.get(tweet.inReplyToTweetId) ?? null),
      parentTweetAuthorId:
        tweet.inReplyToTweetId === null
          ? null
          : (parentTweetAuthorIdById.get(tweet.inReplyToTweetId) ?? null),
    })),
    templatedReplyNetworkSize,
    bioDuplicateNetworkSize,
    replyHijackSwarmSize,
    replyHijackEvidence,
    followGraphLabelSignals: followGraphLabelIndex.signalsFor(account.id),
    selfReplyPromoEvidence: selfReplyPromoIndex.evidenceFor(account.id),
  }
}
