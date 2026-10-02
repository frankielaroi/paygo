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
  AllocatePaymentDto,
  PaymentDto,
  PaymentPageDto,
  PaymentQueryDto,
  RecordPaymentDto,
} from './dto/payment.dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@ApiBearerAuth('bearer')
@ApiForbiddenResponse({ description: 'Requires the payment:manage permission' })
@RequirePermissions(Permission.PAYMENT_MANAGE)
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('payments')
  @ApiOperation({
    summary: 'Search payments, e.g. by provider reference for reconciliation',
  })
  @ApiOkResponse({ type: PaymentPageDto })
  list(@Query() query: PaymentQueryDto): Promise<PaymentPageDto> {
    return this.payments.list(query);
  }

  @Get('payments/:id')
  @ApiOperation({ summary: 'One payment' })
  @ApiOkResponse({ type: PaymentDto })
  @ApiNotFoundResponse({ description: 'Payment not found' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<PaymentDto> {
    return this.payments.get(id);
  }

  @Post('payments/:id/allocation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply an unallocated payment to a loan',
    description:
      'For money that arrived without a usable loan reference. Refused if the loan cannot take it.',
  })
  @ApiOkResponse({ type: PaymentDto })
  @ApiNotFoundResponse({ description: 'Payment or loan not found' })
  @ApiConflictResponse({
    description: 'Payment already applied, or loan closed, or currency differs',
  })
  allocate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: AllocatePaymentDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<PaymentDto> {
    return this.payments.allocate(id, input.loanId, user.id);
  }

  @Post('loans/:loanId/payments')
  @ApiOperation({
    summary: 'Record money received by hand against a loan',
    description:
      'Unlike the webhook, refused outright if the loan does not exist, is closed, or uses ' +
      'another currency.',
  })
  @ApiCreatedResponse({ type: PaymentDto })
  @ApiNotFoundResponse({ description: 'Loan not found' })
  @ApiConflictResponse({
    description: 'Loan closed, currency differs, or reference already recorded',
  })
  record(
    @Param('loanId', ParseUUIDPipe) loanId: string,
    @Body() input: RecordPaymentDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<PaymentDto> {
    return this.payments.recordManual(loanId, {
      reference: input.reference,
      amountMinor: input.amountMinor,
      currency: input.currency,
      paidAt: input.paidAt ? new Date(input.paidAt) : new Date(),
      channel: input.method ?? null,
      recordedById: user.id,
    });
  }
}
