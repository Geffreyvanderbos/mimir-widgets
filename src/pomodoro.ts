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
}

function start() {
  if (running) return;
  running = true;
  lastTick = Date.now();
  intervalId = window.setInterval(tick, 250);
  render();
}

function pause() {
  running = false;
  if (intervalId !== undefined) clearInterval(intervalId);
  render();
}

function reset() {
  pause();
  phase = 'work';
  remainingMs = phaseDurationMs('work');
  render();
}

toggleEl.addEventListener('click', () => (running ? pause() : start()));
resetEl.addEventListener('click', reset);

render();

export {};
