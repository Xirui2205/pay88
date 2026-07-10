import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { activationRequestSchema, deviceHeartbeatSchema, deviceJobReportSchema } from '@telebirr/contracts';
import { DeviceAuthGuard, type DeviceRequest } from '../auth/device-auth.guard';
import { success } from '../common/envelope';
import type { RequestWithContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { DeviceJobsService } from './device-jobs.service';
import { DeviceIngressGuard } from '../auth/device-ingress.guard';

const renewalSchema = z.object({ fencing_token: z.number().int().positive().safe() });

@Controller('v1/device')
export class DevicesController {
  constructor(private readonly jobs: DeviceJobsService) {}

  @Post('activate')
  @UseGuards(DeviceIngressGuard)
  async activate(@Req() request: RequestWithContext, @Body(new ZodPipe(activationRequestSchema)) body: z.infer<typeof activationRequestSchema>) {
    return success(
      request,
      await this.jobs.activate(body, request.header('x-client-cert-sha256')?.toLowerCase()),
      'Device activated',
    );
  }

  @Post('heartbeat')
  @UseGuards(DeviceAuthGuard)
  async heartbeat(@Req() request: DeviceRequest, @Body(new ZodPipe(deviceHeartbeatSchema)) body: z.infer<typeof deviceHeartbeatSchema>) {
    await this.jobs.heartbeat(request.device.id, body);
    return success(request, { accepted: true });
  }

  @Get('jobs/next')
  @UseGuards(DeviceAuthGuard)
  async next(@Req() request: DeviceRequest) {
    return success(request, await this.jobs.leaseNext(request.device.id), 'Job lease checked');
  }

  @Post('jobs/:jobId/renew')
  @UseGuards(DeviceAuthGuard)
  async renew(
    @Req() request: DeviceRequest,
    @Param('jobId') jobId: string,
    @Body(new ZodPipe(renewalSchema)) body: z.infer<typeof renewalSchema>,
  ) {
    return success(request, await this.jobs.renew(request.device.id, jobId, body.fencing_token), 'Lease renewed');
  }

  @Post('jobs/:jobId/report')
  @UseGuards(DeviceAuthGuard)
  async report(
    @Req() request: DeviceRequest,
    @Param('jobId') jobId: string,
    @Body(new ZodPipe(deviceJobReportSchema)) body: z.infer<typeof deviceJobReportSchema>,
  ) {
    await this.jobs.report(request.device.id, jobId, body);
    return success(request, { accepted: true });
  }
}
