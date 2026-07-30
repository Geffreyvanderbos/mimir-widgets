const params = new URLSearchParams(location.search);
const workMinutes = Number(params.get('work')) || 25;
const restMinutes = Number(params.get('rest')) || 5;

type Phase = 'work' | 'rest';

let phase: Phase = 'work';
let remainingMs = workMinutes * 60 * 1000;
let running = false;
let intervalId: number | undefined;
let lastTick = 0;

const phaseEl = document.getElementById('pomodoro-phase')!;
const clockEl = document.getElementById('pomodoro-clock')!;
const toggleEl = document.getElementById('pomodoro-toggle')!;
const resetEl = document.getElementById('pomodoro-reset')!;

function phaseDurationMs(p: Phase): number {
  return (p === 'work' ? workMinutes : restMinutes) * 60 * 1000;
}

// Namespaced by the widget's own query string, not just origin — two
// differently-configured embeds (?work=25 vs ?work=50) must not collide on
// the same storage key. See SKILL.md §7.
const STORAGE_PREFIX = 'mimir-widget:pomodoro:';
const STORAGE_KEY = STORAGE_PREFIX + (location.search || '(default)');
const STALE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredState {
  phase: Phase;
  remainingMs: number;
  running: boolean;
  savedAt: number;
}

// Nothing else prunes this storage — sweep every key under our own prefix
// (not just this instance's key) so an embed that's no longer pasted
// anywhere doesn't leak storage forever. See SKILL.md §7.
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
  const state: StoredState = { phase, remainingMs, running, savedAt: Date.now() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// Advances phase/remainingMs through however many work/rest cycles elapsed
// while the iframe was gone, rather than only the single crossover a live
// 250ms tick() handles. Capped since a tiny work/rest duration plus a long
// absence could otherwise loop a very long time.
function fastForward(elapsedMs: number) {
  remainingMs -= elapsedMs;
  let iterations = 0;
  while (remainingMs <= 0 && iterations < 10_000) {
    phase = phase === 'work' ? 'rest' : 'work';
    remainingMs += phaseDurationMs(phase);
    iterations++;
  }
  if (remainingMs <= 0) remainingMs = phaseDurationMs(phase);
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

  phase = stored.phase;
  remainingMs = stored.remainingMs;
  if (stored.running) {
    fastForward(Date.now() - stored.savedAt);
    start();
  }
}

function render() {
  phaseEl.textContent = phase === 'work' ? 'Work' : 'Rest';
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  clockEl.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
  toggleEl.textContent = running ? 'Pause' : 'Start';
}

function tick() {
  const now = Date.now();
  const elapsed = now - lastTick;
  lastTick = now;
  remainingMs -= elapsed;
  if (remainingMs <= 0) {
    phase = phase === 'work' ? 'rest' : 'work';
    remainingMs = phaseDurationMs(phase);
  }
  render();
  saveState();
}

function start() {
  if (running) return;
  running = true;
  lastTick = Date.now();
  intervalId = window.setInterval(tick, 250);
  render();
  saveState();
}

function pause() {
  running = false;
  if (intervalId !== undefined) clearInterval(intervalId);
  render();
  saveState();
}

function reset() {
  pause();
  phase = 'work';
  remainingMs = phaseDurationMs('work');
  render();
  saveState();
}

toggleEl.addEventListener('click', () => (running ? pause() : start()));
resetEl.addEventListener('click', reset);
window.addEventListener('pagehide', saveState);

restoreState();
render();

export {};
