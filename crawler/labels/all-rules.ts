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
import { templatedReplyNetworkRule } from './rules/templated-reply-network'
import { selfDuplicateReplyRule } from './rules/self-duplicate-reply'
import { replyFarmingRule } from './rules/reply-farming'
import { replyFloodingRule } from './rules/reply-flooding'
import { replyHijackSwarmRule } from './rules/reply-hijack-swarm'

/**
 * The canonical set of all label rules registered by the crawler. Both `runCrawlCycle`
 * (registration at crawl time) and `prisma/seed.ts` (LabelDefinition seeding on a fresh
 * database) must derive from this single list, so a rule added to one path is never
 * silently missing from the other.
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
  templatedReplyNetworkRule,
  selfDuplicateReplyRule,
  replyFarmingRule,
  replyFloodingRule,
  replyHijackSwarmRule,
]
