import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module';
import { LedgerModule } from '../ledger/ledger.module';
import { LoanArrearsModule } from './loan-arrears.module';
import { LoanRepaymentService } from './loan-repayment.service';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';

@Module({
  imports: [LedgerModule, LoanArrearsModule, AssetsModule],
  controllers: [LoansController],
  providers: [LoansService, LoanRepaymentService],
  exports: [LoansService, LoanRepaymentService, LoanArrearsModule],
})
export class LoansModule {}
