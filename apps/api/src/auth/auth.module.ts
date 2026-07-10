import { Module } from '@nestjs/common';
import { DeviceAuthGuard } from './device-auth.guard';
import { MerchantAuthGuard } from './merchant-auth.guard';
import { DeviceIngressGuard } from './device-ingress.guard';

@Module({ providers: [MerchantAuthGuard, DeviceAuthGuard, DeviceIngressGuard], exports: [MerchantAuthGuard, DeviceAuthGuard, DeviceIngressGuard] })
export class AuthModule {}
