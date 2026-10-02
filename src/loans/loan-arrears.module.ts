import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { SettingsModule } from '../settings/settings.module';
import { LoanArrearsService } from './loan-arrears.service';

/**
 * Separate from LoansModule on purpose. Enforcement imports this for its arrears source, and
 * LoansModule imports enforcement to trigger restores, so the two cannot share a module.
 */
@Module({
  imports: [LedgerModule, SettingsModule],
  providers: [LoanArrearsService],
  exports: [LoanArrearsService],
})
export class LoanArrearsModule {}
