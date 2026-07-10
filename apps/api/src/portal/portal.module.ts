import { Module } from '@nestjs/common';
import { PortalAuthController, PortalController } from './portal.controller';
import { PortalSessionGuard } from './portal-session.guard';
import { PortalService } from './portal.service';
import { DepositsModule } from '../deposits/deposits.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { ConfigurationModule } from '../configuration/configuration.module';
import { SupportCasesModule } from '../support/support-cases.module';

@Module({
  imports: [DepositsModule, SettlementsModule, WebhooksModule, ConfigurationModule, SupportCasesModule],
  controllers: [PortalAuthController, PortalController],
  providers: [PortalService, PortalSessionGuard],
  exports: [PortalSessionGuard],
})
export class PortalModule {}
