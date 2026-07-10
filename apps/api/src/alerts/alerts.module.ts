import { Global, Module } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';
import { PasswordReauthGuard } from '../admin/password-reauth.guard';
import { PlatformWriteGuard } from '../admin/platform-write.guard';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';

@Global()
@Module({
  controllers: [AlertsController],
  providers: [AlertsService, AdminGuard, PasswordReauthGuard, PlatformWriteGuard],
  exports: [AlertsService],
})
export class AlertsModule {}
