import { Module } from '@nestjs/common';
import { SupportCasesService } from './support-cases.service';

@Module({
  providers: [SupportCasesService],
  exports: [SupportCasesService],
})
export class SupportCasesModule {}
