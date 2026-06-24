// EPG helpers operating on the parsed structure returned by the backend.

export function findNowNext(programmes = [], at = new Date()) {
  if (!programmes || !programmes.length) return { now: null, next: null };
  const t = at.getTime();
  let now = null;
  let next = null;
  for (let i = 0; i < programmes.length; i++) {
    const p = programmes[i];
    const start = p.start ? new Date(p.start).getTime() : 0;
    const stop = p.stop ? new Date(p.stop).getTime() : 0;
    if (start <= t && t < stop) {
      now = p;
      next = programmes[i + 1] || null;
      break;
    }
    if (start > t) {
      next = p;
      break;
    }
  }
  return { now, next };
}

export function progressPct(programme, at = new Date()) {
  if (!programme || !programme.start || !programme.stop) return 0;
  const start = new Date(programme.start).getTime();
  const stop = new Date(programme.stop).getTime();
  const t = at.getTime();
  if (t <= start) return 0;
  if (t >= stop) return 100;
  return Math.round(((t - start) / (stop - start)) * 100);
}

export function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Build a lookup of EPG programmes for a channel, matching by tvg-id or tvg-name.
export function programmesForChannel(epg, channel) {
  if (!epg || !channel) return [];
  const byId = channel.tvgId && epg.programmes[channel.tvgId];
  if (byId) return byId;
  // Fallback: match by display name.
  if (channel.tvgName) {
    for (const [id, name] of Object.entries(epg.channels || {})) {
      if (name && name.toLowerCase() === channel.tvgName.toLowerCase()) {
        return epg.programmes[id] || [];
      }
    }
  }
  return [];
}
