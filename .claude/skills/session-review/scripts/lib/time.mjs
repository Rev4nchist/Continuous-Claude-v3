// Local time for Dave's reports. The zone name comes from Intl, so it is CDT or CST by date.
const ZONE = 'America/Chicago';
const FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
});

const parts = (ms) => Object.fromEntries(FMT.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));

/** "2026-11-02 09:00 CST" (zone name from Intl), or null for a missing time. */
export function localStamp(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return null;
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** "2026-11-02" in the local zone. */
export function localDate(ms) {
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}
