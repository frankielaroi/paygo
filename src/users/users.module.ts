import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MeController } from './me.controller';
import { StaffActivityService } from './staff-activity.service';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

/**
 * Staff accounts and self-service. Auth decides how someone signs in; this module decides who
 * exists, what role they hold, and whether they may sign in at all.
 */
@Module({
  imports: [AuthModule],
  controllers: [StaffController, MeController],
  providers: [StaffService, StaffActivityService],
})
export class UsersModule {}
