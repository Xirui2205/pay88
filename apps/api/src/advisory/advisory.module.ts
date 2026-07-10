import { Module } from '@nestjs/common';
import { AdvisoryController } from './advisory.controller';
import { OpenClawGuard } from './openclaw.guard';
import { NameAdvisoryDispatchService } from './name-advisory-dispatch.service';

@Module({ controllers: [AdvisoryController], providers: [OpenClawGuard, NameAdvisoryDispatchService] })
export class AdvisoryModule {}
