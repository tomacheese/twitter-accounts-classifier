import { classifyAmazonAffiliateUrl } from '../amazon-affiliate-url'
import {
  combineRequired,
  posteriorProbabilityAtLeast,
  rampScore,
  toConfidence,
} from '../confidence'
import { hasPrDisclosure } from '../pr-disclosure'
import { isRecentTweetsEvaluable } from '../recent-tweets-evaluable'
import type { AccountFeatureBundle, LabelRule } from '../types'

const MIN_OWN_POSTS = 8
const COVERAGE_THRESHOLD = 0.8
const MIN_MATCHED = 6
const MATCHED_RATIO_THRESHOLD = 0.75

type RecentTweet = AccountFeatureBundle['recentTweets'][number]

function hasCardAffiliateEvidence(tweet: RecentTweet): boolean {
  return (tweet.cardDestinationUrls ?? []).some((url) => classifyAmazonAffiliateUrl(url) !== null)
}

function hasAmazonAffiliateEvidence(tweet: RecentTweet): boolean {
  const candidateUrls = [...(tweet.expandedUrls ?? []), ...(tweet.cardDestinationUrls ?? [])]
  return candidateUrls.some((url) => classifyAmazonAffiliateUrl(url) !== null)
}

function hasPrEvidence(tweet: RecentTweet): boolean {
  return hasPrDisclosure(tweet.fullText) || tweet.isPaidPromotion
}

export const amazonAffiliatePrSpamRule: LabelRule = {
  key: 'amazon_affiliate_pr_spam',
  description:
    '自身の最近の投稿の大半が、PR 開示と高い確度で判断できる Amazon アソシエイトリンクを組み合わせた誘導で占められている',
  version: '1.1.0',
  // 新規ルールの追加だけで既存アカウント全件が stale 扱いになることを避けるため、
  // version 変更だけでは scanForStaleAccounts の対象にしない。
  excludeFromStaleScan: true,
  evaluate(bundle) {
    const ownPosts = bundle.recentTweets.filter((t) => !t.isReply && !t.isRetweet)
    const assessablePosts = ownPosts.filter((t) => t.cardDestinationUrlsEvaluated === true)
    const matchedPosts = assessablePosts.filter(
      (t) => hasAmazonAffiliateEvidence(t) && hasPrEvidence(t),
    )

    const own = ownPosts.length
    const assessable = assessablePosts.length
    const matched = matchedPosts.length
    const coverage = own > 0 ? assessable / own : 0
    const matchedRatio = assessable > 0 ? matched / assessable : 0

    const prEvidenceCount = ownPosts.filter((t) => hasPrEvidence(t)).length
    const affiliateEvidenceCount = ownPosts.filter((t) => hasAmazonAffiliateEvidence(t)).length
    const cardAffiliateEvidenceCount = ownPosts.filter((t) => hasCardAffiliateEvidence(t)).length

    const hasEnoughSample = own >= MIN_OWN_POSTS && coverage >= COVERAGE_THRESHOLD
    const value =
      hasEnoughSample && matched >= MIN_MATCHED && matchedRatio >= MATCHED_RATIO_THRESHOLD

    const evidenceScore = combineRequired([
      rampScore(own, MIN_OWN_POSTS, MIN_OWN_POSTS),
      posteriorProbabilityAtLeast(assessable, own, COVERAGE_THRESHOLD),
      rampScore(matched, MIN_MATCHED, MIN_MATCHED),
      posteriorProbabilityAtLeast(matched, assessable, MATCHED_RATIO_THRESHOLD),
    ])

    // recentTweets が未取得の場合、単にサンプル・カバレッジが足りないだけの陰性とは区別する。
    const evaluable = hasEnoughSample && isRecentTweetsEvaluable(bundle)
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `prEvidence=${prEvidenceCount}/${own}, affiliateEvidence=${affiliateEvidenceCount}/${own}, cardAffiliateEvidence=${cardAffiliateEvidenceCount}/${own}, matched=${matched}/${assessable} (ratio=${matchedRatio.toFixed(2)}), coverage=${coverage.toFixed(2)} (n=${own})`,
      evaluable,
    }
  },
}
