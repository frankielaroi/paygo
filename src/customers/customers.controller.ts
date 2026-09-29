import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { CustomersService } from './customers.service';
import {
  CreateCustomerDto,
  CustomerQueryDto,
  DeactivateCustomerDto,
  UpdateCustomerDto,
} from './dto/customer-input.dto';
import {
  CustomerDetailDto,
  CustomerPageDto,
} from './dto/customer-response.dto';

/**
 * Riders. A field agent reaches only riders assigned to them; anyone else's rider is a 404.
 */
@ApiTags('customers')
@ApiBearerAuth('bearer')
@ApiForbiddenResponse({ description: 'Missing the required permission' })
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post()
  @RequirePermissions(Permission.CUSTOMER_CREATE)
  @ApiOperation({ summary: 'Register a rider' })
  @ApiCreatedResponse({ type: CustomerDetailDto })
  @ApiConflictResponse({
    description: 'Phone or national ID already registered',
  })
  create(
    @Body() input: CreateCustomerDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<CustomerDetailDto> {
    return this.customers.create(input, user);
  }

  @Get()
  @RequirePermissions(Permission.CUSTOMER_READ_OWN)
  @ApiOperation({ summary: 'Search riders by name, phone or national ID' })
  @ApiOkResponse({ type: CustomerPageDto })
  list(
    @Query() query: CustomerQueryDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<CustomerPageDto> {
    return this.customers.list(query, user);
  }

  @Get(':id')
  @RequirePermissions(Permission.CUSTOMER_READ_OWN)
  @ApiOperation({
    summary: 'A rider with contacts, every bike they have held, and risk facts',
  })
  @ApiOkResponse({ type: CustomerDetailDto })
  @ApiNotFoundResponse({ description: 'Rider not found or not yours' })
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<CustomerDetailDto> {
    return this.customers.get(id, user);
  }

  @Patch(':id')
  @RequirePermissions(Permission.CUSTOMER_UPDATE)
  @ApiOperation({
    summary: 'Edit a rider',
    description:
      'Changing a name, national ID, date of birth, photo or ID document clears KYC.',
  })
  @ApiOkResponse({ type: CustomerDetailDto })
  @ApiNotFoundResponse({ description: 'Rider not found or not yours' })
  @ApiConflictResponse({
    description: 'Phone or national ID already registered',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateCustomerDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<CustomerDetailDto> {
    return this.customers.update(id, input, user);
  }

  @Post(':id/kyc-verification')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.KYC_VERIFY)
  @ApiOperation({
    summary: 'Mark KYC verified, making the rider eligible for a bike',
  })
  @ApiOkResponse({ type: CustomerDetailDto })
  @ApiNotFoundResponse({ description: 'Rider not found' })
  @ApiConflictResponse({
    description: 'Not pending KYC, or photo or ID document missing',
  })
  verifyKyc(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<CustomerDetailDto> {
    return this.customers.verifyKyc(id, user);
  }

  @Post(':id/deactivation')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.CUSTOMER_MANAGE)
  @ApiOperation({
    summary: 'Deactivate a rider',
    description:
      'The record and its history are kept. Refused while they hold a bike.',
  })
  @ApiOkResponse({ type: CustomerDetailDto })
  @ApiNotFoundResponse({ description: 'Rider not found' })
  @ApiConflictResponse({
    description: 'Already deactivated, or still holds a bike',
  })
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: DeactivateCustomerDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<CustomerDetailDto> {
    return this.customers.deactivate(id, input.reason, user);
  }
}
