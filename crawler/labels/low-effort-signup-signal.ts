import { rampScore } from './confidence'

// X の未設定アバターは `default_profile_images` を含む固定 URL 形式で配信される。
const DEFAULT_AVATAR_MARKER = 'default_profile_images'

/**
 * プロフィール画像 URL が X のデフォルトアバターかどうかを判定する。
 * @param profileImageUrl - `Account.profileImageUrl` の値
 * @returns デフォルトアバターであれば true
 */
export function isDefaultAvatar(profileImageUrl: string | null): boolean {
  return profileImageUrl?.includes(DEFAULT_AVATAR_MARKER) ?? false
}

// 4桁未満の連番は西暦や誕生日など人間が意図的に選ぶ数字と区別が付かないため、
// 機械的な大量登録に典型的な4桁以上の連番のみを対象にする。
const MECHANICAL_USERNAME_PATTERN = /\d{4,}$/

/**
 * ユーザー名末尾が機械的な連番かどうかを判定する。
 * @param screenName - 判定対象のスクリーンネーム
 * @returns 末尾が数字4桁以上であれば true
 */
export function isMechanicalUsername(screenName: string): boolean {
  return MECHANICAL_USERNAME_PATTERN.test(screenName)
}

/**
 * bio が空かどうかを判定する。
 * @param bio - 判定対象の bio
 * @returns `null` または空白のみであれば true
 */
export function isEmptyBio(bio: string | null): boolean {
  return bio === null || bio.trim() === ''
}

export interface LowEffortSignupSignalAccount {
  screenName: string
  bio: string | null
  profileImageUrl?: string | null
}

/**
 * 低労力アカウント登録シグネチャ (デフォルトアバター・機械的ユーザー名・空 bio) のうち、
 * 満たす条件の数を数える。
 * @param account - 判定対象アカウントの特徴
 * @returns 満たした条件数 (0〜3)
 */
export function countLowEffortSignals(account: LowEffortSignupSignalAccount): number {
  let count = 0
  if (isDefaultAvatar(account.profileImageUrl ?? null)) count++
  if (isMechanicalUsername(account.screenName)) count++
  if (isEmptyBio(account.bio)) count++
  return count
}

// 各シグネチャは単独では正当な低労力ユーザーとの誤検知リスクが高いため、
// 単独該当では evidenceScore を大きく動かさず、2条件以上の同時該当だけを強いシグナルの境界とする。
const LOW_EFFORT_SIGNAL_THRESHOLD = 2
const LOW_EFFORT_SIGNAL_RAMP_WIDTH = 1

/**
 * 低労力アカウント登録シグネチャの該当数から、二次シグナルとしての証拠スコアを算出する。
 * @param count - `countLowEffortSignals` が返した該当数
 * @returns 0〜1 の証拠スコア
 */
export function lowEffortSignatureScore(count: number): number {
  return rampScore(
    count,
    LOW_EFFORT_SIGNAL_THRESHOLD,
    LOW_EFFORT_SIGNAL_RAMP_WIDTH,
    'higher-is-positive',
  )
}
