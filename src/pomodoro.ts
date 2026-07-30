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

// Browsers only allow audio to start from a real user gesture, so the
// AudioContext is created lazily on the toggle click rather than up front —
// if the timer auto-resumes from storage without a fresh click this load,
// there's no context yet and beep() below just no-ops instead of erroring.
let audioCtx: AudioContext | null = null;

function unlockAudio() {
  if (audioCtx) return;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctor) audioCtx = new Ctor();
}

// A bell-like note: a fundamental plus a quieter inharmonic partial (a
// non-integer multiple, as real bells have) so it reads as a "chime" rather
// than a flat sine beep, with a slow decay instead of a quick blip.
function playChimeNote(ctx: AudioContext, startAt: number) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.7, startAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 1.1);
  gain.connect(ctx.destination);

  const fundamental = ctx.createOscillator();
  fundamental.type = 'sine';
  fundamental.frequency.value = 880;
  fundamental.connect(gain);

  const partialGain = ctx.createGain();
  partialGain.gain.value = 0.4;
  const partial = ctx.createOscillator();
  partial.type = 'sine';
  partial.frequency.value = 880 * 2.4;
  partial.connect(partialGain).connect(gain);

  fundamental.start(startAt);
  partial.start(startAt);
  fundamental.stop(startAt + 1.2);
  partial.stop(startAt + 1.2);
}

// A single chime for "work done, rest starts"; two for "rest done, back to
// work" — matches the two-ping request specifically for that one.
function chime(times: number) {
  if (!audioCtx) return;
  for (let i = 0; i < times; i++) {
    playChimeNote(audioCtx, audioCtx.currentTime + i * 0.55);
  }
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
    const endedPhase = phase;
    phase = phase === 'work' ? 'rest' : 'work';
    remainingMs = phaseDurationMs(phase);
    chime(endedPhase === 'work' ? 1 : 2);
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

toggleEl.addEventListener('click', () => {
  unlockAudio();
  running ? pause() : start();
});
resetEl.addEventListener('click', reset);
window.addEventListener('pagehide', saveState);

restoreState();
render();

export {};
