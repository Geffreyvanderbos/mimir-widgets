/*
 * The builder for /hike URLs. Everything here runs in the browser: the GPX
 * file is read with FileReader and never sent anywhere, which is the whole
 * privacy claim — there is no upload endpoint to trust, because there is no
 * upload. The output is a URL that carries the track itself.
 */

import {
  durationMinutes,
  elevationGainM,
  encodeTrack,
  parseGpx,
  simplify,
  trackLengthKm,
  trackName,
  trimEnds,
  type TrackPoint,
} from './hike-codec';
import { drawTrackMap } from './hike-map';

/* Browsers and intermediaries are comfortable well past this, but a widget URL
 * gets nested inside the oEmbed endpoint's own ?url= parameter and then stored
 * in a note, so leaving headroom is worth a warning. */
const URL_LENGTH_WARNING = 1600;

const fileEl = document.getElementById('gpx-file') as HTMLInputElement;
const dropEl = document.getElementById('gpx-drop')!;
const errorEl = document.getElementById('gpx-error')!;
const editorEl = document.getElementById('gpx-editor')!;
const labelEl = document.getElementById('gpx-label') as HTMLInputElement;
const detailEl = document.getElementById('gpx-detail') as HTMLInputElement;
const detailValueEl = document.getElementById('gpx-detail-value')!;
const trimEl = document.getElementById('gpx-trim') as HTMLInputElement;
const trimValueEl = document.getElementById('gpx-trim-value')!;
const mapEl = document.getElementById('hike-map')!;
const previewLabelEl = document.getElementById('hike-label')!;
const previewStatsEl = document.getElementById('hike-stats')!;
const summaryEl = document.getElementById('gpx-summary')!;
const urlEl = document.getElementById('gpx-url') as HTMLTextAreaElement;
const lengthEl = document.getElementById('gpx-length')!;
const copyEl = document.getElementById('gpx-copy')!;
const openEl = document.getElementById('gpx-open') as HTMLAnchorElement;

let rawPoints: TrackPoint[] = [];

function showError(text: string): void {
  errorEl.textContent = text;
  errorEl.hidden = text === '';
}

function formatDuration(minutes: number | undefined): string | undefined {
  if (minutes === undefined || minutes <= 0) {
    return undefined;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h${String(rest).padStart(2, '0')}` : `${rest} min`;
}

let pendingFrame: number | undefined;

function render(): void {
  if (pendingFrame !== undefined) {
    cancelAnimationFrame(pendingFrame);
  }
  // Coalesce: dragging a slider fires input on every pixel, and each render
  // re-runs Douglas-Peucker over the full-resolution track.
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = undefined;
    build();
  });
}

function build(): void {
  if (rawPoints.length === 0) {
    return;
  }

  const toleranceM = Number(detailEl.value);
  const trimM = Number(trimEl.value);

  detailValueEl.textContent = `${toleranceM} m`;
  trimValueEl.textContent = trimM === 0 ? 'off' : `${trimM} m`;

  const trimmed = trimEnds(rawPoints, trimM);
  const simplified = simplify(trimmed, toleranceM);

  /* Stats come from the trimmed-but-unsimplified track: simplification is a
   * drawing concern, and measuring distance on it would systematically
   * under-report by cutting every corner. */
  const km = trackLengthKm(trimmed);
  const gain = elevationGainM(trimmed);
  const minutes = durationMinutes(trimmed);

  const target = new URL('/hike', location.origin);
  target.searchParams.set('t', encodeTrack(simplified));
  if (labelEl.value.trim() !== '') {
    target.searchParams.set('label', labelEl.value.trim());
  }
  target.searchParams.set('km', km.toFixed(1));
  if (gain > 0) {
    target.searchParams.set('g', String(gain));
  }
  if (minutes !== undefined) {
    target.searchParams.set('d', String(minutes));
  }

  const href = target.toString();
  urlEl.value = href;
  openEl.href = href;

  lengthEl.textContent = `${href.length} characters`;
  lengthEl.classList.toggle('is-warning', href.length > URL_LENGTH_WARNING);

  const stats = [`${km.toFixed(1)} km`];
  if (gain > 0) {
    stats.push(`↑ ${gain} m`);
  }
  const duration = formatDuration(minutes);
  if (duration !== undefined) {
    stats.push(duration);
  }

  previewLabelEl.textContent = labelEl.value.trim() || 'Hike';
  previewStatsEl.textContent = stats.join('  ·  ');
  drawTrackMap(mapEl, simplified);

  summaryEl.textContent =
    `${rawPoints.length.toLocaleString()} recorded points → ${simplified.length.toLocaleString()} drawn` +
    (trimM > 0 ? `, ${trimM} m trimmed from each end` : '');

  editorEl.hidden = false;
}

async function loadFile(file: File): Promise<void> {
  showError('');
  try {
    const xml = await file.text();
    rawPoints = parseGpx(xml);
    if (labelEl.value.trim() === '') {
      labelEl.value = trackName(xml) ?? file.name.replace(/\.gpx$/i, '');
    }
    build();
  } catch (error) {
    editorEl.hidden = true;
    rawPoints = [];
    showError(error instanceof Error ? error.message : 'That file could not be read.');
  }
}

fileEl.addEventListener('change', () => {
  const file = fileEl.files?.[0];
  if (file !== undefined) {
    void loadFile(file);
  }
});

for (const eventName of ['dragenter', 'dragover'] as const) {
  dropEl.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropEl.classList.add('is-active');
  });
}

for (const eventName of ['dragleave', 'dragend'] as const) {
  dropEl.addEventListener(eventName, () => dropEl.classList.remove('is-active'));
}

dropEl.addEventListener('drop', (event) => {
  event.preventDefault();
  dropEl.classList.remove('is-active');
  const file = event.dataTransfer?.files?.[0];
  if (file !== undefined) {
    void loadFile(file);
  }
});

labelEl.addEventListener('input', render);
detailEl.addEventListener('input', render);
trimEl.addEventListener('input', render);

let copyResetId: number | undefined;
copyEl.addEventListener('click', async () => {
  let copied = false;
  try {
    await navigator.clipboard.writeText(urlEl.value);
    copied = true;
  } catch {
    urlEl.select();
  }
  copyEl.textContent = copied ? 'Copied' : 'Press ⌘C';
  if (copyResetId !== undefined) {
    clearTimeout(copyResetId);
  }
  copyResetId = window.setTimeout(() => {
    copyEl.textContent = 'Copy URL';
  }, 1500);
});

export {};
