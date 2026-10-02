/**
 * Events raised by one module for others to react to, so the module that notices something
 * (tracking, geofences) does not need to know who wants to hear about it (staff notifications).
 */

/** A bike that had been reporting has just gone quiet past the offline threshold. */
export const BIKE_WENT_OFFLINE = 'bike.went-offline';

export interface BikeWentOfflineEvent {
  bikeId: string;
  lastReportedAt: Date;
}

/** A bike has just been recorded leaving an operating zone. */
export const GEOFENCE_EXITED = 'geofence.exited';

export interface GeofenceExitedEvent {
  crossingId: string;
  bikeId: string;
  geofenceName: string;
}
