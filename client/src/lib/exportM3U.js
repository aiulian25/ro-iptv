// Reconstruct a valid .m3u from parsed channels (download fallback for playlists
// whose original uploaded file isn't stored server-side, e.g. URL playlists).
export function channelsToM3U(channels = []) {
  const lines = ['#EXTM3U'];
  for (const c of channels) {
    const attrs = [
      c.tvgId ? `tvg-id="${c.tvgId}"` : '',
      c.tvgName ? `tvg-name="${c.tvgName}"` : '',
      c.logo ? `tvg-logo="${c.logo}"` : '',
      c.group ? `group-title="${c.group}"` : '',
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(`#EXTINF:-1 ${attrs},${c.name || ''}`);
    lines.push(c.url || '');
  }
  return lines.join('\n') + '\n';
}

// Trigger a client-side download of text as a file.
export function downloadText(filename, text, mime = 'audio/x-mpegurl') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
