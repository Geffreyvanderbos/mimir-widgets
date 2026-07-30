const params = new URLSearchParams(location.search);
const latitude = Number(params.get('lat'));
const longitude = Number(params.get('lon'));
const label = params.get('label') ?? '';

const labelEl = document.getElementById('weather-label')!;
const bodyEl = document.getElementById('weather-body')!;
if (label) {
  labelEl.textContent = label;
} else {
  labelEl.remove();
}

// Weather codes are WMO codes (https://open-meteo.com/en/docs); open-meteo
// only returns the numeric code, so we map to a small icon set ourselves.
type IconKey =
  | 'clear-day' | 'clear-night'
  | 'partly-day' | 'partly-night'
  | 'overcast' | 'fog'
  | 'drizzle' | 'rain' | 'snow' | 'thunder';

function iconKeyFor(code: number, isDay: boolean): IconKey {
  if (code === 0) return isDay ? 'clear-day' : 'clear-night';
  if (code === 1 || code === 2) return isDay ? 'partly-day' : 'partly-night';
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'fog';
  if ([51, 53, 55, 56, 57].includes(code)) return 'drizzle';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'rain';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  if ([95, 96, 99].includes(code)) return 'thunder';
  return 'overcast';
}

const CLOUD_PATH =
  'M7 17.5a4 4 0 0 1-.6-7.95 5 5 0 0 1 9.7-1.6A3.75 3.75 0 0 1 16.5 17.5H7Z';

function svg(inner: string): string {
  return `<svg class="weather-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

const ICONS: Record<IconKey, string> = {
  'clear-day': svg(
    '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>' +
      '<path d="M12 2.5v2.5M12 19v2.5M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2.5 12H5M19 12h2.5M4.2 19.8 6 18M18 6l1.8-1.8"/>',
  ),
  'clear-night': svg(
    '<path d="M20 14.2A8.2 8.2 0 1 1 9.8 4a6.7 6.7 0 0 0 10.2 10.2Z" fill="currentColor" stroke="none"/>',
  ),
  'partly-day': svg(
    '<circle cx="8" cy="8.5" r="3.2" fill="currentColor" stroke="none"/>' +
      '<path d="M8 3.3v1.7M3.7 8.5H2M4.5 4.5l1.2 1.2" stroke-width="1.3"/>' +
      `<path d="${CLOUD_PATH}" fill="var(--bg)" stroke="currentColor"/>`,
  ),
  'partly-night': svg(
    '<path d="M16.3 9.4a4.6 4.6 0 1 1-5-5 3.7 3.7 0 0 0 5 5Z" fill="currentColor" stroke="none"/>' +
      `<path d="${CLOUD_PATH}" fill="var(--bg)" stroke="currentColor"/>`,
  ),
  overcast: svg(`<path d="${CLOUD_PATH}" fill="currentColor" stroke="none" opacity="0.85"/>`),
  fog: svg(
    `<path d="${CLOUD_PATH}" fill="currentColor" stroke="none" opacity="0.6"/>` +
      '<path d="M4 20h16M6 22h12" stroke-width="1.3"/>',
  ),
  drizzle: svg(
    `<path d="${CLOUD_PATH}" fill="currentColor" stroke="none" opacity="0.85"/>` +
      '<path d="M9 19.5v1.5M12.5 19.5v1.5M16 19.5v1.5" stroke-width="1.6"/>',
  ),
  rain: svg(
    `<path d="${CLOUD_PATH}" fill="currentColor" stroke="none" opacity="0.85"/>` +
      '<path d="M8.5 19.2 7.3 22M13 19.2l-1.2 2.8M17.5 19.2l-1.2 2.8" stroke-width="1.6"/>',
  ),
  snow: svg(
    `<path d="${CLOUD_PATH}" fill="currentColor" stroke="none" opacity="0.85"/>` +
      '<path d="M9 19.2v3M7.6 20.2l2.8 1M11.4 20.2l-2.8 1M15 19.2v3M13.6 20.2l2.8 1M17.4 20.2l-2.8 1" stroke-width="1.3"/>',
  ),
  thunder: svg(
    `<path d="${CLOUD_PATH}" fill="currentColor" stroke="none" opacity="0.85"/>` +
      '<path d="M13 18.5 10.5 22h2.2l-1.4 2" stroke-width="1.6" fill="none"/>',
  ),
};

interface HourlyForecast {
  time: string[];
  temperature_2m: number[];
  precipitation_probability: number[];
  weathercode: number[];
  is_day: number[];
}

function localHourToUtcMs(localTime: string, utcOffsetSeconds: number): number {
  return Date.parse(`${localTime}:00Z`) - utcOffsetSeconds * 1000;
}

// Widths chosen so a column never crowds below ~50px; wider embeds show
// more hours instead of stretching existing ones.
function columnCountForWidth(width: number): number {
  if (width < 320) return 4;
  if (width < 400) return 5;
  if (width < 480) return 6;
  if (width < 560) return 7;
  return 8;
}

const HOUR_STEP = 3;
const MAX_SLOTS = 8;

function renderHourly(hourly: HourlyForecast, startIndex: number) {
  const slotIndices: number[] = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const idx = startIndex + i * HOUR_STEP;
    if (idx >= hourly.time.length) break;
    slotIndices.push(idx);
  }

  const columns = Math.min(columnCountForWidth(window.innerWidth), slotIndices.length);
  const visible = slotIndices.slice(0, columns);

  bodyEl.innerHTML = visible
    .map((idx) => {
      const hour = new Date(`${hourly.time[idx]}:00Z`).getUTCHours();
      const timeLabel = `${hour}:00`;
      const temp = Math.round(hourly.temperature_2m[idx]);
      const precip = hourly.precipitation_probability[idx];
      const icon = ICONS[iconKeyFor(hourly.weathercode[idx], hourly.is_day[idx] === 1)];
      return `
        <div class="weather-hour">
          <span class="weather-hour-time">${timeLabel}</span>
          <span class="weather-icon">${icon}</span>
          <span class="weather-hour-temp">${temp}°</span>
          <span class="weather-hour-precip">${precip}%</span>
        </div>
      `;
    })
    .join('');
}

async function main() {
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    bodyEl.textContent = 'Missing ?lat=/?lon=';
    return;
  }

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(latitude));
  url.searchParams.set('longitude', String(longitude));
  url.searchParams.set(
    'hourly',
    'temperature_2m,precipitation_probability,weathercode,is_day',
  );
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '2');

  let hourly: HourlyForecast;
  let utcOffsetSeconds: number;
  try {
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`open-meteo returned ${res.status}`);
    const data = await res.json();
    hourly = data.hourly;
    utcOffsetSeconds = data.utc_offset_seconds;
  } catch {
    bodyEl.textContent = 'Forecast unavailable';
    return;
  }

  const now = Date.now();
  let startIndex = hourly.time.findIndex(
    (t) => localHourToUtcMs(t, utcOffsetSeconds) >= now,
  );
  if (startIndex === -1) startIndex = 0;

  renderHourly(hourly, startIndex);
  window.addEventListener('resize', () => renderHourly(hourly, startIndex));
}

main();

export {};
