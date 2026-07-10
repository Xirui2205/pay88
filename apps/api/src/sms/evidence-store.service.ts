import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaService } from '../infra/prisma.service';

@Injectable()
export class EvidenceStoreService {
  private readonly logger = new Logger(EvidenceStoreService.name);
  private readonly bucket = process.env.OBJECT_STORAGE_BUCKET;
  private readonly client?: S3Client;
  private running = false;

  constructor(private readonly prisma: PrismaService) {
    const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
    const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY;
    const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_KEY;
    if (endpoint && this.bucket && accessKeyId && secretAccessKey) {
      this.client = new S3Client({
        endpoint,
        region: process.env.OBJECT_STORAGE_REGION ?? 'us-east-1',
        forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE === 'true',
        credentials: { accessKeyId, secretAccessKey },
      });
    }
  }

  async persistByEvent(eventId: string): Promise<boolean> {
    if (!this.client || !this.bucket) return false;
    const receipt = await this.prisma.smsReceipt.findUnique({ where: { eventId } });
    if (!receipt || receipt.evidenceObjectKey) return Boolean(receipt?.evidenceObjectKey);
    const date = receipt.receivedAt;
    const key = evidenceObjectKey(receipt.eventId, date);
    const body = JSON.stringify({
      version: 1,
      event_id: receipt.eventId,
      body_hash: receipt.bodyHash,
      received_at: receipt.receivedAt.toISOString(),
      encrypted_body: receipt.rawBody,
    });
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/octet-stream',
        ServerSideEncryption: 'AES256',
        Metadata: { body_sha256: receipt.bodyHash, retention_class: 'raw-telebirr-evidence' },
      }));
      await this.prisma.smsReceipt.update({ where: { id: receipt.id }, data: { evidenceObjectKey: key } });
      return true;
    } catch (error) {
      this.logger.error(`Evidence upload failed for event ${receipt.eventId}: ${(error as Error).message}`);
      return false;
    }
  }

  async persistUssdByEvent(eventId: string): Promise<boolean> {
    if (!this.client || !this.bucket) return false;
    const evidence = await this.prisma.ussdEvidence.findUnique({ where: { eventId } });
    if (!evidence || evidence.evidenceObjectKey) return Boolean(evidence?.evidenceObjectKey);
    const key = ussdEvidenceObjectKey(evidence.eventId, evidence.capturedAt);
    const body = JSON.stringify({
      version: 1,
      event_id: evidence.eventId,
      device_job_id: evidence.deviceJobId,
      step_id: evidence.stepId,
      screen_hash: evidence.screenHash,
      captured_at: evidence.capturedAt.toISOString(),
      encrypted_screen: evidence.encryptedScreen,
    });
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/octet-stream',
        ServerSideEncryption: 'AES256',
        Metadata: { screen_sha256: evidence.screenHash, retention_class: 'raw-telebirr-ussd-evidence' },
      }));
      await this.prisma.ussdEvidence.update({ where: { id: evidence.id }, data: { evidenceObjectKey: key } });
      return true;
    } catch (error) {
      this.logger.error(`USSD evidence upload failed for event ${evidence.eventId}: ${(error as Error).message}`);
      return false;
    }
  }

  async persistUnattributedSmsByEvent(eventId: string): Promise<boolean> {
    if (!this.client || !this.bucket) return false;
    const evidence = await this.prisma.unattributedSmsEvidence.findUnique({ where: { eventId } });
    if (!evidence || evidence.evidenceObjectKey) return Boolean(evidence?.evidenceObjectKey);
    const key = unattributedSmsEvidenceObjectKey(evidence.eventId, evidence.receivedAt);
    const body = JSON.stringify({
      version: 1,
      event_id: evidence.eventId,
      device_id: evidence.deviceId,
      body_hash: evidence.bodyHash,
      reason: evidence.reason,
      received_at: evidence.receivedAt.toISOString(),
      encrypted_body: evidence.encryptedBody,
    });
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/octet-stream',
        ServerSideEncryption: 'AES256',
        Metadata: { body_sha256: evidence.bodyHash, retention_class: 'raw-unattributed-sms-evidence' },
      }));
      await this.prisma.unattributedSmsEvidence.update({ where: { id: evidence.id }, data: { evidenceObjectKey: key } });
      return true;
    } catch (error) {
      this.logger.error(`Unattributed SMS evidence upload failed for event ${evidence.eventId}: ${(error as Error).message}`);
      return false;
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async retryMissing(): Promise<void> {
    if (this.running || !this.client) return;
    this.running = true;
    try {
      const receipts = await this.prisma.smsReceipt.findMany({
        where: { evidenceObjectKey: null },
        select: { eventId: true },
        orderBy: { createdAt: 'asc' },
        take: Number(process.env.EVIDENCE_UPLOAD_BATCH_SIZE ?? 100),
      });
      for (const receipt of receipts) await this.persistByEvent(receipt.eventId);
      const ussdEvents = await this.prisma.ussdEvidence.findMany({
        where: { evidenceObjectKey: null },
        select: { eventId: true },
        orderBy: { createdAt: 'asc' },
        take: Number(process.env.EVIDENCE_UPLOAD_BATCH_SIZE ?? 100),
      });
      for (const event of ussdEvents) await this.persistUssdByEvent(event.eventId);
      const unattributedSmsEvents = await this.prisma.unattributedSmsEvidence.findMany({
        where: { evidenceObjectKey: null },
        select: { eventId: true },
        orderBy: { createdAt: 'asc' },
        take: Number(process.env.EVIDENCE_UPLOAD_BATCH_SIZE ?? 100),
      });
      for (const event of unattributedSmsEvents) await this.persistUnattributedSmsByEvent(event.eventId);
    } finally {
      this.running = false;
    }
  }
}

export function evidenceObjectKey(eventId: string, date: Date): string {
  return [
    'sms',
    date.getUTCFullYear().toString(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
    `${eventId}.json.enc`,
  ].join('/');
}

export function ussdEvidenceObjectKey(eventId: string, date: Date): string {
  return [
    'ussd',
    date.getUTCFullYear().toString(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
    `${eventId}.json.enc`,
  ].join('/');
}

export function unattributedSmsEvidenceObjectKey(eventId: string, date: Date): string {
  return [
    'sms-unattributed',
    date.getUTCFullYear().toString(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
    `${eventId}.json.enc`,
  ].join('/');
}
