import { decodeTrack, type LatLon } from './hike-codec';
import { drawTrackMapResponsively } from './hike-map';

const params = new URLSearchParams(location.search);
const mapEl = document.getElementById('hike-map')!;
const labelEl = document.getElementById('hike-label')!;
const statsEl = document.getElementById('hike-stats')!;

labelEl.textContent = params.get('label') ?? 'Hike';

/*
 * Distance, climb and duration arrive as three short numbers rather than being
 * recomputed from the encoded track. They're measured by the builder from the
 * *full-resolution* GPX, so they're both more accurate than anything derivable
 * here and far cheaper than carrying a per-point elevation and time channel
 * (which would roughly double the payload).
 */
function formatStats(): string {
  const parts: string[] = [];

  const km = Number(params.get('km'));
  if (Number.isFinite(km) && km > 0) {
    parts.push(`${km.toFixed(1)} km`);
  }

  const gain = Number(params.get('g'));
  if (Number.isFinite(gain) && gain > 0) {
    parts.push(`↑ ${Math.round(gain)} m`);
  }

  const minutes = Number(params.get('d'));
  if (Number.isFinite(minutes) && minutes > 0) {
    const hours = Math.floor(minutes / 60);
    const rest = Math.round(minutes % 60);
    parts.push(hours > 0 ? `${hours}h${String(rest).padStart(2, '0')}` : `${rest} min`);
  }

  return parts.join('  ·  ');
}

let track: LatLon[];
try {
  const payload = params.get('t');
  if (payload === null || payload === '') {
    throw new Error('No track in this URL.');
  }
  track = decodeTrack(payload);
} catch {
  mapEl.classList.add('is-empty');
  mapEl.textContent = 'No readable track in this URL.';
  statsEl.textContent = '';
  throw new Error('hike: unreadable track payload');
}

statsEl.textContent = formatStats();
drawTrackMapResponsively(mapEl, track);

export {};
