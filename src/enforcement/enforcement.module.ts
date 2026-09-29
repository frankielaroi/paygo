import { Module } from '@nestjs/common';
import { LoanArrearsModule } from '../loans/loan-arrears.module';
import { LoanArrearsService } from '../loans/loan-arrears.service';
import { TcpModule } from '../tcp/tcp.module';
import { TrackingModule } from '../tracking/tracking.module';
import { ARREARS_SOURCE } from './arrears-source';
import { EnforcementController } from './enforcement.controller';
import { EnforcementService } from './enforcement.service';

/**
 * The only module that decides to immobilize or restore, and the only caller of
 * TcpServerService.sendCommand. Overdue loans come from LoanArrearsService, which works out
 * arrears from the loan schedules and the ledger.
 */
@Module({
  imports: [TrackingModule, TcpModule, LoanArrearsModule],
  controllers: [EnforcementController],
  providers: [
    EnforcementService,
    { provide: ARREARS_SOURCE, useExisting: LoanArrearsService },
  ],
  exports: [EnforcementService],
})
export class EnforcementModule {}
