import { classifyAmazonAffiliateUrl } from '../amazon-affiliate-url'
import { toConfidence } from '../confidence'
import { hasPrDisclosure } from '../pr-disclosure'
import { isRecentTweetsEvaluable } from '../recent-tweets-evaluable'
import type { LabelRule } from '../types'

// amzn.to は一般ユーザーも商品共有で使う短縮 URL のため、単独 1 回では陽性にしない。
// 商品文脈の語を伴うか、複数ツイートに繰り返し現れる場合のみ陽性とする。
// PR 開示や有償プロモーション表記は商品語を含まなくても広告投稿の根拠になるため、文脈として扱う。
// 単独の「円」「買っ」は日常会話にも現れ、リンクを共有しただけの投稿まで陽性にするため含めない。
const PRODUCT_CONTEXT_PATTERN =
  /商品|購入|価格|値段|[¥￥]|セール|クーポン|レビュー|おすすめ|オススメ|ポチ/u
const SHORT_LINK_MIN_TWEETS = 2

export const amazonAffiliateLinkRule: LabelRule = {
  key: 'amazon_affiliate_link',
  description:
    '自身の最近の投稿に、Amazonアソシエイト由来と高い確度で判断できるリンクが含まれている。tag 付きの Amazon リンクは 1 件で陽性とし、amzn.to 短縮リンクは商品文脈または PR 開示を伴うか複数ツイートに現れる場合のみ陽性とする',
  version: '1.3.0',
  evaluate(bundle) {
    let shortLinkTweetCount = 0
    let hasContext = false
    let firstShortLink: { tweetId: string; host: string } | undefined
    for (const tweet of bundle.recentTweets) {
      if (tweet.isRetweet) continue

      let hasShortLink = false
      for (const url of tweet.expandedUrls ?? []) {
        const evidence = classifyAmazonAffiliateUrl(url)
        if (!evidence) continue

        if (evidence.kind === 'associate-tag') {
          return {
            value: true,
            confidence: toConfidence(true, 1),
            reason: `tweet=${tweet.id}, evidence=${evidence.kind}, host=${evidence.host}`,
          }
        }

        if (hasShortLink) continue
        hasShortLink = true
        shortLinkTweetCount++
        firstShortLink ??= { tweetId: tweet.id, host: evidence.host }
        hasContext ||=
          PRODUCT_CONTEXT_PATTERN.test(tweet.fullText) ||
          hasPrDisclosure(tweet.fullText) ||
          tweet.isPaidPromotion
      }
    }

    if (firstShortLink && (hasContext || shortLinkTweetCount >= SHORT_LINK_MIN_TWEETS)) {
      return {
        value: true,
        confidence: toConfidence(true, 0.9),
        reason: `tweet=${firstShortLink.tweetId}, evidence=associates-short-link, host=${firstShortLink.host}, shortLinkTweets=${shortLinkTweetCount}`,
      }
    }

    // recentTweets が未取得の場合、単に一致が無いだけの陰性とは区別する。
    const evaluable = isRecentTweetsEvaluable(bundle)
    return {
      value: false,
      confidence: toConfidence(false, 0, evaluable),
      reason: firstShortLink
        ? 'single amzn.to link without product context'
        : 'no Amazon affiliate link evidence',
      evaluable,
    }
  },
}
