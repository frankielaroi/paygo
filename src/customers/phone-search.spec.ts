import { phoneSearchForms } from './customers.service';

describe('phoneSearchForms', () => {
  it('also matches the international form of a local fragment', () => {
    expect(phoneSearchForms('0241')).toEqual(['0241', '233241']);
    expect(phoneSearchForms('024-123')).toEqual(['024123', '23324123']);
  });

  it('leaves anything else as typed', () => {
    expect(phoneSearchForms('+23324')).toEqual(['+23324']);
    expect(phoneSearchForms('241234')).toEqual(['241234']);
    expect(phoneSearchForms('0')).toEqual(['0']);
    expect(phoneSearchForms('kofi')).toEqual(['kofi']);
  });
});
