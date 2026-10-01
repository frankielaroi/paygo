import { Module } from '@nestjs/common';
import { LoanArrearsModule } from '../loans/loan-arrears.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

/** Riders: identity, KYC, contacts, and the history of bikes they have held. */
@Module({
  // Arrears drive each rider's standing (active / overdue / no-bike).
  imports: [LoanArrearsModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
