import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedStaff } from '../common/types/authenticated-staff';
import { Permission } from '../users/enums/role.enum';
import {
  CreateLoanDto,
  LoanDetailDto,
  LoanPageDto,
  LoanQueryDto,
  LoanReasonDto,
} from './dto/loan.dto';
import { LoansService } from './loans.service';

@ApiTags('loans')
@ApiBearerAuth('bearer')
@ApiForbiddenResponse({ description: 'Missing the required permission' })
@Controller('loans')
export class LoansController {
  constructor(private readonly loans: LoansService) {}

  @Post()
  @RequirePermissions(Permission.LOAN_CREATE)
  @ApiOperation({
    summary: 'Start a loan and generate its full schedule',
    description: 'The bike must already be assigned to the rider.',
  })
  @ApiCreatedResponse({ type: LoanDetailDto })
  @ApiBadRequestResponse({
    description: 'Terms that produce no valid schedule',
  })
  @ApiConflictResponse({
    description:
      'Bike not assigned to this rider, rider not active, or bike has an open loan',
  })
  create(
    @Body() input: CreateLoanDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<LoanDetailDto> {
    return this.loans.create(input, user);
  }

  @Get()
  @RequirePermissions(Permission.LOAN_READ_OWN)
  @ApiOperation({ summary: 'List loans with balances derived from the ledger' })
  @ApiOkResponse({ type: LoanPageDto })
  list(
    @Query() query: LoanQueryDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<LoanPageDto> {
    return this.loans.list(query, user);
  }

  @Get(':id')
  @RequirePermissions(Permission.LOAN_READ_OWN)
  @ApiOperation({
    summary: 'A loan with its schedule, balance, next due and every payment',
  })
  @ApiOkResponse({ type: LoanDetailDto })
  @ApiNotFoundResponse({ description: 'Loan not found or not yours' })
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<LoanDetailDto> {
    return this.loans.get(id, user);
  }

  @Post(':id/default')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.LOAN_MANAGE)
  @ApiOperation({ summary: 'Declare an active loan in default' })
  @ApiOkResponse({ type: LoanDetailDto })
  @ApiConflictResponse({ description: 'Loan is not active' })
  markDefaulted(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: LoanReasonDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<LoanDetailDto> {
    return this.loans.markDefaulted(id, input.reason, user);
  }

  @Post(':id/repossession')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.LOAN_MANAGE)
  @ApiOperation({
    summary: 'Repossess the bike under an open loan',
    description:
      "Ends the rider's assignment as repossessed in the same transaction. The balance stays owed.",
  })
  @ApiOkResponse({ type: LoanDetailDto })
  @ApiConflictResponse({ description: 'Loan is not open' })
  repossess(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: LoanReasonDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<LoanDetailDto> {
    return this.loans.repossess(id, input.reason, user);
  }
}
