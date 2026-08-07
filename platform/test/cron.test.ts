import { describe, expect, test } from "bun:test";
import { cronMatches, nextCronRun, parseCron } from "../src/cron";

describe("cron schedules", () => {
  test("supports minute-level five-field UTC expressions", () => {
    const cron = parseCron("*/5 3 * * 1-5");
    expect(cronMatches(cron, new Date("2026-08-07T03:10:00Z"))).toBe(true);
    expect(cronMatches(cron, new Date("2026-08-08T03:10:00Z"))).toBe(false);
  });

  test("uses standard day-of-month or day-of-week behavior", () => {
    const cron = parseCron("0 0 1 * 1");
    expect(cronMatches(cron, new Date("2026-09-01T00:00:00Z"))).toBe(true);
    expect(cronMatches(cron, new Date("2026-09-07T00:00:00Z"))).toBe(true);
    expect(cronMatches(cron, new Date("2026-09-08T00:00:00Z"))).toBe(false);
  });

  test("finds the next run on a minute boundary", () => {
    expect(nextCronRun("17 3 * * *", Date.parse("2026-08-07T03:17:10Z")))
      .toBe(Date.parse("2026-08-08T03:17:00Z"));
  });

  test("rejects out-of-range and non-five-field expressions", () => {
    expect(() => parseCron("60 * * * *")).toThrow("outside");
    expect(() => parseCron("* * * *")).toThrow("five-field");
  });
});
