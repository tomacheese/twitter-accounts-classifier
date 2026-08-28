"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createConfiguredAuthenticatedUserApi = createConfiguredAuthenticatedUserApi;
exports.parseOptions = parseOptions;
exports.runRecentTweetsBackfill = runRecentTweetsBackfill;
const load_config_1 = require("../config/load-config");
const crawl_limits_1 = require("../config/crawl-limits");
const env_1 = require("../config/env");
const client_1 = require("../db/client");
const account_repository_1 = require("../db/account-repository");
const tweet_repository_1 = require("../db/tweet-repository");
const analysis_work_item_repository_1 = require("../db/analysis-work-item-repository");
const recent_tweets_backfill_repository_1 = require("../db/recent-tweets-backfill-repository");
const twitter_client_1 = require("twitter-client");
const profile_1 = require("../twitter/profile");
const DEFAULT_LIMIT = 100;
/**
 * credential-bearing OpenAPI context を UserApiLike に変換し、変換途中の例外でも context を閉じる。
 * @param context - close が必要な OpenAPI context
 * @param adapt - context から UserApiLike を構築する処理
 * @param closeContext - context の close 処理
 * @returns 変換済み API と通常終了時の close 処理
 */
async function createAuthenticatedUserApiWithCleanup(context, adapt, closeContext) {
    try {
        const userApi = adapt(context);
        return { userApi, close: () => closeContext(context) };
    }
    catch (error) {
        await closeContext(context);
        throw error;
    }
}
const AUTHENTICATED_USER_API_FACTORY_DEPENDENCIES = {
    getCookieIssuerBaseUrl: env_1.getCookieIssuerBaseUrl,
    createCookieIssuerClient: twitter_client_1.createCookieIssuerClient,
    createOpenApiClient: twitter_client_1.createOpenApiClient,
    closeOpenApiClient: twitter_client_1.closeOpenApiClient,
    createUserApiLike: profile_1.createUserApiLike,
};
/**
 * 指定済み account の cookie と OpenAPI client を作り、backfill 用 UserApiLike に変換する。
 * @param account - username で選択済みの設定 account
 * @param requestTimeoutMs - OpenAPI request timeout
 * @param deps - cookie/OpenAPI client 構築と cleanup の依存関係
 * @returns 認証済み UserApiLike と close 処理
 */
async function createConfiguredAuthenticatedUserApi(account, requestTimeoutMs, deps = AUTHENTICATED_USER_API_FACTORY_DEPENDENCIES) {
    const cookieIssuer = deps.createCookieIssuerClient({
        baseUrl: deps.getCookieIssuerBaseUrl(),
        clientName: 'crawler',
    });
    const cookies = await cookieIssuer.issueCookiesWithRetry({
        username: account.username,
        password: account.password,
        otp_secret: account.otpSecret,
    });
    const context = await deps.createOpenApiClient(cookies, requestTimeoutMs);
    return createAuthenticatedUserApiWithCleanup(context, (openApiContext) => deps.createUserApiLike(openApiContext.client.getUserApi(), openApiContext.client.getTweetApi()), deps.closeOpenApiClient);
}
function readValue(args, index, option) {
    const value = args.at(index + 1);
    if (value === undefined || value.startsWith('--')) {
        throw new Error(`${option} requires a value`);
    }
    return value;
}
/**
 * backfill CLI の引数を検証して正規化する。
 * @param args - process.argv の script 名より後ろの引数
 * @returns 検証済みの実行オプション
 */
function parseOptions(args) {
    let limit = DEFAULT_LIMIT;
    let afterId;
    let username;
    let dryRunSpecified = false;
    let execute = false;
    const seen = new Set();
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (!['--limit', '--after-id', '--username', '--dry-run', '--execute'].includes(argument)) {
            throw new Error(`Unknown argument: ${argument}`);
        }
        if (seen.has(argument))
            throw new Error(`Duplicate argument: ${argument}`);
        seen.add(argument);
        if (argument === '--dry-run') {
            dryRunSpecified = true;
            continue;
        }
        if (argument === '--execute') {
            execute = true;
            continue;
        }
        const value = readValue(args, index, argument);
        index += 1;
        if (argument === '--limit') {
            if (!/^\d+$/.test(value))
                throw new Error('Limit must be an integer from 1 to 1000');
            limit = Number(value);
        }
        else if (argument === '--after-id') {
            afterId = value;
        }
        else {
            username = value;
        }
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error('Limit must be an integer from 1 to 1000');
    }
    if (dryRunSpecified && execute)
        throw new Error('Cannot combine --dry-run and --execute');
    if (execute && username === undefined)
        throw new Error('--execute requires --username');
    if (!execute && username !== undefined)
        throw new Error('--username requires --execute');
    return {
        limit,
        ...(afterId === undefined ? {} : { afterId }),
        execute,
        ...(username === undefined ? {} : { username }),
    };
}
async function fetchWithCrawlPolicy(operation, requestTimeoutMs, timeoutMessage) {
    return (0, twitter_client_1.withTwitterRateLimitRetry)(() => (0, twitter_client_1.withTwitterRetry)(() => (0, twitter_client_1.withTimeout)(operation(), requestTimeoutMs, timeoutMessage), crawl_limits_1.TWITTER_RETRY));
}
/** coverage の先行更新時に success transaction 全体を rollback するための内部エラー。 */
class StaleRecentTweetsBackfillWriteError extends Error {
}
async function persistSuccessfulCandidate(deps, accountId, profile, recentTweets, attemptedAt, fetchedAt) {
    const fallbackAuthors = new Map(recentTweets.authors.map((fallbackAuthor) => [fallbackAuthor.id, fallbackAuthor]));
    const tweets = (0, twitter_client_1.mergeTweetAdFlags)(recentTweets.tweets);
    try {
        await deps.prisma.$transaction(async (transaction) => {
            const tx = transaction;
            await deps.upsertAccount(tx, profile);
            for (const fallbackAuthor of fallbackAuthors.values()) {
                if (fallbackAuthor.id === profile.id)
                    continue;
                await deps.upsertAccount(tx, fallbackAuthor);
            }
            for (const tweet of tweets) {
                await deps.upsertTweet(tx, tweet);
            }
            const coverage = await tx.account.updateMany({
                where: { id: accountId, lastRecentTweetsAttemptedAt: null },
                data: {
                    lastRecentTweetsAttemptedAt: attemptedAt,
                    lastRecentTweetsFetchedAt: fetchedAt,
                    recentTweetsFetchStatus: 'success',
                },
            });
            if (coverage.count !== 1) {
                throw new StaleRecentTweetsBackfillWriteError(`Recent tweets backfill coverage is stale for ${accountId}`);
            }
            await deps.requestAccountRelabelBulk(tx, [accountId]);
        }, { maxWait: 30_000, timeout: 30_000 });
    }
    catch (error) {
        if (error instanceof StaleRecentTweetsBackfillWriteError)
            return;
        throw error;
    }
}
async function recordFailedCandidate(deps, accountId, attemptedAt) {
    await deps.prisma.account.updateMany({
        where: { id: accountId, lastRecentTweetsAttemptedAt: null },
        data: {
            lastRecentTweetsAttemptedAt: attemptedAt,
            recentTweetsFetchStatus: 'failed',
        },
    });
}
/**
 * recent tweets backfill を dry-run または明示的な execute mode で実行する。
 * @param args - CLI 引数
 * @param deps - 外部通信・永続化を含む依存関係
 */
async function runRecentTweetsBackfill(args, deps) {
    let authenticated;
    try {
        const options = parseOptions(args);
        let configuredAccount;
        if (options.execute) {
            const config = deps.loadConfig();
            configuredAccount = config.accounts.find((account) => account.username === options.username);
            if (configuredAccount === undefined) {
                throw new Error(`Configured account not found: ${options.username}`);
            }
        }
        const forcedAccountIds = process.env.BACKFILL_FORCED_IDS?.split(',').map((value) => value.trim()).filter(Boolean);
        const candidates = forcedAccountIds === undefined ? await deps.selectCandidates(deps.prisma, options) : { accountIds: forcedAccountIds };
        deps.log(JSON.stringify({ mode: options.execute ? 'execute' : 'dry-run', ...candidates }));
        if (!options.execute || candidates.accountIds.length === 0)
            return;
        if (configuredAccount === undefined) {
            throw new Error('Execute account is missing after validation');
        }
        const requestTimeoutMs = deps.getRequestTimeoutMs();
        authenticated = await deps.createAuthenticatedUserApi(configuredAccount, requestTimeoutMs);
        const userApi = authenticated.userApi;
        for (const accountId of candidates.accountIds) {
            const attemptedAt = deps.now();
            let profile;
            let recentTweets;
            try {
                profile = await fetchWithCrawlPolicy(() => deps.fetchAccountProfile(userApi, accountId), requestTimeoutMs, `Profile fetch for ${accountId} timed out`);
                recentTweets = await fetchWithCrawlPolicy(() => deps.fetchRecentTweets(userApi, accountId, crawl_limits_1.CRAWL_LIMITS.recentTweetsPerAccount), requestTimeoutMs, `Recent tweets fetch for ${accountId} timed out`);
            }
            catch (error) {
                const diagnostics = (0, twitter_client_1.getResponseErrorDiagnostics)(error);
                if (diagnostics?.httpStatus === 429) {
                    throw new Error('BACKFILL_RATE_LIMIT');
                }
                if (process.env.BACKFILL_DEFER_TIMEOUT === '1' && error instanceof Error && error.name === 'TimeoutError') {
                    continue;
                }
                await recordFailedCandidate(deps, accountId, attemptedAt);
                deps.logError(`Recent tweets backfill fetch failed for ${accountId}`);
                continue;
            }
            await persistSuccessfulCandidate(deps, accountId, profile, recentTweets, attemptedAt, deps.now());
        }
    }
    finally {
        try {
            if (authenticated !== undefined)
                await authenticated.close();
        }
        finally {
            await deps.disconnectPrisma();
        }
    }
}
function createDefaultDependencies(prisma) {
    return {
        prisma,
        selectCandidates: recent_tweets_backfill_repository_1.selectRecentTweetsBackfillCandidates,
        loadConfig: load_config_1.loadConfig,
        createAuthenticatedUserApi: createConfiguredAuthenticatedUserApi,
        fetchAccountProfile: profile_1.fetchAccountProfile,
        fetchRecentTweets: profile_1.fetchRecentTweets,
        upsertAccount: account_repository_1.upsertAccount,
        upsertTweet: tweet_repository_1.upsertTweet,
        requestAccountRelabelBulk: analysis_work_item_repository_1.requestAccountRelabelBulk,
        getRequestTimeoutMs: env_1.getTwitterRequestTimeoutMs,
        now: () => new Date(),
        log: console.log,
        logError: console.error,
        disconnectPrisma: client_1.disconnectPrisma,
    };
}
async function main() {
    const prisma = (0, client_1.getPrismaClient)();
    await runRecentTweetsBackfill(process.argv.slice(2), createDefaultDependencies(prisma));
}
// import.meta ではなく require/module を使う: このプロジェクトは CommonJS であるため。
// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
//# sourceMappingURL=recent-tweets-backfill.js.map
