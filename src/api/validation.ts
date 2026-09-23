import { z } from 'zod';
import { MAX_EVENT_CLOCK_SKEW_MS } from '../shared/clock';

export const caseReportSchema = z.object({
  event_timestamp: z.iso
    .datetime({ offset: true })
    .refine((value) => Date.parse(value) <= Date.now() + MAX_EVENT_CLOCK_SKEW_MS, {
      message: 'must not be more than 5 minutes in the future',
    }),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  disease_category: z.string().trim().toLowerCase().min(1).max(100),
  case_count: z.number().int().positive(),
  age_band: z.string().trim().min(1).max(20).optional(),
  symptom_codes: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
});

export type CaseReportInput = z.infer<typeof caseReportSchema>;

export interface FieldError {
  field: string;
  message: string;
}

export type ValidationResult = { ok: true; value: CaseReportInput } | { ok: false; errors: FieldError[] };

export function validateCaseReport(body: unknown): ValidationResult {
  const result = caseReportSchema.safeParse(body);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      field: issue.path.map(String).join('.') || '(body)',
      message: issue.message,
    })),
  };
}
