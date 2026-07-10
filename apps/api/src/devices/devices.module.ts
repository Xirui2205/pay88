import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { DeviceJobsService } from './device-jobs.service';
import { DevicesController } from './devices.controller';
import { DeviceSigningService } from './device-signing.service';
import { DeviceProfilesService } from './device-profiles.service';
import { DeviceWebSocketGateway } from './device-websocket.gateway';
import { SmsModule } from '../sms/sms.module';

@Module({
  imports: [AuthModule, LedgerModule, SmsModule],
  controllers: [DevicesController],
  providers: [DeviceSigningService, DeviceProfilesService, DeviceJobsService, DeviceWebSocketGateway],
  exports: [DeviceJobsService],
})
export class DevicesModule {}
