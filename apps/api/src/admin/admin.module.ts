import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { PasswordReauthGuard } from './password-reauth.guard';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformWriteGuard } from './platform-write.guard';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module';
import { ConfigurationModule } from '../configuration/configuration.module';
import { SupportCasesModule } from '../support/support-cases.module';
import { DepositsModule } from '../deposits/deposits.module';

@Module({
  imports: [LedgerModule, DepositsModule, WithdrawalsModule, ConfigurationModule, SupportCasesModule],
  controllers: [AdminController, PlatformAuthController],
  providers: [AdminGuard, AdminService, PasswordReauthGuard, PlatformAuthService, PlatformWriteGuard],
  exports: [AdminGuard, PasswordReauthGuard, PlatformWriteGuard],
})
export class AdminModule {}
