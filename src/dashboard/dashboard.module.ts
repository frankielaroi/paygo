import { Module } from '@nestjs/common';
import { LoanArrearsModule } from '../loans/loan-arrears.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/** Read-side aggregation for the FleetView screens. Owns no data. */
@Module({
  imports: [LoanArrearsModule, NotificationsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
