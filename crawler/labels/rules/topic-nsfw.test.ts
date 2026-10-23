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

  it('is true when a blog mention follows a genuine declaration', () => {
    expect(
      topicNsfwRule.evaluate(
        makeBundle({ bio: 'R18イラストを投稿しています。ブログも書いています。' }),
      ).value,
    ).toBe(true)
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
  it.each([
    'R18絵あり、無断転載禁止',
    'R18絵あり無断転載禁止',
    'R-18あり、苦手な方はブロックしてください',
    'R-18あり苦手な方はブロックしてください',
    'NSFW artist, minors DNI',
    'NSFW art account minors DNI',
    'R18イラストを描いています。未成年はフォローしないでね。DNI',
    'DNI if you are a minor. NSFW artist',
  ])('stays true for a self-declaration followed by unrelated refusal wording (%s)', (bio) => {
    expect(topicNsfwRule.evaluate(makeBundle({ bio })).value).toBe(true)
  })

  it.each(['R18リプ禁止', 'R-18G 禁止', 'R18の方はブロック'])(
    'is false when a short refusal noun precedes the prohibition (%s)',
    (bio) => {
      expect(topicNsfwRule.evaluate(makeBundle({ bio })).value).toBe(false)
    },
  )

  it.each([
    'NSFWも描きます、フォローいただけると嬉しいです',
    'R18絵を描いてます、ご依頼いただければ対応',
  ])('stays true when unrelated request wording follows a self-declaration (%s)', (bio) => {
    expect(topicNsfwRule.evaluate(makeBundle({ bio })).value).toBe(true)
  })

  it.each(['NSFW DNI', 'R18は禁止', 'NSFW投稿は禁止です', 'NSFW系はブロックします', 'DNI NSFW'])(
    'is false when the adult keyword itself is refused (%s)',
    (bio) => {
      expect(topicNsfwRule.evaluate(makeBundle({ bio })).value).toBe(false)
    },
  )

  it.each(['成人向け英会話を教えています', '2018禁煙に成功した'])(
    'is false for look-alike words that are not adult content (%s)',
    (bio) => {
      expect(topicNsfwRule.evaluate(makeBundle({ bio })).value).toBe(false)
    },
  )

  it.each([
    'R18の二次創作をもらうのが好きです',
    'NSFWのファンアートを頂くことがあります',
    'R-18絵をいただけると嬉しいです',
  ])('is false when adult content is only received from others (%s)', (bio) => {
    expect(topicNsfwRule.evaluate(makeBundle({ bio })).value).toBe(false)
  })

  it.each([
    'R18は → https://example.com/alice_sub',
    'NSFW→https://example.com/alice_sub',
    'R18垢 x.com/alice_sub',
    '18禁はこちら https://example.com/alice_sub',
  ])('is false for a bio that only redirects to an adult account by URL (%s)', (bio) => {
    expect(topicNsfwRule.evaluate(makeBundle({ bio })).value).toBe(false)
  })

  it('stays true for a company account that distributes adult videos', () => {
    expect(
      topicNsfwRule.evaluate(makeBundle({ bio: 'アダルト動画を配信する会社の公式アカウントです' }))
        .value,
    ).toBe(true)
  })

  it.each([
    'R18の話題は禁止です',
    'NSFWコンテンツは禁止です',
    'NSFW投稿は全部ブロックします',
    'NSFWの投稿は嫌なのでブロックします',
  ])('is false for an explicit prohibition with a direct-object noun (%s)', (bio) => {
    expect(topicNsfwRule.evaluate(makeBundle({ bio })).value).toBe(false)
  })

  it.each(['R18絵あり、無断転載禁止', 'R18イラスト投稿、未成年はブロック'])(
    'stays true when the restriction is unrelated to the NSFW word (%s)',
    (bio) => {
      expect(topicNsfwRule.evaluate(makeBundle({ bio })).value).toBe(true)
    },
  )

  it.each(['Minors DNI, NSFW artist', 'NSFW artist, minors DNI'])(
    'stays true when "DNI" addresses minors on either side of the NSFW word (%s)',
    (bio) => {
      expect(topicNsfwRule.evaluate(makeBundle({ bio })).value).toBe(true)
    },
  )

  it.each([
    'Hello 健全垢です。現メイン垢R18は(@alice_sub)',
    'Artist. Minor | NSFW ACCOUNTS DNI',
    'Artist. NSFW CONTENT DNI',
    'イラスト置き場。R18絵や他の作品はPixivにあります',
    'お絵描き。R18(少数)はPixiv https://t.co/exampleXXXX',
    '日常ポスト。アイコンは@alice_draw(※R18有)に描いて頂きました',
    '応援垢。副業、勧誘、投資、アダルト系、お金配り、ネットビジネス全く興味ありません',
  ])('is false for a redirect, rejection, or third-party mention (%s)', (bio) => {
    expect(topicNsfwRule.evaluate(makeBundle({ bio })).value).toBe(false)
  })

  it.each([
    'R18絵を投稿します。Pixivにも置いています',
    'NSFW artist. Minors DNI',
    'R18イラスト描きです。アダルト系依頼も受けます',
  ])('stays true for a genuine self-declaration near the new suppression words (%s)', (bio) => {
    expect(topicNsfwRule.evaluate(makeBundle({ bio })).value).toBe(true)
  })

  it.each([
    'R18は見ません',
    'R18の絵は描きません',
    'R18は苦手です',
    'R18はご遠慮ください',
    'NSFWは別垢で',
    '成人向けプログラミング教室を運営しています',
    '成人向け教育サービスの会社員です',
    '無修正の写真だけ載せます',
  ])('is false for a refusal, an unlinked redirect, or an unrelated usage (%s)', (bio) => {
    expect(topicNsfwRule.evaluate(makeBundle({ bio })).value).toBe(false)
  })

  it.each(['R18絵を投稿します', '無修正動画を紹介しています'])(
    'stays true for a genuine declaration near the new guards (%s)',
    (bio) => {
      expect(topicNsfwRule.evaluate(makeBundle({ bio })).value).toBe(true)
    },
  )
})
