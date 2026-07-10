import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FleetModule } from '../fleet/fleet.module';
import { LedgerModule } from '../ledger/ledger.module';
import { WithdrawalsController } from './withdrawals.controller';
import { WithdrawalsService } from './withdrawals.service';
import { TransferTokenService } from './transfer-token.service';

@Module({ imports: [AuthModule, FleetModule, LedgerModule], controllers: [WithdrawalsController], providers: [WithdrawalsService, TransferTokenService], exports: [WithdrawalsService] })
export class WithdrawalsModule {}
