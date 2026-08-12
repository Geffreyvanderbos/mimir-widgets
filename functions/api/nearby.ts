/*
 * Overpass lookup for the /nearby widget: `/api/nearby?lat=&lon=&radius=&amenities=`
 * → a distance-sorted list of nearby places, already normalised.
 *
 * Why this runs here rather than in the browser, given Overpass sends CORS `*`:
 *
 * 1. Privacy, for the same reason the hike widget proxies its tiles (see
 *    CLAUDE.md). This widget's entire payload is *where someone is standing*,
 *    and a direct query would hand that coordinate plus the IP of every viewer
 *    of the note to whichever volunteer-run instance answered.
 * 2. The fallback chain only works from here. Public instances differ in which
 *    origins and methods they allow, so a browser-side retry loop can't tell
 *    "instance is down" from "instance refused the preflight" — and a failed
 *    preflight isn't retryable in a way the page can see.
 * 3. The client never composes Overpass QL. It sends a coordinate and a list of
 *    slugs; this function looks those slugs up in a fixed table and builds the
 *    query itself, so nothing user-supplied is ever interpolated into QL.
 *
 * GET with ?data=, deliberately, not POST: only a GET is edge-cacheable, and
 * `cacheEverything` is what keeps a popular note from hitting Overpass at all.
 */

/*
 * slug → the OSM tag it means, and the icon and label it's shown under.
 *
 * Keyed rather than assuming `amenity=<slug>`: the defaults all happen to be
 * amenities, but viewpoints are tourism=, playgrounds are leisure= and
 * supermarkets are shop=.
 *
 * The icon lives here, with the query, and travels back in the response — the
 * whole table is one object because the card has two places that draw a
 * category (a map pin and an accordion header) and a third that names it, and
 * an icon defined twice is an icon that eventually disagrees with itself.
 */
interface Amenity {
  key: string;
  value: string;
  emoji: string;
  label: string;
  /* Matches the value inside a semicolon list rather than as the whole tag. A
   * bin that takes both litter and dog waste is tagged `waste=trash;dog_excrement`,
   * and an exact match would miss every one of them. */
  loose?: boolean;
}

const AMENITIES: Record<string, Amenity> = {
  drinking_water: { key: 'amenity', value: 'drinking_water', emoji: '💧', label: 'Water' },
  toilets: { key: 'amenity', value: 'toilets', emoji: '🚻', label: 'Toilet' },
  bench: { key: 'amenity', value: 'bench', emoji: '🪑', label: 'Bench' },
  cafe: { key: 'amenity', value: 'cafe', emoji: '☕', label: 'Café' },
  parking: { key: 'amenity', value: 'parking', emoji: '🅿️', label: 'Parking' },
  restaurant: { key: 'amenity', value: 'restaurant', emoji: '🍽️', label: 'Restaurant' },
  fast_food: { key: 'amenity', value: 'fast_food', emoji: '🍔', label: 'Fast food' },
  bar: { key: 'amenity', value: 'bar', emoji: '🍸', label: 'Bar' },
  pub: { key: 'amenity', value: 'pub', emoji: '🍺', label: 'Pub' },
  ice_cream: { key: 'amenity', value: 'ice_cream', emoji: '🍦', label: 'Ice cream' },
  pharmacy: { key: 'amenity', value: 'pharmacy', emoji: '💊', label: 'Pharmacy' },
  hospital: { key: 'amenity', value: 'hospital', emoji: '🏥', label: 'Hospital' },
  atm: { key: 'amenity', value: 'atm', emoji: '🏧', label: 'ATM' },
  bank: { key: 'amenity', value: 'bank', emoji: '🏦', label: 'Bank' },
  post_box: { key: 'amenity', value: 'post_box', emoji: '📮', label: 'Post box' },
  fuel: { key: 'amenity', value: 'fuel', emoji: '⛽', label: 'Fuel' },
  charging_station: { key: 'amenity', value: 'charging_station', emoji: '🔌', label: 'Charger' },
  bicycle_parking: { key: 'amenity', value: 'bicycle_parking', emoji: '🚲', label: 'Bike parking' },
  bicycle_repair_station: {
    key: 'amenity',
    value: 'bicycle_repair_station',
    emoji: '🔧',
    label: 'Bike repair',
  },
  shelter: { key: 'amenity', value: 'shelter', emoji: '⛺', label: 'Shelter' },
  waste_basket: { key: 'amenity', value: 'waste_basket', emoji: '🗑️', label: 'Bin' },
  fountain: { key: 'amenity', value: 'fountain', emoji: '⛲', label: 'Fountain' },
  library: { key: 'amenity', value: 'library', emoji: '📚', label: 'Library' },
  museum: { key: 'tourism', value: 'museum', emoji: '🏛️', label: 'Museum' },
  viewpoint: { key: 'tourism', value: 'viewpoint', emoji: '🔭', label: 'Viewpoint' },
  picnic_table: { key: 'leisure', value: 'picnic_table', emoji: '🧺', label: 'Picnic table' },
  playground: { key: 'leisure', value: 'playground', emoji: '🛝', label: 'Playground' },
  park: { key: 'leisure', value: 'park', emoji: '🌳', label: 'Park' },
  supermarket: { key: 'shop', value: 'supermarket', emoji: '🛒', label: 'Supermarket' },
  bakery: { key: 'shop', value: 'bakery', emoji: '🥐', label: 'Bakery' },
  convenience: { key: 'shop', value: 'convenience', emoji: '🏪', label: 'Shop' },
  bus_stop: { key: 'highway', value: 'bus_stop', emoji: '🚌', label: 'Bus stop' },
  station: { key: 'railway', value: 'station', emoji: '🚉', label: 'Station' },
  spring: { key: 'natural', value: 'spring', emoji: '🌀', label: 'Spring' },
  peak: { key: 'natural', value: 'peak', emoji: '⛰️', label: 'Peak' },
  // The paw print on the standard OSM basemap is `leisure=dog_park`. The rest
  // of this block is what else is mapped for a dog — `vending=excrement_bags`
  // is the surprise, better mapped worldwide than dog parks themselves.
  dog_park: { key: 'leisure', value: 'dog_park', emoji: '🐕', label: 'Dog park' },
  dog_toilet: { key: 'amenity', value: 'dog_toilet', emoji: '🐾', label: 'Dog toilet' },
  dog_waste: { key: 'waste', value: 'dog_excrement', emoji: '💩', label: 'Dog bin', loose: true },
  dog_bags: { key: 'vending', value: 'excrement_bags', emoji: '🛍️', label: 'Poop bags' },
  veterinary: { key: 'amenity', value: 'veterinary', emoji: '🩺', label: 'Vet' },
  pet: { key: 'shop', value: 'pet', emoji: '🦴', label: 'Pet shop' },
  pet_grooming: { key: 'shop', value: 'pet_grooming', emoji: '✂️', label: 'Grooming' },
  animal_shelter: { key: 'amenity', value: 'animal_shelter', emoji: '🏠', label: 'Shelter' },
};

const DEFAULT_AMENITIES = ['drinking_water', 'toilets', 'bench', 'cafe', 'parking'];

/* An unbounded radius is a guaranteed Overpass timeout rather than a bigger
 * answer, and the widget's map can't usefully show more than a few km anyway. */
const MIN_RADIUS = 100;
const MAX_RADIUS = 5000;
const DEFAULT_RADIUS = 1500;

/* Overpass returns hundreds of benches for an urban kilometre. The list is
 * distance-sorted before this cut, so what's dropped is always the far end. */
const MAX_PLACES = 60;

/*
 * Asked for from Overpass per category, not across the query as a whole.
 *
 * This matters because Overpass's own cut is by internal id, not by distance:
 * one shared limit over `radius=5000` in a city centre is spent on benches long
 * before the parser reaches the cafés, and a category cut off upstream can't be
 * recovered by any amount of sorting down here. A limit per category costs one
 * `out` statement each and makes the worst case "the far end of one category
 * was trimmed" rather than "one category vanished".
 */
const PER_CATEGORY_LIMIT = 150;

/*
 * Tried in order. Each gets its own timeout: without one, a single hung
 * instance eats the whole request budget and the rest of this list never runs.
 *
 * Every entry must be a *global* instance. A regional extract is the one
 * failure this chain cannot detect — overpass.osm.ch answers a query in the
 * Netherlands with a cheerful `200` and zero elements, which is indistinguishable
 * from "nothing is mapped near here", so it would end the chain with an empty
 * list rather than falling through to an instance that has the data.
 *
 * overpass.kumi.systems is deliberately absent: it is a CNAME onto
 * private.coffee, so listing both would be the same machine twice wearing a
 * different name — a fallback that fails at exactly the same moment as the one
 * before it isn't a fallback.
 *
 * The order is measured, not alphabetical: openstreetmap.fr answered this
 * widget's own query in under a second, where overpass-api.de — the busiest
 * instance there is, and the one the OSM community asks people to spare — took
 * eight seconds once and timed out entirely on the next try. The reference
 * instance stays in the list, just not as the one every embed hits first.
 */
const INSTANCES = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/* Generous, because what's usually being waited on is the instance's *queue*,
 * not the query — overpass-api.de under load takes seconds before it starts
 * running anything, and the query timeout below doesn't cover that wait. */
const ATTEMPT_TIMEOUT_MS = 10_000;

/* And a ceiling on the whole chain, so three slow instances in a row can't add
 * up to a request the browser has long since given up on. */
const TOTAL_BUDGET_MS = 25_000;

/* Overpass's own budget, kept under the per-attempt abort so a slow query comes
 * back as an error we can fall through on rather than as a dropped connection. */
const QUERY_TIMEOUT_S = 8;

/* OSM's API usage policy wants a User-Agent that identifies the app and offers
 * a way to make contact; the same one the tile proxy sends. */
const USER_AGENT = 'mimir-widgets/0.1 (+https://github.com/Geffreyvanderbos/mimir-widgets)';

const CACHE_SECONDS = 60 * 30;

/* The tags worth showing under a selected place, and nothing else. Passing the
 * whole tag set through would triple the response for data the card has no room
 * for — and some of it (operator contact details, survey notes) is noise. */
const KEPT_TAGS = [
  'dog',
  'opening_hours',
  'fee',
  'access',
  'wheelchair',
  'cuisine',
  'capacity',
  'covered',
  'indoor',
  'backrest',
  'seasonal',
  'drinking_water',
  'bottle',
  'changing_table',
  'operator',
  'brand',
  'parking',
  'surface',
  'shelter',
  'ele',
  'network',
  'description',
];

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface Category {
  slug: string;
  emoji: string;
  label: string;
  count: number;
  found: number;
  capped: boolean;
  nearest: number | null;
}

interface Place {
  id: string;
  slug: string;
  name: string | null;
  lat: number;
  lon: number;
  distance: number;
  tags: Record<string, string>;
}

function coordinate(value: string | null, limit: number): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > limit) return undefined;
  return parsed;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/* Metres between two coordinates on a sphere. Good to a few parts in a thousand
 * at these distances, which is well inside the rounding the card displays. */
function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/*
 * What `?amenities=` may say. Two forms, both resolving to the same shape:
 *
 *   cafe                     a slug from the table above — nice icon, real label
 *   leisure=fitness_station  any OSM tag at all, spelled key=value
 *
 * The freeform form is what stops the table being a ceiling: OpenStreetMap has
 * thousands of tags and this file will never list them, so anything the map
 * knows about is reachable without a deploy. It costs a generic pin and a label
 * derived from the value, which is the trade for not having to be predicted.
 *
 * Safety here is *not* the allowlist — it's the charset. OSM keys and values are
 * lowercase-ish identifiers, and this accepts only those, so a quote, a bracket,
 * a semicolon or a backslash can't survive to reach the query. Anything that
 * doesn't match is dropped, not escaped: there is no legitimate tag that needs
 * escaping, so a value that would need it is a value being used for something
 * other than a tag.
 */
const KEY_PATTERN = /^[a-z][a-z0-9_:]{0,29}$/;
const VALUE_PATTERN = /^[a-z0-9][a-z0-9_:.-]{0,49}$/;

/* One `out` statement each, and each one is real work for a volunteer-run
 * server. A URL asking for thirty categories is a URL misusing someone else's
 * hardware, whoever wrote it. */
const MAX_CATEGORIES = 8;

interface Spec {
  /** How the category is identified in the response, and grouped in the card. */
  slug: string;
  key: string;
  value: string;
  emoji: string;
  label: string;
  loose?: boolean;
}

/* `fitness_station` → `Fitness station`. Not clever, and it doesn't need to be:
 * OSM values are snake_case English, which is one substitution away from a
 * label — and a wrong-but-readable label beats a raw tag in a 12rem column. */
function humanise(value: string): string {
  const spaced = value.replace(/[_:.-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function resolve(raw: string): Spec | undefined {
  const known = AMENITIES[raw];
  if (known !== undefined) return { slug: raw, ...known };

  const [key, ...rest] = raw.split('=');
  const value = rest.join('=');
  if (rest.length !== 1 || !KEY_PATTERN.test(key) || !VALUE_PATTERN.test(value)) return undefined;
  return { slug: raw, key, value, emoji: '📍', label: humanise(value) };
}

function requestedSpecs(raw: string | null): Spec[] {
  if (raw === null || raw.trim() === '') {
    return DEFAULT_AMENITIES.map((slug) => resolve(slug)!);
  }
  const asked = raw.split(',').map((entry) => entry.trim().toLowerCase());
  // Deduped so `?amenities=cafe,cafe` doesn't ask Overpass the same thing twice
  // and then render every café twice.
  const specs = [...new Set(asked)]
    .map(resolve)
    .filter((spec): spec is Spec => spec !== undefined)
    .slice(0, MAX_CATEGORIES);
  return specs.length > 0 ? specs : DEFAULT_AMENITIES.map((slug) => resolve(slug)!);
}

/*
 * `?dogs=1`. Measured before it was built, and the measurement changed it.
 *
 * `dog=*` reads like a venue policy but isn't one: it co-occurs with `highway`
 * 120k times against 18.7k with `leisure`, sitting beside `foot`, `bicycle` and
 * `horse` — it is an access tag for *paths*. On places to sit down it is
 * essentially unmapped: of the eateries within 2 km of the centre, Arnhem has 0
 * of 240 tagged, Amsterdam 1 of 1880 (and that one is a `no`), Berlin 4 of 1209.
 *
 * So the obvious version — "show only cafés that take dogs" — returns an empty
 * card in most of the world, which reads as a broken widget rather than as an
 * unmapped one. This does the two things the data does support: drop the places
 * that have said no, and float the ones that have said yes to the top of their
 * category. Everything untagged stays, because unknown is not a refusal.
 */
const DOG_WELCOME = new Set(['yes', 'leashed', 'outside']);

function dogFriendly(place: Place): boolean {
  return DOG_WELCOME.has(place.tags.dog ?? '');
}

function buildQuery(lat: number, lon: number, radius: number, specs: Spec[], dogs: boolean): string {
  const around = `around:${radius},${lat},${lon}`;
  // Negation also matches elements carrying no `dog` tag at all, which is the
  // wanted behaviour: only an explicit refusal is excluded.
  const dogFilter = dogs ? '["dog"!="no"]' : '';
  // One query statement and its own `out` per category — see PER_CATEGORY_LIMIT.
  // `nwr` rather than `node`: parking lots, most cafés and every park are ways
  // or relations, so a node-only query silently loses most of them. `out center`
  // prints tags plus, for ways and relations, a single representative point,
  // which is all a marker needs.
  const clauses = specs
    .map(({ key, value, loose }) => {
      const filter = loose === true ? `["${key}"~"${value}"]` : `["${key}"="${value}"]`;
      return `nwr${filter}${dogFilter}(${around});\nout center ${PER_CATEGORY_LIMIT};`;
    })
    .join('\n');
  return `[out:json][timeout:${QUERY_TIMEOUT_S}];\n${clauses}`;
}

/* Which of the requested categories an element actually matched. An element can
 * match more than one (a café inside a park), so the first requested one wins
 * — the order the caller asked in is the order they care about. */
function slugOf(element: OverpassElement, specs: Spec[]): string | undefined {
  const tags = element.tags ?? {};
  return specs.find(({ key, value, loose }) => {
    const actual = tags[key];
    if (actual === undefined) return false;
    return loose === true ? actual.split(';').includes(value) : actual === value;
  })?.slug;
}

function toPlace(
  element: OverpassElement,
  specs: Spec[],
  lat: number,
  lon: number,
): Place | undefined {
  const point = element.center ?? (element.lat !== undefined ? { lat: element.lat, lon: element.lon! } : undefined);
  if (point === undefined) return undefined;

  const slug = slugOf(element, specs);
  if (slug === undefined) return undefined;

  const tags = element.tags ?? {};
  const kept: Record<string, string> = {};
  for (const key of KEPT_TAGS) {
    const value = tags[key];
    // Long free text is a note to mappers, not a caption — the card shows one
    // short line and would be truncating anything past this anyway.
    if (typeof value === 'string' && value.length > 0 && value.length <= 120) {
      kept[key] = value;
    }
  }

  return {
    id: `${element.type}/${element.id}`,
    slug,
    name: tags.name ?? null,
    lat: point.lat,
    lon: point.lon,
    distance: Math.round(haversine(lat, lon, point.lat, point.lon)),
    tags: kept,
  };
}

/*
 * Takes the nearest `limit` places, but a round at a time across the categories
 * rather than straight off the top of the distance sort.
 *
 * Measured, not guessed: a plain nearest-60 for the default set in a park came
 * back as 50 benches, 5 parking, 2 water, 2 cafés, 1 toilet — because a city
 * maps benches by the dozen, so a bench is almost always nearer than the toilet
 * you were actually looking for. Interleaving means the nearest of *each* thing
 * asked for is on screen, and the leftover capacity still fills with whatever
 * is closest once the thinner categories run dry.
 */
function balance(sorted: Place[], limit: number): Place[] {
  const queues = new Map<string, Place[]>();
  for (const place of sorted) {
    const queue = queues.get(place.slug);
    if (queue === undefined) queues.set(place.slug, [place]);
    else queue.push(place);
  }

  const picked: Place[] = [];
  let drained = false;
  while (picked.length < limit && !drained) {
    drained = true;
    for (const queue of queues.values()) {
      const next = queue.shift();
      if (next === undefined) continue;
      picked.push(next);
      drained = false;
      if (picked.length === limit) break;
    }
  }

  // Returned in the order it was handed, not re-sorted: the caller's comparator
  // is the one that knows whether distance is the only thing that ranks a place.
  return picked;
}

/*
 * One entry per category that was *asked for*, including the ones nothing was
 * found in — an accordion has to be able to say "Toilet — none within 1.5 km",
 * which is a different and more useful answer than the row silently not being
 * there at all.
 *
 * Ordered by how near the closest one is, empties last: the thing you can reach
 * soonest is the row your thumb lands on first.
 */
function categorise(specs: Spec[], all: Place[], shown: Place[]): Category[] {
  return specs
    .map(({ slug, emoji, label }) => {
      const nearby = all.filter((place) => place.slug === slug);
      return {
        slug,
        emoji,
        label,
        // `count` is how many rows the accordion will hold; `found` is how many
        // exist inside the radius. They differ once the balance cut bites, and
        // conflating them would make the header lie about the list under it.
        count: shown.filter((place) => place.slug === slug).length,
        found: nearby.length,
        // `found` is only what Overpass was asked to return. A category that
        // came back at exactly its cap almost certainly has more behind it, and
        // saying "150" flat would be a number the card can't stand behind.
        capped: nearby.length >= PER_CATEGORY_LIMIT,
        // A minimum, not the first element: with ?dogs=1 the list is ranked by
        // welcome before distance, so the head of it need not be the closest.
        nearest: nearby.length > 0 ? Math.min(...nearby.map((place) => place.distance)) : null,
      };
    })
    .sort((a, b) => (a.nearest ?? Infinity) - (b.nearest ?? Infinity));
}

async function askOverpass(query: string): Promise<{ elements: OverpassElement[]; instance: string }> {
  const failures: string[] = [];
  const started = Date.now();

  for (const endpoint of INSTANCES) {
    const host = new URL(endpoint).host;
    const left = TOTAL_BUDGET_MS - (Date.now() - started);
    if (left < 1000) {
      failures.push(`${host}: skipped, out of budget`);
      break;
    }
    try {
      const response = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, left)),
        // Edge-cached so a note that several people open only costs Overpass
        // one query. The key is the full URL, so it's per lat/lon/radius/slugs.
        cf: { cacheEverything: true, cacheTtl: CACHE_SECONDS },
      });

      if (!response.ok) {
        // 429 (over quota) and 504 (query timed out) are exactly the cases the
        // next instance may well answer, so they're not terminal.
        failures.push(`${host}: ${response.status}`);
        continue;
      }

      const payload = (await response.json()) as { elements?: OverpassElement[] };
      if (!Array.isArray(payload.elements)) {
        failures.push(`${host}: malformed`);
        continue;
      }
      return { elements: payload.elements, instance: host };
    } catch (error) {
      failures.push(`${host}: ${error instanceof Error ? error.name : 'error'}`);
    }
  }

  throw new Error(failures.join('; '));
}

export const onRequest: PagesFunction = async (context) => {
  const { request } = context;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const url = new URL(request.url);

  // `/api/nearby?catalog=1` lists the named slugs `?amenities=` accepts. They
  // are a shorthand, not the limit — any `key=value` OSM tag works too — but
  // without this the shorthand exists only in this file, where nobody writing a
  // widget URL or an Apple Shortcut will find it.
  if (url.searchParams.has('catalog')) {
    return json(
      {
        defaults: DEFAULT_AMENITIES,
        freeform: 'Any OSM tag as key=value, e.g. leisure=fitness_station',
        maxCategories: MAX_CATEGORIES,
        amenities: Object.entries(AMENITIES).map(([slug, { emoji, label, key, value }]) => ({
          slug,
          emoji,
          label,
          tag: `${key}=${value}`,
        })),
      },
      200,
    );
  }

  const lat = coordinate(url.searchParams.get('lat'), 90);
  const lon = coordinate(url.searchParams.get('lon'), 180);
  if (lat === undefined || lon === undefined) {
    return json({ error: 'lat and lon are required' }, 400);
  }

  const radius = clamp(
    Math.round(Number(url.searchParams.get('radius'))) || DEFAULT_RADIUS,
    MIN_RADIUS,
    MAX_RADIUS,
  );
  const specs = requestedSpecs(url.searchParams.get('amenities'));
  const dogs = ['1', 'true', 'yes'].includes(url.searchParams.get('dogs') ?? '');

  let elements: OverpassElement[];
  let instance: string;
  try {
    ({ elements, instance } = await askOverpass(buildQuery(lat, lon, radius, specs, dogs)));
  } catch (error) {
    // 502 rather than 500: every instance in the chain refused or timed out,
    // which is an upstream condition and not this function's own failure.
    return json({ error: 'No Overpass instance answered', detail: String(error) }, 502);
  }

  const seen = new Set<string>();
  const places: Place[] = [];
  for (const element of elements) {
    const place = toPlace(element, specs, lat, lon);
    // Overpass can return the same feature twice when it matches two clauses.
    if (place === undefined || seen.has(place.id)) continue;
    seen.add(place.id);
    places.push(place);
  }
  // With ?dogs=1 the ones that have said yes come first, then everything
  // untagged, each group by distance — so a confirmed welcome outranks a nearer
  // unknown, without the unknowns disappearing.
  const order = (a: Place, b: Place): number =>
    (dogs ? Number(dogFriendly(b)) - Number(dogFriendly(a)) : 0) || a.distance - b.distance;
  places.sort(order);
  // Sorted again after the balance cut, because balance interleaves categories
  // and hands them back in pick order.
  const shown = balance(places, MAX_PLACES).sort(order);

  return json(
    {
      instance,
      radius,
      dogs,
      dogFriendly: dogs ? shown.filter(dogFriendly).length : 0,
      truncated: places.length > shown.length,
      categories: categorise(specs, places, shown),
      places: shown,
    },
    200,
  );
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // Errors stay uncached so a passing outage doesn't stick to the note for
      // half an hour after the instances recover.
      'cache-control': status === 200 ? `public, max-age=${CACHE_SECONDS}` : 'no-store',
    },
  });
}
