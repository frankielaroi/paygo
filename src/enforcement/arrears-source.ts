import { Injectable } from '@nestjs/common';

/** Plain, JSON-safe facts about why a bike is overdue, stored with the audit entry. */
export type ArrearsDetail = Record<string, string | number | boolean | null>;

export interface OverdueBike {
  bikeId: string;
  detail: ArrearsDetail;
}

/**
 * Where Enforcement learns which bikes are overdue. The contracts module implements this once
 * it exists; grace periods and the "current enough" threshold belong there, not here, so
 * Enforcement never does arrears arithmetic itself.
 *
 * It must return only bikes that are overdue past their grace period as of `asOf`.
 */
export interface ArrearsSource {
  findOverdue(asOf: Date): Promise<OverdueBike[]>;
}

export const ARREARS_SOURCE = Symbol('ARREARS_SOURCE');

/**
 * Placeholder until contracts exist: nothing is ever overdue, so the sweep never immobilizes on
 * its own. Staff actions and the reconciler work in full.
 */
@Injectable()
export class NoArrearsSource implements ArrearsSource {
  findOverdue(): Promise<OverdueBike[]> {
    return Promise.resolve([]);
  }
}
