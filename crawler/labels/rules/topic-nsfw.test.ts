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

  it('is false for an unrelated bio', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: '大阪のおばちゃん。フォローはご自由にどぞ' })).value,
    ).toBe(false)
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

  it('is true for a bio that self-declares adult content without a rejection/redirect phrase', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: 'アダルトグッズのレビューを投稿しています' })).value,
    ).toBe(true)
  })
})
