import { describe, expect, it } from 'vitest';
import { validateCaseReport } from '../../src/api/validation';

const valid = {
  event_timestamp: '2026-09-20T08:00:00Z',
  lat: 42.605,
  lon: -5.603,
  disease_category: 'respiratory',
  case_count: 3,
  age_band: '25-34',
  symptom_codes: ['R05'],
};

describe('validateCaseReport', () => {
  it('accepts a valid report and normalizes the category', () => {
    expect(validateCaseReport({ ...valid, disease_category: '  Respiratory ' })).toEqual({
      ok: true,
      value: valid,
    });
  });

  it('accepts a report without optional fields', () => {
    const { age_band, symptom_codes, ...required } = valid;
    expect(validateCaseReport(required)).toEqual({ ok: true, value: required });
  });

  it('accepts timestamps with a numeric offset', () => {
    expect(validateCaseReport({ ...valid, event_timestamp: '2026-09-20T08:00:00+02:00' }).ok).toBe(true);
  });

  it.each([
    ['lat', { lat: 91 }],
    ['lon', { lon: -181 }],
    ['case_count', { case_count: 0 }],
    ['case_count', { case_count: 1.5 }],
    ['event_timestamp', { event_timestamp: '2026-09-20' }],
    ['event_timestamp', { event_timestamp: '2026-09-20T08:00:00' }],
    ['disease_category', { disease_category: '   ' }],
    ['symptom_codes', { symptom_codes: 'R05' }],
  ])('rejects an invalid %s', (field, override) => {
    const result = validateCaseReport({ ...valid, ...override });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.field)).toContain(field);
  });

  it('reports every missing required field', () => {
    const result = validateCaseReport({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.field)).toEqual(
        expect.arrayContaining(['event_timestamp', 'lat', 'lon', 'disease_category', 'case_count']),
      );
    }
  });

  it.each([null, [], 'text', 42])('rejects a non-object body %j', (body) => {
    expect(validateCaseReport(body).ok).toBe(false);
  });
});
