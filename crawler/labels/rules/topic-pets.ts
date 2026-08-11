import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 「猫背」「猫舌」「負け犬」「犬猿の仲」のような、動物と無関係な慣用句を避けるため、
// 単独の「猫」「犬」ではなく愛玩動物としての飼育・愛好を明示する複合語のみを対象とする。
// 「わんこ」「にゃんこ」は単独では同名ゲームのキャラクター・コミュニティ文脈と区別できないため対象から外す。
const PETS_PATTERN =
  /愛猫|愛犬|飼い猫|飼い犬|保護猫|保護犬|猫好き|犬好き|ねこ好き|いぬ好き|多頭飼い|\bpet\s*(?:lover|parent)\b/i

export const topicPetsRule: LabelRule = {
  key: 'topic_pets',
  description: 'プロフィールで猫・犬などペットの飼育・愛好を中心的な関心事として挙げている',
  version: '1.0.0',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && PETS_PATTERN.test(bio)
    const followGraphMatch = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_pets)
    const value = keywordMatch || followGraphMatch
    return {
      value,
      confidence: keywordMatch ? 0.8 : followGraphMatch ? 0.5 : 0,
      reason: `bio pets-keyword match=${keywordMatch}, follow-graph match=${followGraphMatch}`,
    }
  },
}
