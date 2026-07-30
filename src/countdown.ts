const params = new URLSearchParams(location.search);
const targetDate = new Date(params.get('date') ?? '');
const label = params.get('label') ?? 'Countdown';

const labelEl = document.getElementById('countdown-label')!;
const clockEl = document.getElementById('countdown-clock')!;
labelEl.textContent = label;

const UNITS: Array<[string, number]> = [
  ['d', 1000 * 60 * 60 * 24],
  ['h', 1000 * 60 * 60],
  ['m', 1000 * 60],
  ['s', 1000],
];

function render() {
  if (Number.isNaN(targetDate.getTime())) {
    clockEl.textContent = 'Invalid date';
    return;
  }
  const remaining = targetDate.getTime() - Date.now();
  if (remaining <= 0) {
    clockEl.textContent = 'Arrived';
    return;
  }
  const parts: string[] = [];
  let rest = remaining;
  for (const [suffix, size] of UNITS) {
    const value = Math.floor(rest / size);
    rest -= value * size;
    parts.push(`${value}${suffix}`);
  }
  clockEl.textContent = parts.join(' ');
}

render();
setInterval(render, 1000);

export {};
