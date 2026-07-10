import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { smsIngestSchema } from '@telebirr/contracts';
import { DeviceAuthGuard, type DeviceRequest } from '../auth/device-auth.guard';
import { success } from '../common/envelope';
import { ZodPipe } from '../common/zod.pipe';
import { SmsIngestionService } from './sms-ingestion.service';

@Controller('v1/device')
export class SmsController {
  constructor(private readonly ingestion: SmsIngestionService) {}

  @Post('sms')
  @UseGuards(DeviceAuthGuard)
  async ingest(
    @Req() request: DeviceRequest,
    @Body(new ZodPipe(smsIngestSchema)) body: ReturnType<typeof smsIngestSchema.parse>,
  ) {
    return success(request, await this.ingestion.ingest(request.device.id, body), 'SMS accepted');
  }
}
