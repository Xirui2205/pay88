import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { CacheService } from './cache.service';
import { MessageBusService } from './message-bus.service';

@Global()
@Module({
  providers: [PrismaService, CacheService, MessageBusService],
  exports: [PrismaService, CacheService, MessageBusService],
})
export class InfraModule {}

