import type { LabelRule } from '../types'

// 英単語は無関係な複合語の内部に一致しないよう単語境界で判定し、
// 日本語は単語境界の概念が同様には成り立たないため部分一致のままとしている。
//
// プログラマ/プログラミングは、
// プログラム という語幹のみで判定すると、
// アフィリエイトプログラムやマイルプログラムなど技術と無関係な用法まで一致してしまうため、
// 具体的な語形に限定している。
//
// engineer は分野を問わずあらゆる技術者に使われる語であるため、
// 土木・機械・音響などソフトウェア以外の分野を示す語が直前にある場合は除外している。
// 該当分野のエンジニアであっても software/developer 等の他の技術シグナルを bio に含む場合は、
// それらの語で引き続き一致する。
const NON_SOFTWARE_ENGINEER_DISCIPLINE =
  'civil|mechanical|electrical|chemical|structural|controls?|audio|sound|recording|mixing|mastering|aerospace|industrial|process|petroleum|mining|nuclear|marine|agricultural|biomedical|automotive'

const TECH_PATTERN = new RegExp(
  String.raw`\b(developer|(?<!\b(?:${NON_SOFTWARE_ENGINEER_DISCIPLINE})[\s-])engineer|software|full[\s-]?stack)|エンジニア|プログラマ|プログラミング|開発者`,
  'i',
)

export const topicTechRule: LabelRule = {
  key: 'topic_tech',
  description: 'プロフィールで技術/ソフトウェア開発を中心的な関心事として挙げている',
  version: '1.2.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const value = bio !== null && TECH_PATTERN.test(bio)
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio tech-keyword match=${value}`,
    }
  },
}
