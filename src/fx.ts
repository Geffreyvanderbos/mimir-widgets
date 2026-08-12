const params = new URLSearchParams(location.search);
const locale = navigator.language || 'en';

function currencyParam(name: string, fallback: string): string | null {
  const raw = params.get(name) ?? fallback;
  return /^[A-Za-z]{3}$/.test(raw) ? raw.toUpperCase() : null;
}

// Deliberately not 1: at an amount of 1 the headline would read exactly the
// same as the "1 EUR = …" rate line under it, wasting half the card.
const DEFAULT_AMOUNT = 100;
const HISTORY_DAYS = 30;

const amountEl = document.getElementById('fx-amount') as HTMLInputElement;
const resultEl = document.getElementById('fx-result')!;
const fromEl = document.getElementById('fx-from')!;
const toEl = document.getElementById('fx-to')!;
const swapEl = document.getElementById('fx-swap')!;
const sparkEl = document.getElementById('fx-spark-path')!;
const noteEl = document.getElementById('fx-note')!;

interface RatePoint {
  date: string;
  rate: number;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

// Each currency's own convention for how many decimals it's quoted in — JPY
// has none, most have two. Intl already knows this table, so read it off a
// formatter rather than shipping one.
function fractionDigits(code: string): number {
  const resolved = new Intl.NumberFormat(locale, { style: 'currency', currency: code })
    .resolvedOptions();
  return resolved.maximumFractionDigits ?? 2;
}

const decimalSeparator =
  new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === 'decimal')
    ?.value ?? '.';

// The result is locale-formatted ("1.234,56" for a Dutch reader), so the input
// has to read that same format back or a four-figure amount round-trips into a
// different number entirely. Digits before the locale's own decimal separator
// are the whole part; every other separator is grouping and is dropped.
function parseAmount(raw: string): number {
  let whole = '';
  let fraction: string | null = null;
  for (const char of raw) {
    if (char >= '0' && char <= '9') {
      if (fraction === null) whole += char;
      else fraction += char;
    } else if (char === decimalSeparator && fraction === null) {
      fraction = '';
    }
  }
  return Number(fraction === null ? whole : `${whole}.${fraction}`);
}

function formatMoney(value: number, code: string): string {
  const digits = fractionDigits(code);
  return value.toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function fail(message: string) {
  resultEl.textContent = '—';
  sparkEl.removeAttribute('d');
  noteEl.textContent = message;
}

// Normalised into the SVG's own 100x30 viewBox, which is stretched to the
// embed's width by preserveAspectRatio="none" — so no resize listener, and
// the stroke stays 1.5px thanks to vector-effect on the path.
function sparkPath(values: number[]): string {
  if (values.length < 2) return 'M0 15 L100 15';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return values
    .map((value, i) => {
      const x = (i / (values.length - 1)) * 100;
      // A currency against itself is a flat 1.0 for every point: there's no
      // range to normalise against, so draw it straight down the middle.
      const y = span === 0 ? 15 : 27 - ((value - min) / span) * 24;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

async function loadSeries(base: string, quote: string): Promise<RatePoint[]> {
  const url = new URL('https://api.frankfurter.dev/v2/rates');
  url.searchParams.set('base', base);
  url.searchParams.set('quotes', quote);
  // `to` defaults to today, so an open-ended start date is the whole range.
  url.searchParams.set('from', isoDaysAgo(HISTORY_DAYS));

  const res = await fetch(url.toString());
  const body = await res.json();
  if (!res.ok) {
    throw new Error(typeof body?.message === 'string' ? body.message : `HTTP ${res.status}`);
  }
  if (!Array.isArray(body) || body.length === 0) {
    throw new Error('No rates for this pair');
  }
  return body as RatePoint[];
}

let from = '';
let to = '';
let points: RatePoint[] = [];

function render() {
  const latest = points[points.length - 1];
  const first = points[0];
  const typed = parseAmount(amountEl.value);
  const amount = Number.isFinite(typed) ? typed : 0;

  fromEl.textContent = from;
  toEl.textContent = to;
  resultEl.textContent = amountEl.value.trim() === ''
    ? '—'
    : formatMoney(amount * latest.rate, to);
  sparkEl.setAttribute('d', sparkPath(points.map((p) => p.rate)));

  const rate = latest.rate.toLocaleString(locale, { maximumSignificantDigits: 6 });
  const change = first.rate === 0 ? 0 : ((latest.rate - first.rate) / first.rate) * 100;
  const magnitude = Math.abs(change).toLocaleString(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const changeLabel = `${change >= 0 ? '+' : '−'}${magnitude}%`;
  noteEl.textContent =
    `1 ${from} = ${rate} ${to} · ${changeLabel} in ${HISTORY_DAYS}d · ${formatDate(latest.date)}`;
}

async function main() {
  const fromParam = currencyParam('from', 'EUR');
  const toParam = currencyParam('to', 'USD');
  if (fromParam === null || toParam === null) {
    fail('Missing ?from=/?to=');
    return;
  }
  from = fromParam;
  to = toParam;

  const amount = Number(params.get('amount'));
  amountEl.value = String(amount > 0 ? amount : DEFAULT_AMOUNT)
    .replace('.', decimalSeparator);

  try {
    points = await loadSeries(from, to);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Rate unavailable');
    return;
  }
  render();

  // Both interactions are pure arithmetic on the series already in hand —
  // neither one goes back to the network.
  amountEl.addEventListener('input', render);
  swapEl.addEventListener('click', () => {
    [from, to] = [to, from];
    points = points.map((p) => ({ date: p.date, rate: 1 / p.rate }));
    render();
  });
}

main();

export {};
