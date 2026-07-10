import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { SmsController } from './sms.controller';
import { SmsIngestionService } from './sms-ingestion.service';
import { EvidenceStoreService } from './evidence-store.service';

@Module({ imports: [AuthModule, LedgerModule], controllers: [SmsController], providers: [SmsIngestionService, EvidenceStoreService], exports: [SmsIngestionService, EvidenceStoreService] })
export class SmsModule {}
