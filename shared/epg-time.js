// Unknown end times are points in the guide, not intervals that run forever.
export function programmeInWindow(programme, from, to) {
  const start = Date.parse(programme.start);
  if (!Number.isFinite(start) || start >= to) return false;
  if (programme.stop == null && programme.endStatus === 'unknown') return start >= from;
  const stop = Date.parse(programme.stop);
  return Number.isFinite(stop) && stop > start && stop > from;
}
export function canScheduleProgramme(programme) {
  const start = Date.parse(programme?.start), stop = Date.parse(programme?.stop);
  return !programme?.timeUncertain && Number.isFinite(start) && Number.isFinite(stop) && stop > start;
}
