import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module';
import { SweepsAdminController, SweepsController } from './sweeps.controller';
import { SweepsService } from './sweeps.service';

@Module({
  imports: [AdminModule, AuthModule, WithdrawalsModule],
  controllers: [SweepsController, SweepsAdminController],
  providers: [SweepsService],
  exports: [SweepsService],
})
export class SweepsModule {}
