import { Module } from '@nestjs/common';
import { SimSelectionService } from './sim-selection.service';
import { FleetMaintenanceService } from './fleet-maintenance.service';

@Module({ providers: [SimSelectionService, FleetMaintenanceService], exports: [SimSelectionService] })
export class FleetModule {}
