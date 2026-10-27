export const timeZone = 'Europe/Zurich';

export const policy = {
  totalConsumptionLimitKw: 16,
  batteryPowerLimitKw: 7,
  homeBatteryCapacityKwh: 60,
  homeBatteryReserveSocPercent: 5,
  solarCapacityKw: 8.5,
  carCapacityKwh: 75,
  // JavaScript weekday order, indexed by the morning's local calendar date.
  carMorningMinimumSocPercentByWeekday: {
    Sunday: 60, Monday: 60, Tuesday: 50, Wednesday: 50,
    Thursday: 60, Friday: 50, Saturday: 60,
  },
  storageRoundTripEfficiency: 0.95,
} as const;

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function localParts(date: Date) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

export function getLocalDate(date: Date): string {
  const parts = localParts(date);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

// Resolve scheduled local wall times against Zurich's offset on that date.
// These boundaries avoid the repeated/missing 02:00 hour at DST changes.
function wallTime(day: Date, hour: number, minute = 0): Date {
  const target = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = localParts(new Date(candidate));
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    candidate += target - represented;
  }
  return new Date(candidate);
}

// The Date carries a calendar date in UTC; measure its actual Zurich midnight boundaries.
export function getCalendarDayBounds(day: Date): { start: Date; end: Date } {
  const nextDay = new Date(day.getTime() + 86_400_000);
  return { start: wallTime(day, 0), end: wallTime(nextDay, 0) };
}

export function getCalendarDayHours(day: Date): number {
  const { start, end } = getCalendarDayBounds(day);
  return (end.getTime() - start.getTime()) / 3_600_000;
}

export function getCarTarget(now: Date) {
  const local = localParts(now);
  let day = new Date(Date.UTC(local.year, local.month - 1, local.day));
  if (now.getTime() >= wallTime(day, 6, 55).getTime()) {
    day = new Date(day.getTime() + 86_400_000);
  }
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
  const weekday = weekdays[day.getUTCDay()];
  return {
    date: day.toISOString().slice(0, 10),
    weekday,
    minimumSocPercent: policy.carMorningMinimumSocPercentByWeekday[weekday],
    deadline: wallTime(day, 6, 55).toISOString(),
    gridChargingEndsAt: wallTime(day, 6, 55).toISOString(),
    reason: weekday === 'Saturday' || weekday === 'Sunday' ? 'Week-end' : 'Minimum quotidien',
  };
}

/** The origin restriction covers the whole night, including tariff buffers. */
export function getNightTariffEnd(now: Date): string | null {
  const local = localParts(now);
  if (local.hour >= 7 && local.hour < 23) return null;
  const day = new Date(Date.UTC(local.year, local.month - 1, local.day + (local.hour >= 23 ? 1 : 0)));
  return wallTime(day, 7).toISOString();
}

export function getSchedule(now: Date) {
  const local = localParts(now);
  const minute = local.hour * 60 + local.minute;
  const low = minute < 7 * 60 || (minute >= 12 * 60 && minute < 17 * 60) || minute >= 23 * 60;
  const day = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const offsetDay = (offset: number) => new Date(day.getTime() + offset * 86_400_000);
  const boundaries = [0, 1].flatMap(offset => [7, 12, 17, 23].map(hour => wallTime(offsetDay(offset), hour)));
  const nextChange = boundaries.find(boundary => boundary.getTime() > now.getTime())!;
  const windows = [-1, 0, 1, 2].flatMap(offset => [
    { kind: 'night' as const, label: 'Nuit' as const, start: wallTime(offsetDay(offset), 23, 5), end: wallTime(offsetDay(offset + 1), 6, 55) },
    { kind: 'afternoon' as const, label: 'Secours de l’après-midi' as const, start: wallTime(offsetDay(offset), 12, 5), end: wallTime(offsetDay(offset), 16, 55) },
  ]).sort((a, b) => a.start.getTime() - b.start.getTime());
  const current = windows.find(window => window.start.getTime() <= now.getTime() && now.getTime() < window.end.getTime());
  const next = current ?? windows.find(window => window.start.getTime() > now.getTime())!;
  return {
    tariff: { kind: low ? 'low' as const : 'high' as const, priceCts: low ? 17.1 : 28.29, nextChangeAt: nextChange.toISOString() },
    charging: {
      allowed: Boolean(current),
      phase: current ? 'open' as const : low ? 'buffer' as const : 'high_tariff' as const,
      currentWindow: current?.kind ?? null,
      nextWindow: { label: next.label, start: next.start.toISOString(), end: next.end.toISOString() },
    },
  };
}
