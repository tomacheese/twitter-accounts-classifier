-- DB 作り直しの baseline。空の DB に、次の順で適用する。
--   1. baseline.sql (このファイル)
--   2. tweet-hash.sql または tweet-range.sql (どちらか一方だけを適用する)
--   3. functions.sql
-- 適用は単一トランザクション (psql の -1 オプション) で行う。
-- このファイルは Tweet に依存しない。どのテーブルも Tweet を FK で参照しない。
--
-- このファイルの前提は次のとおり。
-- - Account と Tweet 系の ID は bigint。LabelDefinition.id は smallint の identity で、再利用しない。
-- - 時刻型は timestamptz(3)。
-- - 巨大・ホットな表 (Tweet、AccountLabelState、AccountActiveLabel、AccountClassificationLatest) には FK を張らない。
-- - 行数の多い表の低カーディナリティ列は native enum。
-- - 大きい表の列は、8B 境界、4B、2B、1B、可変長の順に並べる。
--
-- DB 作成時の設定 (data checksums、照合順序) は initdb で決めるため、このファイルでは扱わない。

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- ============================================================
-- 1. enum、テーブル、インデックス、FK (prisma/schema.prisma から `prisma migrate diff` で生成し、手で加工した)
-- ============================================================

-- CreateEnum
CREATE TYPE "RecentTweetsFetchStatus" AS ENUM ('success', 'failed');

-- CreateEnum
CREATE TYPE "AccountLabelChangeType" AS ENUM ('added', 'removed', 'unevaluable');

-- CreateTable
CREATE TABLE "Account" (
    "id" BIGINT NOT NULL,
    "accountCreatedAt" TIMESTAMPTZ(3) NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "followersCount" INTEGER NOT NULL,
    "followingCount" INTEGER NOT NULL,
    "tweetCount" INTEGER NOT NULL,
    "isBlueVerified" BOOLEAN NOT NULL DEFAULT false,
    "screenName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "bio" TEXT,
    "profileImageUrl" TEXT,
    "location" TEXT,
    "url" TEXT,
    "verifiedType" TEXT,
    "professionalType" TEXT,
    "parodyCommentaryFanLabel" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountCrawlState" (
    "accountId" BIGINT NOT NULL,
    "lastCrawledAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRecentTweetsAttemptedAt" TIMESTAMPTZ(3),
    "lastRecentTweetsFetchedAt" TIMESTAMPTZ(3),
    "recentTweetsFetchStatus" "RecentTweetsFetchStatus",

    CONSTRAINT "AccountCrawlState_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "LabelDefinition" (
    "id" SMALLINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    "currentRuleVersionNo" SMALLINT,
    "retiredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "LabelDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelRuleVersion" (
    "labelDefinitionId" SMALLINT NOT NULL,
    "versionNo" SMALLINT NOT NULL,
    "ruleVersion" TEXT NOT NULL,

    CONSTRAINT "LabelRuleVersion_pkey" PRIMARY KEY ("labelDefinitionId","versionNo")
);

-- CreateTable
CREATE TABLE "AccountLabelState" (
    "accountId" BIGINT NOT NULL,
    "evaluatedAt" TIMESTAMPTZ(3) NOT NULL,
    "rev" INTEGER NOT NULL DEFAULT 0,
    "versions" SMALLINT[] NOT NULL DEFAULT ARRAY[]::SMALLINT[],

    CONSTRAINT "AccountLabelState_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "AccountActiveLabel" (
    "accountId" BIGINT NOT NULL,
    "labeledAt" TIMESTAMPTZ(3) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "labelDefinitionId" SMALLINT NOT NULL,
    "ruleVersionNo" SMALLINT NOT NULL,
    "sourceKind" SMALLINT NOT NULL DEFAULT 0,
    "method" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceId" TEXT,
    "sourceUsername" TEXT,

    CONSTRAINT "AccountActiveLabel_pkey" PRIMARY KEY ("accountId","labelDefinitionId")
);

-- CreateTable
CREATE TABLE "StorageCapacityState" (
    "id" TEXT NOT NULL,
    "availableGib" DOUBLE PRECISION NOT NULL,
    "usedPercent" INTEGER NOT NULL,
    "measuredAt" TIMESTAMPTZ(3) NOT NULL,
    "relabelBlocked" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StorageCapacityState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyAnalysisRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "staleAfterAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL,
    "currentPhase" TEXT,
    "errorMessage" TEXT,
    "pullRequestNumber" INTEGER,
    "pullRequestUrl" TEXT,
    "sampledAccountIds" JSONB NOT NULL,
    "findings" TEXT,
    "commitSha" TEXT,
    "targetFrom" TIMESTAMPTZ(3),
    "targetTo" TIMESTAMPTZ(3),
    "analysisVersion" TEXT,
    "modelIdentity" TEXT,
    "toolIdentity" TEXT,
    "policyHash" TEXT,
    "reviewPlan" JSONB,
    "structuredOutput" JSONB,

    CONSTRAINT "WeeklyAnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Follow" (
    "id" TEXT NOT NULL,
    "followerId" BIGINT NOT NULL,
    "followeeId" BIGINT NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowStateChange" (
    "id" TEXT NOT NULL,
    "followerId" BIGINT NOT NULL,
    "followeeId" BIGINT NOT NULL,
    "changeType" TEXT NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowStateChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplyHijackEvidence" (
    "id" TEXT NOT NULL,
    "accountId" BIGINT NOT NULL,
    "targetTweetId" BIGINT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "swarmSize" INTEGER NOT NULL,
    "averageSimilarity" DOUBLE PRECISION NOT NULL,
    "spanHours" DOUBLE PRECISION NOT NULL,
    "replyTweetIds" BIGINT[] DEFAULT ARRAY[]::BIGINT[],

    CONSTRAINT "ReplyHijackEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Block" (
    "id" TEXT NOT NULL,
    "blockerId" BIGINT NOT NULL,
    "blockedId" BIGINT NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastCheckedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "missingSinceAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),
    "consecutiveMissingCount" INTEGER NOT NULL DEFAULT 0,
    "sourceKind" TEXT NOT NULL DEFAULT 'legacy',
    "sourceId" TEXT,

    CONSTRAINT "Block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawlRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL,
    "currentUsername" TEXT,
    "currentAccountStartedAt" TIMESTAMPTZ(3),
    "staleAfterAt" TIMESTAMPTZ(3),

    CONSTRAINT "CrawlRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelEvidenceEpoch" (
    "id" TEXT NOT NULL,
    "crawlRunId" TEXT NOT NULL,
    "sourceWatermarkAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabelEvidenceEpoch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawlAccountRun" (
    "id" TEXT NOT NULL,
    "crawlRunId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL,
    "recommendedCount" INTEGER NOT NULL DEFAULT 0,
    "followingCount" INTEGER NOT NULL DEFAULT 0,
    "trendingCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "profileCount" INTEGER NOT NULL DEFAULT 0,
    "labelsAppliedCount" INTEGER NOT NULL DEFAULT 0,
    "parentTweetFetchCount" INTEGER NOT NULL DEFAULT 0,
    "followingSynced" BOOLEAN NOT NULL DEFAULT false,
    "followersSynced" BOOLEAN NOT NULL DEFAULT false,
    "blocksSynced" BOOLEAN NOT NULL DEFAULT false,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "errorMessage" TEXT,
    "appVersion" TEXT NOT NULL DEFAULT 'unknown',
    "classificationStatus" TEXT NOT NULL DEFAULT 'unknown',

    CONSTRAINT "CrawlAccountRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawlAccountCheckpoint" (
    "id" TEXT NOT NULL,
    "crawlRunId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "completedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrawlAccountCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawlAccountLabelRun" (
    "id" TEXT NOT NULL,
    "crawlRunId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "accountId" BIGINT NOT NULL,
    "labelDefinitionId" SMALLINT NOT NULL,
    "method" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrawlAccountLabelRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawlAuthorCheckpoint" (
    "id" TEXT NOT NULL,
    "crawlRunId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "authorId" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "profileCount" INTEGER NOT NULL DEFAULT 0,
    "labelsAppliedCount" INTEGER NOT NULL DEFAULT 0,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "durationMs" INTEGER,
    "retryWaitMs" INTEGER,
    "followSampleStatus" TEXT,
    "followSampleRequestCount" INTEGER NOT NULL DEFAULT 0,
    "followSampleRateLimitRemaining" INTEGER,
    "followSampleRateLimitReset" INTEGER,
    "parentTweetFetchRequestCount" INTEGER NOT NULL DEFAULT 0,
    "parentTweetFetchRateLimitRemaining" INTEGER,
    "parentTweetFetchRateLimitReset" INTEGER,
    "appVersion" TEXT NOT NULL DEFAULT 'unknown',
    "completedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrawlAuthorCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountSummaryLatest" (
    "accountId" BIGINT NOT NULL,
    "normalizedScreenName" TEXT NOT NULL,
    "normalizedDisplayName" TEXT NOT NULL,
    "searchDocument" TEXT NOT NULL,
    "profileObservedAt" TIMESTAMPTZ(3) NOT NULL,
    "activeLabelKeys" TEXT[],
    "activeLabelCount" INTEGER NOT NULL,
    "lastClassificationChangedAt" TIMESTAMPTZ(3),
    "classificationObservedAt" TIMESTAMPTZ(3),
    "activeFindingCount" INTEGER NOT NULL DEFAULT 0,
    "highestFindingSeverity" TEXT,
    "findingObservedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AccountSummaryLatest_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "LabeledAccountCounter" (
    "id" TEXT NOT NULL,
    "labeledAccounts" INTEGER NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LabeledAccountCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountClassificationLatest" (
    "accountId" BIGINT NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "labeledAt" TIMESTAMPTZ(3),
    "confidence" DOUBLE PRECISION NOT NULL,
    "labelDefinitionId" SMALLINT NOT NULL,
    "value" BOOLEAN NOT NULL,
    "evaluable" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "sourceObservationId" TEXT,

    CONSTRAINT "AccountClassificationLatest_pkey" PRIMARY KEY ("accountId","labelDefinitionId")
);

-- CreateTable
CREATE TABLE "WeeklyReviewSampleBucketCount" (
    "labelDefinitionId" SMALLINT NOT NULL,
    "value" BOOLEAN NOT NULL,
    "bucket" INTEGER NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WeeklyReviewSampleBucketCount_pkey" PRIMARY KEY ("labelDefinitionId","value","bucket")
);

-- CreateTable
CREATE TABLE "AccountClassificationValueCount" (
    "labelDefinitionId" SMALLINT NOT NULL,
    "value" BOOLEAN NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "confidenceSum" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "AccountClassificationValueCount_pkey" PRIMARY KEY ("labelDefinitionId","value")
);

-- CreateTable
CREATE TABLE "AccountClassificationConfidenceBucketCount" (
    "labelDefinitionId" SMALLINT NOT NULL,
    "confidenceBucket" INTEGER NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AccountClassificationConfidenceBucketCount_pkey" PRIMARY KEY ("labelDefinitionId","confidenceBucket")
);

-- CreateTable
CREATE TABLE "AccountClassificationRuleVersionCount" (
    "labelDefinitionId" SMALLINT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AccountClassificationRuleVersionCount_pkey" PRIMARY KEY ("labelDefinitionId","ruleVersion")
);

-- CreateTable
CREATE TABLE "AccountClassificationFreshnessBucket" (
    "labelDefinitionId" SMALLINT NOT NULL,
    "observedAtBucket" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AccountClassificationFreshnessBucket_pkey" PRIMARY KEY ("labelDefinitionId","observedAtBucket")
);

-- CreateTable
CREATE TABLE "AccountClassificationReasonCount" (
    "labelDefinitionId" SMALLINT NOT NULL,
    "reason" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AccountClassificationReasonCount_pkey" PRIMARY KEY ("labelDefinitionId","reason")
);

-- CreateTable
CREATE TABLE "AccountClassificationObservation" (
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accountId" BIGINT NOT NULL,
    "labelCount" INTEGER NOT NULL,
    "snapshotVersion" INTEGER,
    "id" TEXT NOT NULL,
    "crawlRunId" TEXT,
    "username" TEXT,
    "classificationSnapshot" JSONB,

    CONSTRAINT "AccountClassificationObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReadModelBootstrap" (
    "modelKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "cursor" TEXT,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),
    "errorSummary" TEXT,

    CONSTRAINT "ReadModelBootstrap_pkey" PRIMARY KEY ("modelKey")
);

-- CreateTable
CREATE TABLE "BlockRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL,
    "staleAfterAt" TIMESTAMPTZ(3),

    CONSTRAINT "BlockRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockAccountRun" (
    "id" TEXT NOT NULL,
    "blockRunId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL,
    "candidatesCount" INTEGER NOT NULL DEFAULT 0,
    "blockedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,

    CONSTRAINT "BlockAccountRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockAction" (
    "id" TEXT NOT NULL,
    "blockAccountRunId" TEXT NOT NULL,
    "blockerId" BIGINT NOT NULL,
    "blockedId" BIGINT NOT NULL,
    "labelDefinitionId" SMALLINT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "result" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outboxEntryId" TEXT,

    CONSTRAINT "BlockAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockOutboxEntry" (
    "id" TEXT NOT NULL,
    "blockAccountRunId" TEXT NOT NULL,
    "blockerId" BIGINT NOT NULL,
    "blockedId" BIGINT NOT NULL,
    "labelDefinitionId" SMALLINT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "remoteSkipCount" INTEGER NOT NULL DEFAULT 0,
    "lastRemoteSkippedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remoteSucceededAt" TIMESTAMPTZ(3),
    "localPersistedAt" TIMESTAMPTZ(3),
    "reconciledAt" TIMESTAMPTZ(3),

    CONSTRAINT "BlockOutboxEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisWorkItem" (
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "staleRequestedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "kind" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "triggerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "leaseOwner" TEXT,
    "dependencyKey" TEXT,
    "lastErrorCode" TEXT,
    "lastErrorSummary" TEXT,

    CONSTRAINT "AnalysisWorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisWorkItemDone" (
    "completedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "triggerId" TEXT NOT NULL,

    CONSTRAINT "AnalysisWorkItemDone_pkey" PRIMARY KEY ("kind","triggerType","triggerId")
);

-- CreateTable
CREATE TABLE "AnalysisRun" (
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "workItemId" INTEGER,
    "attemptNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorSummary" TEXT,

    CONSTRAINT "AnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelabelScanCursor" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "lastScannedAccountId" BIGINT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RelabelScanCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationCycle" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "triggeredAt" TIMESTAMPTZ(3) NOT NULL,
    "expectedAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "attentionRequired" BOOLEAN NOT NULL DEFAULT false,
    "currentStageKey" TEXT,
    "sourceWatermarkAt" TIMESTAMPTZ(3),
    "modelVersion" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OperationCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationStage" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "requiredness" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "expectedAt" TIMESTAMPTZ(3),
    "delayedAt" TIMESTAMPTZ(3),
    "staleAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "heartbeatAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "counters" JSONB NOT NULL DEFAULT '{}',
    "errorCode" TEXT,
    "errorSummary" TEXT,
    "analysisRunId" INTEGER,

    CONSTRAINT "OperationStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalIssue" (
    "id" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "severity" TEXT NOT NULL,
    "firstDetectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "currentOccurrenceId" TEXT,
    "sourceCycleId" TEXT,
    "sourceStageId" TEXT,

    CONSTRAINT "OperationalIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalIssueOccurrence" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stateTransition" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "measurements" JSONB NOT NULL DEFAULT '{}',
    "observationKey" TEXT NOT NULL,

    CONSTRAINT "OperationalIssueOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewFinding" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "identityVersion" INTEGER NOT NULL,
    "episodeNumber" INTEGER NOT NULL DEFAULT 1,
    "type" TEXT NOT NULL,
    "primaryScopeType" TEXT NOT NULL,
    "primaryScopeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "currentSeverity" TEXT NOT NULL,
    "maximumSeverity" TEXT NOT NULL,
    "firstDetectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "recurrenceCount" INTEGER NOT NULL DEFAULT 0,
    "previousFindingId" TEXT,
    "supersededByFindingId" TEXT,
    "currentOccurrenceId" TEXT,

    CONSTRAINT "ReviewFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewFindingOccurrence" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceObservedAt" TIMESTAMPTZ(3) NOT NULL,
    "stateTransition" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "observedValue" DOUBLE PRECISION,
    "baselineValue" DOUBLE PRECISION,
    "absoluteDifference" DOUBLE PRECISION,
    "relativeDifference" DOUBLE PRECISION,
    "affectedCount" INTEGER,
    "totalCount" INTEGER,
    "affectedRatio" DOUBLE PRECISION,
    "consecutiveCount" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION,
    "thresholds" JSONB NOT NULL DEFAULT '{}',
    "measurements" JSONB NOT NULL DEFAULT '{}',
    "policyHash" TEXT NOT NULL,
    "detectorVersion" TEXT NOT NULL,
    "observationKey" TEXT NOT NULL,

    CONSTRAINT "ReviewFindingOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FindingEvidence" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "redactionVersion" INTEGER NOT NULL,
    "sampleStrategyVersion" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FindingEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FindingRawArtifact" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "isTruncated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FindingRawArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FindingEntityLink" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,

    CONSTRAINT "FindingEntityLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DetectionPolicyVersion" (
    "id" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "loadedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DetectionPolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DetectorEvaluation" (
    "id" TEXT NOT NULL,
    "detectorType" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "identityVersion" INTEGER NOT NULL,
    "sourceId" TEXT NOT NULL,
    "evaluatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isShadow" BOOLEAN NOT NULL DEFAULT false,
    "result" JSONB NOT NULL,
    "policyHash" TEXT NOT NULL,

    CONSTRAINT "DetectorEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyBacktestRun" (
    "id" TEXT NOT NULL,
    "candidatePolicyHash" TEXT NOT NULL,
    "baselinePolicyHash" TEXT NOT NULL,
    "targetFrom" TIMESTAMPTZ(3) NOT NULL,
    "targetTo" TIMESTAMPTZ(3) NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "summary" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "PolicyBacktestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyBacktestFinding" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "diffKind" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "PolicyBacktestFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelMetricSnapshot" (
    "id" TEXT NOT NULL,
    "sourceCrawlRunId" TEXT,
    "triggerWorkItemId" INTEGER NOT NULL,
    "labelDefinitionId" SMALLINT NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "generatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceWatermarkAt" TIMESTAMPTZ(3) NOT NULL,
    "populationCount" INTEGER NOT NULL DEFAULT 0,
    "evaluatedCount" INTEGER NOT NULL,
    "trueCount" INTEGER NOT NULL,
    "prevalence" DOUBLE PRECISION NOT NULL,
    "coverage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currentCount" INTEGER NOT NULL DEFAULT 0,
    "delayedCount" INTEGER NOT NULL DEFAULT 0,
    "staleCount" INTEGER NOT NULL DEFAULT 0,
    "unknownCount" INTEGER NOT NULL DEFAULT 0,
    "staleRatio" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "trueConfidenceAverage" DOUBLE PRECISION,
    "falseConfidenceAverage" DOUBLE PRECISION,
    "confidenceBuckets" JSONB NOT NULL DEFAULT '{}',
    "reasonDistribution" JSONB NOT NULL DEFAULT '{}',
    "ruleVersionDistribution" JSONB NOT NULL DEFAULT '{}',
    "completeness" TEXT NOT NULL,
    "policyHash" TEXT NOT NULL,
    "analyzerVersion" TEXT NOT NULL,
    "analysisRunId" INTEGER,

    CONSTRAINT "LabelMetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelMetricDaily" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "labelDefinitionId" SMALLINT NOT NULL,
    "evaluatedCount" INTEGER NOT NULL,
    "trueCount" INTEGER NOT NULL,
    "prevalence" DOUBLE PRECISION NOT NULL,
    "confidenceBuckets" JSONB NOT NULL DEFAULT '{}',
    "reasonDistribution" JSONB NOT NULL DEFAULT '{}',
    "sourceObservedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LabelMetricDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountLabelChange" (
    "accountId" BIGINT NOT NULL,
    "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previousConfidence" DOUBLE PRECISION,
    "newConfidence" DOUBLE PRECISION,
    "id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "changeType" "AccountLabelChangeType" NOT NULL,
    "labelDefinitionId" SMALLINT NOT NULL,
    "previousValue" BOOLEAN,
    "newValue" BOOLEAN,
    "sourceId" TEXT,
    "sourceLabelId" TEXT,
    "previousReason" TEXT,
    "newReason" TEXT,

    CONSTRAINT "AccountLabelChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelSummaryCurrent" (
    "generationId" TEXT NOT NULL,
    "labelDefinitionId" SMALLINT NOT NULL,
    "latestSnapshotId" TEXT,
    "evaluatedCount" INTEGER NOT NULL,
    "trueCount" INTEGER NOT NULL,
    "populationCount" INTEGER NOT NULL DEFAULT 0,
    "coverage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "prevalence" DOUBLE PRECISION NOT NULL,
    "previousRunDelta" DOUBLE PRECISION,
    "dayDelta" DOUBLE PRECISION,
    "weekDelta" DOUBLE PRECISION,
    "confidenceShift" JSONB NOT NULL DEFAULT '{}',
    "reasonShift" JSONB NOT NULL DEFAULT '{}',
    "activeFindingCount" INTEGER NOT NULL DEFAULT 0,
    "highestFindingSeverity" TEXT,
    "qualityStatus" TEXT NOT NULL,
    "sourceWatermarkAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LabelSummaryCurrent_pkey" PRIMARY KEY ("generationId","labelDefinitionId")
);

-- CreateTable
CREATE TABLE "BlockRelationCurrent" (
    "generationId" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "normalizedBlockerScreenName" TEXT NOT NULL,
    "normalizedBlockedScreenName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "statusChangedAt" TIMESTAMPTZ(3) NOT NULL,
    "activeFindingCount" INTEGER NOT NULL DEFAULT 0,
    "highestFindingSeverity" TEXT,
    "sourceWatermarkAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BlockRelationCurrent_pkey" PRIMARY KEY ("generationId","blockId")
);

-- CreateTable
CREATE TABLE "BlockStateChange" (
    "id" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceId" TEXT,

    CONSTRAINT "BlockStateChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttentionItemCurrent" (
    "generationId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "severity" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "impact" JSONB NOT NULL DEFAULT '{}',
    "detectedAt" TIMESTAMPTZ(3) NOT NULL,
    "freshness" TEXT NOT NULL,
    "detailHref" TEXT NOT NULL,

    CONSTRAINT "AttentionItemCurrent_pkey" PRIMARY KEY ("generationId","sourceType","sourceId")
);

-- CreateTable
CREATE TABLE "OverviewSnapshot" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "generatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceWatermarkAt" TIMESTAMPTZ(3) NOT NULL,
    "operationalStatus" TEXT NOT NULL,
    "qualityStatus" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "analysisRunId" INTEGER,

    CONSTRAINT "OverviewSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReadModelGeneration" (
    "id" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'building',
    "sourceWatermarkAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "rowCount" INTEGER,
    "validationSummary" JSONB NOT NULL DEFAULT '{}',
    "analysisRunId" INTEGER,

    CONSTRAINT "ReadModelGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReadModelPointer" (
    "modelKey" TEXT NOT NULL,
    "currentGenerationId" TEXT NOT NULL,
    "switchedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReadModelPointer_pkey" PRIMARY KEY ("modelKey")
);

-- CreateTable
CREATE TABLE "ReadModelState" (
    "modelKey" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "currentGenerationId" TEXT,
    "sourceWatermarkAt" TIMESTAMPTZ(3),
    "lastStartedAt" TIMESTAMPTZ(3),
    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastFailureAt" TIMESTAMPTZ(3),
    "expectedNextAt" TIMESTAMPTZ(3),
    "delayedAt" TIMESTAMPTZ(3),
    "staleAt" TIMESTAMPTZ(3),
    "rowCount" INTEGER,
    "policyHash" TEXT,
    "analyzerVersion" TEXT,
    "errorCode" TEXT,
    "errorSummary" TEXT,

    CONSTRAINT "ReadModelState_pkey" PRIMARY KEY ("modelKey")
);

-- CreateTable
CREATE TABLE "DetectorState" (
    "detectorKey" TEXT NOT NULL,
    "lastEvidenceEpochId" TEXT,
    "sourceWatermarkAt" TIMESTAMPTZ(3),
    "lastStartedAt" TIMESTAMPTZ(3),
    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastFailureAt" TIMESTAMPTZ(3),
    "errorCode" TEXT,
    "errorSummary" TEXT,
    "policyHash" TEXT,
    "analyzerVersion" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DetectorState_pkey" PRIMARY KEY ("detectorKey")
);

-- CreateTable
CREATE TABLE "ComponentBuildIdentity" (
    "component" TEXT NOT NULL,
    "applicationVersion" TEXT NOT NULL,
    "gitRevision" TEXT NOT NULL,
    "buildTime" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ComponentBuildIdentity_pkey" PRIMARY KEY ("component")
);

-- CreateTable
CREATE TABLE "BioDuplicateClusterSize" (
    "clusterKey" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "memberIds" BIGINT[] DEFAULT ARRAY[]::BIGINT[],

    CONSTRAINT "BioDuplicateClusterSize_pkey" PRIMARY KEY ("clusterKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "LabelDefinition_key_key" ON "LabelDefinition"("key");

-- CreateIndex
CREATE UNIQUE INDEX "LabelRuleVersion_labelDefinitionId_ruleVersion_key" ON "LabelRuleVersion"("labelDefinitionId", "ruleVersion");

-- CreateIndex
CREATE INDEX "AccountActiveLabel_labelDefinitionId_ruleVersionNo_confiden_idx" ON "AccountActiveLabel"("labelDefinitionId", "ruleVersionNo", "confidence" DESC, "accountId");

-- CreateIndex
CREATE INDEX "WeeklyAnalysisRun_status_startedAt_id_idx" ON "WeeklyAnalysisRun"("status", "startedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Follow_followerId_idx" ON "Follow"("followerId");

-- CreateIndex
CREATE INDEX "Follow_followeeId_idx" ON "Follow"("followeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_followeeId_key" ON "Follow"("followerId", "followeeId");

-- CreateIndex
CREATE INDEX "FollowStateChange_followerId_observedAt_idx" ON "FollowStateChange"("followerId", "observedAt" DESC);

-- CreateIndex
CREATE INDEX "FollowStateChange_followeeId_observedAt_idx" ON "FollowStateChange"("followeeId", "observedAt" DESC);

-- CreateIndex
CREATE INDEX "ReplyHijackEvidence_targetTweetId_idx" ON "ReplyHijackEvidence"("targetTweetId");

-- CreateIndex
CREATE UNIQUE INDEX "ReplyHijackEvidence_accountId_targetTweetId_ruleVersion_key" ON "ReplyHijackEvidence"("accountId", "targetTweetId", "ruleVersion");

-- CreateIndex
CREATE INDEX "Block_blockerId_idx" ON "Block"("blockerId");

-- CreateIndex
CREATE INDEX "Block_blockedId_idx" ON "Block"("blockedId");

-- CreateIndex
CREATE INDEX "Block_status_lastCheckedAt_idx" ON "Block"("status", "lastCheckedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Block_blockerId_blockedId_key" ON "Block"("blockerId", "blockedId");

-- CreateIndex
CREATE INDEX "CrawlRun_startedAt_idx" ON "CrawlRun"("startedAt");

-- CreateIndex
CREATE INDEX "CrawlRun_status_startedAt_id_idx" ON "CrawlRun"("status", "startedAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "LabelEvidenceEpoch_crawlRunId_key" ON "LabelEvidenceEpoch"("crawlRunId");

-- CreateIndex
CREATE INDEX "LabelEvidenceEpoch_sourceWatermarkAt_idx" ON "LabelEvidenceEpoch"("sourceWatermarkAt" DESC);

-- CreateIndex
CREATE INDEX "CrawlAccountRun_crawlRunId_idx" ON "CrawlAccountRun"("crawlRunId");

-- CreateIndex
CREATE INDEX "CrawlAccountRun_startedAt_idx" ON "CrawlAccountRun"("startedAt");

-- CreateIndex
CREATE INDEX "CrawlAccountRun_crawlRunId_username_startedAt_id_idx" ON "CrawlAccountRun"("crawlRunId", "username", "startedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "CrawlAccountCheckpoint_crawlRunId_username_idx" ON "CrawlAccountCheckpoint"("crawlRunId", "username");

-- CreateIndex
CREATE UNIQUE INDEX "CrawlAccountCheckpoint_crawlRunId_username_phase_key" ON "CrawlAccountCheckpoint"("crawlRunId", "username", "phase");

-- CreateIndex
CREATE UNIQUE INDEX "CrawlAccountLabelRun_crawlRunId_username_accountId_labelDef_key" ON "CrawlAccountLabelRun"("crawlRunId", "username", "accountId", "labelDefinitionId", "method", "ruleVersion");

-- CreateIndex
CREATE INDEX "CrawlAuthorCheckpoint_crawlRunId_username_idx" ON "CrawlAuthorCheckpoint"("crawlRunId", "username");

-- CreateIndex
CREATE UNIQUE INDEX "CrawlAuthorCheckpoint_crawlRunId_username_authorId_key" ON "CrawlAuthorCheckpoint"("crawlRunId", "username", "authorId");

-- CreateIndex
CREATE INDEX "AccountSummaryLatest_lastClassificationChangedAt_accountId_idx" ON "AccountSummaryLatest"("lastClassificationChangedAt" DESC, "accountId");

-- CreateIndex
CREATE INDEX "AccountSummaryLatest_highestFindingSeverity_activeFindingCo_idx" ON "AccountSummaryLatest"("highestFindingSeverity", "activeFindingCount", "accountId");

-- CreateIndex
CREATE INDEX "AccountSummaryLatest_normalizedScreenName_idx" ON "AccountSummaryLatest"("normalizedScreenName");

-- CreateIndex
CREATE INDEX "AccountSummaryLatest_activeLabelKeys_gin_idx" ON "AccountSummaryLatest" USING GIN ("activeLabelKeys");

-- CreateIndex
CREATE INDEX "AccountClassificationObservation_accountId_observedAt_idx" ON "AccountClassificationObservation"("accountId", "observedAt" DESC);

-- CreateIndex
CREATE INDEX "BlockRun_startedAt_idx" ON "BlockRun"("startedAt");

-- CreateIndex
CREATE INDEX "BlockRun_status_startedAt_id_idx" ON "BlockRun"("status", "startedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "BlockAccountRun_blockRunId_idx" ON "BlockAccountRun"("blockRunId");

-- CreateIndex
CREATE INDEX "BlockAccountRun_blockRunId_username_startedAt_id_idx" ON "BlockAccountRun"("blockRunId", "username", "startedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "BlockAccountRun_errorMessage_startedAt_id_idx" ON "BlockAccountRun"("errorMessage", "startedAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "BlockAction_outboxEntryId_key" ON "BlockAction"("outboxEntryId");

-- CreateIndex
CREATE INDEX "BlockAction_blockerId_blockedId_result_idx" ON "BlockAction"("blockerId", "blockedId", "result");

-- CreateIndex
CREATE INDEX "BlockAction_blockAccountRunId_idx" ON "BlockAction"("blockAccountRunId");

-- CreateIndex
CREATE INDEX "BlockOutboxEntry_status_createdAt_idx" ON "BlockOutboxEntry"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BlockOutboxEntry_blockerId_blockedId_key" ON "BlockOutboxEntry"("blockerId", "blockedId");

-- CreateIndex
CREATE INDEX "AnalysisWorkItem_status_availableAt_priority_idx" ON "AnalysisWorkItem"("status", "availableAt", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisWorkItem_kind_triggerType_triggerId_key" ON "AnalysisWorkItem"("kind", "triggerType", "triggerId");

-- CreateIndex
CREATE INDEX "AnalysisWorkItemDone_completedAt_idx" ON "AnalysisWorkItemDone"("completedAt");

-- CreateIndex
CREATE INDEX "AnalysisRun_workItemId_startedAt_idx" ON "AnalysisRun"("workItemId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "OperationCycle_kind_startedAt_id_idx" ON "OperationCycle"("kind", "startedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "OperationCycle_kind_triggeredAt_id_idx" ON "OperationCycle"("kind", "triggeredAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "OperationCycle_attentionRequired_status_idx" ON "OperationCycle"("attentionRequired", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OperationCycle_sourceType_sourceId_key" ON "OperationCycle"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "OperationStage_cycleId_sequence_idx" ON "OperationStage"("cycleId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "OperationStage_cycleId_stageKey_key" ON "OperationStage"("cycleId", "stageKey");

-- CreateIndex
CREATE INDEX "OperationalIssue_status_severity_lastDetectedAt_id_idx" ON "OperationalIssue"("status", "severity", "lastDetectedAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "OperationalIssue_fingerprint_key" ON "OperationalIssue"("fingerprint");

-- CreateIndex
CREATE INDEX "OperationalIssueOccurrence_issueId_observedAt_id_idx" ON "OperationalIssueOccurrence"("issueId", "observedAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "OperationalIssueOccurrence_issueId_observationKey_key" ON "OperationalIssueOccurrence"("issueId", "observationKey");

-- CreateIndex
CREATE INDEX "ReviewFinding_status_currentSeverity_lastDetectedAt_id_idx" ON "ReviewFinding"("status", "currentSeverity", "lastDetectedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ReviewFinding_primaryScopeType_primaryScopeId_idx" ON "ReviewFinding"("primaryScopeType", "primaryScopeId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewFinding_fingerprint_identityVersion_episodeNumber_key" ON "ReviewFinding"("fingerprint", "identityVersion", "episodeNumber");

-- CreateIndex
CREATE INDEX "ReviewFindingOccurrence_findingId_observedAt_id_idx" ON "ReviewFindingOccurrence"("findingId", "observedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ReviewFindingOccurrence_findingId_sourceObservedAt_id_idx" ON "ReviewFindingOccurrence"("findingId", "sourceObservedAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewFindingOccurrence_findingId_observationKey_key" ON "ReviewFindingOccurrence"("findingId", "observationKey");

-- CreateIndex
CREATE INDEX "FindingEvidence_findingId_kind_createdAt_idx" ON "FindingEvidence"("findingId", "kind", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "FindingRawArtifact_findingId_kind_idx" ON "FindingRawArtifact"("findingId", "kind");

-- CreateIndex
CREATE INDEX "FindingEntityLink_entityType_entityId_idx" ON "FindingEntityLink"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "FindingEntityLink_findingId_entityType_entityId_key" ON "FindingEntityLink"("findingId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "DetectionPolicyVersion_policyVersion_key" ON "DetectionPolicyVersion"("policyVersion");

-- CreateIndex
CREATE INDEX "DetectorEvaluation_detectorType_fingerprint_evaluatedAt_idx" ON "DetectorEvaluation"("detectorType", "fingerprint", "evaluatedAt" DESC);

-- CreateIndex
CREATE INDEX "DetectorEvaluation_isShadow_evaluatedAt_idx" ON "DetectorEvaluation"("isShadow", "evaluatedAt" DESC);

-- CreateIndex
CREATE INDEX "DetectorEvaluation_fingerprint_identityVersion_evaluatedAt_idx" ON "DetectorEvaluation"("fingerprint", "identityVersion", "evaluatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "DetectorEvaluation_fingerprint_identityVersion_sourceId_isS_key" ON "DetectorEvaluation"("fingerprint", "identityVersion", "sourceId", "isShadow");

-- CreateIndex
CREATE INDEX "PolicyBacktestFinding_runId_diffKind_idx" ON "PolicyBacktestFinding"("runId", "diffKind");

-- CreateIndex
CREATE INDEX "LabelMetricSnapshot_labelDefinitionId_observedAt_id_idx" ON "LabelMetricSnapshot"("labelDefinitionId", "observedAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "LabelMetricSnapshot_triggerWorkItemId_labelDefinitionId_key" ON "LabelMetricSnapshot"("triggerWorkItemId", "labelDefinitionId");

-- CreateIndex
CREATE INDEX "LabelMetricDaily_labelDefinitionId_date_idx" ON "LabelMetricDaily"("labelDefinitionId", "date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "LabelMetricDaily_date_labelDefinitionId_key" ON "LabelMetricDaily"("date", "labelDefinitionId");

-- CreateIndex
CREATE INDEX "AccountLabelChange_accountId_changedAt_idx" ON "AccountLabelChange"("accountId", "changedAt" DESC);

-- CreateIndex
CREATE INDEX "AccountLabelChange_changedAt_idx" ON "AccountLabelChange" USING BRIN ("changedAt");

-- CreateIndex
CREATE INDEX "LabelSummaryCurrent_generationId_qualityStatus_idx" ON "LabelSummaryCurrent"("generationId", "qualityStatus");

-- CreateIndex
CREATE INDEX "BlockRelationCurrent_generationId_status_statusChangedAt_bl_idx" ON "BlockRelationCurrent"("generationId", "status", "statusChangedAt" DESC, "blockId");

-- CreateIndex
CREATE INDEX "BlockStateChange_blockId_changedAt_id_idx" ON "BlockStateChange"("blockId", "changedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "AttentionItemCurrent_generationId_priority_idx" ON "AttentionItemCurrent"("generationId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "OverviewSnapshot_generationId_key" ON "OverviewSnapshot"("generationId");

-- CreateIndex
CREATE INDEX "OverviewSnapshot_generatedAt_idx" ON "OverviewSnapshot"("generatedAt" DESC);

-- CreateIndex
CREATE INDEX "ReadModelGeneration_modelKey_status_startedAt_idx" ON "ReadModelGeneration"("modelKey", "status", "startedAt" DESC);

-- AddForeignKey
ALTER TABLE "AccountCrawlState" ADD CONSTRAINT "AccountCrawlState_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelRuleVersion" ADD CONSTRAINT "LabelRuleVersion_labelDefinitionId_fkey" FOREIGN KEY ("labelDefinitionId") REFERENCES "LabelDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followeeId_fkey" FOREIGN KEY ("followeeId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowStateChange" ADD CONSTRAINT "FollowStateChange_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowStateChange" ADD CONSTRAINT "FollowStateChange_followeeId_fkey" FOREIGN KEY ("followeeId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyHijackEvidence" ADD CONSTRAINT "ReplyHijackEvidence_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelEvidenceEpoch" ADD CONSTRAINT "LabelEvidenceEpoch_crawlRunId_fkey" FOREIGN KEY ("crawlRunId") REFERENCES "CrawlRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawlAccountRun" ADD CONSTRAINT "CrawlAccountRun_crawlRunId_fkey" FOREIGN KEY ("crawlRunId") REFERENCES "CrawlRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawlAccountCheckpoint" ADD CONSTRAINT "CrawlAccountCheckpoint_crawlRunId_fkey" FOREIGN KEY ("crawlRunId") REFERENCES "CrawlRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawlAccountLabelRun" ADD CONSTRAINT "CrawlAccountLabelRun_crawlRunId_fkey" FOREIGN KEY ("crawlRunId") REFERENCES "CrawlRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawlAuthorCheckpoint" ADD CONSTRAINT "CrawlAuthorCheckpoint_crawlRunId_fkey" FOREIGN KEY ("crawlRunId") REFERENCES "CrawlRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockAccountRun" ADD CONSTRAINT "BlockAccountRun_blockRunId_fkey" FOREIGN KEY ("blockRunId") REFERENCES "BlockRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockAction" ADD CONSTRAINT "BlockAction_blockAccountRunId_fkey" FOREIGN KEY ("blockAccountRunId") REFERENCES "BlockAccountRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockAction" ADD CONSTRAINT "BlockAction_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockAction" ADD CONSTRAINT "BlockAction_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockAction" ADD CONSTRAINT "BlockAction_labelDefinitionId_fkey" FOREIGN KEY ("labelDefinitionId") REFERENCES "LabelDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockAction" ADD CONSTRAINT "BlockAction_outboxEntryId_fkey" FOREIGN KEY ("outboxEntryId") REFERENCES "BlockOutboxEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockOutboxEntry" ADD CONSTRAINT "BlockOutboxEntry_blockAccountRunId_fkey" FOREIGN KEY ("blockAccountRunId") REFERENCES "BlockAccountRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockOutboxEntry" ADD CONSTRAINT "BlockOutboxEntry_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockOutboxEntry" ADD CONSTRAINT "BlockOutboxEntry_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockOutboxEntry" ADD CONSTRAINT "BlockOutboxEntry_labelDefinitionId_fkey" FOREIGN KEY ("labelDefinitionId") REFERENCES "LabelDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationStage" ADD CONSTRAINT "OperationStage_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "OperationCycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalIssueOccurrence" ADD CONSTRAINT "OperationalIssueOccurrence_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "OperationalIssue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewFindingOccurrence" ADD CONSTRAINT "ReviewFindingOccurrence_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "ReviewFinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingEvidence" ADD CONSTRAINT "FindingEvidence_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "ReviewFinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingEntityLink" ADD CONSTRAINT "FindingEntityLink_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "ReviewFinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyBacktestFinding" ADD CONSTRAINT "PolicyBacktestFinding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PolicyBacktestRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- 2. ACL の集計表、weekly review の sample、labeled counter を維持する関数とトリガー
-- 時刻型は timestamptz のため、now() との比較は変換せずに行う。
-- 分単位の丸めは、セッションの timezone に依存しないよう `date_trunc(..., 'UTC')` で行う。
-- ============================================================

-- weekly review の sample 用 bucket。ID の文字列表現から 0..4095 を返す。
CREATE FUNCTION weekly_review_sample_bucket(account_id bigint) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT ('x' || substr(encode(sha256(convert_to(account_id::text, 'UTF8')), 'hex'), 1, 8))::bit(32)::int & 4095
$$;

-- ACL への書き込みと同一トランザクションで、5 つの集計表を維持する。
CREATE FUNCTION account_classification_latest_aggregate_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_sentinel CONSTANT timestamptz := timestamptz '1970-01-01 00:00:00+00';
  v_ceiling CONSTANT INTERVAL := INTERVAL '7 days';
  v_confidence_bucket_old INT;
  v_confidence_bucket_new INT;
  v_literal_old_bucket timestamptz;
  v_literal_new_bucket timestamptz;
BEGIN
  -- 5 集計テーブルに影響する列 (value/confidence/ruleVersion/reason と、分単位に
  -- 丸めた observedAt) が UPDATE 前後で変わらないなら、decrement/increment は
  -- 差し引きゼロにしかならない。単なる再クロールで observedAt が同一分内で
  -- 微増するだけの多発ケースで、不要な行ロックを取らずに済ませる。
  -- reason を対象列に含めると早期リターン率は下がるが、
  -- reasonDistribution の正しさには reason 変化の検知が必須であり、
  -- 省くことはできない。
  IF TG_OP = 'UPDATE'
    AND NEW."value" IS NOT DISTINCT FROM OLD."value"
    AND NEW."confidence" IS NOT DISTINCT FROM OLD."confidence"
    AND NEW."ruleVersion" IS NOT DISTINCT FROM OLD."ruleVersion"
    AND NEW."reason" IS NOT DISTINCT FROM OLD."reason"
    AND date_trunc('minute', NEW."observedAt", 'UTC') IS NOT DISTINCT FROM date_trunc('minute', OLD."observedAt", 'UTC')
  THEN
    RETURN NEW;
  END IF;

  -- sentinel 行を(無ければ)作ってから常に先にロックする。compaction・OLD/NEW
  -- いずれの分岐でもこの順序を守ることで、逆順ロックによるデッドロックを
  -- 構造的に排除する。DELETE では NEW が存在しないため OLD を使う。
  INSERT INTO "AccountClassificationFreshnessBucket" ("labelDefinitionId", "observedAtBucket", "count")
    VALUES (COALESCE(NEW."labelDefinitionId", OLD."labelDefinitionId"), v_sentinel, 0)
    ON CONFLICT DO NOTHING;
  PERFORM 1 FROM "AccountClassificationFreshnessBucket"
    WHERE "labelDefinitionId" = COALESCE(NEW."labelDefinitionId", OLD."labelDefinitionId")
      AND "observedAtBucket" = v_sentinel
    FOR UPDATE;

  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    v_confidence_bucket_old := LEAST(FLOOR(OLD."confidence" * 10), 9)::int;

    UPDATE "AccountClassificationValueCount"
      SET "count" = "count" - 1, "confidenceSum" = "confidenceSum" - OLD."confidence"
      WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "value" = OLD."value";
    DELETE FROM "AccountClassificationValueCount"
      WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "value" = OLD."value" AND "count" <= 0;

    UPDATE "AccountClassificationConfidenceBucketCount"
      SET "count" = "count" - 1
      WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "confidenceBucket" = v_confidence_bucket_old;
    DELETE FROM "AccountClassificationConfidenceBucketCount"
      WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "confidenceBucket" = v_confidence_bucket_old
        AND "count" <= 0;

    UPDATE "AccountClassificationRuleVersionCount"
      SET "count" = "count" - 1
      WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "ruleVersion" = OLD."ruleVersion";
    DELETE FROM "AccountClassificationRuleVersionCount"
      WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "ruleVersion" = OLD."ruleVersion"
        AND "count" <= 0;

    -- reasonDistribution は value=true 行だけを対象にするため、false 行は数えない。
    IF OLD."value" THEN
      UPDATE "AccountClassificationReasonCount"
        SET "count" = "count" - 1
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "reason" = OLD."reason";
      DELETE FROM "AccountClassificationReasonCount"
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "reason" = OLD."reason"
          AND "count" <= 0;
    END IF;

    -- freshness バケットの decrement 対象は、OLD の実際の物理的な所属先を
    -- 確認してから決める。now() だけを基準に「本来あるべきバケット」を
    -- 再計算してはならない(compaction が丸め込んだかどうかは書き込み側からは
    -- 分からないため)。
    v_literal_old_bucket := date_trunc('minute', OLD."observedAt", 'UTC');
    IF EXISTS (
      SELECT 1 FROM "AccountClassificationFreshnessBucket"
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "observedAtBucket" = v_literal_old_bucket
        FOR UPDATE
    ) THEN
      UPDATE "AccountClassificationFreshnessBucket"
        SET "count" = "count" - 1
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "observedAtBucket" = v_literal_old_bucket;
      DELETE FROM "AccountClassificationFreshnessBucket"
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "observedAtBucket" = v_literal_old_bucket
          AND "count" <= 0;
    ELSE
      UPDATE "AccountClassificationFreshnessBucket"
        SET "count" = "count" - 1
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "observedAtBucket" = v_sentinel;
    END IF;
  END IF;

  -- DELETE は OLD の decrement のみで完結し、INSERT 相当の増分は行わない。
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  v_confidence_bucket_new := LEAST(FLOOR(NEW."confidence" * 10), 9)::int;

  INSERT INTO "AccountClassificationValueCount" ("labelDefinitionId", "value", "count", "confidenceSum")
    VALUES (NEW."labelDefinitionId", NEW."value", 1, NEW."confidence")
    ON CONFLICT ("labelDefinitionId", "value") DO UPDATE SET
      "count" = "AccountClassificationValueCount"."count" + 1,
      "confidenceSum" = "AccountClassificationValueCount"."confidenceSum" + NEW."confidence";

  INSERT INTO "AccountClassificationConfidenceBucketCount" ("labelDefinitionId", "confidenceBucket", "count")
    VALUES (NEW."labelDefinitionId", v_confidence_bucket_new, 1)
    ON CONFLICT ("labelDefinitionId", "confidenceBucket") DO UPDATE SET
      "count" = "AccountClassificationConfidenceBucketCount"."count" + 1;

  INSERT INTO "AccountClassificationRuleVersionCount" ("labelDefinitionId", "ruleVersion", "count")
    VALUES (NEW."labelDefinitionId", NEW."ruleVersion", 1)
    ON CONFLICT ("labelDefinitionId", "ruleVersion") DO UPDATE SET
      "count" = "AccountClassificationRuleVersionCount"."count" + 1;

  -- reasonDistribution は value=true 行だけを対象にするため、false 行は数えない。
  IF NEW."value" THEN
    INSERT INTO "AccountClassificationReasonCount" ("labelDefinitionId", "reason", "count")
      VALUES (NEW."labelDefinitionId", NEW."reason", 1)
      ON CONFLICT ("labelDefinitionId", "reason") DO UPDATE SET
        "count" = "AccountClassificationReasonCount"."count" + 1;
  END IF;

  -- freshness バケットの increment 対象も OLD と対称に、実際の物理的な所属先を
  -- 確認してから決める。既存バケットが存在すれば年齢に関わらずそこへ加算し、
  -- 同一分単位バケットの量がバケット行と sentinel に分裂することを防ぐ。
  -- 存在しない場合のみ年齢基準で振り分ける。
  v_literal_new_bucket := date_trunc('minute', NEW."observedAt", 'UTC');
  IF EXISTS (
    SELECT 1 FROM "AccountClassificationFreshnessBucket"
      WHERE "labelDefinitionId" = NEW."labelDefinitionId" AND "observedAtBucket" = v_literal_new_bucket
      FOR UPDATE
  ) THEN
    UPDATE "AccountClassificationFreshnessBucket"
      SET "count" = "count" + 1
      WHERE "labelDefinitionId" = NEW."labelDefinitionId" AND "observedAtBucket" = v_literal_new_bucket;
  ELSIF now() - NEW."observedAt" > v_ceiling THEN
    UPDATE "AccountClassificationFreshnessBucket"
      SET "count" = "count" + 1
      WHERE "labelDefinitionId" = NEW."labelDefinitionId" AND "observedAtBucket" = v_sentinel;
  ELSE
    INSERT INTO "AccountClassificationFreshnessBucket" ("labelDefinitionId", "observedAtBucket", "count")
      VALUES (NEW."labelDefinitionId", v_literal_new_bucket, 1);
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER account_classification_latest_aggregate_trigger
  AFTER INSERT OR UPDATE OR DELETE ON "AccountClassificationLatest"
  FOR EACH ROW EXECUTE FUNCTION account_classification_latest_aggregate_trigger();

-- weekly review の baseline sampling 用に、eligible な ACL 行数を bucket 単位で維持する。
CREATE FUNCTION weekly_review_sample_bucket_count_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_old_eligible BOOLEAN;
  v_new_eligible BOOLEAN;
  v_bucket INT;
BEGIN
  v_old_eligible := TG_OP IN ('UPDATE', 'DELETE') AND OLD."evaluable" AND OLD."labeledAt" IS NOT NULL;
  v_new_eligible := TG_OP IN ('UPDATE', 'INSERT') AND NEW."evaluable" AND NEW."labeledAt" IS NOT NULL;

  IF TG_OP = 'UPDATE' AND v_old_eligible = v_new_eligible
    AND (NOT v_old_eligible OR OLD."value" IS NOT DISTINCT FROM NEW."value")
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' AND NOT v_old_eligible THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' AND NOT v_new_eligible THEN
    RETURN NEW;
  END IF;

  v_bucket := weekly_review_sample_bucket(COALESCE(NEW."accountId", OLD."accountId"));

  IF v_old_eligible AND v_new_eligible THEN
    IF OLD."value" THEN
      INSERT INTO "WeeklyReviewSampleBucketCount" ("labelDefinitionId", "value", "bucket", "count")
        VALUES (NEW."labelDefinitionId", false, v_bucket, 1)
        ON CONFLICT ("labelDefinitionId", "value", "bucket") DO UPDATE SET
          "count" = "WeeklyReviewSampleBucketCount"."count" + 1;
      UPDATE "WeeklyReviewSampleBucketCount" SET "count" = "count" - 1
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "value" = true AND "bucket" = v_bucket;
      DELETE FROM "WeeklyReviewSampleBucketCount"
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "value" = true AND "bucket" = v_bucket AND "count" <= 0;
    ELSE
      UPDATE "WeeklyReviewSampleBucketCount" SET "count" = "count" - 1
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "value" = false AND "bucket" = v_bucket;
      DELETE FROM "WeeklyReviewSampleBucketCount"
        WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "value" = false AND "bucket" = v_bucket AND "count" <= 0;
      INSERT INTO "WeeklyReviewSampleBucketCount" ("labelDefinitionId", "value", "bucket", "count")
        VALUES (NEW."labelDefinitionId", true, v_bucket, 1)
        ON CONFLICT ("labelDefinitionId", "value", "bucket") DO UPDATE SET
          "count" = "WeeklyReviewSampleBucketCount"."count" + 1;
    END IF;
    RETURN NEW;
  END IF;

  IF v_old_eligible THEN
    UPDATE "WeeklyReviewSampleBucketCount" SET "count" = "count" - 1
      WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "value" = OLD."value" AND "bucket" = v_bucket;
    DELETE FROM "WeeklyReviewSampleBucketCount"
      WHERE "labelDefinitionId" = OLD."labelDefinitionId" AND "value" = OLD."value" AND "bucket" = v_bucket AND "count" <= 0;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO "WeeklyReviewSampleBucketCount" ("labelDefinitionId", "value", "bucket", "count")
    VALUES (NEW."labelDefinitionId", NEW."value", v_bucket, 1)
    ON CONFLICT ("labelDefinitionId", "value", "bucket") DO UPDATE SET
      "count" = "WeeklyReviewSampleBucketCount"."count" + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER weekly_review_sample_bucket_count_trigger
  AFTER INSERT OR UPDATE OR DELETE ON "AccountClassificationLatest"
  FOR EACH ROW EXECUTE FUNCTION weekly_review_sample_bucket_count_trigger();

-- AccountSummaryLatest.activeLabelCount が 0 と正を跨いだ行だけ、LabeledAccountCounter を増減させる。
CREATE FUNCTION account_summary_latest_labeled_counter_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_was_labeled BOOLEAN;
  v_is_labeled BOOLEAN;
BEGIN
  v_was_labeled := (TG_OP <> 'INSERT') AND (OLD."activeLabelCount" > 0);
  v_is_labeled := (TG_OP <> 'DELETE') AND (NEW."activeLabelCount" > 0);

  IF v_was_labeled = v_is_labeled THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  UPDATE "LabeledAccountCounter"
    SET "labeledAccounts" = "labeledAccounts" + (CASE WHEN v_is_labeled THEN 1 ELSE -1 END),
        "updatedAt" = now()
    WHERE "id" = 'global';

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER account_summary_latest_labeled_counter_trigger
  AFTER INSERT OR UPDATE OR DELETE ON "AccountSummaryLatest"
  FOR EACH ROW EXECUTE FUNCTION account_summary_latest_labeled_counter_trigger();

-- ============================================================
-- 3. Prisma の schema DSL で表現できないもの
-- ============================================================

-- 初期行。トリガーが UPDATE するため、行が無いと集計が止まる。
INSERT INTO "LabeledAccountCounter" ("id", "labeledAccounts", "updatedAt")
VALUES ('global', 0, now());

-- recent tweets backfill の候補 selector 用。lastRecentTweetsAttemptedAt が NULL の行だけを引く。
CREATE INDEX "AccountCrawlState_recent_tweets_unattempted_idx"
  ON "AccountCrawlState" ("accountId")
  WHERE "lastRecentTweetsAttemptedAt" IS NULL;

-- weekly review の baseline sampling 用。eligible な行 (evaluable かつ labeledAt あり) だけを bucket 順に引く。
CREATE INDEX "AccountClassificationLatest_weekly_review_sample_idx"
  ON "AccountClassificationLatest" (
    "labelDefinitionId", "value", weekly_review_sample_bucket("accountId"), "accountId"
  )
  WHERE "evaluable" = true AND "labeledAt" IS NOT NULL;

-- viewer の検索用の trigram インデックス。
CREATE INDEX "AccountSummaryLatest_normalizedDisplayName_gin_idx"
  ON "AccountSummaryLatest" USING gin ("normalizedDisplayName" gin_trgm_ops);
CREATE INDEX "AccountSummaryLatest_searchDocument_gin_idx"
  ON "AccountSummaryLatest" USING gin ("searchDocument" gin_trgm_ops);

-- analyzer の再処理を冪等にするキー。値があるときだけ一意にし、NULL の行を索引に載せない。
CREATE UNIQUE INDEX "AccountLabelChange_sourceLabelId_key"
  ON "AccountLabelChange" ("sourceLabelId")
  WHERE "sourceLabelId" IS NOT NULL;

ALTER TABLE "FollowStateChange"
  ADD CONSTRAINT "FollowStateChange_changeType_check"
  CHECK ("changeType" IN ('followed', 'unfollowed'));

-- versionNo は 1 始まりで、0 は予約値。AccountLabelState.versions の符号付きエンコードで 0 と -0 を区別できないため。
ALTER TABLE "LabelRuleVersion"
  ADD CONSTRAINT "LabelRuleVersion_versionNo_check" CHECK ("versionNo" >= 1);
ALTER TABLE "AccountActiveLabel"
  ADD CONSTRAINT "AccountActiveLabel_ruleVersionNo_check" CHECK ("ruleVersionNo" >= 1);

-- 圧縮は lz4 にする (大きい JSON の展開が速い)。
ALTER TABLE "AccountClassificationObservation"
  ALTER COLUMN "classificationSnapshot" SET COMPRESSION lz4;

-- ============================================================
-- 4. テーブルごとの fillfactor と autovacuum
-- 既定の閾値 (20%) では、数千万行の表は大量の死んだ行が溜まるまで動かないため、大きい表は閾値を下げる。
-- Tweet は tweet-hash.sql / tweet-range.sql で、パーティションごとに設定する。
-- ============================================================

ALTER TABLE "Account" SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE "AccountCrawlState" SET (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE "AccountLabelState" SET (fillfactor = 75, autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE "AccountClassificationLatest" SET (autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE "AccountActiveLabel" SET (autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE "AnalysisWorkItem" SET (fillfactor = 50, autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE "AccountClassificationObservation" SET (autovacuum_vacuum_scale_factor = 0.02);
-- AccountLabelChange は追記のみのため、insert 起点の autovacuum だけを早める。
ALTER TABLE "AccountLabelChange" SET (autovacuum_vacuum_insert_scale_factor = 0.02);
