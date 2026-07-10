import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AdvisoryModule } from './advisory/advisory.module';
import { AuthModule } from './auth/auth.module';
import { DepositsModule } from './deposits/deposits.module';
import { DevicesModule } from './devices/devices.module';
import { FleetModule } from './fleet/fleet.module';
import { HealthModule } from './health/health.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { InfraModule } from './infra/infra.module';
import { LedgerModule } from './ledger/ledger.module';
import { SmsModule } from './sms/sms.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { WithdrawalsModule } from './withdrawals/withdrawals.module';
import { AdminModule } from './admin/admin.module';
import { validateEnvironment } from './config/configuration';
import { AlertsModule } from './alerts/alerts.module';
import { PortalModule } from './portal/portal.module';
import { SettlementsModule } from './settlements/settlements.module';
import { SweepsModule } from './sweeps/sweeps.module';
import { ConfigurationModule } from './configuration/configuration.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    ScheduleModule.forRoot(),
    InfraModule,
    ConfigurationModule,
    AlertsModule,
    IdempotencyModule,
    AuthModule,
    LedgerModule,
    FleetModule,
    DepositsModule,
    WithdrawalsModule,
    DevicesModule,
    SmsModule,
    WebhooksModule,
    AdvisoryModule,
    HealthModule,
    AdminModule,
    PortalModule,
    SettlementsModule,
    SweepsModule,
  ],
})
export class AppModule {}
