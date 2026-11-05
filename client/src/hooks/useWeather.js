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

// Open-Meteo (no API key). Auto-detects location via geolocation, IP fallback.
export function useWeather() {
  const [weather, setWeather] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const controllers = new Set();
    let geoTimer;
    const validLocation = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    async function json(url) {
      if (cancelled) throw new Error('Weather cancelled');
      const controller = new AbortController(); controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error('Weather unavailable');
        return await response.json();
      } finally { clearTimeout(timer); controllers.delete(controller); controller.abort(); }
    }

    async function fetchFor(lat, lon, place) {
      if (cancelled || !validLocation(lat, lon)) return;
      try {
        const j = await json(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`
        );
        if (cancelled) return;
        const code = j?.current?.weather_code, temp = j?.current?.temperature_2m;
        if (!Number.isFinite(code) || !Number.isFinite(temp)) return;
        const [label, icon] = WMO[code] || ['—', 'cloud'];
        const name = place || 'Local';
        if (!cancelled)
          setWeather({ temp: Math.round(temp), label, icon, place: name });
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
          if (cancelled) return;
          const loc = s.pick(await json(s.url));
          if (loc && validLocation(loc.lat, loc.lon)) {
            fetchFor(loc.lat, loc.lon, loc.city);
            return;
          }
        } catch {
          /* try next source */
        }
      }
    }

    let fallbackStarted = false;
    const fallback = () => { if (fallbackStarted || cancelled) return; fallbackStarted = true; clearTimeout(geoTimer); void ipFallback(); };
    if ('geolocation' in navigator) {
      geoTimer = setTimeout(fallback, 6500);
      navigator.geolocation.getCurrentPosition(
        (pos) => { clearTimeout(geoTimer); if (fallbackStarted || cancelled) return; if (validLocation(pos.coords.latitude, pos.coords.longitude)) void fetchFor(pos.coords.latitude, pos.coords.longitude); else fallback(); },
        fallback,
        { timeout: 6000, maximumAge: 600000 }
      );
    } else {
      fallback();
    }

    return () => {
      cancelled = true; clearTimeout(geoTimer); for (const controller of controllers) controller.abort();
    };
  }, []);

  return weather;
}
