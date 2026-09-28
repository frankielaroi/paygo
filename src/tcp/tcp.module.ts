import { Module } from '@nestjs/common';
import { TcpServerService } from './tcp-server.service';

/**
 * The device protocol layer. Exports TcpServerService so enforcement can send commands, and
 * imports nothing from the business modules: it must stay usable without knowing what a
 * contract is.
 */
@Module({
  providers: [TcpServerService],
  exports: [TcpServerService],
})
export class TcpModule {}
