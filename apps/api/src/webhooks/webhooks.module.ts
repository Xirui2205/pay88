import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WebhookSecretService } from './webhook-secret.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookHttpClientService } from './webhook-http-client.service';
import { WebhookUrlPolicyService } from './webhook-url-policy.service';

@Module({
  imports: [AuthModule],
  controllers: [WebhooksController],
  providers: [WebhookSecretService, WebhookUrlPolicyService, WebhookHttpClientService, WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
