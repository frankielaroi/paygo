/**
 * Where a rider stands with FleetView today: holding a bike and up to date, holding a bike and
 * behind on its loan, or holding no bike. Derived from the same arrears source as the
 * dashboard's overdue queue and a bike's "overdue" status (LoanArrearsService.findOverdue), so
 * the three can never disagree. Nothing about it is stored.
 */
export type RiderStanding = 'active' | 'overdue' | 'no-bike';

export const RIDER_STANDINGS: readonly RiderStanding[] = [
  'active',
  'overdue',
  'no-bike',
];

/**
 * @param bikeIds the bikes the rider holds now
 * @param overdueByBike minor units owed past grace, per bike with an overdue loan
 */
export function riderStandingOf(
  bikeIds: readonly string[],
  overdueByBike: ReadonlyMap<string, number>,
): RiderStanding {
  if (bikeIds.length === 0) {
    return 'no-bike';
  }
  return bikeIds.some((id) => (overdueByBike.get(id) ?? 0) > 0)
    ? 'overdue'
    : 'active';
}
