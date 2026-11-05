export const LOCAL_RADIO_PLAYLIST_ID = 'local-radio-stations';
export const LOCAL_RADIO_PLAYLIST_NAME = 'Local radio stations';
export function validateStation(input = {}) {
  const field = (key, max, required = false) => {
    const value = input[key] == null ? '' : input[key];
    if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value) || (required && !value.trim())) throw new Error(`Invalid station ${key}`);
    return value.trim();
  };
  const web = (key, required) => {
    const value = field(key, 4096, required); if (!value) return '';
    let parsed; try { parsed = new URL(value); } catch { throw new Error(`Station ${key} must be an HTTP(S) URL`); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Station ${key} must be an HTTP(S) URL`);
    return parsed.href;
  };
  const name = field('name', 120, true), url = web('url', true), logo = web('logo', false);
  const country = field('country', 2).toLowerCase(), genre = field('genre', 80);
  if (country && !/^[a-z]{2}$/.test(country)) throw new Error('Country must be a two-letter code');
  if (genre.includes('"')) throw new Error('Genre cannot contain double quotes');
  return { name, url, logo, country, genre: genre || 'Radio' };
}
export function stationsToM3U(stations) {
  return '#EXTM3U\n' + stations.map(station => `#EXTINF:-1 radio="true" tvg-id="${station.id}" tvg-country="${station.country}" tvg-logo="${station.logo}" group-title="${station.genre || 'Radio'}",${station.name}\n${station.url}\n`).join('');
}
