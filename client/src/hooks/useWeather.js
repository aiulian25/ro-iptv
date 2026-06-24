import { useEffect, useState } from 'react';

// WMO weather code → label + Material Symbols icon.
const WMO = {
  0: ['Clear', 'clear_day'],
  1: ['Mainly clear', 'partly_cloudy_day'],
  2: ['Partly cloudy', 'partly_cloudy_day'],
  3: ['Overcast', 'cloud'],
  45: ['Fog', 'foggy'],
  48: ['Rime fog', 'foggy'],
  51: ['Light drizzle', 'rainy'],
  53: ['Drizzle', 'rainy'],
  55: ['Heavy drizzle', 'rainy'],
  61: ['Light rain', 'rainy'],
  63: ['Rain', 'rainy'],
  65: ['Heavy rain', 'rainy'],
  71: ['Light snow', 'weather_snowy'],
  73: ['Snow', 'weather_snowy'],
  75: ['Heavy snow', 'weather_snowy'],
  80: ['Showers', 'rainy'],
  81: ['Showers', 'rainy'],
  82: ['Violent showers', 'thunderstorm'],
  95: ['Thunderstorm', 'thunderstorm'],
  96: ['Thunderstorm', 'thunderstorm'],
  99: ['Thunderstorm', 'thunderstorm'],
};

async function reverseName(lat, lon) {
  try {
    const r = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?count=1&latitude=${lat}&longitude=${lon}`
    );
    const j = await r.json();
    return j?.results?.[0]?.name;
  } catch {
    return null;
  }
}

// Open-Meteo (no API key). Auto-detects location via geolocation, IP fallback.
export function useWeather() {
  const [weather, setWeather] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchFor(lat, lon, place) {
      try {
        const r = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`
        );
        const j = await r.json();
        if (cancelled) return;
        const code = j?.current?.weather_code ?? 0;
        const [label, icon] = WMO[code] || ['—', 'cloud'];
        const name = place || (await reverseName(lat, lon)) || 'Local';
        if (!cancelled)
          setWeather({ temp: Math.round(j?.current?.temperature_2m ?? 0), label, icon, place: name });
      } catch {
        /* ignore */
      }
    }

    async function ipFallback() {
      // Browser-CORS-enabled, HTTPS IP geolocation. Works on plain-HTTP LAN
      // origins (where the Geolocation API is unavailable) without CORS errors
      // or mixed-content. Tries sources in order until one resolves.
      const sources = [
        { url: 'https://ipwho.is/', pick: (j) => (j.success === false ? null : { lat: j.latitude, lon: j.longitude, city: j.city }) },
        { url: 'https://get.geojs.io/v1/ip/geo.json', pick: (j) => ({ lat: parseFloat(j.latitude), lon: parseFloat(j.longitude), city: j.city }) },
      ];
      for (const s of sources) {
        try {
          const r = await fetch(s.url);
          const loc = s.pick(await r.json());
          if (loc && loc.lat != null && !Number.isNaN(loc.lat)) {
            fetchFor(loc.lat, loc.lon, loc.city);
            return;
          }
        } catch {
          /* try next source */
        }
      }
    }

    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => fetchFor(pos.coords.latitude, pos.coords.longitude),
        () => ipFallback(),
        { timeout: 6000, maximumAge: 600000 }
      );
    } else {
      ipFallback();
    }

    return () => {
      cancelled = true;
    };
  }, []);

  return weather;
}
