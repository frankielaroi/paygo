import {
  bikeOfflineText,
  overdueDigestText,
  zoneExitText,
} from './staff-messages';

describe('staff alert text', () => {
  it('names the bike, its rider and when it was last heard from', () => {
    expect(
      bikeOfflineText(
        'GR-4471-24',
        'Kwame Boateng',
        new Date('2026-10-02T09:05:00Z'),
      ),
    ).toBe(
      'Bike GR-4471-24 (Kwame Boateng) stopped reporting. Last heard from at 09:05.',
    );
  });

  it('names the zone a bike left, with or without a rider', () => {
    expect(zoneExitText('GR-4471-24', 'Kwame Boateng', 'Accra zone')).toBe(
      'Bike GR-4471-24 (Kwame Boateng) has left Accra zone.',
    );
    expect(zoneExitText('ACC-014', null, 'Accra zone')).toBe(
      'Bike ACC-014 has left Accra zone.',
    );
  });

  it('lists the loans that became overdue, counting the rest', () => {
    expect(overdueDigestText(['GR-1'])).toBe(
      '1 loan became overdue today: GR-1.',
    );
    expect(
      overdueDigestText([
        'GR-1',
        'GR-2',
        'GR-3',
        'GR-4',
        'GR-5',
        'GR-6',
        'GR-7',
      ]),
    ).toBe(
      '7 loans became overdue today: GR-1, GR-2, GR-3, GR-4, GR-5, +2 more.',
    );
  });

  it('fits one SMS part and stays plain ASCII', () => {
    const texts = [
      bikeOfflineText('M-26-GR 6595', 'Kwabena Sarpong-Mensah', new Date()),
      zoneExitText('M-26-GR 6595', 'Kwabena Sarpong-Mensah', 'Greater Accra'),
      overdueDigestText(
        Array.from({ length: 40 }, (_, i) => `GR-${1000 + i}-26`),
      ),
    ];
    for (const text of texts) {
      expect(text.length).toBeLessThanOrEqual(160);
      expect(text).toMatch(/^[\x20-\x7E]+$/);
    }
  });
});
