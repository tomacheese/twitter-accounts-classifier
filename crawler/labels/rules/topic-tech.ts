import type { LabelRule } from '../types'

// English terms are word-boundary-matched to avoid matching inside unrelated compound
// words (e.g. "engineer" inside the game title "spaceengineers" / "Space Engineers").
// Japanese terms are left as substring matches since word boundaries don't apply the
// same way to Japanese script.
//
// プログラマ/プログラミング (programmer/programming) are matched specifically rather than
// the bare substring プログラ, which also matches unrelated uses of プログラム ("program" as
// in "Amazonアソシエイトプログラム" affiliate program, "マイルプログラム" loyalty program,
// "プログラムマネージャー" project manager).
//
// "engineer" additionally excludes a preceding non-software engineering discipline
// (civil/mechanical/audio/controls/... engineer) via negative lookbehind: the bare term
// covers every engineering field, so without this exclusion any civil or audio engineer
// gets tagged as a software/tech account. A bio that also carries a software marker
// (software/developer/full-stack/エンジニア/...) still matches through those other terms.
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
