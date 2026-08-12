const params = new URLSearchParams(location.search);
const locale = navigator.language || 'en';

const country = (params.get('country') ?? '').trim().toUpperCase();
const county = (params.get('county') ?? '').trim().toUpperCase();
const english = params.get('en') === '1';
const count = Math.min(Math.max(Math.round(Number(params.get('n'))) || 4, 1), 8);
const label = params.get('label');

const NAGER_URL = 'https://date.nager.at/api/v3/NextPublicHolidays';
// Nothing here changes minute to minute; this exists only so a tab left open
// across midnight stops saying "in 1 day" about today's holiday.
const RERENDER_MS = 60 * 60 * 1000;

const labelEl = document.getElementById('holidays-label')!;
const heroEl = document.getElementById('holidays-hero')!;
const listEl = document.getElementById('holidays-list')!;

interface Holiday {
  date: string;
  localName: string;
  name: string;
  global: boolean;
  counties: string[] | null;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

// The reader's own calendar day, not UTC's: a holiday is "today" when it is
// today where you are.
function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Both sides parsed as UTC midnight so the subtraction is whole days even
// across a daylight-saving change, which a local-midnight diff isn't.
function daysUntil(date: string): number {
  return Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${todayIso()}T00:00:00Z`)) / 86_400_000,
  );
}

function formatDate(date: string): string {
  const sameYear = date.slice(0, 4) === todayIso().slice(0, 4);
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric',
    timeZone: 'UTC',
  });
}

function regionName(code: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function nameOf(holiday: Holiday): string {
  return english ? holiday.name : holiday.localName;
}

// A holiday that only some regions observe is a different claim from one the
// whole country takes off, so it says which — by bare subdivision code while
// they still fit, since "DE-BY" reads as Bavaria to anyone it matters to.
// Every row emits all three cells even when this one is empty: the rows are
// `display: contents` inside one grid, so a skipped cell would slide the next
// row's date into the column beside it.
function scopeHtml(holiday: Holiday): string {
  if (holiday.global || county) return '';
  const counties = holiday.counties ?? [];
  const text =
    counties.length > 0 && counties.length <= 3
      ? counties.map((code) => code.split('-')[1] ?? code).join(' ')
      : 'regional';
  return `<span class="holidays-scope">${esc(text)}</span>`;
}

function applies(holiday: Holiday): boolean {
  return !county || holiday.global || (holiday.counties ?? []).includes(county);
}

function countdownHtml(days: number): string {
  if (days <= 0) return '<span class="holidays-count">Today</span>';
  if (days === 1) return '<span class="holidays-count">Tomorrow</span>';
  return `<span class="holidays-count">${days}</span> days`;
}

function fail(message: string) {
  labelEl.textContent = label ?? (country ? regionName(country) : 'Public holidays');
  heroEl.innerHTML = `<p class="holidays-message">${esc(message)}</p>`;
  listEl.innerHTML = '';
}

function render(holidays: Holiday[]) {
  const upcoming = holidays.filter((holiday) => applies(holiday) && daysUntil(holiday.date) >= 0);
  if (upcoming.length === 0) {
    fail('No upcoming holidays');
    return;
  }

  const [next, ...rest] = upcoming;
  labelEl.textContent = label ?? `${regionName(country)} · public holidays`;

  heroEl.innerHTML = `
    <p class="holidays-name">${esc(nameOf(next))}</p>
    <p class="holidays-when">${countdownHtml(daysUntil(next.date))}
      <span class="holidays-date">${esc(formatDate(next.date))}</span>
      ${scopeHtml(next)}</p>
  `;

  listEl.innerHTML = rest
    .slice(0, count)
    .map(
      (holiday) => `
        <li class="holidays-row">
          <span class="holidays-row-date">${esc(formatDate(holiday.date))}</span>
          <span class="holidays-row-name">${esc(nameOf(holiday))}</span>
          <span class="holidays-row-scope">${scopeHtml(holiday)}</span>
        </li>
      `,
    )
    .join('');
}

async function main() {
  if (!/^[A-Z]{2}$/.test(country)) {
    fail('Missing ?country= (two-letter code, e.g. NL)');
    return;
  }

  let holidays: Holiday[];
  try {
    const res = await fetch(`${NAGER_URL}/${country}`);
    // An unknown country code comes back as a 500 rather than a 404, so every
    // failure gets the same, honest message.
    if (!res.ok) throw new Error(`No holidays for ${country}`);
    holidays = await res.json();
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Holidays unavailable');
    return;
  }

  render(holidays);
  setInterval(() => render(holidays), RERENDER_MS);
}

main();

export {};
