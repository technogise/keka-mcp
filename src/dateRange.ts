// Shared date-range validation for the timesheet endpoints.
// Validated client-side per spec, instead of letting Keka's API reject it.
//
// Keka's public API reference documents a 90-day maximum, but a live call
// against the real sandbox came back with "Total days should not exceed
// more than 60 days" - so this is set to the value actually enforced by
// the API, confirmed against the sandbox, rather than the documented one.
// If your tenant turns out to allow more, this is the one constant to
// change.

export const MAX_DATE_RANGE_DAYS = 60;

export class DateRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DateRangeError";
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Throws DateRangeError if `from`/`to` are invalid or span more than
 * MAX_DATE_RANGE_DAYS. If either side is omitted, validation is skipped -
 * Keka fills in its own default window (last 30 days) in that case, which is
 * always within the limit.
 */
export function assertValidDateRange(from?: string, to?: string): void {
  if (!from || !to) return;

  const fromDate = new Date(from);
  const toDate = new Date(to);

  if (Number.isNaN(fromDate.getTime())) {
    throw new DateRangeError(`'from' is not a valid date: "${from}"`);
  }
  if (Number.isNaN(toDate.getTime())) {
    throw new DateRangeError(`'to' is not a valid date: "${to}"`);
  }
  if (fromDate.getTime() > toDate.getTime()) {
    throw new DateRangeError(`'from' (${from}) must not be after 'to' (${to})`);
  }

  const diffDays = (toDate.getTime() - fromDate.getTime()) / MS_PER_DAY;
  if (diffDays > MAX_DATE_RANGE_DAYS) {
    throw new DateRangeError(
      `Date range too large: ${from} to ${to} spans ${Math.ceil(diffDays)} days, but Keka's API allows ` +
        `a maximum of ${MAX_DATE_RANGE_DAYS} days between 'from' and 'to'. Narrow the range and try again.`
    );
  }
}
