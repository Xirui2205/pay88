import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FleetModule } from '../fleet/fleet.module';
import { LedgerModule } from '../ledger/ledger.module';
import { CheckoutTokenService } from './checkout-token.service';
import { DepositsController } from './deposits.controller';
import { DepositsService } from './deposits.service';

@Module({
  imports: [AuthModule, FleetModule, LedgerModule],
  controllers: [DepositsController],
  providers: [DepositsService, CheckoutTokenService],
  exports: [DepositsService, CheckoutTokenService],
})
export class DepositsModule {}
