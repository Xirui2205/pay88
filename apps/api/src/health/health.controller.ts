import { Controller, Get, HttpStatus, Req } from '@nestjs/common';
import { success } from '../common/envelope';
import type { RequestWithContext } from '../common/request-context';
import { PrismaService } from '../infra/prisma.service';
import { CacheService } from '../infra/cache.service';
import { MessageBusService } from '../infra/message-bus.service';
import { ApiException } from '../common/api-exception';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly cache: CacheService, private readonly bus: MessageBusService) {}

  @Get('live')
  live(@Req() request: RequestWithContext) {
    return success(request, { status: 'alive', uptime_seconds: Math.floor(process.uptime()) });
  }

  @Get('ready')
  async ready(@Req() request: RequestWithContext) {
    await this.prisma.$queryRaw`SELECT 1`;
    const [redisReady, rabbitReady] = await Promise.all([this.cache.isReady(), this.bus.isReady()]);
    if (!redisReady || !rabbitReady) throw new ApiException('dependency_unavailable', 'A required infrastructure dependency is unavailable', HttpStatus.SERVICE_UNAVAILABLE);
    return success(request, { status: 'ready', database: 'connected', redis: process.env.REDIS_URL ? 'connected' : 'in_memory', rabbitmq: process.env.RABBITMQ_URL || process.env.AMQP_URL ? 'connected' : 'in_memory' });
  }
}
