-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RuntimeEnvironment" AS ENUM ('test', 'live');

-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('active', 'suspended', 'disabled');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('pending', 'qualifying', 'online', 'degraded', 'offline', 'quarantined', 'retired');

-- CreateEnum
CREATE TYPE "SimStatus" AS ENUM ('pending', 'active', 'payout_stale', 'quarantined', 'disabled');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('awaiting_payment', 'late_grace', 'matching', 'manual_review', 'success', 'expired', 'failed');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('accepted', 'queued', 'device_assigned', 'device_started', 'committed', 'provider_pending', 'success', 'failed', 'unknown', 'manual_review', 'cancelled');

-- CreateEnum
CREATE TYPE "DeviceJobType" AS ENUM ('customer_withdrawal', 'unknown_reconciliation', 'merchant_settlement', 'emergency_liquidity_move', 'automatic_sweep', 'balance_query');

-- CreateEnum
CREATE TYPE "DeviceJobState" AS ENUM ('queued', 'leased', 'device_started', 'committed', 'provider_pending', 'succeeded', 'failed', 'unknown', 'cancelled');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('asset', 'liability', 'revenue', 'expense', 'suspense');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('open', 'proposed', 'resolved', 'rejected');

-- CreateEnum
CREATE TYPE "FinancialMode" AS ENUM ('merchant_debit', 'internal_move');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('requested', 'approved', 'rejected', 'dispatched', 'success', 'failed', 'unknown', 'manual_review');

-- CreateEnum
CREATE TYPE "SweepRuleStatus" AS ENUM ('pending', 'approved', 'rejected', 'disabled');

-- CreateEnum
CREATE TYPE "SweepDestinationType" AS ENUM ('platform_treasury', 'merchant_owned');

-- CreateEnum
CREATE TYPE "SweepExecutionStatus" AS ENUM ('queued', 'device_started', 'committed', 'provider_pending', 'success', 'failed', 'unknown', 'manual_review');

-- CreateEnum
CREATE TYPE "MerchantUserRole" AS ENUM ('owner', 'admin', 'support');

-- CreateEnum
CREATE TYPE "PlatformStaffRole" AS ENUM ('admin', 'operator', 'support', 'auditor');

-- CreateEnum
CREATE TYPE "HumanUserStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "TreasuryWalletStatus" AS ENUM ('pending', 'active', 'disabled', 'quarantined');

-- CreateEnum
CREATE TYPE "ConfigurationChangeStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "OperationalAlertStatus" AS ENUM ('open', 'acknowledged', 'resolved');

-- CreateEnum
CREATE TYPE "AlertDeliveryStatus" AS ENUM ('pending', 'processing', 'delivered', 'failed');

-- CreateEnum
CREATE TYPE "QualificationRunStatus" AS ENUM ('pending', 'running', 'passed', 'failed', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "QualificationCheckStatus" AS ENUM ('pending', 'passed', 'failed');

-- CreateEnum
CREATE TYPE "SupportCaseStatus" AS ENUM ('open', 'investigating', 'awaiting_merchant', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "SupportCaseCategory" AS ENUM ('transaction_match', 'withdrawal_outcome', 'topup', 'settlement', 'webhook', 'api', 'other');

-- CreateTable
CREATE TABLE "Merchant" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "status" "MerchantStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantUser" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "displayName" VARCHAR(160) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "role" "MerchantUserRole" NOT NULL,
    "status" "HumanUserStatus" NOT NULL DEFAULT 'active',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantInvitation" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "role" "MerchantUserRole" NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "invitedById" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "ipAddress" VARCHAR(64),
    "userAgent" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformStaff" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "displayName" VARCHAR(160) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "role" "PlatformStaffRole" NOT NULL,
    "status" "HumanUserStatus" NOT NULL DEFAULT 'active',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformStaff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSession" (
    "id" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "ipAddress" VARCHAR(64),
    "userAgent" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformReauthToken" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformReauthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" VARCHAR(100) NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "TreasuryWallet" (
    "id" UUID NOT NULL,
    "merchantId" UUID,
    "environment" "RuntimeEnvironment" NOT NULL DEFAULT 'live',
    "phoneNumber" VARCHAR(16) NOT NULL,
    "accountName" VARCHAR(200) NOT NULL,
    "status" "TreasuryWalletStatus" NOT NULL DEFAULT 'pending',
    "predictedBalanceMinor" BIGINT NOT NULL DEFAULT 0,
    "confirmedBalanceMinor" BIGINT,
    "lastConfirmedAt" TIMESTAMP(3),
    "approvedBy" VARCHAR(128),
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TreasuryWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigurationChange" (
    "id" UUID NOT NULL,
    "scopeType" VARCHAR(40) NOT NULL,
    "scopeId" VARCHAR(128) NOT NULL,
    "version" INTEGER NOT NULL,
    "proposed" JSONB NOT NULL,
    "status" "ConfigurationChangeStatus" NOT NULL DEFAULT 'pending',
    "proposedBy" VARCHAR(128) NOT NULL,
    "reviewedBy" VARCHAR(128),
    "reviewReason" VARCHAR(1000),
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfigurationChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalAlert" (
    "id" UUID NOT NULL,
    "type" VARCHAR(80) NOT NULL,
    "severity" VARCHAR(20) NOT NULL DEFAULT 'warning',
    "status" "OperationalAlertStatus" NOT NULL DEFAULT 'open',
    "message" VARCHAR(1000) NOT NULL,
    "dedupeKey" VARCHAR(64) NOT NULL,
    "metadata" JSONB NOT NULL,
    "acknowledgedBy" VARCHAR(128),
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedBy" VARCHAR(128),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertDelivery" (
    "id" UUID NOT NULL,
    "alertId" UUID NOT NULL,
    "channel" VARCHAR(32) NOT NULL,
    "destination" VARCHAR(255) NOT NULL,
    "status" "AlertDeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" VARCHAR(64),
    "leaseExpiresAt" TIMESTAMP(3),
    "lastError" VARCHAR(1000),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantConfig" (
    "merchantId" UUID NOT NULL,
    "allowAlternateWithdrawalPhone" BOOLEAN NOT NULL DEFAULT false,
    "depositMinimumMinor" BIGINT NOT NULL DEFAULT 1000,
    "depositMaximumMinor" BIGINT NOT NULL DEFAULT 500000000,
    "wrongAmountToleranceMinor" BIGINT NOT NULL DEFAULT 0,
    "depositCountdownSeconds" INTEGER NOT NULL DEFAULT 600,
    "depositLateGraceSeconds" INTEGER NOT NULL DEFAULT 1800,
    "reserveProviderFeeMinor" BIGINT NOT NULL DEFAULT 10000,
    "gatewayFeeFlatMinor" BIGINT NOT NULL DEFAULT 0,
    "technicalDifficultyMessage" VARCHAR(500) NOT NULL DEFAULT 'We are experiencing technical difficulties. Please try again shortly.',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantConfig_pkey" PRIMARY KEY ("merchantId")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "environment" "RuntimeEnvironment" NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "prefix" VARCHAR(32) NOT NULL,
    "secretHash" VARCHAR(255) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "environment" "RuntimeEnvironment" NOT NULL,
    "operation" VARCHAR(80) NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "responseCode" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetLocation" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "timezone" VARCHAR(80) NOT NULL DEFAULT 'Africa/Addis_Ababa',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceGroup" (
    "id" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "dailyLimitMinor" BIGINT NOT NULL DEFAULT 15000000,
    "walletCeilingMinor" BIGINT NOT NULL DEFAULT 7500000,
    "safetyBalanceMinor" BIGINT NOT NULL DEFAULT 100000,
    "safetyHeadroomMinor" BIGINT NOT NULL DEFAULT 100000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantGroupPolicy" (
    "merchantId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "dedicated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MerchantGroupPolicy_pkey" PRIMARY KEY ("merchantId","groupId")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "hardwareSerial" VARCHAR(120),
    "imei1" VARCHAR(20),
    "imei2" VARCHAR(20),
    "model" VARCHAR(100),
    "buildFingerprint" VARCHAR(255),
    "agentVersion" VARCHAR(32),
    "ussdProfileVersion" VARCHAR(32),
    "status" "DeviceStatus" NOT NULL DEFAULT 'pending',
    "authTokenHash" VARCHAR(255),
    "certificateFingerprint" VARCHAR(128),
    "lastHeartbeatAt" TIMESTAMP(3),
    "lastPermissionsOk" BOOLEAN NOT NULL DEFAULT false,
    "lastAccessibilityOk" BOOLEAN NOT NULL DEFAULT false,
    "openclawPaired" BOOLEAN NOT NULL DEFAULT false,
    "batteryPercent" INTEGER,
    "charging" BOOLEAN,
    "temperatureCelsius" DECIMAL(5,2),
    "networkType" VARCHAR(32),
    "activeUssdJobId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimWallet" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "subscriptionId" INTEGER,
    "iccid" VARCHAR(32) NOT NULL,
    "iccidHash" VARCHAR(64) NOT NULL,
    "phoneNumber" VARCHAR(16) NOT NULL,
    "telebirrAccountName" VARCHAR(200) NOT NULL,
    "status" "SimStatus" NOT NULL DEFAULT 'pending',
    "mainBalanceMinor" BIGINT NOT NULL DEFAULT 0,
    "incentiveBalanceMinor" BIGINT NOT NULL DEFAULT 0,
    "fuelBalanceMinor" BIGINT NOT NULL DEFAULT 0,
    "pocketMoneyBalanceMinor" BIGINT NOT NULL DEFAULT 0,
    "reservedBalanceMinor" BIGINT NOT NULL DEFAULT 0,
    "sentTodayMinor" BIGINT NOT NULL DEFAULT 0,
    "receivedTodayMinor" BIGINT NOT NULL DEFAULT 0,
    "financialDay" TIMESTAMP(3),
    "lastBalanceAt" TIMESTAMP(3),
    "lastBalanceSource" VARCHAR(32),
    "lastSmsAt" TIMESTAMP(3),
    "nextFencingToken" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SimWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceQualificationRun" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "status" "QualificationRunStatus" NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedBy" VARCHAR(128),
    "approvalReason" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceQualificationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceQualificationCheck" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "simWalletId" UUID,
    "key" VARCHAR(80) NOT NULL,
    "status" "QualificationCheckStatus" NOT NULL DEFAULT 'pending',
    "evidence" JSONB,
    "observedAt" TIMESTAMP(3),
    "recordedBy" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceQualificationCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BalanceSnapshot" (
    "id" UUID NOT NULL,
    "simWalletId" UUID NOT NULL,
    "mainBalanceMinor" BIGINT NOT NULL,
    "incentiveBalanceMinor" BIGINT NOT NULL,
    "fuelBalanceMinor" BIGINT NOT NULL,
    "pocketMoneyBalanceMinor" BIGINT NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BalanceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositIntent" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "environment" "RuntimeEnvironment" NOT NULL,
    "simWalletId" UUID NOT NULL,
    "txRef" VARCHAR(128) NOT NULL,
    "customerId" VARCHAR(128) NOT NULL,
    "customerName" VARCHAR(200) NOT NULL,
    "customerPhone" VARCHAR(16) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "creditedAmountMinor" BIGINT,
    "currency" CHAR(3) NOT NULL DEFAULT 'ETB',
    "status" "DepositStatus" NOT NULL DEFAULT 'awaiting_payment',
    "callbackUrl" VARCHAR(2000),
    "returnUrl" VARCHAR(2000),
    "metadata" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lateGraceEndsAt" TIMESTAMP(3) NOT NULL,
    "matchedReceiptId" UUID,
    "providerTransactionId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsReceipt" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "simWalletId" UUID NOT NULL,
    "sender" VARCHAR(32) NOT NULL,
    "direction" VARCHAR(20) NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "rawBody" TEXT NOT NULL,
    "bodyHash" VARCHAR(64) NOT NULL,
    "parsed" JSONB,
    "providerTransactionId" VARCHAR(64),
    "amountMinor" BIGINT,
    "counterpartyName" VARCHAR(200),
    "counterpartyPhoneSuffix" VARCHAR(12),
    "counterpartyPhonePrefix" VARCHAR(12),
    "providerOccurredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "multipartReference" VARCHAR(100),
    "evidenceObjectKey" VARCHAR(512),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transfer" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "environment" "RuntimeEnvironment" NOT NULL,
    "simWalletId" UUID,
    "reference" VARCHAR(128) NOT NULL,
    "customerId" VARCHAR(128) NOT NULL,
    "destinationPhone" VARCHAR(16) NOT NULL,
    "expectedName" VARCHAR(200) NOT NULL,
    "resolvedName" VARCHAR(200),
    "amountMinor" BIGINT NOT NULL,
    "reserveProviderFeeMinor" BIGINT NOT NULL,
    "providerFeeMinor" BIGINT,
    "providerVatMinor" BIGINT,
    "gatewayFeeMinor" BIGINT NOT NULL,
    "financialMode" "FinancialMode" NOT NULL DEFAULT 'merchant_debit',
    "operationKind" "DeviceJobType" NOT NULL DEFAULT 'customer_withdrawal',
    "status" "TransferStatus" NOT NULL DEFAULT 'accepted',
    "callbackUrl" VARCHAR(2000),
    "metadata" JSONB,
    "providerTransactionId" VARCHAR(64),
    "committedAt" TIMESTAMP(3),
    "estimatedCompletionAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementRequest" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "environment" "RuntimeEnvironment" NOT NULL,
    "reference" VARCHAR(128) NOT NULL,
    "destinationPhone" VARCHAR(16) NOT NULL,
    "expectedName" VARCHAR(200) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'requested',
    "transferId" UUID,
    "requestedBy" VARCHAR(128) NOT NULL,
    "reviewedBy" VARCHAR(128),
    "reviewReason" VARCHAR(1000),
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SweepRule" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "environment" "RuntimeEnvironment" NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "status" "SweepRuleStatus" NOT NULL DEFAULT 'pending',
    "destinationType" "SweepDestinationType" NOT NULL,
    "destinationPhone" VARCHAR(16) NOT NULL,
    "destinationName" VARCHAR(200) NOT NULL,
    "highWaterMinor" BIGINT NOT NULL,
    "targetBalanceMinor" BIGINT NOT NULL,
    "maxPerRunMinor" BIGINT NOT NULL,
    "minimumIntervalSeconds" INTEGER NOT NULL DEFAULT 900,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "proposedBy" VARCHAR(128) NOT NULL,
    "approvedBy" VARCHAR(128),
    "approvalReason" VARCHAR(1000),
    "approvedAt" TIMESTAMP(3),
    "lastExecutedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SweepRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SweepExecution" (
    "id" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "simWalletId" UUID NOT NULL,
    "transferId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" "SweepExecutionStatus" NOT NULL DEFAULT 'queued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SweepExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferAttempt" (
    "id" UUID NOT NULL,
    "transferId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "fencingToken" BIGINT NOT NULL,
    "deviceJobId" UUID,
    "startedAt" TIMESTAMP(3),
    "committedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "outcome" VARCHAR(32),
    "errorCode" VARCHAR(80),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransferAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceJob" (
    "id" UUID NOT NULL,
    "type" "DeviceJobType" NOT NULL,
    "state" "DeviceJobState" NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL,
    "deviceId" UUID,
    "simWalletId" UUID NOT NULL,
    "profileVersion" VARCHAR(32) NOT NULL,
    "payload" JSONB NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "fencingToken" BIGINT NOT NULL,
    "leaseOwner" UUID,
    "leaseExpiresAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "signature" VARCHAR(128),
    "startedAt" TIMESTAMP(3),
    "committedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorCode" VARCHAR(80),
    "lastScreenText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UssdEvidence" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "deviceJobId" UUID NOT NULL,
    "stepId" VARCHAR(128) NOT NULL,
    "encryptedScreen" TEXT NOT NULL,
    "screenHash" VARCHAR(64) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "evidenceObjectKey" VARCHAR(512),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UssdEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnattributedSmsEvidence" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "encryptedBody" TEXT NOT NULL,
    "bodyHash" VARCHAR(64) NOT NULL,
    "reason" VARCHAR(120) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "evidenceObjectKey" VARCHAR(512),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnattributedSmsEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" UUID NOT NULL,
    "merchantId" UUID,
    "environment" "RuntimeEnvironment" NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "balanceMinor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'ETB',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerJournal" (
    "id" UUID NOT NULL,
    "environment" "RuntimeEnvironment" NOT NULL,
    "sourceType" VARCHAR(50) NOT NULL,
    "sourceId" UUID NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerJournal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" UUID NOT NULL,
    "journalId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "direction" CHAR(1) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "environment" "RuntimeEnvironment" NOT NULL,
    "url" VARCHAR(2000) NOT NULL,
    "secretHash" VARCHAR(255) NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "aggregateType" VARCHAR(50) NOT NULL,
    "aggregateId" UUID NOT NULL,
    "eventType" VARCHAR(80) NOT NULL,
    "payload" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "outboxEventId" UUID NOT NULL,
    "endpointId" UUID NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" VARCHAR(64),
    "leaseExpiresAt" TIMESTAMP(3),
    "responseCode" INTEGER,
    "responseBody" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxEvent" (
    "id" UUID NOT NULL,
    "source" VARCHAR(40) NOT NULL,
    "externalId" VARCHAR(128) NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationCase" (
    "id" UUID NOT NULL,
    "merchantId" UUID,
    "type" VARCHAR(60) NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'open',
    "referenceType" VARCHAR(40) NOT NULL,
    "referenceId" UUID NOT NULL,
    "evidence" JSONB NOT NULL,
    "proposal" JSONB,
    "resolution" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconciliationCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantSupportCase" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "environment" "RuntimeEnvironment" NOT NULL,
    "category" "SupportCaseCategory" NOT NULL,
    "status" "SupportCaseStatus" NOT NULL DEFAULT 'open',
    "subject" VARCHAR(200) NOT NULL,
    "reference" VARCHAR(128),
    "createdByUserId" UUID,
    "assignedStaffId" UUID,
    "workflowNote" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "MerchantSupportCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportCaseMessage" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "authorMerchantUserId" UUID,
    "authorPlatformStaffId" UUID,
    "body" TEXT NOT NULL,
    "evidenceReference" VARCHAR(500),
    "proposal" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportCaseMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "merchantId" UUID,
    "actorType" VARCHAR(32) NOT NULL,
    "actorId" VARCHAR(128) NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "targetType" VARCHAR(60) NOT NULL,
    "targetId" VARCHAR(128),
    "reason" VARCHAR(1000),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceActivationCode" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "codeHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceActivationCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_slug_key" ON "Merchant"("slug");

-- CreateIndex
CREATE INDEX "MerchantUser_email_status_idx" ON "MerchantUser"("email", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantUser_merchantId_email_key" ON "MerchantUser"("merchantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantInvitation_tokenHash_key" ON "MerchantInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "MerchantInvitation_merchantId_email_expiresAt_idx" ON "MerchantInvitation"("merchantId", "email", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantSession_tokenHash_key" ON "MerchantSession"("tokenHash");

-- CreateIndex
CREATE INDEX "MerchantSession_userId_expiresAt_idx" ON "MerchantSession"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformStaff_email_key" ON "PlatformStaff"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformSession_tokenHash_key" ON "PlatformSession"("tokenHash");

-- CreateIndex
CREATE INDEX "PlatformSession_staffId_expiresAt_idx" ON "PlatformSession"("staffId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformReauthToken_tokenHash_key" ON "PlatformReauthToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PlatformReauthToken_sessionId_expiresAt_idx" ON "PlatformReauthToken"("sessionId", "expiresAt");

-- CreateIndex
CREATE INDEX "TreasuryWallet_status_environment_idx" ON "TreasuryWallet"("status", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "TreasuryWallet_environment_phoneNumber_key" ON "TreasuryWallet"("environment", "phoneNumber");

-- CreateIndex
CREATE INDEX "ConfigurationChange_status_createdAt_idx" ON "ConfigurationChange"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigurationChange_scopeType_scopeId_version_key" ON "ConfigurationChange"("scopeType", "scopeId", "version");

-- CreateIndex
CREATE INDEX "OperationalAlert_status_createdAt_idx" ON "OperationalAlert"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OperationalAlert_dedupeKey_createdAt_idx" ON "OperationalAlert"("dedupeKey", "createdAt");

-- CreateIndex
CREATE INDEX "AlertDelivery_status_nextAttemptAt_idx" ON "AlertDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "AlertDelivery_status_leaseExpiresAt_idx" ON "AlertDelivery"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_prefix_key" ON "ApiKey"("prefix");

-- CreateIndex
CREATE INDEX "ApiKey_merchantId_environment_idx" ON "ApiKey"("merchantId", "environment");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_merchantId_environment_operation_key_key" ON "IdempotencyRecord"("merchantId", "environment", "operation", "key");

-- CreateIndex
CREATE UNIQUE INDEX "FleetLocation_code_key" ON "FleetLocation"("code");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceGroup_code_key" ON "DeviceGroup"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Device_hardwareSerial_key" ON "Device"("hardwareSerial");

-- CreateIndex
CREATE UNIQUE INDEX "Device_imei1_key" ON "Device"("imei1");

-- CreateIndex
CREATE UNIQUE INDEX "Device_imei2_key" ON "Device"("imei2");

-- CreateIndex
CREATE UNIQUE INDEX "Device_certificateFingerprint_key" ON "Device"("certificateFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "Device_activeUssdJobId_key" ON "Device"("activeUssdJobId");

-- CreateIndex
CREATE UNIQUE INDEX "SimWallet_iccid_key" ON "SimWallet"("iccid");

-- CreateIndex
CREATE UNIQUE INDEX "SimWallet_iccidHash_key" ON "SimWallet"("iccidHash");

-- CreateIndex
CREATE UNIQUE INDEX "SimWallet_phoneNumber_key" ON "SimWallet"("phoneNumber");

-- CreateIndex
CREATE INDEX "SimWallet_status_mainBalanceMinor_idx" ON "SimWallet"("status", "mainBalanceMinor");

-- CreateIndex
CREATE UNIQUE INDEX "SimWallet_deviceId_slot_key" ON "SimWallet"("deviceId", "slot");

-- CreateIndex
CREATE INDEX "DeviceQualificationRun_deviceId_createdAt_idx" ON "DeviceQualificationRun"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceQualificationRun_status_createdAt_idx" ON "DeviceQualificationRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceQualificationCheck_runId_status_idx" ON "DeviceQualificationCheck"("runId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceQualificationCheck_runId_simWalletId_key_key" ON "DeviceQualificationCheck"("runId", "simWalletId", "key");

-- CreateIndex
CREATE INDEX "BalanceSnapshot_simWalletId_observedAt_idx" ON "BalanceSnapshot"("simWalletId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DepositIntent_matchedReceiptId_key" ON "DepositIntent"("matchedReceiptId");

-- CreateIndex
CREATE UNIQUE INDEX "DepositIntent_providerTransactionId_key" ON "DepositIntent"("providerTransactionId");

-- CreateIndex
CREATE INDEX "DepositIntent_merchantId_environment_customerId_status_idx" ON "DepositIntent"("merchantId", "environment", "customerId", "status");

-- CreateIndex
CREATE INDEX "DepositIntent_simWalletId_status_expiresAt_idx" ON "DepositIntent"("simWalletId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "DepositIntent_merchantId_environment_txRef_key" ON "DepositIntent"("merchantId", "environment", "txRef");

-- CreateIndex
CREATE UNIQUE INDEX "SmsReceipt_eventId_key" ON "SmsReceipt"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "SmsReceipt_providerTransactionId_key" ON "SmsReceipt"("providerTransactionId");

-- CreateIndex
CREATE INDEX "SmsReceipt_simWalletId_receivedAt_idx" ON "SmsReceipt"("simWalletId", "receivedAt");

-- CreateIndex
CREATE INDEX "SmsReceipt_type_providerOccurredAt_idx" ON "SmsReceipt"("type", "providerOccurredAt");

-- CreateIndex
CREATE INDEX "SmsReceipt_evidenceObjectKey_idx" ON "SmsReceipt"("evidenceObjectKey");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_providerTransactionId_key" ON "Transfer"("providerTransactionId");

-- CreateIndex
CREATE INDEX "Transfer_status_createdAt_idx" ON "Transfer"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_merchantId_environment_reference_key" ON "Transfer"("merchantId", "environment", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementRequest_transferId_key" ON "SettlementRequest"("transferId");

-- CreateIndex
CREATE INDEX "SettlementRequest_status_createdAt_idx" ON "SettlementRequest"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementRequest_merchantId_environment_reference_key" ON "SettlementRequest"("merchantId", "environment", "reference");

-- CreateIndex
CREATE INDEX "SweepRule_status_enabled_lastExecutedAt_idx" ON "SweepRule"("status", "enabled", "lastExecutedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SweepRule_merchantId_environment_name_key" ON "SweepRule"("merchantId", "environment", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SweepExecution_transferId_key" ON "SweepExecution"("transferId");

-- CreateIndex
CREATE UNIQUE INDEX "SweepExecution_idempotencyKey_key" ON "SweepExecution"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SweepExecution_ruleId_status_createdAt_idx" ON "SweepExecution"("ruleId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SweepExecution_simWalletId_status_idx" ON "SweepExecution"("simWalletId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TransferAttempt_deviceJobId_key" ON "TransferAttempt"("deviceJobId");

-- CreateIndex
CREATE UNIQUE INDEX "TransferAttempt_transferId_attemptNumber_key" ON "TransferAttempt"("transferId", "attemptNumber");

-- CreateIndex
CREATE INDEX "DeviceJob_state_priority_createdAt_idx" ON "DeviceJob"("state", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceJob_deviceId_state_idx" ON "DeviceJob"("deviceId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "UssdEvidence_eventId_key" ON "UssdEvidence"("eventId");

-- CreateIndex
CREATE INDEX "UssdEvidence_deviceJobId_capturedAt_idx" ON "UssdEvidence"("deviceJobId", "capturedAt");

-- CreateIndex
CREATE INDEX "UssdEvidence_evidenceObjectKey_idx" ON "UssdEvidence"("evidenceObjectKey");

-- CreateIndex
CREATE UNIQUE INDEX "UnattributedSmsEvidence_eventId_key" ON "UnattributedSmsEvidence"("eventId");

-- CreateIndex
CREATE INDEX "UnattributedSmsEvidence_deviceId_receivedAt_idx" ON "UnattributedSmsEvidence"("deviceId", "receivedAt");

-- CreateIndex
CREATE INDEX "UnattributedSmsEvidence_evidenceObjectKey_idx" ON "UnattributedSmsEvidence"("evidenceObjectKey");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_merchantId_environment_code_key" ON "LedgerAccount"("merchantId", "environment", "code");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerJournal_sourceType_sourceId_key" ON "LedgerJournal"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_createdAt_idx" ON "LedgerEntry"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_createdAt_idx" ON "OutboxEvent"("publishedAt", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_leaseExpiresAt_idx" ON "WebhookDelivery"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_outboxEventId_endpointId_key" ON "WebhookDelivery"("outboxEventId", "endpointId");

-- CreateIndex
CREATE UNIQUE INDEX "InboxEvent_source_externalId_key" ON "InboxEvent"("source", "externalId");

-- CreateIndex
CREATE INDEX "ReconciliationCase_status_createdAt_idx" ON "ReconciliationCase"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MerchantSupportCase_merchantId_environment_status_updatedAt_idx" ON "MerchantSupportCase"("merchantId", "environment", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "MerchantSupportCase_status_updatedAt_idx" ON "MerchantSupportCase"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "SupportCaseMessage_caseId_createdAt_idx" ON "SupportCaseMessage"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_merchantId_createdAt_idx" ON "AuditLog"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceActivationCode_codeHash_expiresAt_idx" ON "DeviceActivationCode"("codeHash", "expiresAt");

-- AddForeignKey
ALTER TABLE "MerchantUser" ADD CONSTRAINT "MerchantUser_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantInvitation" ADD CONSTRAINT "MerchantInvitation_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantInvitation" ADD CONSTRAINT "MerchantInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "MerchantUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantSession" ADD CONSTRAINT "MerchantSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "MerchantUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformSession" ADD CONSTRAINT "PlatformSession_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "PlatformStaff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformReauthToken" ADD CONSTRAINT "PlatformReauthToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PlatformSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreasuryWallet" ADD CONSTRAINT "TreasuryWallet_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertDelivery" ADD CONSTRAINT "AlertDelivery_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "OperationalAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantConfig" ADD CONSTRAINT "MerchantConfig_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceGroup" ADD CONSTRAINT "DeviceGroup_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "FleetLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantGroupPolicy" ADD CONSTRAINT "MerchantGroupPolicy_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantGroupPolicy" ADD CONSTRAINT "MerchantGroupPolicy_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DeviceGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DeviceGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_activeUssdJobId_fkey" FOREIGN KEY ("activeUssdJobId") REFERENCES "DeviceJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimWallet" ADD CONSTRAINT "SimWallet_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceQualificationRun" ADD CONSTRAINT "DeviceQualificationRun_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceQualificationCheck" ADD CONSTRAINT "DeviceQualificationCheck_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DeviceQualificationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceQualificationCheck" ADD CONSTRAINT "DeviceQualificationCheck_simWalletId_fkey" FOREIGN KEY ("simWalletId") REFERENCES "SimWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BalanceSnapshot" ADD CONSTRAINT "BalanceSnapshot_simWalletId_fkey" FOREIGN KEY ("simWalletId") REFERENCES "SimWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositIntent" ADD CONSTRAINT "DepositIntent_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositIntent" ADD CONSTRAINT "DepositIntent_simWalletId_fkey" FOREIGN KEY ("simWalletId") REFERENCES "SimWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositIntent" ADD CONSTRAINT "DepositIntent_matchedReceiptId_fkey" FOREIGN KEY ("matchedReceiptId") REFERENCES "SmsReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsReceipt" ADD CONSTRAINT "SmsReceipt_simWalletId_fkey" FOREIGN KEY ("simWalletId") REFERENCES "SimWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_simWalletId_fkey" FOREIGN KEY ("simWalletId") REFERENCES "SimWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementRequest" ADD CONSTRAINT "SettlementRequest_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementRequest" ADD CONSTRAINT "SettlementRequest_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SweepRule" ADD CONSTRAINT "SweepRule_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SweepRule" ADD CONSTRAINT "SweepRule_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DeviceGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SweepExecution" ADD CONSTRAINT "SweepExecution_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "SweepRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SweepExecution" ADD CONSTRAINT "SweepExecution_simWalletId_fkey" FOREIGN KEY ("simWalletId") REFERENCES "SimWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SweepExecution" ADD CONSTRAINT "SweepExecution_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferAttempt" ADD CONSTRAINT "TransferAttempt_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferAttempt" ADD CONSTRAINT "TransferAttempt_deviceJobId_fkey" FOREIGN KEY ("deviceJobId") REFERENCES "DeviceJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceJob" ADD CONSTRAINT "DeviceJob_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceJob" ADD CONSTRAINT "DeviceJob_simWalletId_fkey" FOREIGN KEY ("simWalletId") REFERENCES "SimWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UssdEvidence" ADD CONSTRAINT "UssdEvidence_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UssdEvidence" ADD CONSTRAINT "UssdEvidence_deviceJobId_fkey" FOREIGN KEY ("deviceJobId") REFERENCES "DeviceJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnattributedSmsEvidence" ADD CONSTRAINT "UnattributedSmsEvidence_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "LedgerJournal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_outboxEventId_fkey" FOREIGN KEY ("outboxEventId") REFERENCES "OutboxEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantSupportCase" ADD CONSTRAINT "MerchantSupportCase_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantSupportCase" ADD CONSTRAINT "MerchantSupportCase_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "MerchantUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantSupportCase" ADD CONSTRAINT "MerchantSupportCase_assignedStaffId_fkey" FOREIGN KEY ("assignedStaffId") REFERENCES "PlatformStaff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCaseMessage" ADD CONSTRAINT "SupportCaseMessage_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "MerchantSupportCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCaseMessage" ADD CONSTRAINT "SupportCaseMessage_authorMerchantUserId_fkey" FOREIGN KEY ("authorMerchantUserId") REFERENCES "MerchantUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCaseMessage" ADD CONSTRAINT "SupportCaseMessage_authorPlatformStaffId_fkey" FOREIGN KEY ("authorPlatformStaffId") REFERENCES "PlatformStaff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
