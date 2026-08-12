import { createMap, zoomForRadius, type SlippyMap } from './nearby-map';

interface Place {
  id: string;
  slug: string;
  name: string | null;
  lat: number;
  lon: number;
  distance: number;
  tags: Record<string, string>;
}

/* Category identity — icon and label included — comes back with the answer
 * rather than being looked up here. The same table that decides which OSM tag a
 * slug means decides what it looks like, so the pin on the map and the header
 * in the list can't drift apart, and a category added server-side arrives
 * already drawable. */
interface Category {
  slug: string;
  emoji: string;
  label: string;
  count: number;
  found: number;
  capped: boolean;
  nearest: number | null;
}

interface Answer {
  instance: string;
  radius: number;
  truncated: boolean;
  categories: Category[];
  places: Place[];
}

const params = new URLSearchParams(location.search);

const mapEl = document.getElementById('nearby-map')!;
const metaEl = document.getElementById('nearby-meta')!;
const searchEl = document.getElementById('nearby-search') as HTMLButtonElement;
const resetEl = document.getElementById('nearby-reset') as HTMLButtonElement;
const headEl = document.getElementById('nearby-head')!;
const listEl = document.getElementById('nearby-list')!;

function number(name: string, limit: number): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : undefined;
}

const lat = number('lat', 90);
const lon = number('lon', 180);

/* Clamped the same way the function clamps it, so the circle the map is drawn
 * to fit is the circle that was actually queried. */
const radius = Math.min(Math.max(Math.round(number('radius', 1e6) ?? 1500), 100), 5000);

function fail(message: string): never {
  mapEl.classList.add('is-empty');
  mapEl.textContent = message;
  headEl.textContent = 'Nearby';
  listEl.replaceChildren();
  throw new Error(`nearby: ${message}`);
}

if (lat === undefined || lon === undefined) {
  fail('Add ?lat= and ?lon= to this URL.');
}

const label = params.get('label')?.trim();
/* Kept apart from what's displayed, because the count is appended to it on
 * every load — and a retry that appended to the previous line would grow it. */
const headBase = label !== undefined && label !== '' ? label : 'Nearby';
headEl.textContent = headBase;

/* `?dogs=1` drops the places that refuse dogs and floats the ones that welcome
 * them — see the note in functions/api/nearby.ts for why it can't be a stricter
 * filter than that. */
const dogs = ['1', 'true', 'yes'].includes(params.get('dogs') ?? '');
const DOG_WELCOME = ['yes', 'leashed', 'outside'];

function metres(distance: number): string {
  return distance < 950 ? `${distance} m` : `${(distance / 1000).toFixed(1)} km`;
}

/* The handful of tags worth a line under a selected place, in the order they'd
 * be wanted. Anything not listed here is left out rather than dumped raw: the
 * strip is two lines tall, and "which of these is the useful one" is a judgment
 * this table makes once instead of the reader making it every time. */
const DETAILS: Array<{ tag: string; format: (value: string) => string | null }> = [
  {
    tag: 'dog',
    format: (value) =>
      value === 'yes'
        ? '🐕 Dogs welcome'
        : value === 'leashed'
          ? '🐕 Dogs on a lead'
          : value === 'outside'
            ? '🐕 Dogs outside only'
            : value === 'no'
              ? 'No dogs'
              : null,
  },
  { tag: 'opening_hours', format: (value) => (value === '24/7' ? 'Open 24/7' : value) },
  {
    tag: 'fee',
    format: (value) => (value === 'no' ? 'Free' : value === 'yes' ? 'Fee' : `Fee: ${value}`),
  },
  {
    tag: 'access',
    format: (value) =>
      value === 'yes' || value === 'public'
        ? null
        : value === 'customers'
          ? 'Customers only'
          : `Access: ${value.replace(/_/g, ' ')}`,
  },
  {
    tag: 'wheelchair',
    format: (value) =>
      value === 'no' ? 'No step-free access' : value === 'yes' ? 'Step-free' : null,
  },
  { tag: 'cuisine', format: (value) => value.split(';')[0].replace(/_/g, ' ') },
  { tag: 'capacity', format: (value) => (/^\d+$/.test(value) ? `${value} spaces` : null) },
  { tag: 'covered', format: (value) => (value === 'yes' ? 'Covered' : null) },
  { tag: 'backrest', format: (value) => (value === 'yes' ? 'Backrest' : null) },
  { tag: 'bottle', format: (value) => (value === 'yes' ? 'Bottle filling' : null) },
  { tag: 'seasonal', format: (value) => (value === 'yes' ? 'Seasonal' : null) },
  { tag: 'changing_table', format: (value) => (value === 'yes' ? 'Changing table' : null) },
  {
    tag: 'ele',
    format: (value) => (/^-?\d+(\.\d+)?$/.test(value) ? `${Math.round(Number(value))} m` : null),
  },
  { tag: 'operator', format: (value) => value },
];

const MAX_DETAILS = 3;

function detailsOf(place: Place): string[] {
  const lines: string[] = [];
  for (const { tag, format } of DETAILS) {
    const raw = place.tags[tag];
    if (raw === undefined) continue;
    const text = format(raw);
    if (text !== null && text !== '') lines.push(text);
    if (lines.length === MAX_DETAILS) break;
  }
  return lines;
}

const map: SlippyMap = createMap(mapEl, {
  lat,
  lon,
  // An explicit ?zoom= wins; otherwise fit the queried circle to the map's own
  // width, which is only knowable after layout — hence reading clientWidth here
  // rather than picking a constant.
  zoom: number('zoom', 22) ?? zoomForRadius(mapEl.clientWidth || 360, radius, lat),
  onSelect: (id) => select(id),
  onBackground: () => select(null),
});

let places: Place[] = [];
let categories: Category[] = [];
const rows = new Map<string, HTMLButtonElement>();
const groups = new Map<string, { head: HTMLButtonElement; body: HTMLElement }>();
let selected: string | null = null;
/* One group open at a time. The panel column is twelve rems at Mimir's width
 * and the frame's height is fixed, so several open groups would mean scrolling
 * past categories to reach categories — which is the flat list this replaced. */
let openSlug: string | null = null;

function labelOf(place: Place): string {
  return place.name ?? categories.find((category) => category.slug === place.slug)?.label ?? 'Place';
}

function emojiOf(slug: string): string {
  return categories.find((category) => category.slug === slug)?.emoji ?? '📍';
}

function openGroup(slug: string | null): void {
  openSlug = slug;
  for (const [groupSlug, group] of groups) {
    const open = groupSlug === slug;
    group.head.setAttribute('aria-expanded', String(open));
    group.head.classList.toggle('is-open', open);
    group.body.hidden = !open;
  }
}

function select(id: string | null): void {
  selected = id;
  map.setActive(id);

  const place = places.find((candidate) => candidate.id === id);
  // Selecting a pin on the map has to open the group holding it, or the
  // highlighted row would be inside a collapsed section and read as nothing
  // having happened.
  if (place !== undefined && openSlug !== place.slug) openGroup(place.slug);

  for (const [rowId, row] of rows) row.classList.toggle('is-active', rowId === id);

  if (place === undefined) {
    metaEl.hidden = true;
    metaEl.replaceChildren();
    return;
  }

  const title = document.createElement('div');
  title.className = 'nearby-meta-title';
  title.textContent = `${emojiOf(place.slug)} ${labelOf(place)}`;

  const detail = document.createElement('div');
  detail.className = 'nearby-meta-detail';
  detail.textContent = [metres(place.distance), ...detailsOf(place)].join(' · ');

  metaEl.replaceChildren(title, detail);
  metaEl.hidden = false;

  map.reveal(place.lat, place.lon);
  rows.get(place.id)?.scrollIntoView({ block: 'nearest' });
}

function placeRow(place: Place): HTMLElement {
  const item = document.createElement('li');
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'nearby-item';

  const name = document.createElement('span');
  name.className = 'nearby-item-name';
  name.textContent = labelOf(place);
  name.title = labelOf(place);

  const distance = document.createElement('span');
  distance.className = 'nearby-item-distance';
  distance.textContent = metres(place.distance);

  row.append(name, distance);
  // Only under ?dogs=1: elsewhere a paw on two rows out of sixty is a puzzle
  // rather than a signal, since almost nothing carries the tag either way.
  if (dogs && DOG_WELCOME.includes(place.tags.dog ?? '')) {
    const paw = document.createElement('span');
    paw.className = 'nearby-item-paw';
    paw.textContent = '🐕';
    paw.title = place.tags.dog === 'leashed' ? 'Dogs on a lead' : 'Dogs welcome';
    row.append(paw);
  }
  // Selecting from the list and selecting from the map are the same action, so
  // they run the same function rather than two that drift apart.
  row.addEventListener('click', () => select(selected === place.id ? null : place.id));
  rows.set(place.id, row);
  item.append(row);
  return item;
}

function groupRow(category: Category): HTMLElement {
  const item = document.createElement('li');
  item.className = 'nearby-group';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'nearby-group-head';
  head.setAttribute('aria-expanded', 'false');

  const glyph = document.createElement('span');
  glyph.className = 'nearby-item-glyph';
  glyph.textContent = category.emoji;

  const name = document.createElement('span');
  name.className = 'nearby-item-name';
  name.textContent = category.label;

  const count = document.createElement('span');
  count.className = 'nearby-group-count';
  // The nearest distance, not the tally: standing somewhere, "the closest one
  // is 90 m away" is the answer, and how many there are is a footnote. The
  // tally is still in the tooltip for whoever wants it.
  count.textContent = category.nearest === null ? '—' : metres(category.nearest);
  head.title =
    category.found === 0
      ? `No ${category.label.toLowerCase()} within ${metres(radius)}`
      : category.found > category.count
        ? `${category.count} of ${category.found}${category.capped ? '+' : ''} shown`
        : `${category.found} found`;

  head.append(glyph, name, count);

  const body = document.createElement('ul');
  body.className = 'nearby-sub';
  body.hidden = true;

  const mine = places.filter((place) => place.slug === category.slug);
  if (mine.length === 0) {
    head.disabled = true;
    head.classList.add('is-empty');
  } else {
    body.append(...mine.map(placeRow));
    head.addEventListener('click', () => {
      openGroup(openSlug === category.slug ? null : category.slug);
      // Collapsing the group a selected place lives in would leave a pin
      // highlighted on the map with nothing on the list to match it.
      if (openSlug !== category.slug && selected !== null) {
        const place = places.find((candidate) => candidate.id === selected);
        if (place?.slug === category.slug) select(null);
      }
    });
  }

  groups.set(category.slug, { head, body });
  item.append(head, body);
  return item;
}

function renderGroups(): void {
  rows.clear();
  groups.clear();
  listEl.replaceChildren(...categories.map(groupRow));
  // Opening the nearest non-empty category by default: an all-collapsed panel
  // beside a map full of pins reads as a list that failed to load.
  const first = categories.find((category) => category.count > 0);
  openGroup(first?.slug ?? null);
}

function status(text: string, retry: boolean): void {
  const item = document.createElement('li');
  item.className = 'nearby-status';
  item.textContent = text;
  if (retry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nearby-retry';
    button.textContent = 'Retry';
    button.addEventListener('click', () => void load());
    item.append(button);
  }
  listEl.replaceChildren(item);
}

/*
 * Where the current answer is measured from. It starts at the URL's coordinate
 * and a "look around here" moves it — but only in memory: nothing is written to
 * the address bar or to storage, so the parameters stay the source of truth and
 * a reload (or anyone else opening the same note) lands back at the original
 * point. That's the whole contract of the button: flexibility while you're
 * looking, not a change to what the link means.
 */
let origin = { lat, lon };

function movedAway(): boolean {
  return origin.lat !== lat || origin.lon !== lon;
}

function query(): string {
  const search = new URLSearchParams({
    lat: String(origin.lat),
    lon: String(origin.lon),
    radius: String(radius),
  });
  const amenities = params.get('amenities')?.trim();
  if (amenities !== undefined && amenities !== '') search.set('amenities', amenities);
  if (dogs) search.set('dogs', '1');
  return `/api/nearby?${search.toString()}`;
}

let busy = false;

function setBusy(next: boolean): void {
  busy = next;
  searchEl.disabled = next;
  resetEl.disabled = next;
  searchEl.textContent = next ? 'Looking…' : 'Look around here';
  resetEl.hidden = !movedAway();
  resetEl.title = `Back to ${headBase}`;
}

/* Both buttons re-query, differing only in where they point the origin — so
 * they share one path rather than being two nearly-identical handlers. */
function lookAround(next: { lat: number; lon: number }, recentre: boolean): void {
  if (busy) return;
  origin = next;
  map.setOrigin(origin.lat, origin.lon);
  if (recentre) map.panTo(origin.lat, origin.lon);
  // The old selection belongs to the old origin; its distance was measured from
  // a point that is no longer the point.
  select(null);
  void load();
}

searchEl.addEventListener('click', () => lookAround(map.centre(), false));
resetEl.addEventListener('click', () => lookAround({ lat, lon }, true));

async function load(): Promise<void> {
  setBusy(true);
  status('Looking around…', false);
  headEl.textContent = headBase;
  let truncated = false;
  try {
    const response = await fetch(query());
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const answer = (await response.json()) as Answer;
    places = answer.places;
    categories = answer.categories;
    truncated = answer.truncated;
  } catch {
    // The map is already drawn and stays usable: every Overpass instance being
    // down costs the list, not the widget.
    status("Couldn't reach OpenStreetMap.", true);
    map.setMarkers([]);
    return;
  } finally {
    // Cleared here rather than only on the happy path: a failed look-around
    // that left the button reading "Looking…" for good would be worse than the
    // failure it's reporting.
    setBusy(false);
  }

  if (places.length === 0) {
    status('Nothing mapped within this radius.', false);
    map.setMarkers([]);
    return;
  }

  // The count earns its place in a narrow column: "60+" is how you know the
  // list was cut rather than that this is everything within the radius.
  headEl.textContent = `${headBase} · ${places.length}${truncated ? '+' : ''}`;
  renderGroups();
  map.setMarkers(
    places.map((place) => ({
      id: place.id,
      lat: place.lat,
      lon: place.lon,
      emoji: emojiOf(place.slug),
      title: `${labelOf(place)} · ${metres(place.distance)}`,
    })),
  );
}

void load();

export {};
