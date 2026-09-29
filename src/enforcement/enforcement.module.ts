import { Module } from '@nestjs/common';
import { TcpModule } from '../tcp/tcp.module';
import { TrackingModule } from '../tracking/tracking.module';
import { ARREARS_SOURCE, NoArrearsSource } from './arrears-source';
import { EnforcementController } from './enforcement.controller';
import { EnforcementService } from './enforcement.service';

/**
 * The only module that decides to immobilize or restore, and the only caller of
 * TcpServerService.sendCommand. Replace NoArrearsSource with the contracts module's
 * implementation once contracts exist.
 */
@Module({
  imports: [TrackingModule, TcpModule],
  controllers: [EnforcementController],
  providers: [
    EnforcementService,
    { provide: ARREARS_SOURCE, useClass: NoArrearsSource },
  ],
  exports: [EnforcementService],
})
export class EnforcementModule {}
