/** Plain, JSON-safe facts about why a bike is overdue, stored with the audit entry. */
export type ArrearsDetail = Record<string, string | number | boolean | null>;

export interface OverdueBike {
  bikeId: string;
  detail: ArrearsDetail;
}

/**
 * Where Enforcement learns which bikes are overdue. Implemented by LoanArrearsService in the loans
 * module; grace periods and the catch-up rule live there, so Enforcement never does arrears
 * arithmetic itself.
 *
 * It must return only bikes that are overdue past their grace period as of `asOf`.
 */
export interface ArrearsSource {
  findOverdue(asOf: Date): Promise<OverdueBike[]>;
}

export const ARREARS_SOURCE = Symbol('ARREARS_SOURCE');
