const params = new URLSearchParams(location.search);

const from = (params.get('from') ?? '').trim();
const to = (params.get('to') ?? '').trim();
const apiKey = (params.get('key') ?? '').trim();
const at = /^\d{2}:\d{2}$/.test(params.get('at') ?? '') ? params.get('at')! : null;
const searchForArrival = params.get('arrive') === '1';
const count = Math.min(Math.max(Math.round(Number(params.get('n'))) || 3, 1), 6);
const label = params.get('label');

const NS_TRIPS_URL = 'https://gateway.apiportal.ns.nl/reisinformatie-api/api/v3/trips';
const AMSTERDAM = 'Europe/Amsterdam';
const REFRESH_MS = 60_000;

const labelEl = document.getElementById('train-label')!;
const bodyEl = document.getElementById('train-body')!;
const footEl = document.getElementById('train-updated')!;

interface Stop {
  name: string;
  plannedDateTime: string;
  actualDateTime?: string;
  plannedTrack?: string;
  actualTrack?: string;
}

interface Leg {
  origin: Stop;
  destination: Stop;
  cancelled?: boolean;
  product?: { shortCategoryName?: string };
}

interface Trip {
  legs: Leg[];
  status?: string;
}

// NS stamps its offsets as "+0200", which Date.parse isn't required to accept
// (the ISO grammar wants "+02:00"); Safari in particular returns NaN for it.
function parseNsDate(value: string): number {
  return Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

// A timetable is in Dutch local time no matter where it's being read, and
// every timestamp already arrives stamped with that offset — so read the wall
// clock straight off the string instead of converting into the reader's zone.
function wallClock(value: string): string {
  return value.slice(11, 16);
}

function stopTime(stop: Stop): string {
  return wallClock(stop.actualDateTime ?? stop.plannedDateTime);
}

function delayMinutes(stop: Stop): number {
  if (!stop.actualDateTime) return 0;
  const diff = parseNsDate(stop.actualDateTime) - parseNsDate(stop.plannedDateTime);
  return diff > 0 ? Math.round(diff / 60_000) : 0;
}

function trackOf(stop: Stop): string | null {
  return stop.actualTrack ?? stop.plannedTrack ?? null;
}

function trackChanged(stop: Stop): boolean {
  return !!stop.actualTrack && !!stop.plannedTrack && stop.actualTrack !== stop.plannedTrack;
}

function departure(trip: Trip): Stop {
  return trip.legs[0].origin;
}

function arrival(trip: Trip): Stop {
  return trip.legs[trip.legs.length - 1].destination;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// "en-CA" gives an ISO-shaped date and "longOffset" gives "GMT+02:00", which
// together pin an "HH:MM" preference to a real instant in Dutch local time —
// what the ?at= parameter means, whatever zone the reader's clock is in.
function amsterdamNow(): { date: string; time: string; offset: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: AMSTERDAM,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'longOffset',
    })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    offset: parts.timeZoneName.replace('GMT', '') || '+00:00',
  };
}

function addDay(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

// A preferred time that has already gone by today means tomorrow's train —
// the morning commute is still the morning commute when you look at it at 21:00.
function preferredDateTime(time: string): string {
  const now = amsterdamNow();
  const day = time >= now.time ? now.date : addDay(now.date);
  return `${day}T${time}:00${now.offset}`;
}

function errorFor(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return 'Invalid API key';
    case 404:
      return 'Station not found';
    case 429:
      return 'Rate limit exceeded';
    default:
      return `NS API error ${status}`;
  }
}

async function loadTrips(): Promise<Trip[]> {
  const url = new URL(NS_TRIPS_URL);
  url.searchParams.set('fromStation', from);
  url.searchParams.set('toStation', to);
  // A few more than asked for: the API pads its window with trips on the far
  // side of the requested time, which chooseTrips filters back out.
  url.searchParams.set('numJourneys', String(count + 3));
  if (at) {
    url.searchParams.set('dateTime', preferredDateTime(at));
    url.searchParams.set('searchForArrival', String(searchForArrival));
  }

  const res = await fetch(url.toString(), {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey },
  });
  if (!res.ok) throw new Error(errorFor(res.status));

  const data = await res.json();
  return (data.trips ?? []).filter((trip: Trip) => trip.legs?.length > 0);
}

function chooseTrips(trips: Trip[]): Trip[] {
  if (!at) return trips.slice(0, count);
  const target = parseNsDate(preferredDateTime(at));

  if (searchForArrival) {
    // Arrive-by: the useful ones are the *latest* trips that still land in time.
    const inTime = trips.filter((trip) => parseNsDate(arrival(trip).plannedDateTime) <= target);
    return (inTime.length ? inTime : trips).slice(-count);
  }
  const after = trips.filter((trip) => parseNsDate(departure(trip).plannedDateTime) >= target);
  return (after.length ? after : trips).slice(0, count);
}

function chip(track: string, changed: boolean): string {
  return `<span class="train-track${changed ? ' changed' : ''}">${esc(track)}</span>`;
}

function metaHtml(trip: Trip): string {
  const { legs } = trip;
  const parts: string[] = [];

  const category = legs[0].product?.shortCategoryName;
  if (category) parts.push(`<span class="train-cat">${esc(category)}</span>`);

  const departureTrack = trackOf(legs[0].origin);
  if (departureTrack) parts.push(chip(departureTrack, trackChanged(legs[0].origin)));

  // One entry per transfer: where you change, and onto which track.
  legs.slice(1).forEach((leg, index) => {
    const track = trackOf(leg.origin);
    parts.push(
      `<span class="train-via">${esc(legs[index].destination.name)}` +
        `${track ? ` ${chip(track, trackChanged(leg.origin))}` : ''}</span>`,
    );
  });

  return parts.join('<span class="train-dot">·</span>');
}

function delayHtml(stop: Stop): string {
  const minutes = delayMinutes(stop);
  return `<span class="train-delay">${minutes > 0 ? `+${minutes}` : ''}</span>`;
}

function rowHtml(trip: Trip): string {
  const cancelled = trip.status === 'CANCELLED' || trip.legs.some((leg) => leg.cancelled);
  return `
    <div class="train-row${cancelled ? ' cancelled' : ''}">
      <span class="train-time">${stopTime(departure(trip))}</span>
      ${delayHtml(departure(trip))}
      <span class="train-arrow">→</span>
      <span class="train-time">${stopTime(arrival(trip))}</span>
      ${delayHtml(arrival(trip))}
      <span class="train-meta">${cancelled ? '<span class="train-cancelled">cancelled</span>' : metaHtml(trip)}</span>
    </div>
  `;
}

function labelFor(trips: Trip[]): string {
  const route = trips.length
    ? `${departure(trips[0]).name} → ${arrival(trips[0]).name}`
    : `${from} → ${to}`;
  const when = at
    ? `${searchForArrival ? 'arrive by' : 'depart'} ${at}`
    : 'next departures';
  const tomorrow =
    trips.length && departure(trips[0]).plannedDateTime.slice(0, 10) !== amsterdamNow().date;
  return `${label ?? route} · ${when}${tomorrow ? ' · tomorrow' : ''}`;
}

function fail(message: string) {
  labelEl.textContent = label ?? `${from || '?'} → ${to || '?'}`;
  bodyEl.innerHTML = `<p class="train-message">${esc(message)}</p>`;
  footEl.textContent = '';
}

async function refresh() {
  let trips: Trip[];
  try {
    trips = chooseTrips(await loadTrips());
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Departures unavailable');
    return;
  }

  labelEl.textContent = labelFor(trips);
  bodyEl.innerHTML = trips.length
    ? trips.map(rowHtml).join('')
    : '<p class="train-message">No trips found</p>';
  footEl.textContent = `updated ${amsterdamNow().time}`;
}

if (!from || !to) {
  fail('Missing ?from=/?to=');
} else if (!apiKey) {
  fail('Missing ?key= (NS Reisinformatie API key)');
} else {
  refresh();
  setInterval(refresh, REFRESH_MS);
}

export {};
