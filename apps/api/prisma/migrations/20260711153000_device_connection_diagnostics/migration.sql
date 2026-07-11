ALTER TABLE "Device"
  ADD COLUMN "lastSocketConnectedAt" TIMESTAMP(3),
  ADD COLUMN "lastSocketDisconnectedAt" TIMESTAMP(3),
  ADD COLUMN "lastSocketDisconnectCode" INTEGER,
  ADD COLUMN "lastSocketDisconnectReason" VARCHAR(500),
  ADD COLUMN "lastHelloAt" TIMESTAMP(3);
