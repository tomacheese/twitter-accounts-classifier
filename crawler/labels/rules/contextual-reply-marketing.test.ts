import { describe, expect, it } from 'vitest'
import { ALL_LABEL_RULES } from '../all-rules'
import type { AccountFeatureBundle, LabelRule } from '../types'

function getRule(): LabelRule {
  const rule = ALL_LABEL_RULES.find((candidate) => candidate.key === 'contextual_reply_marketing')
  if (!rule) throw new Error('contextual_reply_marketing is not registered')
  return rule
}

// 本番で観測された低頻度アーキタイプ (直近19投稿, 外部リプライ6・オリジナル13) を、
// 特定の話題語にはハードコードせず複数話題にまたがる自己ポジショニングの反復として再現する。
const SELF_POSITIONING_REPLY_TEXTS = [
  '在宅ワークを始めたばかりの頃は本当に大変でしたよね。自分も最初はペース配分が全然分からなくて苦労しました。少しずつ慣れていくものだと思います。',
  '引っ越し準備、本当にお疲れさまです。フリーランスとして働く自分からすると、生活拠点を整える大切さはよく分かります。無理せず進めてくださいね。',
  '資格の勉強、根気がいりますよね。会社員から独立した自分の立場では、学び直しの大変さは身に染みて分かります。応援しています。',
  '初めての一人暮らし、緊張しますよね。地方から出てきた自分も、最初の数ヶ月は環境に慣れるだけで精一杯でした。少しずつ楽になっていきますよ。',
  '犬のしつけ、根気強く向き合っていて素敵です。ペットを飼い始めたばかりの自分としても、毎日の積み重ねの大切さを実感しています。',
  '転職活動、大変な時期ですね。何度か転職を経験した自分からすると、焦らず自分に合う環境を探すのが一番だと思います。',
]

function makeReactionControlledReplyTexts(genericReaction: boolean): string[] {
  const controlledPhrase = genericReaction ? '大変でした' : '記録したよ'
  return Array.from(
    { length: 6 },
    (_, index) =>
      `自分も在宅勤務を始めた時期があり、${controlledPhrase}。朝に机へ向かう時間を固定して、作業の区切りごとに休憩を入れ、週ごとに予定を見直していました。番号${index}`,
  )
}

// 主語省略の自己経験ブリッジ (「以前/昔」+節頭) は、一人称語を伴わない第三者主語の経験談まで誤検出しないよう、
// 「以前友人が/以前同僚が/以前先輩が/以前知人が」のように節頭直後に第三者主語 (Xが/Xは) を挟む形を除外している。
// その挙動を確認する回帰 fixture。
const THIRD_PARTY_SUBJECT_OMITTED_REPLY_TEXTS = [
  '以前友人が同じ経験をしたことがあるので今回は当てはまらないかもしれませんが、状況を聞いて色々と考えさせられました。無理せず進めてほしいと思います。',
  '以前同僚が似た経験をしたことがあるらしく、大変だったと聞きました。聞いているだけでも大変さが伝わってきて、応援したくなりました。',
  '以前先輩が同様のトラブルを経験したそうで、詳しく話を聞いたことがあります。その時の対処法も参考になりそうなので、機会があれば共有したいです。',
  '以前知人が近い状況を経験したことがあるみたいで、当時の話を色々聞かせてもらいました。今回の件にも役立つ工夫があったので参考になりそうです。',
]

// 一人称語は「以前」より前の無関係な挿入句 (「〜にも無関係で」) の中だけに現れ、
// 経験の主体は「以前」より後ろの第三者主語 (Xが) になる自己経験ブリッジを再現する。
// 一人称語と「以前」のあいだの第三者主語は既存の否定先読みで除外できるが、
// 「以前」より後ろの第三者主語は対象外であるべきで、これを自己ポジショニングとして扱わない。
const FIRST_PERSON_UNRELATED_ASIDE_BEFORE_THIRD_PARTY_AFTER_REPLY_TEXTS = [
  '在宅ワークの大変さ、分かります。自分にも無関係で以前友人が同じ経験をしたと聞きました。少しずつ慣れていくものだと思います。',
  '引っ越し準備、お疲れさまです。自分にも無関係で以前同僚が同じ経験をしたと聞きました。無理せず進めてくださいね。',
  '資格の勉強、根気がいりますよね。自分にも無関係で以前先輩が同じ経験をしたと聞きました。応援しています。',
  '初めての一人暮らし、緊張しますよね。自分にも無関係で以前知人が同じ経験をしたと聞きました。少しずつ楽になっていきますよ。',
]

// 主語省略の自己経験ブリッジでは、「以前は/昔は」の時間表現につく係助詞「は」を許容する。
// これは第三者主語 (Xが/Xは) とは別で、真の主語省略を示す自然な言い回しである。
const TOPIC_MARKED_SUBJECT_OMITTED_REPLY_TEXTS = [
  '以前は在宅ワークで似た働き方を経験したことがあるので、大変さがよく分かります。慣れるまで数か月かかりました。',
  '昔は資格勉強で同じようなことをやっていたので、根気が要る大変さがよく分かります。少しずつ続けることが大事だと思います。',
  '以前は引っ越し準備で近い状況を経験したことがあるので、荷造りの大変さがよく分かります。無理せず進めてください。',
  '昔は一人暮らしの家事を同じようにやっていたので、慣れないうちの大変さがよく分かります。少しずつ楽になりますよ。',
]

const PLAIN_EMPATHY_REPLY_TEXTS = [
  '在宅ワークを始めたばかりの頃は本当に大変ですよね。少しずつ慣れていくものだと思いますので、無理せず頑張ってください。',
  '引っ越し準備、本当にお疲れさまです。新しい生活が落ち着くまで大変だと思いますが、応援しています。',
  '資格の勉強、根気がいりますよね。コツコツ続けているのがすごいと思います。応援しています。',
  '初めての一人暮らし、緊張しますよね。少しずつ環境に慣れていくと思うので、無理せず過ごしてくださいね。',
  '犬のしつけ、根気強く向き合っていて素敵です。毎日の積み重ねが大切だと思います。応援しています。',
  '転職活動、大変な時期ですね。焦らず自分に合う環境が見つかるといいですね。応援しています。',
]

function makeBundle(
  options: {
    replyTexts?: string[]
    originalCount?: number
    sampleSize?: number
    lifetimePerDay?: number
    intervalMinutes?: number
    verifiedType?: string | null
    professionalType?: string | null
    resolvedReplyCount?: number
    originalTextFactory?: (index: number) => string
    parentAuthorIds?: string[]
    accountAgeDays?: number
    originalExternalUrlCount?: number
    originalXUrlCount?: number
  } = {},
): AccountFeatureBundle {
  const replyTexts = options.replyTexts ?? SELF_POSITIONING_REPLY_TEXTS
  const replyCount = replyTexts.length
  const originalTextFactory =
    options.originalTextFactory ??
    ((index: number) => `今日の出来事メモその${index}。特に変わったことはなかった一日でした。`)
  const sampleSize = options.sampleSize ?? replyCount + (options.originalCount ?? 13)
  const lifetimePerDay = options.lifetimePerDay ?? 3.4
  const intervalMinutes = options.intervalMinutes ?? 655
  const resolvedReplyCount = options.resolvedReplyCount ?? replyCount
  const now = Date.now()
  const ageDays = options.accountAgeDays ?? 200

  return {
    account: {
      id: 'acct-1',
      screenName: 'sample',
      displayName: 'Sample',
      bio: null,
      followersCount: 300,
      followingCount: 200,
      tweetCount: Math.round(lifetimePerDay * ageDays),
      accountCreatedAt: new Date(now - ageDays * 24 * 60 * 60 * 1000),
      isBlueVerified: false,
      verifiedType: options.verifiedType ?? null,
      professionalType: options.professionalType ?? null,
    },
    recentTweets: Array.from({ length: sampleSize }, (_, index) => {
      const isReply = index < replyCount
      const hasResolvedParent = isReply && index < resolvedReplyCount
      const originalIndex = index - replyCount
      const expandedUrls =
        !isReply && originalIndex < (options.originalExternalUrlCount ?? 0)
          ? [`https://example.com/posts/${originalIndex}`]
          : !isReply && originalIndex < (options.originalXUrlCount ?? 0)
            ? [`https://x.com/sample/status/${1000 + originalIndex}`]
            : []
      return {
        id: `tweet-${index}`,
        fullText: isReply ? replyTexts[index] : originalTextFactory(index),
        createdAt: new Date(now - index * intervalMinutes * 60 * 1000),
        retweetCount: 0,
        likeCount: 0,
        isReply,
        isRetweet: false,
        isPromoted: false,
        isPaidPromotion: false,
        expandedUrls,
        cardDestinationUrls: [],
        inReplyToTweetId: isReply ? `parent-${index}` : null,
        parentTweetFullText: isReply ? `parent text ${index}` : null,
        parentTweetAuthorId: hasResolvedParent
          ? (options.parentAuthorIds?.[index] ?? `parent-author-${index}`)
          : null,
      }
    }),
  }
}

// 低頻度・高多様性アーキタイプを、日本語と中国語の自己経験表現を織り交ぜて再現する。
// 直近速度が加速していても lifetime 側の頻度が閾値内であれば検出対象になる。
const BROADER_MULTILINGUAL_SELF_EXPERIENCE_REPLY_TEXTS = [
  '在宅ワークへの切り替え、大変でしたよね。自分は以前まったく同じ働き方で苦労した時期があり、気持ちがよく分かります。当時は生活リズムを整え直すのに何ヶ月もかかりました。',
  '引っ越し準備お疲れさまです。以前近い状況を経験したことがあるので、荷造りの大変さは身に染みて分かります。段ボールの数が想像以上に増えて途方に暮れた記憶があります。',
  '資格の勉強、根気がいりますよね。今も似た教材を使っている身として、モチベーション維持の難しさに共感します。毎日少しずつでも机に向かう習慣づけが一番大変でした。',
  '一人暮らしを始めたばかりの頃、自分は以前やっていたことなので緊張する気持ちがよく分かります。少しずつ慣れますよ。最初の一ヶ月は炊事も洗濯も手探りでした。',
  '犬のしつけ、根気強く向き合っていて素敵ですね。以前ペットのしつけで似たような苦労を経験したことがあります。トイレの失敗が続いて落ち込んだ時期もありました。',
  '转行确实需要勇气,我之前也经历过类似的迷茫期,一开始很不适应,但慢慢找到了自己的节奏。刚开始那几个月每天都在怀疑自己的选择,后来慢慢调整了心态,才逐渐找回信心。',
  '搬家真的很辛苦,我自己之前搬过好几次家,收拾行李的疲惫感我完全能体会。每次打包到深夜才发现东西比想象中多了很多,真的很累人,还得花时间重新分类整理。',
  '备考的过程很磨人,我也用过类似的学习方法,坚持下来确实不容易。每天挤时间复习,遇到瓶颈的时候特别容易怀疑自己是不是方法不对,后来调整了节奏才好一些。',
  '第一次独居会紧张很正常,我一直记得自己刚独居时手忙脚乱的样子,慢慢就好了。连简单的做饭和采购都要花很久才能摸索出节奏,厨房收纳也是慢慢才理顺的。',
  '养宠物需要耐心,我之前养猫的时候也经历过类似的磨合期,能体会你的心情。刚开始磨合的那段时间真的很考验耐心,后来慢慢就顺了,现在回想也是宝贵的经历。',
  '在宅ワークのペース配分、自分は以前かなり苦戦した経験があります。少しずつ整えていけば大丈夫だと思います。最初は仕事と休憩の境目が曖昧になって疲れが抜けませんでした。',
  '転職活動は不安になりますよね。以前転職を経験したことがあるので、焦らず進めてほしいと思います。書類選考でなかなか通らず落ち込んだ時期を思い出します。',
  '独学は孤独になりがちですよね。似た教材を使っている身として、続けるコツは小さな達成感の積み重ねだと思います。一人で進めていると心が折れそうになる瞬間が何度もありました。',
  '搬家收拾行李真的很累,我之前也搬过家,深有同感。整理旧物的时候总会花掉比预期多好几倍的时间和精力,还容易舍不得丢掉旧东西。',
  '换工作的焦虑很正常,我自己之前也换过几次工作,慢慢都会适应的。每次换工作前的那段等待期都让人特别焦虑不安,连睡眠都受到影响。',
  '备考期间的孤独感很真实,我一直用番茄工作法坚持下来,或许可以参考。长期一个人复习真的容易怀疑自己是否走在正确的方向上,情绪起伏也很大。',
  '养宠物初期的手忙脚乱我也经历过,现在回想起来都是很珍贵的回忆。当时半夜起来照顾的日子虽然辛苦,但现在想想都很值得,也让我更有耐心了。',
  '在宅ワークの孤独感、以前同じ働き方をやっていたので分かります。無理せず進めてくださいね。誰とも話さない日が続くと気持ちが沈みがちになりますよね。',
  '资格考试的压力很大,我之前也考过类似的证书,坚持下来就会看到成果。备考后期的心理压力真的很大,坚持到最后才发现值得,现在回头看也很有成就感。',
]

/** 直近速度が閾値を超えても、lifetime 側の頻度が閾値内であれば検出対象になる低頻度・高多様性アーキタイプの bundle を作る。 */
function makeMissedTargetArchetypeBundle(): AccountFeatureBundle {
  const parentAuthorIds = Array.from({ length: 19 }, (_, index) =>
    index === 18 ? 'parent-author-1' : `parent-author-${index + 1}`,
  )
  return makeBundle({
    replyTexts: BROADER_MULTILINGUAL_SELF_EXPERIENCE_REPLY_TEXTS,
    originalCount: 1,
    parentAuthorIds,
    lifetimePerDay: 5.7,
    intervalMinutes: 150, // 1440 / 150 = 9.6 recentTweetsPerDay、lifetime 側の hard gate 閾値(8)を超える速度。
    accountAgeDays: 200,
  })
}

// 一人称の自己経験マーカーを含まず、第三者の過去経験だけを反復する外部リプライ群。
// 第三者の「以前〜経験」は自己ポジショニングとして扱わない。
const THIRD_PERSON_PRIOR_EXPERIENCE_REPLY_TEXTS = [
  '在宅ワークの大変さについて、友人も以前同じような経験をしたと言っていて、慣れるまで数か月かかったそうです。少しずつ楽になっていくと思います。',
  '引っ越し準備、大変ですよね。彼女も以前似たような経験をしたことがあり、荷造りに何日もかかったと話していました。無理せず進めてくださいね。',
  '資格勉強、根気がいりますよね。同僚も以前同じような経験をしていて、毎日少しずつ続けるのが大事だったと言っていました。応援しています。',
  '初めての一人暮らし、緊張しますよね。先輩も以前似たような経験をしたそうで、最初の数か月は環境に慣れるだけで大変だったと聞きました。',
  '犬のしつけ、根気強く向き合っていて素敵です。知人も以前同じような経験をしていて、トイレの失敗が続いて苦労したと話していました。',
  '転職活動、大変な時期ですね。姉も以前似たような経験をしたことがあり、焦らず希望に合う環境を探すのが一番だったと言っていました。',
  '子育ての大変さ、よく分かります。部下も以前同じような経験をしていて、夜泣きが続いて寝不足だったと話していました。',
  '新しい職場に慣れるのは大変ですよね。後輩も以前似たような経験をしたことがあり、最初の一か月が一番つらかったと言っていました。',
  '節約生活、根気がいりますよね。上司も以前同じような経験をしていて、家計簿をつけ始めてから意識が変わったと話していました。',
  '語学学習、続けるのは大変ですよね。友人も以前似たような経験をしたそうで、毎日少しずつの積み重ねが大事だったと言っていました。',
  '引っ越し先探し、大変な作業ですよね。彼女も以前同じような経験をしていて、条件に合う物件を見つけるまで苦労したそうです。',
  '新生活の準備、慌ただしいですよね。同僚も以前似たような経験をしたことがあり、最初は何を揃えればいいか分からなかったと話していました。',
  '資格試験の結果待ち、緊張しますよね。先輩も以前同じような経験をしていて、結果が出るまで落ち着かなかったと言っていました。',
  'ペットのしつけ、根気がいりますよね。知人も以前似たような経験をしたことがあり、根気強く向き合って乗り越えたそうです。',
  '転職後の環境変化、大変ですよね。姉も以前同じような経験をしていて、新しい人間関係に慣れるまで時間がかかったと話していました。',
  '在宅勤務のペース配分、難しいですよね。部下も以前似たような経験をしたことがあり、休憩のタイミングを工夫していたそうです。',
  '一人暮らしの家事、大変ですよね。後輩も以前同じような経験をしていて、料理も洗濯も慣れるまで時間がかかったと言っていました。',
  '子どもの進学準備、慌ただしいですよね。上司も以前似たような経験をしたことがあり、情報収集に苦労したと話していました。',
  '資格の勉強と仕事の両立、大変ですよね。友人も以前同じような経験をしていて、隙間時間の使い方を工夫していたそうです。',
]

// 所有格越しの第三者主語は経験や利用の主体が自分自身ではないため、自己ポジショニングとして扱わない。
// 主語は一貫して第三者のまま話題だけを変える。
const GENITIVE_THIRD_PARTY_REPLY_TEXTS = [
  '在宅ワークの大変さ、分かります。自分の同僚が以前同じ経験をしたことがあり、苦労していたのを見ていました。',
  '引っ越し準備お疲れさまです。自分の友人が今もこのツールを使っている様子を見ていて、便利そうだと思いました。',
  '資格の勉強、根気がいりますよね。自分の同僚が以前同じ経験をして、合格まで時間がかかったと話していました。',
  '初めての一人暮らし、緊張しますよね。自分の友人が今もこのツールを使っているので、役立つかもしれません。',
  '犬のしつけ、素敵ですね。自分の同僚が以前同じ経験をしていて、苦労していた姿を覚えています。',
  '転職活動、大変な時期ですね。自分の友人が今もこのツールを使っているので、参考になるかもしれません。',
  '子育ての大変さ、よく分かります。自分の同僚が以前同じ経験をしたと話していました。',
  '新しい職場に慣れるのは大変ですよね。自分の友人が今もこのツールを使っているそうです。',
  '節約生活、根気がいりますよね。自分の同僚が以前同じ経験をしていたと聞きました。',
  '語学学習、続けるのは大変ですよね。自分の友人が今もこのツールを使っているらしいです。',
  '引っ越し先探し、大変な作業ですよね。自分の同僚が以前同じ経験をしていました。',
  '新生活の準備、慌ただしいですよね。自分の友人が今もこのツールを使っています。',
  '資格試験の結果待ち、緊張しますよね。自分の同僚が以前同じ経験をしたそうです。',
  'ペットのしつけ、根気がいりますよね。自分の友人が今もこのツールを使っているみたいです。',
  '転職後の環境変化、大変ですよね。自分の同僚が以前同じ経験をしていたらしいです。',
  '在宅勤務のペース配分、難しいですよね。自分の友人が今もこのツールを使っていると言っていました。',
  '一人暮らしの家事、大変ですよね。自分の同僚が以前同じ経験をしたと言っていました。',
  '子どもの進学準備、慌ただしいですよね。自分の友人が今もこのツールを使っているとのことです。',
  '資格の勉強と仕事の両立、大変ですよね。自分の同僚が以前同じ経験をしていたようです。',
]

// 一人称語や中国語マーカーを含まず、主語省略でも一人称の経験として読める日本語構文だけを反復する。
// 「以前〜経験した」「今も〜している身として」「以前〜やっていた」を対象にする。
const OMITTED_SUBJECT_SELF_EXPERIENCE_REPLY_TEXTS = [
  '在宅ワークを始めたばかりの頃は本当に大変でしたよね。以前似た働き方を経験したことがあるので、気持ちがよく分かります。少しずつ慣れていくものだと思います。',
  '引っ越し準備、本当にお疲れさまです。今も近い道具を使っている身として、荷造りの大変さはよく分かります。無理せず進めてくださいね。',
  '資格の勉強、根気がいりますよね。以前同じ教材をやっていたので分かります。学び直しの大変さは身に染みて分かります。応援しています。',
  '初めての一人暮らし、緊張しますよね。以前似た生活を経験したことがあるので、最初の数ヶ月の大変さが分かります。少しずつ楽になっていきますよ。',
  '犬のしつけ、根気強く向き合っていて素敵です。今もペットのしつけ教材を使っている身として、毎日の積み重ねの大切さを実感しています。',
  '転職活動、大変な時期ですね。以前転職をやっていたので分かります。焦らず合う環境を探すのが一番だと思います。',
]

// 低頻度・高多様性アーキタイプを、節冒頭の主語省略自己経験ブリッジだけで再現する。
const LOW_FREQUENCY_OMITTED_SUBJECT_SELF_EXPERIENCE_REPLY_TEXTS = [
  ...OMITTED_SUBJECT_SELF_EXPERIENCE_REPLY_TEXTS,
  '節約生活を続けるの、根気がいりますよね。以前同じような暮らし方をしていたので分かります。家計簿をつける習慣が身につくまでかなり時間がかかりました。',
  '語学学習、継続するのは大変ですよね。今も同じ教材を使っている身として、毎日少しずつの積み重ねが大事だと感じています。単語を忘れてしまう日もあり根気が必要です。',
  'ランニングを始めたばかりなんですね。以前同じ辛さを経験したことがあるので、最初のきつさはよく分かります。少しずつ距離が伸びていくので焦らなくて大丈夫です。',
  '掃除の習慣づけ、大変ですよね。以前同じように苦労した経験があるので分かります。曜日ごとに分担を決めると続けやすくなりますよ。',
  '筋トレを始めたところなんですね。今も同じメニューを使っている身として、最初の数週間の筋肉痛はよく覚えています。少しずつ体が慣れていきますよ。',
  '読書記録をつけ始めたんですね。以前同じ習慣を経験したことがあるので分かります。続けるコツは無理に多く読まないことだと思います。',
  '貯金の計画、根気がいりますよね。以前似た目標で節約をやっていたので分かります。小さな成功体験を積み重ねるのが大事だと思います。',
  '育児の大変さ、よく分かります。今も似た育児グッズを使っている身として、夜泣きが続く時期のつらさを実感しています。少しずつ楽になっていくと思います。',
  '副業を始めたばかりなんですね。以前同じような働き方を経験したことがあるので分かります。時間配分の難しさがよく分かります。',
  '旅行の計画、楽しみですね。以前似たような旅行を計画した経験があるので、事前準備の大変さはよく分かります。無理せず進めてくださいね。',
  '睡眠改善に取り組んでいるんですね。今も同じ習慣を継続している身として、最初は効果が見えにくくて焦りました。少しずつ実感できるようになりますよ。',
  '料理のレパートリーを増やしたいんですね。以前似たレシピ本をやっていたので分かります。最初は失敗も多かったですが、続けるうちにコツがつかめてきました。',
  '転居後の片付け、大変ですよね。今も同じ収納グッズを使っている身として、物を減らす難しさがよく分かります。少しずつ整理していけば大丈夫だと思います。',
]

// 一人称に触れた直後、同じ節で別の「Xが」主語へ切り替わる第三者経験・利用を再現する。
// 経験・利用の主体が第三者なら自己ポジショニングとして扱わない。
const NON_GENITIVE_THIRD_PARTY_SAME_CLAUSE_REPLY_TEXTS = [
  '在宅ワークの大変さについては自分には関係ないですが後輩が以前同じような経験をしたことがあるそうで、慣れるまで数か月かかったと聞いています。',
  '引っ越し準備の大変さについては自分には関係ないですが友人が今も同じアプリを使っているそうで、便利だと話していました。',
  '資格の勉強の大変さについては自分には関係ないですが同僚が以前同じような経験をしたことがあるそうで、毎日少しずつ続けるのが大事だったと言っていました。',
  '一人暮らしの大変さについては自分には関係ないですが先輩が今も同じグッズを使っているそうで、かなり助かっていると話していました。',
  '犬のしつけの大変さについては自分には関係ないですが知人が以前同じような経験をしたことがあるそうで、根気強く向き合って乗り越えたと話していました。',
  '転職活動の大変さについては自分には関係ないですが部下が今も同じアプリを使っているそうで、求人の質が良いと話していました。',
  '子育ての大変さについては自分には関係ないですが上司が以前同じような経験をしたことがあるそうで、夜泣きが続いて寝不足だったと話していました。',
  '新しい職場に慣れる大変さについては自分には関係ないですが姉が今も同じアプリを使っているそうで、操作が分かりやすいと話していました。',
  '節約生活の大変さについては自分には関係ないですが妹が以前同じような経験をしたことがあるそうで、家計簿をつけ始めてから意識が変わったと話していました。',
  '語学学習の大変さについては自分には関係ないですが後輩が今も同じグッズを使っているそうで、毎日少しずつの積み重ねが大事だと言っていました。',
  '写真編集の練習の大変さについては自分には関係ないですが友人が以前同じような経験をしたことがあるそうで、仕上がりが違うと実感したと話していました。',
  'ランニングを続ける大変さについては自分には関係ないですが同僚が今も同じアプリを使っているそうで、記録が続けやすいと話していました。',
  '掃除の習慣づけの大変さについては自分には関係ないですが先輩が以前同じような経験をしたことがあるそうで、かなり楽になったコツを教えてくれました。',
  '育児グッズ選びの大変さについては自分には関係ないですが知人が今も同じグッズを使っているそうで、かなり助かっていると話していました。',
  '読書記録を続ける大変さについては自分には関係ないですが部下が以前同じような経験をしたことがあるそうで、続けやすいコツを教えてくれました。',
  '旅行の計画作りの大変さについては自分には関係ないですが上司が今も同じアプリを使っているそうで、比較がしやすいと話していました。',
  '健康管理を続ける大変さについては自分には関係ないですが姉が以前同じような経験をしたことがあるそうで、続けやすいコツを教えてくれました。',
  '瞑想の習慣づけの大変さについては自分には関係ないですが妹が今も同じグッズを使っているそうで、落ち着くと話していました。',
  '転職後の環境変化の大変さについては自分には関係ないですが後輩が以前同じような経験をしたことがあるそうで、新しい人間関係に慣れるまで時間がかかったと話していました。',
]

// 一人称に触れた直後、読点を挟まず別の「Xは」主語へ切り替わる第三者経験・利用を再現する。
// 所有格でも「Xが」でもない助詞「は」による主語切り替えを検証する。
const NON_GENITIVE_WA_MARKED_THIRD_PARTY_REPLY_TEXTS = [
  '在宅ワークの大変さは分かります。自分は元気で友人は以前同じような経験をしたそうで、慣れるまで数か月かかったと聞いています。少しずつ楽になっていくと思います。',
  '引っ越し準備の大変さは分かります。自分は無関係で友人は今も同じようなアプリを使っているそうで、荷物の管理が楽になったと話していました。',
  '資格の勉強の大変さは分かります。自分は無関係で同僚は以前同じような経験をしたそうで、毎日少しずつ続けるのが大事だったと言っていました。',
  '一人暮らしの大変さは分かります。自分は無関係で先輩は今も同じような家電を使っているそうで、かなり助かっていると話していました。',
  '犬のしつけの大変さは分かります。自分は無関係で知人は以前同じような経験をしたそうで、根気強く向き合って乗り越えたと話していました。',
  '転職活動の大変さは分かります。自分は無関係で部下は今も同じようなサービスを使っているそうで、求人の質が良いと話していました。',
  '子育ての大変さは分かります。自分は無関係で上司は以前同じような経験をしたそうで、夜泣きが続いて寝不足だったと話していました。',
  '新しい職場に慣れる大変さは分かります。自分は無関係で姉は今も同じようなアプリを使っているそうで、操作が分かりやすいと話していました。',
  '節約生活の大変さは分かります。自分は無関係で妹は以前同じような経験をしたそうで、家計簿をつけ始めてから意識が変わったと話していました。',
  '語学学習の大変さは分かります。自分は無関係で後輩は今も同じような教材を使っているそうで、毎日少しずつの積み重ねが大事だと言っていました。',
  '写真編集の練習の大変さは分かります。自分は無関係で友人は以前同じような経験をしたそうで、仕上がりが違うと実感したと話していました。',
  'ランニングを続ける大変さは分かります。自分は無関係で同僚は今も同じようなアプリを使っているそうで、記録が続けやすいと話していました。',
  '掃除の習慣づけの大変さは分かります。自分は無関係で先輩は以前同じような経験をしたそうで、かなり楽になったコツを教えてくれました。',
  '育児グッズ選びの大変さは分かります。自分は無関係で知人は今も同じようなグッズを使っているそうで、かなり助かっていると話していました。',
  '読書記録を続ける大変さは分かります。自分は無関係で部下は以前同じような経験をしたそうで、続けやすいコツを教えてくれました。',
  '旅行の計画作りの大変さは分かります。自分は無関係で上司は今も同じようなアプリを使っているそうで、比較がしやすいと話していました。',
  '健康管理を続ける大変さは分かります。自分は無関係で姉は以前同じような経験をしたそうで、続けやすいコツを教えてくれました。',
  '瞑想の習慣づけの大変さは分かります。自分は無関係で妹は今も同じようなグッズを使っているそうで、落ち着くと話していました。',
  '転職後の環境変化の大変さは分かります。自分は無関係で後輩は以前同じような経験をしたそうで、新しい人間関係に慣れるまで時間がかかったと話していました。',
]

describe('contextualReplyMarketingRule', () => {
  it('is registered', () => {
    expect(getRule()).toBeDefined()
  })

  it('detects the low-frequency contextual-reply archetype with repeated self-positioning', () => {
    const result = getRule().evaluate(makeBundle())

    expect(result.value).toBe(true)
    expect(result.evaluable).not.toBe(false)
    expect(result.reason).toContain('distinctParentAuthors=')
    expect(result.reason).toContain('distinctParentAuthorRatio=')
    expect(result.reason).toContain('genericReactionRatio=')
    expect(result.reason).toContain('originalExternalUrlRatio=')
    expect(result.reason).toContain('accountAgeDays=')
  })

  it('detects the "以前は/昔は" topic-marked form of the subject-omitted self-experience bridge', () => {
    const result = getRule().evaluate(
      makeBundle({ replyTexts: TOPIC_MARKED_SUBJECT_OMITTED_REPLY_TEXTS }),
    )

    expect(result.value).toBe(true)
  })

  it('does not label recurring conversations with too few distinct parent authors', () => {
    const result = getRule().evaluate(
      makeBundle({
        parentAuthorIds: ['friend-a', 'friend-a', 'friend-b', 'friend-b', 'friend-c', 'friend-c'],
      }),
    )

    expect(result.value).toBe(false)
  })

  it('does not label broad-looking reply activity when distinct parent author ratio is too low', () => {
    const result = getRule().evaluate(
      makeBundle({
        replyTexts: [...SELF_POSITIONING_REPLY_TEXTS, SELF_POSITIONING_REPLY_TEXTS[0]],
        originalCount: 12,
        parentAuthorIds: [
          'person-a',
          'person-b',
          'person-c',
          'person-d',
          'person-e',
          'person-a',
          'person-b',
        ],
      }),
    )

    expect(result.value).toBe(false)
  })

  it('does not label normal empathetic replies without repeated self-positioning', () => {
    const result = getRule().evaluate(makeBundle({ replyTexts: PLAIN_EMPATHY_REPLY_TEXTS }))

    expect(result.value).toBe(false)
  })

  it('does not label replies with self-positioning below the minimum occurrence count', () => {
    // 外部リプライ数(4)は MIN_EXTERNAL_REPLIES を満たすが、
    // 自己ポジショニングを含むのは2件のみ (MIN_SELF_POSITIONING_COUNT=3 未満) にする。
    const result = getRule().evaluate(
      makeBundle({
        replyTexts: [
          SELF_POSITIONING_REPLY_TEXTS[0],
          SELF_POSITIONING_REPLY_TEXTS[1],
          PLAIN_EMPATHY_REPLY_TEXTS[2],
          PLAIN_EMPATHY_REPLY_TEXTS[3],
        ],
        originalCount: 15,
      }),
    )

    expect(result.value).toBe(false)
  })

  it('does not label subject-omitted "以前/昔" bridges whose subject is a third party', () => {
    const result = getRule().evaluate(
      makeBundle({ replyTexts: THIRD_PARTY_SUBJECT_OMITTED_REPLY_TEXTS }),
    )

    expect(result.value).toBe(false)
  })

  it('does not label a self-experience bridge whose subject after "以前" is a third party, even with an unrelated first-person aside before it', () => {
    const result = getRule().evaluate(
      makeBundle({
        replyTexts: FIRST_PERSON_UNRELATED_ASIDE_BEFORE_THIRD_PARTY_AFTER_REPLY_TEXTS,
      }),
    )

    expect(result.value).toBe(false)
  })

  it('does not label question-driven dialogue even with self-positioning phrasing', () => {
    const result = getRule().evaluate(
      makeBundle({
        replyTexts: SELF_POSITIONING_REPLY_TEXTS.map((text) => `${text}どう思いますか？`),
      }),
    )

    expect(result.value).toBe(false)
  })

  it('does not label a creator who only posts original content without external replies', () => {
    const result = getRule().evaluate(
      makeBundle({
        replyTexts: [],
        originalCount: 19,
        originalTextFactory: (index) =>
          `新作の紹介です。詳しくはこちら https://example.com/works/${index}`,
      }),
    )

    expect(result.value).toBe(false)
  })

  it('does not label high-frequency posting even with the same self-positioning phrasing', () => {
    const result = getRule().evaluate(makeBundle({ lifetimePerDay: 60, intervalMinutes: 5 }))

    expect(result.value).toBe(false)
  })

  it('does not label verified business accounts', () => {
    const result = getRule().evaluate(makeBundle({ verifiedType: 'Business' }))

    expect(result.value).toBe(false)
  })

  it('uses generic-reaction style only as positive confidence support', () => {
    const generic = getRule().evaluate(
      makeBundle({ replyTexts: makeReactionControlledReplyTexts(true) }),
    )
    const neutral = getRule().evaluate(
      makeBundle({ replyTexts: makeReactionControlledReplyTexts(false) }),
    )

    expect(generic.value).toBe(true)
    expect(neutral.value).toBe(true)
    expect(generic.confidence).toBeGreaterThan(neutral.confidence)
  })

  it('uses non-X external links in original posts only as positive confidence support', () => {
    const external = getRule().evaluate(makeBundle({ originalExternalUrlCount: 6 }))
    const xOnly = getRule().evaluate(makeBundle({ originalXUrlCount: 6 }))
    const noLinks = getRule().evaluate(makeBundle())

    expect(external.value).toBe(true)
    expect(xOnly.value).toBe(true)
    expect(noLinks.value).toBe(true)
    expect(external.confidence).toBeGreaterThan(noLinks.confidence)
    expect(xOnly.confidence).toBeCloseTo(noLinks.confidence, 10)
  })

  it('uses account newness only as positive confidence support', () => {
    const fresh = getRule().evaluate(makeBundle({ accountAgeDays: 30 }))
    const old = getRule().evaluate(makeBundle({ accountAgeDays: 2000 }))

    expect(fresh.value).toBe(true)
    expect(old.value).toBe(true)
    expect(fresh.confidence).toBeGreaterThan(old.confidence)
  })

  it('does not let strong soft signals override a failed distinct-parent-author hard gate', () => {
    const result = getRule().evaluate(
      makeBundle({
        parentAuthorIds: ['friend-a', 'friend-a', 'friend-b', 'friend-b', 'friend-c', 'friend-c'],
        accountAgeDays: 30,
        originalExternalUrlCount: 8,
      }),
    )

    expect(result.value).toBe(false)
  })

  it('is neutral when the recent sample is too small', () => {
    const result = getRule().evaluate(makeBundle({ sampleSize: 10, originalCount: 4 }))

    expect(result).toMatchObject({ value: false, evaluable: false, confidence: 0.5 })
  })

  it('is neutral when reply parents could not be resolved', () => {
    const result = getRule().evaluate(makeBundle({ resolvedReplyCount: 1 }))

    expect(result).toMatchObject({ value: false, evaluable: false, confidence: 0.5 })
  })

  it('detects the low-frequency high-diversity archetype with broader multilingual self-experience bridging and accelerating recent velocity', () => {
    const result = getRule().evaluate(makeMissedTargetArchetypeBundle())

    expect(result.value).toBe(true)
    expect(result.evaluable).not.toBe(false)
  })

  it('does not label a multilingual specialist who gives topic-consistent advice without self-experience bridging', () => {
    const specialistReplyTexts = Array.from({ length: 19 }, (_, index) => {
      const languageVariants = [
        'その設定であれば、露出補正を少し下げるとハイライトの白飛びを抑えられます。',
        '这种情况下,建议把快门速度调快一点,能有效减少手抖导致的模糊。',
        'In that lighting setup, lowering the ISO slightly should reduce the visible noise.',
      ]
      return `${languageVariants[index % languageVariants.length]} 番号${index}`
    })
    const parentAuthorIds = Array.from({ length: 19 }, (_, index) => `student-${index + 1}`)
    const result = getRule().evaluate(
      makeBundle({
        replyTexts: specialistReplyTexts,
        originalCount: 1,
        parentAuthorIds,
        lifetimePerDay: 5.7,
        intervalMinutes: 150,
      }),
    )

    expect(result.value).toBe(false)
  })

  it('does not label a template burst reply account exchanging goods with buyers', () => {
    const burstReplyTexts = Array.from(
      { length: 19 },
      (_, index) => `了解です、番号${index}の商品は本日発送しますね。`,
    )
    const parentAuthorIds = Array.from({ length: 19 }, (_, index) => `buyer-${index + 1}`)
    const result = getRule().evaluate(
      makeBundle({
        replyTexts: burstReplyTexts,
        originalCount: 1,
        parentAuthorIds,
        lifetimePerDay: 5.7,
        intervalMinutes: 0.3, // 3件/20秒規模の連投バーストを再現。
      }),
    )

    expect(result.value).toBe(false)
  })

  it('does not label generic third-person tool/method mentions without a self-experience bridge', () => {
    // 「このツールを使っている人は…」のような第三者目線の一般論は、自己経験ブリッジとして扱わない。
    const topics = [
      '写真編集アプリ',
      '家計簿アプリ',
      '語学学習教材',
      'ランニングウォッチ',
      '掃除ロボット',
      '筋トレ器具',
      '読書記録アプリ',
      '節約術',
      'ガーデニング用品',
      '育児グッズ',
      '副業ツール',
      '資格対策教材',
      '旅行プランアプリ',
      '貯金アプリ',
      '健康管理アプリ',
      '睡眠改善グッズ',
      '料理レシピアプリ',
      '転職エージェント',
      '瞑想アプリ',
    ]
    const genericToolMentionReplyTexts = Array.from({ length: 19 }, (_, index) => {
      const topic = topics[index % topics.length]
      return index % 2 === 0
        ? `この${topic}を使っている人は、最初のうちは戸惑うことも多いようですが、慣れてくるにつれて手放せなくなり、日々の暮らしに自然と溶け込んでいくとよく言われています。番号${index}`
        : `この${topic}のやり方をやっているケースは、継続するほど効果を実感しやすくなるとされていて、周囲でも評判が広がりやすい傾向があるようです。番号${index}`
    })
    const parentAuthorIds = Array.from({ length: 19 }, (_, index) => `reader-${index + 1}`)
    const result = getRule().evaluate(
      makeBundle({
        replyTexts: genericToolMentionReplyTexts,
        originalCount: 1,
        parentAuthorIds,
        lifetimePerDay: 5.7,
        intervalMinutes: 150,
      }),
    )

    expect(result.value).toBe(false)
  })

  it('does not label third-person prior-experience mentions with no first-person self-experience marker', () => {
    const parentAuthorIds = Array.from(
      { length: THIRD_PERSON_PRIOR_EXPERIENCE_REPLY_TEXTS.length },
      (_, index) => `commenter-${index + 1}`,
    )
    const result = getRule().evaluate(
      makeBundle({
        replyTexts: THIRD_PERSON_PRIOR_EXPERIENCE_REPLY_TEXTS,
        originalCount: 1,
        parentAuthorIds,
      }),
    )

    expect(result.value).toBe(false)
  })

  it('does not label genitive third-party self-experience mentions ("自分の...が") without a true self-positioning subject', () => {
    const parentAuthorIds = Array.from(
      { length: GENITIVE_THIRD_PARTY_REPLY_TEXTS.length },
      (_, index) => `commenter-${index + 1}`,
    )
    const result = getRule().evaluate(
      makeBundle({
        replyTexts: GENITIVE_THIRD_PARTY_REPLY_TEXTS.map(
          (text) => text + ' この話は第三者の経験として聞いた内容です。本人自身の経験ではありません。',
        ),
        originalCount: 1,
        parentAuthorIds,
      }),
    )

    expect(result.value).toBe(false)
  })

  it('detects the low-frequency high-diversity archetype using only subject-omitted self-experience clauses', () => {
    const parentAuthorIds = Array.from(
      { length: LOW_FREQUENCY_OMITTED_SUBJECT_SELF_EXPERIENCE_REPLY_TEXTS.length },
      (_, index) => `reader-${index + 1}`,
    )
    const result = getRule().evaluate(
      makeBundle({
        replyTexts: LOW_FREQUENCY_OMITTED_SUBJECT_SELF_EXPERIENCE_REPLY_TEXTS,
        originalCount: 1,
        parentAuthorIds,
        lifetimePerDay: 5.7,
        intervalMinutes: 150,
      }),
    )

    expect(result.value).toBe(true)
    expect(result.evaluable).not.toBe(false)
  })

  it('does not label non-genitive third-party same-clause experiences ("自分には関係ないですが〜が") without a true self-positioning subject', () => {
    const parentAuthorIds = Array.from(
      { length: NON_GENITIVE_THIRD_PARTY_SAME_CLAUSE_REPLY_TEXTS.length },
      (_, index) => `commenter-${index + 1}`,
    )
    const result = getRule().evaluate(
      makeBundle({
        replyTexts: NON_GENITIVE_THIRD_PARTY_SAME_CLAUSE_REPLY_TEXTS,
        originalCount: 1,
        parentAuthorIds,
        lifetimePerDay: 5.7,
        intervalMinutes: 150,
      }),
    )

    expect(result.value).toBe(false)
  })

  it('does not label non-genitive "Xは"-marked third-party experiences ("自分は元気でXは以前〜") without a true self-positioning subject', () => {
    const parentAuthorIds = Array.from(
      { length: NON_GENITIVE_WA_MARKED_THIRD_PARTY_REPLY_TEXTS.length },
      (_, index) => `commenter-${index + 1}`,
    )
    const result = getRule().evaluate(
      makeBundle({
        replyTexts: NON_GENITIVE_WA_MARKED_THIRD_PARTY_REPLY_TEXTS,
        originalCount: 1,
        parentAuthorIds,
        lifetimePerDay: 5.7,
        intervalMinutes: 150,
      }),
    )

    expect(result.value).toBe(false)
  })

  it('does not label a stable community account that naturally uses 自分も/私も with a small friend group', () => {
    const communityReplyTexts = Array.from(
      { length: 19 },
      (_, index) =>
        `分かる、自分も似たようなことがあったよ。番号${index}の件、無理せずいこうね。`,
    )
    const parentAuthorIds = Array.from(
      { length: 19 },
      (_, index) => `friend-${(index % 3) + 1}`,
    )
    const result = getRule().evaluate(
      makeBundle({
        replyTexts: communityReplyTexts,
        originalCount: 1,
        parentAuthorIds,
        lifetimePerDay: 5.7,
        intervalMinutes: 150,
      }),
    )

    expect(result.value).toBe(false)
  })
})
