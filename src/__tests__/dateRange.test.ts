import { describe, it, expect } from "vitest";
import { assertValidDateRange, DateRangeError, EXPENSE_MAX_DATE_RANGE_DAYS, MAX_DATE_RANGE_DAYS } from "../dateRange.js";

describe("assertValidDateRange", () => {
  it(`accepts a range within ${MAX_DATE_RANGE_DAYS} days`, () => {
    expect(() => assertValidDateRange("2026-01-01", "2026-02-01")).not.toThrow();
  });

  it(`accepts an exact ${MAX_DATE_RANGE_DAYS}-day range`, () => {
    expect(() => assertValidDateRange("2026-01-01", "2026-03-02")).not.toThrow(); // 60 days apart
  });

  it(`rejects a range over ${MAX_DATE_RANGE_DAYS} days`, () => {
    expect(() => assertValidDateRange("2026-01-01", "2026-06-01")).toThrow(DateRangeError);
  });

  it("includes a clear message on the out-of-range error", () => {
    try {
      assertValidDateRange("2026-01-01", "2026-06-01");
      throw new Error("expected assertValidDateRange to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DateRangeError);
      expect((err as Error).message).toMatch(new RegExp(`${MAX_DATE_RANGE_DAYS} days`));
      expect((err as Error).message).toMatch(/2026-01-01/);
    }
  });

  it("rejects 'from' after 'to'", () => {
    expect(() => assertValidDateRange("2026-06-01", "2026-01-01")).toThrow(DateRangeError);
  });

  it("rejects an unparseable date", () => {
    expect(() => assertValidDateRange("not-a-date", "2026-01-01")).toThrow(DateRangeError);
  });

  it("skips validation when either side is omitted (Keka applies its own default window)", () => {
    expect(() => assertValidDateRange(undefined, "2026-06-01")).not.toThrow();
    expect(() => assertValidDateRange("2026-06-01", undefined)).not.toThrow();
    expect(() => assertValidDateRange(undefined, undefined)).not.toThrow();
  });
});

// get_employee_expenses passes EXPENSE_MAX_DATE_RANGE_DAYS (90) - the
// boundary values below are the exact ones confirmed against the live API
// (2026-01-01..2026-04-01 accepted, ..2026-04-02 rejected).
describe(`assertValidDateRange with maxDays=${EXPENSE_MAX_DATE_RANGE_DAYS}`, () => {
  it("accepts an exact 90-day range", () => {
    expect(() => assertValidDateRange("2026-01-01", "2026-04-01", EXPENSE_MAX_DATE_RANGE_DAYS)).not.toThrow();
  });

  it("rejects a 91-day range with a message naming the 90-day limit", () => {
    expect(() => assertValidDateRange("2026-01-01", "2026-04-02", EXPENSE_MAX_DATE_RANGE_DAYS)).toThrow(/90 days/);
  });

  it("accepts a 61-90 day range that the default 60-day limit would reject", () => {
    expect(() => assertValidDateRange("2026-01-01", "2026-03-15")).toThrow(DateRangeError);
    expect(() => assertValidDateRange("2026-01-01", "2026-03-15", EXPENSE_MAX_DATE_RANGE_DAYS)).not.toThrow();
  });
});
