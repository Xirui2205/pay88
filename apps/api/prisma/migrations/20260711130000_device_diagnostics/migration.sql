ALTER TABLE "Device"
  ALTER COLUMN "ussdProfileVersion" TYPE VARCHAR(500),
  ADD COLUMN "lastHeartbeatPayload" JSONB,
  ADD COLUMN "lastProfileInstallResult" JSONB;
