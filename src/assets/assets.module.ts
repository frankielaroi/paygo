import { Module } from '@nestjs/common';
import { EnforcementModule } from '../enforcement/enforcement.module';
import { LoanArrearsModule } from '../loans/loan-arrears.module';
import { BikesController } from './bikes.controller';
import { BikesService } from './bikes.service';

/**
 * Bike inventory: identity, the tracker fitted, who holds the bike, and its lifecycle status.
 * Imports enforcement so a tracker swap can reset the confirmed state in the same transaction.
 */
@Module({
  imports: [EnforcementModule, LoanArrearsModule],
  controllers: [BikesController],
  providers: [BikesService],
  exports: [BikesService],
})
export class AssetsModule {}
