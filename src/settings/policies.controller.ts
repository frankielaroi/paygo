import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedStaff } from '../common/types/authenticated-staff';
import { Permission } from '../users/enums/role.enum';
import { PolicyDto, UpdatePolicyDto } from './dto/policy.dto';
import { PoliciesService } from './policies.service';

@ApiTags('settings')
@ApiBearerAuth('bearer')
@Controller('settings/policies')
export class PoliciesController {
  constructor(private readonly policies: PoliciesService) {}

  @Get()
  @ApiOperation({
    summary: 'The fleet policies in force',
    description:
      'Readable by every signed-in staff member: the default loan terms prefill a new loan.',
  })
  @ApiOkResponse({ type: PolicyDto })
  get(): Promise<PolicyDto> {
    return this.policies.get();
  }

  @Patch()
  @RequirePermissions(Permission.USER_MANAGE)
  @ApiOperation({
    summary: 'Change fleet policies',
    description:
      'The warning lead time applies to every loan from the next enforcement sweep. The ' +
      'default loan terms only affect loans opened afterwards. Each change is recorded with ' +
      'who made it.',
  })
  @ApiOkResponse({ type: PolicyDto })
  @ApiForbiddenResponse({ description: 'Requires the user:manage permission' })
  update(
    @Body() input: UpdatePolicyDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<PolicyDto> {
    return this.policies.update(input, user);
  }
}
