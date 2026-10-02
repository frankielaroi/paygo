import { Module } from '@nestjs/common';
import { PoliciesController } from './policies.controller';
import { PoliciesService } from './policies.service';

/**
 * Runtime configuration admins change from the app. Depends only on the database and the
 * environment, so any module that acts on a policy (loan arrears, for the lock lead time) can
 * import it without a circular import.
 */
@Module({
  controllers: [PoliciesController],
  providers: [PoliciesService],
  exports: [PoliciesService],
})
export class SettingsModule {}
