import { Module } from '@nestjs/common';
import { GeofencesController } from './geofences.controller';
import { GeofencesService } from './geofences.service';

/**
 * Depends on nothing but the database, so tracking can import it to check each new position
 * without a circular import.
 */
@Module({
  controllers: [GeofencesController],
  providers: [GeofencesService],
  exports: [GeofencesService],
})
export class GeofencesModule {}
