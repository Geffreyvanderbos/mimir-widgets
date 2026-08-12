const params = new URLSearchParams(location.search);

const DEFAULT_PRESETS_MS = [1, 3, 5, 10].map((m) => m * 60 * 1000);
const MAX_PRESETS = 8;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

// One number plus an optional unit. Sticky, so parseUnitParts can walk a
// compound string ("1h09m") part by part and insist the whole of it was
// consumed — longer unit spellings come first in the alternation so "min"
// can't match as a bare "m" with a stray "in" left over.
const DURATION_PART_RE = /\s*(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)?/y;

function unitFactorMs(unit: string | undefined): number {
  if (unit === undefined) return 60_000;
  return unit.startsWith('h') ? 3_600_000 : unit.startsWith('s') ? 1000 : 60_000;
}

function parseUnitParts(text: string): number | null {
  let ms = 0;
  let parts = 0;
  let pos = 0;
  while (pos < text.length) {
    DURATION_PART_RE.lastIndex = pos;
    const match = DURATION_PART_RE.exec(text);
    if (!match) return null;
    pos = DURATION_PART_RE.lastIndex;
    const unit = match[2];
    // Only a lone number may leave its unit off ("7" is seven minutes); in a
    // compound every part has to say what it is, since a trailing bare number
    // is genuinely ambiguous ("1h09" — nine what?).
    if (unit === undefined && (parts > 0 || pos < text.length)) return null;
    ms += Number(match[1]) * unitFactorMs(unit);
    parts++;
  }
  return parts > 0 ? ms : null;
}

// Minutes-first, the way a kitchen timer is spoken: a bare number is minutes,
// colon-separated is m:ss (or h:mm:ss), and explicit units in any combination
// override — "45s", "7m", "2h", "1h09m", "1h 30m 5s". Returns null for
// anything that isn't a usable duration.
function parseDuration(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  const colonMatch = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(text);
  const ms = colonMatch
    ? (colonMatch[3] === undefined
        ? Number(colonMatch[1]) * 60 + Number(colonMatch[2])
        : Number(colonMatch[1]) * 3600 + Number(colonMatch[2]) * 60 + Number(colonMatch[3])) * 1000
    : parseUnitParts(text);

  if (ms === null) return null;
  return ms > 0 && ms <= MAX_DURATION_MS ? ms : null;
}

function parsePresets(): number[] {
  const raw = params.get('presets');
  if (!raw) return DEFAULT_PRESETS_MS;
  const parsed = raw
    .split(',')
    .map((part) => parseDuration(part))
    .filter((ms): ms is number => ms !== null)
    .slice(0, MAX_PRESETS);
  return parsed.length ? parsed : DEFAULT_PRESETS_MS;
}

const presets = parsePresets();

// The big label on a preset button: whole minutes read as "5 / MIN", anything
// with a seconds remainder falls back to a m:ss face so "1:30" stays legible.
function presetFace(ms: number): { value: string; unit: string } {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return { value: String(totalSeconds), unit: 'sec' };
  if (totalSeconds % 60 !== 0) return { value: formatClock(ms), unit: 'min' };
  const minutes = totalSeconds / 60;
  if (minutes % 60 === 0 && minutes >= 60) {
    return { value: String(minutes / 60), unit: minutes === 60 ? 'hour' : 'hours' };
  }
  if (minutes > 60) {
    const face = `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
    return { value: face, unit: 'hrs' };
  }
  return { value: String(minutes), unit: 'min' };
}

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatTotal(ms: number): string {
  const face = presetFace(ms);
  return `${face.value} ${face.unit}`;
}

const pickerEl = document.getElementById('timer-picker')!;
const presetsEl = document.getElementById('timer-presets')!;
const customFormEl = document.getElementById('timer-custom') as HTMLFormElement;
const customInputEl = document.getElementById('timer-custom-input') as HTMLInputElement;
const unitsEl = document.getElementById('timer-units')!;
const runningEl = document.getElementById('timer-running')!;
const ringEl = document.getElementById('timer-ring-progress') as unknown as SVGCircleElement;
const clockEl = document.getElementById('timer-clock')!;
const totalEl = document.getElementById('timer-total')!;
const toggleEl = document.getElementById('timer-toggle')!;
const cancelEl = document.getElementById('timer-cancel')!;

const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14M15 5v14" /></svg>';
const ICON_PLAY =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5 18 12 8 18.5Z" class="filled" /></svg>';

// Matches r=45 in the SVG; the ring is drawn as one dashed stroke whose
// offset is the elapsed fraction, so the arc depletes as time runs out.
const RING_CIRCUMFERENCE = 2 * Math.PI * 45;

type Mode = 'idle' | 'running' | 'done';

let mode: Mode = 'idle';
let totalMs = 0;
let remainingMs = 0;
let running = false;
let intervalId: number | undefined;
let lastTick = 0;

// Browsers only allow audio to start from a real user gesture, so the
// AudioContext is created lazily when a duration is picked. A timer restored
// from storage that already expired while the iframe was gone therefore has
// no context and stays silent — which is also what SKILL.md §8 wants (no
// audio the person didn't set off themselves).
let audioCtx: AudioContext | null = null;

function unlockAudio() {
  if (audioCtx) return;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctor) audioCtx = new Ctor();
}

// A struck bell rather than a beep: a fundamental plus two inharmonic
// partials (non-integer multiples, as real bells have) with a fast attack and
// a long decay.
function playBellStrike(ctx: AudioContext, startAt: number) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.6, startAt + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 1.6);
  gain.connect(ctx.destination);

  const partials: Array<[ratio: number, level: number]> = [
    [1, 1],
    [2.4, 0.35],
    [4.2, 0.18],
  ];
  for (const [ratio, level] of partials) {
    const partialGain = ctx.createGain();
    partialGain.gain.value = level;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 880 * ratio;
    osc.connect(partialGain).connect(gain);
    osc.start(startAt);
    osc.stop(startAt + 1.7);
  }
}

function ringBell() {
  if (!audioCtx) return;
  for (let i = 0; i < 3; i++) {
    playBellStrike(audioCtx, audioCtx.currentTime + i * 0.7);
  }
}

// Namespaced by the widget's own query string, not just origin — two
// differently-configured embeds (?presets=1,3 vs ?presets=20,45) must not
// collide on the same storage key. See SKILL.md §7.
const STORAGE_PREFIX = 'mimir-widget:timer:';
const STORAGE_KEY = STORAGE_PREFIX + (location.search || '(default)');
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredState {
  mode: Mode;
  totalMs: number;
  remainingMs: number;
  running: boolean;
  savedAt: number;
}

// Nothing else prunes this storage — sweep every key under our own prefix
// (not just this instance's key) so an embed that's no longer pasted anywhere
// doesn't leak storage forever. See SKILL.md §7.
function sweepStaleEntries() {
  const now = Date.now();
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
    try {
      const stored = JSON.parse(localStorage.getItem(key)!) as StoredState;
      if (now - stored.savedAt > STALE_TTL_MS) localStorage.removeItem(key);
    } catch {
      localStorage.removeItem(key);
    }
  }
}

function saveState() {
  if (mode === 'idle') {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  const state: StoredState = { mode, totalMs, remainingMs, running, savedAt: Date.now() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function restoreState() {
  sweepStaleEntries();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;

  let stored: StoredState;
  try {
    stored = JSON.parse(raw);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }

  mode = stored.mode;
  totalMs = stored.totalMs;
  remainingMs = stored.remainingMs;
  if (mode === 'running' && stored.running) {
    remainingMs -= Date.now() - stored.savedAt;
    if (remainingMs <= 0) {
      // It expired while the iframe was destroyed; land on the finished
      // screen, silently — there was no gesture this load to ring on.
      mode = 'done';
      remainingMs = 0;
    } else {
      start();
    }
  }
}

function renderPresets() {
  for (const ms of presets) {
    const { value, unit } = presetFace(ms);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'timer-preset';
    button.setAttribute('aria-label', `Start a ${formatTotal(ms)} timer`);
    const valueEl = document.createElement('span');
    valueEl.className = 'timer-preset-value';
    valueEl.textContent = value;
    const unitEl = document.createElement('span');
    unitEl.className = 'timer-preset-unit';
    unitEl.textContent = unit;
    button.append(valueEl, unitEl);
    button.addEventListener('click', () => {
      unlockAudio();
      startTimer(ms);
    });
    presetsEl.append(button);
  }
}

function render() {
  const idle = mode === 'idle';
  pickerEl.hidden = !idle;
  runningEl.hidden = idle;
  if (idle) return;

  const done = mode === 'done';
  const face = formatClock(remainingMs);
  clockEl.textContent = face;
  // An hours-long face ("9:09:41", "10:02:02") is wide enough at full size to
  // graze the ring, so it steps down by character count rather than by a
  // fixed size that would have to suit the widest case at all times.
  clockEl.classList.toggle('is-long', face.length === 7);
  clockEl.classList.toggle('is-longest', face.length > 7);
  totalEl.textContent = done ? "Time's up" : formatTotal(totalMs);
  runningEl.classList.toggle('is-done', done);

  const fraction = totalMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 0;
  ringEl.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  ringEl.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - fraction));

  toggleEl.hidden = done;
  toggleEl.innerHTML = running ? ICON_PAUSE : ICON_PLAY;
  toggleEl.setAttribute('aria-label', running ? 'Pause timer' : 'Resume timer');
  cancelEl.setAttribute('aria-label', done ? 'Dismiss timer' : 'Cancel timer');
}

function tick() {
  const now = Date.now();
  remainingMs -= now - lastTick;
  lastTick = now;
  if (remainingMs <= 0) {
    remainingMs = 0;
    finish();
    return;
  }
  render();
  saveState();
}

function start() {
  if (running) return;
  running = true;
  lastTick = Date.now();
  intervalId = window.setInterval(tick, 250);
}

function pause() {
  running = false;
  if (intervalId !== undefined) clearInterval(intervalId);
}

function startTimer(durationMs: number) {
  pause();
  mode = 'running';
  totalMs = durationMs;
  remainingMs = durationMs;
  start();
  render();
  saveState();
}

function finish() {
  pause();
  mode = 'done';
  ringBell();
  render();
  saveState();
}

function cancel() {
  pause();
  mode = 'idle';
  totalMs = 0;
  remainingMs = 0;
  customInputEl.value = '';
  render();
  saveState();
}

customFormEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const duration = parseDuration(customInputEl.value);
  if (duration === null) {
    customInputEl.classList.add('is-invalid');
    customInputEl.select();
    return;
  }
  customInputEl.classList.remove('is-invalid');
  unlockAudio();
  startTimer(duration);
});

customInputEl.addEventListener('input', () => customInputEl.classList.remove('is-invalid'));

// Replacing a trailing unit rather than stacking onto it puts "5m" one tap
// from "5h"; a value ending in neither a digit nor a unit has nothing for a
// unit to attach to, so the tap does nothing rather than making "m" alone.
function applyUnit(unit: string) {
  const value = customInputEl.value.trimEnd();
  const last = value.slice(-1);
  // "1:30" is already a complete duration in the other notation, and no
  // suffix makes it a valid one — a key press must never turn something
  // parseable into something that isn't.
  if (value.includes(':')) return;
  if (/[hms]/.test(last)) {
    customInputEl.value = value.slice(0, -1) + unit;
  } else if (/\d/.test(last)) {
    customInputEl.value = value + unit;
  }
  customInputEl.classList.remove('is-invalid');
  customInputEl.focus();
}

// Pressing a button moves focus off the input by default, which on a phone
// closes the keypad mid-entry. Cancelling the pointer's default keeps the
// caret where it is; `click` still fires afterwards, so the same handler
// serves a tap, a mouse and Enter on a focused key.
unitsEl.addEventListener('pointerdown', (event) => event.preventDefault());

unitsEl.addEventListener('click', (event) => {
  const key = (event.target as HTMLElement).closest<HTMLElement>('.timer-unit');
  if (key?.dataset.unit) applyUnit(key.dataset.unit);
});

toggleEl.addEventListener('click', () => {
  running ? pause() : start();
  render();
  saveState();
});

cancelEl.addEventListener('click', cancel);
window.addEventListener('pagehide', saveState);

renderPresets();
restoreState();
render();

export {};
