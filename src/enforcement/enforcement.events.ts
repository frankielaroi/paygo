import type {
  DesiredStateSource,
  MobilityState,
} from '../generated/prisma/enums';

/**
 * What enforcement announces, after the change has committed. Listeners (notifications today)
 * subscribe with @OnEvent; enforcement knows nothing about them, so adding a channel or a
 * consumer never touches the reconciler.
 */
export const ENFORCEMENT_STATE_CONFIRMED = 'enforcement.state-confirmed';
export const ENFORCEMENT_REVIEW_FLAGGED = 'enforcement.review-flagged';

/** The device confirmed a new output state. Emitted only when the state actually changed. */
export interface EnforcementStateConfirmedEvent {
  bikeId: string;
  /** The audit row recording it: unique, so a listener can use it to deduplicate. */
  enforcementEventId: string;
  fromState: MobilityState | null;
  toState: MobilityState;
  /** Why the bike is in the desired state it is: arrears or a staff decision. */
  desiredSource: DesiredStateSource;
  confirmedAt: Date;
}

/** An immobilize is wanted but the telemetry cannot be trusted; a person should look. */
export interface EnforcementReviewFlaggedEvent {
  bikeId: string;
  enforcementEventId: string;
  reason: string;
  flaggedAt: Date;
}
