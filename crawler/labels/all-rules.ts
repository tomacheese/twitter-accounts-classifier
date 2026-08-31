import type { LabelRule } from './types'
import { verifiedBlueIndividualRule } from './rules/verified-blue-individual'
import { verifiedBlueCreatorRule } from './rules/verified-blue-creator'
import { verifiedBlueProfessionalBusinessRule } from './rules/verified-blue-professional-business'
import { parodyAccountRule } from './rules/parody-account'
import { commentaryAccountRule } from './rules/commentary-account'
import { fanAccountRule } from './rules/fan-account'
import { verifiedBusinessRule } from './rules/verified-business'
import { verifiedGovernmentRule } from './rules/verified-government'
import { spamRule } from './rules/spam'
import { adPromotedRule } from './rules/ad-promoted'
import { adPrHashtagRule } from './rules/ad-pr-hashtag'
import { amazonAffiliateLinkRule } from './rules/amazon-affiliate-link'
import { amazonAffiliatePromotedRule } from './rules/amazon-affiliate-promoted'
import { amazonAffiliatePrSpamRule } from './rules/amazon-affiliate-pr-spam'
import { adReplyHijackRule } from './rules/ad-reply-hijack'
import { replyLanguageMismatchRule } from './rules/reply-language-mismatch'
import { botRule } from './rules/bot'
import { aiGeneratedRule } from './rules/ai-generated'
import { tweetAiGeneratedMediaRule } from './rules/tweet-ai-generated-media'
import { videoRepostRule } from './rules/video-repost'
import { topicTechRule } from './rules/topic-tech'
import { topicFinanceRule } from './rules/topic-finance'
import { topicCryptoRule } from './rules/topic-crypto'
import { topicAnimeRule } from './rules/topic-anime'
import { topicGamingRule } from './rules/topic-gaming'
import { topicIdolRule } from './rules/topic-idol'
import { topicIllustrationRule } from './rules/topic-illustration'
import { topicVtuberRule } from './rules/topic-vtuber'
import { topicNsfwRule } from './rules/topic-nsfw'
import { topicPoliticsRule } from './rules/topic-politics'
import { topicSportsRule } from './rules/topic-sports'
import { topicMusicRule } from './rules/topic-music'
import { topicFoodRule } from './rules/topic-food'
import { topicMovieRule } from './rules/topic-movie'
import { topicParentingRule } from './rules/topic-parenting'
import { topicTravelRule } from './rules/topic-travel'
import { topicBeautyRule } from './rules/topic-beauty'
import { topicVrchatRule } from './rules/topic-vrchat'
import { topicPetsRule } from './rules/topic-pets'
import { topicFitnessRule } from './rules/topic-fitness'
import { templatedReplyNetworkRule } from './rules/templated-reply-network'
import { bioDuplicateNetworkRule } from './rules/bio-duplicate-network'
import { selfDuplicateReplyRule } from './rules/self-duplicate-reply'
import { replyFarmingRule } from './rules/reply-farming'
import { genericReplyFarmingRule } from './rules/generic-reply-farming'
import { replyFloodingRule } from './rules/reply-flooding'
import { crossTargetTemplatedReplyRule } from './rules/cross-target-templated-reply'
import { replyHijackSwarmRule } from './rules/reply-hijack-swarm'
import { scamLinkDomainRule } from './rules/scam-link-domain'
import { bareLinkSpamRule } from './rules/bare-link-spam'
// irrelevant_reply は無効化する。
// bigram 類似度では、話題に沿った通常のリプライと真に無関係なリプライを統計的に区別できないため。

/**
 * クローラーに登録される全ラベルルールの正規リスト。
 * `runCrawlCycle`（登録）と `prisma/seed.ts`（シード投入）の両方が単一リストを参照し、
 * 一方にだけルールを追加してもう一方に反映し忘れる事態を防ぐ。
 */
export const ALL_LABEL_RULES: LabelRule[] = [
  verifiedBlueIndividualRule,
  verifiedBlueCreatorRule,
  verifiedBlueProfessionalBusinessRule,
  parodyAccountRule,
  commentaryAccountRule,
  fanAccountRule,
  verifiedBusinessRule,
  verifiedGovernmentRule,
  spamRule,
  adPromotedRule,
  adPrHashtagRule,
  amazonAffiliateLinkRule,
  amazonAffiliatePromotedRule,
  adReplyHijackRule,
  replyLanguageMismatchRule,
  botRule,
  aiGeneratedRule,
  tweetAiGeneratedMediaRule,
  videoRepostRule,
  topicTechRule,
  topicFinanceRule,
  topicCryptoRule,
  topicAnimeRule,
  topicGamingRule,
  topicIdolRule,
  topicIllustrationRule,
  topicVtuberRule,
  topicNsfwRule,
  topicPoliticsRule,
  topicSportsRule,
  topicMusicRule,
  topicFoodRule,
  topicMovieRule,
  topicParentingRule,
  topicTravelRule,
  topicBeautyRule,
  topicVrchatRule,
  topicPetsRule,
  topicFitnessRule,
  templatedReplyNetworkRule,
  bioDuplicateNetworkRule,
  selfDuplicateReplyRule,
  replyFarmingRule,
  genericReplyFarmingRule,
  replyFloodingRule,
  crossTargetTemplatedReplyRule,
  replyHijackSwarmRule,
  scamLinkDomainRule,
  bareLinkSpamRule,
  amazonAffiliatePrSpamRule,
]
