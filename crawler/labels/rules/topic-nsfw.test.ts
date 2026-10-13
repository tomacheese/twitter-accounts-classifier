import { describe, expect, it } from 'vitest'
import { topicNsfwRule } from './topic-nsfw'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  accountOverrides: Partial<AccountFeatureBundle['account']>,
): AccountFeatureBundle {
  return {
    account: {
      id: '1',
      screenName: 'x',
      displayName: 'X',
      bio: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date(),
      isBlueVerified: false,
      verifiedType: null,
      ...accountOverrides,
    },
    recentTweets: [],
  }
}

describe('topicNsfwRule', () => {
  it('is true for a bio with an R-18 age-rating marker', () => {
    expect(topicNsfwRule.evaluate(makeBundle({ bio: 'R-18 成人向け創作垢です' })).value).toBe(true)
  })

  it('is true for an English NSFW bio', () => {
    expect(topicNsfwRule.evaluate(makeBundle({ bio: 'NSFW art account, 18+' })).value).toBe(true)
  })

  it('is false for an unrelated bio, with high confidence since no keyword evidence was found', () => {
    const result = topicNsfwRule.evaluate(
      makeBundle({ bio: '大阪のおばちゃん。フォローはご自由にどぞ' }),
    )
    expect(result.value).toBe(false)
    expect(result.confidence).toBe(1)
  })

  it('is false for a bio listing NSFW in a "do not interact" list', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: 'I AM A MINOR | DNI: nsfw accounts, bigots' }))
        .value,
    ).toBe(false)
  })

  it('is false for a bio placing NSFW before "DNI"', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: 'he/they | nsfw dni | i love my friends' })).value,
    ).toBe(false)
  })

  it('is false for a bio declaring it does not support NSFW', () => {
    expect(
      topicNsfwRule.evaluate(
        makeBundle({ bio: 'hi, i like to make stuff. I do not support: Nsfw, Ai, Tracing' }),
      ).value,
    ).toBe(false)
  })

  it('is false for a Japanese bio declaring R18 topics are off-limits', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: '日々の話題を発信中！政治、R18の話題は✖です' }))
        .value,
    ).toBe(false)
  })

  it('is true for an NSFW artist whose "DNI" addresses minors rather than NSFW', () => {
    expect(
      topicNsfwRule.evaluate(
        makeBundle({ bio: '🔞NSFW Artist 🔞 | All Ocs are Adults | MINORS DNI!' }),
      ).value,
    ).toBe(true)
  })

  it('is false when an all-ages profile redirects adult content to another account by URL', () => {
    expect(
      topicNsfwRule.evaluate(
        makeBundle({
          bio: '一般向けの絵を投稿。成人向け作品は別アカウントはこちら https://example.test/alt',
        }),
      ).value,
    ).toBe(false)
  })

  it('is false when an all-ages profile links to its adult account with a descriptive label', () => {
    expect(
      topicNsfwRule.evaluate(
        makeBundle({ bio: '一般向けイラスト。🔞成人向け垢🔞→【https://example.test/alt】' }),
      ).value,
    ).toBe(false)
  })

  it('is true for a bio linking an NSFW alt account alongside a "minors dni" notice', () => {
    expect(
      topicNsfwRule.evaluate(
        makeBundle({ bio: 'illustrator, gym rat. nsfw @alt_example. minors dni' }),
      ).value,
    ).toBe(true)
  })

  it('is false for a Japanese bio prose-declining adult-related interaction', () => {
    expect(
      topicNsfwRule.evaluate(
        makeBundle({
          bio: 'アニメと猫が好きな雑談アカウントです。気軽にフォローしてください。アダルト系の話題はNGでお願いします🙏',
        }),
      ).value,
    ).toBe(false)
  })

  it('is false for a bio listing an NSFW term among things it reports and blocks', () => {
    expect(
      topicNsfwRule.evaluate(
        makeBundle({
          bio: '怪しい勧誘は苦手です。アダルトやスパムのDMは運営へ報告してからブロックしています。',
        }),
      ).value,
    ).toBe(false)
  })

  it('is false for an all-ages bio that redirects adult content to a separate account', () => {
    expect(
      topicNsfwRule.evaluate(
        makeBundle({
          bio: 'ゲーム実況が好きなアカウントです。全年齢向けの内容のみ投稿しています。成人向け→@fictional_sub_acct',
        }),
      ).value,
    ).toBe(false)
  })

  it('is false for a bio declaring it does not follow NSFW accounts', () => {
    expect(
      topicNsfwRule.evaluate(
        makeBundle({
          bio: 'ゲーム実況とお絵描きが好き。トラブルを避けたいのでNSFW系はフォローしません',
        }),
      ).value,
    ).toBe(false)
  })

  it('is false for a bio using the unrelated psychology term "アダルトチルドレン"', () => {
    expect(
      topicNsfwRule.evaluate(
        makeBundle({
          bio: '毒親育ちのアダルトチルドレン当事者です。心理学の勉強を発信しています。',
        }),
      ).value,
    ).toBe(false)
  })

  it('is false for a bio declining NSFW content using "拒否"', () => {
    expect(
      topicNsfwRule.evaluate(
        makeBundle({
          bio: 'イラスト垢です。NSFWは拒否します。フォローはご自由に。',
        }),
      ).value,
    ).toBe(false)
  })

  it('is false for a bio declaring it blocks NSFW accounts without a "報告" mention', () => {
    expect(
      topicNsfwRule.evaluate(
        makeBundle({
          bio: 'トイレ写真が好きな趣味垢です。アダルト系のアカウントはブロックします。',
        }),
      ).value,
    ).toBe(false)
  })

  it('is true for a bio that self-declares adult content without a rejection/redirect phrase', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: 'アダルトグッズのレビューを投稿しています' })).value,
    ).toBe(true)
  })

  it('is false for an adult-products business account that mentions its product category only', () => {
    expect(
      topicNsfwRule.evaluate(
        makeBundle({ bio: '成人向け商品の公式ショップです。新商品を販売しています。' }),
      ).value,
    ).toBe(false)
  })

  it('is false for a fighting-game bio whose Master Rank number happens to contain "R18"', () => {
    expect(
      topicNsfwRule.evaluate(
        makeBundle({ bio: '格ゲー勢。最高ランクMR1823で燃え尽きました。フォローはご自由に' }),
      ).value,
    ).toBe(false)
  })

  it('is false for a bio whose product model code happens to contain "R18"', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: '愛用カメラはAR18です。散歩と写真が趣味' })).value,
    ).toBe(false)
  })

  it('is false for a bio whose model number happens to start with "R18" followed by more digits', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: '愛用レンズはR1850です。散歩と写真が趣味' })).value,
    ).toBe(false)
  })

  it('is true when a genuine self-declaration coexists with an unrelated rejection mention elsewhere in the bio', () => {
    expect(
      topicNsfwRule.evaluate(
        makeBundle({
          bio: 'R18同人作家です。仕事の勧誘目的のアダルトDMは受け付けません。',
        }),
      ).value,
    ).toBe(true)
  })

  it.each([
    'イラストを描いています。R18目的のフォローは厳禁です',
    '雑多垢です。18禁アカウント：@alice_sub',
    '雑多垢です。18禁もの投稿用→@alice_sub',
    '日常垢です。NSFW（@alice_sub）',
    '雑多垢です。R18弟@alice_sub',
    '雑多垢です。R-18はサブサイトにて公開しています',
    '雑多垢です。R18はpixivにて公開しています',
    '家族みんなでやってます @alice_R18 @bob_nsfw',
    '日常垢です。18禁もの投稿用(未成年の方はご遠慮ください)→@alice_sub',
    '家族設定 お母さん　ほげ（R18）(a)alice_sub',
    '投資家です。初18禁ゲーム：架空タイトル｜アプリ：架空ゲーム',
    '年中無休のネットカフェ。映画・アニメ・アダルト無料で見放題！',
    'お絵描きしています。NSFWや近しい表現はサブアカウントにて対応します。',
  ])('is false for a bio that rejects or redirects adult content (%s)', (bio) => {
    expect(topicNsfwRule.evaluate(makeBundle({ bio })).value).toBe(false)
  })

  it('stays true for a self-declaration even when a redirect handle appears elsewhere', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: 'R18イラストを投稿しています。連絡は @alice_sub' }))
        .value,
    ).toBe(true)
  })

  it.each([
    'NSFW drawings and art',
    'R18イラストを描いています。未成年の方はフォロー厳禁',
    'R18絵を描いています。無断転載禁止',
    'R-18あり。苦手な方はブロックしてください',
    'NSFWアカです。未成年NG',
    'R18です@alice_sub',
  ])('is true for a self-declaration that is not a rejection or redirect (%s)', (bio) => {
    expect(topicNsfwRule.evaluate(makeBundle({ bio })).value).toBe(true)
  })
})
