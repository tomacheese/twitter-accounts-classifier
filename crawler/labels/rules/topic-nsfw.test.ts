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

  it('is false for abbreviated block phrase listing adult content as a block target', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: '雑談垢です。アダルト、勧誘、副業は即ブロ。' }))
        .value,
    ).toBe(false)
  })

  it('is false for denying 18+ talk with a negated verb', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: '日常と趣味の垢です。18禁な話はしてません。' }))
        .value,
    ).toBe(false)
  })

  it('is false for declaring that adult content is excluded with "なし"', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: 'ゲーム好きです。鍵垢と18禁系はなしで。' })).value,
    ).toBe(false)
  })

  it('is false for a bio that disclaims being an adult account with a "非" prefix', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: '規格の話をする非18禁アカです。' })).value,
    ).toBe(false)
  })

  it('is false for a bio saying adult art exists but not on this site', () => {
    expect(
      topicNsfwRule.evaluate(
        makeBundle({ bio: '絵を描きます。18禁絵も描きますがX内にはありません。' }),
      ).value,
    ).toBe(false)
  })

  it('is false for a bare alt-account pointer with an @ handle but no URL', () => {
    expect(topicNsfwRule.evaluate(makeBundle({ bio: '絵を描く人。R18垢 @alice_alt' })).value).toBe(
      false,
    )
  })

  it('is false for a bare alt-account pointer without spaces', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: '成人済 R18アカ@bob_alt 小説を書く' })).value,
    ).toBe(false)
  })

  it('is false for an English alt pointer', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: 'music fan / nsfw alt @carol_alt' })).value,
    ).toBe(false)
  })

  it('is false for a redirect with an arrow after a "とか" qualifier', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: '日常とか割と素→@dave NSFWとか→@erin_alt' })).value,
    ).toBe(false)
  })

  it('is false for an English "no NSFW" statement', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: 'No NSFW please. Cat photos only.' })).value,
    ).toBe(false)
  })

  it('is false for an English non-NSFW account statement', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: 'non-NSFW account about retro games' })).value,
    ).toBe(false)
  })

  it('is true for an English NSFW artist whose bio contains "drawing"', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: 'R18 art account, drawing daily' })).value,
    ).toBe(true)
  })

  it('is true for an English NSFW artist whose bio contains "posting"', () => {
    expect(topicNsfwRule.evaluate(makeBundle({ bio: 'NSFW artist posting lewd' })).value).toBe(true)
  })
})
