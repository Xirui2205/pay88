import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module';
import { SettlementAdminController, SettlementsController } from './settlements.controller';
import { SettlementsService } from './settlements.service';

@Module({
  imports: [AdminModule, AuthModule, WithdrawalsModule],
  controllers: [SettlementsController, SettlementAdminController],
  providers: [SettlementsService],
  exports: [SettlementsService],
})
export class SettlementsModule {}
