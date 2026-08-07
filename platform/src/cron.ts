const FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
] as const;

function parseNumber(value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`invalid cron value: ${value}`);
  const number = Number(value);
  if (number < min || number > max) throw new Error(`cron value ${value} is outside ${min}-${max}`);
  return number;
}

function expandPart(part: string, min: number, max: number): number[] {
  const [range, rawStep] = part.split("/");
  if (!range || part.split("/").length > 2) throw new Error(`invalid cron field: ${part}`);
  const step = rawStep === undefined ? 1 : parseNumber(rawStep, 1, max - min + 1);
  let start: number;
  let end: number;
  if (range === "*") {
    start = min;
    end = max;
  } else if (range.includes("-")) {
    const [rawStart, rawEnd, extra] = range.split("-");
    if (!rawStart || !rawEnd || extra !== undefined) throw new Error(`invalid cron range: ${range}`);
    start = parseNumber(rawStart, min, max);
    end = parseNumber(rawEnd, min, max);
    if (start > end) throw new Error(`cron range starts after it ends: ${range}`);
  } else {
    start = parseNumber(range, min, max);
    end = rawStep === undefined ? start : max;
  }
  const values: number[] = [];
  for (let value = start; value <= end; value += step) values.push(value);
  return values;
}

function parseField(field: string, min: number, max: number): Set<number> {
  if (!field) throw new Error("cron fields must not be empty");
  const values = new Set<number>();
  for (const part of field.split(",")) {
    for (const value of expandPart(part, min, max)) values.add(value);
  }
  if (!values.size) throw new Error("cron fields must select at least one value");
  return values;
}

export interface ParsedCron {
  expression: string;
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  anyDay: boolean;
  anyWeekday: boolean;
}

export function parseCron(expression: string): ParsedCron {
  const normalized = expression.trim().replace(/\s+/g, " ");
  const fields = normalized.split(" ");
  if (fields.length !== 5) throw new Error("schedules must use five-field cron syntax");
  const parsed = fields.map((field, index) => {
    const [min, max] = FIELD_RANGES[index]!;
    return parseField(field!, min, max);
  });
  return {
    expression: normalized,
    minutes: parsed[0]!,
    hours: parsed[1]!,
    days: parsed[2]!,
    months: parsed[3]!,
    weekdays: parsed[4]!,
    anyDay: fields[2] === "*",
    anyWeekday: fields[4] === "*",
  };
}

export function cronMatches(parsed: ParsedCron, date: Date): boolean {
  if (!parsed.minutes.has(date.getUTCMinutes()) || !parsed.hours.has(date.getUTCHours()) || !parsed.months.has(date.getUTCMonth() + 1)) {
    return false;
  }
  const dayMatches = parsed.days.has(date.getUTCDate());
  const weekdayMatches = parsed.weekdays.has(date.getUTCDay());
  const calendarMatches = parsed.anyDay
    ? weekdayMatches
    : parsed.anyWeekday
      ? dayMatches
      : dayMatches || weekdayMatches;
  return calendarMatches;
}

export function nextCronRun(expression: string, afterMs: number): number {
  const parsed = parseCron(expression);
  const start = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  const limit = start + 366 * 24 * 60 * 60_000;
  for (let timestamp = start; timestamp <= limit; timestamp += 60_000) {
    if (cronMatches(parsed, new Date(timestamp))) return timestamp;
  }
  throw new Error(`schedule has no occurrence in the next year: ${expression}`);
}
