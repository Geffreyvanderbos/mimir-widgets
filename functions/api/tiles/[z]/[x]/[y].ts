/*
 * Basemap tile proxy for the /hike widget: `/api/tiles/{z}/{x}/{y}` → the
 * standard OpenStreetMap raster tile.
 *
 * Why proxy at all, rather than pointing <img src> straight at
 * tile.openstreetmap.org? Because the hike widget is the privacy-oriented one.
 * A direct tile URL leaks two things to a third party: the bounding box of
 * where you walked (from which tiles get requested), and the IP address of
 * every person who ever opens the note it's embedded in. Going through this
 * function, the only client the tile server ever sees is Cloudflare — and
 * because the responses are edge-cached, most views don't reach it at all.
 *
 * Swapping providers later is a one-line change here, and a keyed provider's
 * token would stay server-side rather than being baked into a widget URL.
 */

const TILE_ORIGIN = 'https://tile.openstreetmap.org';

/* The union of what the map widgets ask for, not any one widget's own limit:
 * src/hike-map.ts stops at 17 (a static picture of a route needs no more),
 * src/nearby-map.ts at 18 (a map you can zoom in on wants to reach street
 * level). Bounding the zoom (and the x/y range below) is what stops this being
 * an open image proxy for arbitrary paths. */
const MAX_ZOOM = 18;

const CACHE_SECONDS = 60 * 60 * 24 * 30;

/* OSM's tile usage policy requires a User-Agent that identifies the app and
 * offers a way to get in touch. A generic or absent one gets blocked. */
const USER_AGENT = 'mimir-widgets/0.1 (+https://github.com/Geffreyvanderbos/mimir-widgets)';

function parseTileIndex(value: string | string[] | undefined): number | undefined {
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

export const onRequest: PagesFunction = async (context) => {
  const { request, params } = context;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const zoom = parseTileIndex(params.z);
  const x = parseTileIndex(params.x);
  const y = parseTileIndex(params.y);

  if (zoom === undefined || x === undefined || y === undefined) {
    return new Response('Bad tile coordinates', { status: 400 });
  }
  if (zoom > MAX_ZOOM) {
    return new Response('Zoom out of range', { status: 400 });
  }
  const limit = 2 ** zoom;
  if (x >= limit || y >= limit) {
    return new Response('Tile out of range', { status: 404 });
  }

  const upstream = await fetch(`${TILE_ORIGIN}/${zoom}/${x}/${y}.png`, {
    headers: { 'user-agent': USER_AGENT, accept: 'image/png,image/*;q=0.8' },
    // Cache at the edge so a popular note doesn't re-fetch the same tiles.
    cf: { cacheEverything: true, cacheTtl: CACHE_SECONDS },
  });

  if (!upstream.ok) {
    return new Response('Tile unavailable', { status: 502 });
  }

  // A fresh Response with an explicit header set, rather than passing the
  // upstream one through — no upstream cookies or tracking headers reach the
  // browser this way.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'image/png',
      'cache-control': `public, max-age=${CACHE_SECONDS}, immutable`,
      'x-content-type-options': 'nosniff',
    },
  });
};
