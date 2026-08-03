/*
 * A static slippy-map render with no map library: project the track to Web
 * Mercator, pick the highest zoom whose bounding box still fits the viewport,
 * lay the covering tiles out absolutely, and stroke the track over them as
 * SVG. Leaflet would be ~40 kB to do panning and zooming this widget doesn't
 * want — the embed is a fixed-height picture of one hike, not a map you drive.
 *
 * Tiles come from `/api/tiles/...` on this same origin, never straight from
 * OpenStreetMap. That indirection is the privacy-relevant part: a direct tile
 * URL would tell a third party the bounding box of the hike *and* the IP of
 * everyone who ever views the note. Proxied, the only address the tile server
 * sees is Cloudflare's.
 */

import type { LatLon } from './hike-codec';

const TILE_SIZE = 256;

/* z17 is ~1.2 m/px — past the point where more zoom shows more hike, and it
 * keeps the tile count (and so the proxy's fan-out) in single digits. */
const MAX_ZOOM = 17;

/* Keeps the track's extremes off the frame edge, and leaves the stroke's own
 * width room so a corner point isn't clipped in half. */
const PADDING_PX = 22;

const SVG_NS = 'http://www.w3.org/2000/svg';

const MERCATOR_LAT_LIMIT = 85.05112878;

interface Point {
  x: number;
  y: number;
}

/* Web Mercator, normalised to 0..1 over the whole world — multiply by
 * TILE_SIZE * 2^zoom for pixel coordinates at that zoom. */
function project({ lat, lon }: LatLon): Point {
  const clamped = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, lat));
  const sin = Math.sin((clamped * Math.PI) / 180);
  return {
    x: (lon + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI),
  };
}

function niceScaleLength(metres: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(metres));
  for (const step of [1, 2, 5]) {
    if (metres < step * magnitude) {
      return step * magnitude;
    }
  }
  return 10 * magnitude;
}

function formatScale(metres: number): string {
  return metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
}

function tileLayer(zoom: number, originX: number, originY: number, width: number, height: number): HTMLElement {
  const layer = document.createElement('div');
  layer.className = 'hike-tiles';

  const tileCount = 2 ** zoom;
  const firstX = Math.floor(originX / TILE_SIZE);
  const lastX = Math.floor((originX + width) / TILE_SIZE);
  const firstY = Math.floor(originY / TILE_SIZE);
  const lastY = Math.floor((originY + height) / TILE_SIZE);

  for (let ty = firstY; ty <= lastY; ty++) {
    if (ty < 0 || ty >= tileCount) {
      continue; // Above the north pole / below the south pole: nothing to draw.
    }
    for (let tx = firstX; tx <= lastX; tx++) {
      const wrappedX = ((tx % tileCount) + tileCount) % tileCount;
      const image = document.createElement('img');
      image.className = 'hike-tile';
      image.src = `/api/tiles/${zoom}/${wrappedX}/${ty}`;
      image.alt = '';
      image.decoding = 'async';
      image.style.left = `${tx * TILE_SIZE - originX}px`;
      image.style.top = `${ty * TILE_SIZE - originY}px`;
      layer.append(image);
    }
  }

  return layer;
}

function trackOverlay(projected: Point[], worldSize: number, originX: number, originY: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'hike-track');

  const coordinates = projected
    .map((point) => `${(point.x * worldSize - originX).toFixed(1)},${(point.y * worldSize - originY).toFixed(1)}`)
    .join(' ');

  // Two strokes, same geometry: a light halo underneath so the route stays
  // legible crossing a dark forest or a road of the same colour.
  for (const className of ['hike-track-halo', 'hike-track-line']) {
    const polyline = document.createElementNS(SVG_NS, 'polyline');
    polyline.setAttribute('class', className);
    polyline.setAttribute('points', coordinates);
    svg.append(polyline);
  }

  const ends: Array<[Point, string]> = [
    [projected[0], 'hike-track-start'],
    [projected[projected.length - 1], 'hike-track-end'],
  ];
  for (const [point, className] of ends) {
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('class', className);
    circle.setAttribute('cx', (point.x * worldSize - originX).toFixed(1));
    circle.setAttribute('cy', (point.y * worldSize - originY).toFixed(1));
    circle.setAttribute('r', '4.5');
    svg.append(circle);
  }

  return svg;
}

function scaleBar(zoom: number, latitude: number): HTMLElement {
  /* Ground resolution of Web Mercator at this latitude and zoom. */
  const metresPerPixel = (156_543.033_92 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
  const metres = niceScaleLength(70 * metresPerPixel);

  const bar = document.createElement('div');
  bar.className = 'hike-scale';
  bar.style.width = `${Math.round(metres / metresPerPixel)}px`;
  bar.textContent = formatScale(metres);
  return bar;
}

function attribution(): HTMLElement {
  const credit = document.createElement('div');
  credit.className = 'hike-attribution';
  const link = document.createElement('a');
  link.href = 'https://www.openstreetmap.org/copyright';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'OpenStreetMap';
  credit.append('© ', link);
  return credit;
}

function message(root: HTMLElement, text: string): void {
  const notice = document.createElement('p');
  notice.className = 'hike-message';
  notice.textContent = text;
  root.replaceChildren(notice);
}

/*
 * Draws `points` into `root`, sizing itself to root's *current* box. The embed
 * is fluid-width (SKILL.md §4), so the fitted zoom isn't knowable until layout
 * has happened — call this on load and again when the width actually changes.
 */
export function drawTrackMap(root: HTMLElement, points: LatLon[]): void {
  const width = root.clientWidth;
  const height = root.clientHeight;
  if (width === 0 || height === 0) {
    return;
  }
  if (points.length < 2) {
    message(root, 'No track to show.');
    return;
  }

  const projected = points.map(project);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const { x, y } of projected) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  /* An out-and-back on the same line has zero span in one axis; the epsilon
   * keeps the zoom fit from dividing by it. */
  const spanX = Math.max(maxX - minX, 1e-9);
  const spanY = Math.max(maxY - minY, 1e-9);
  const usableWidth = Math.max(width - PADDING_PX * 2, 1);
  const usableHeight = Math.max(height - PADDING_PX * 2, 1);
  const fitted = Math.log2(
    Math.min(usableWidth / (spanX * TILE_SIZE), usableHeight / (spanY * TILE_SIZE)),
  );
  const zoom = Math.max(0, Math.min(MAX_ZOOM, Math.floor(fitted)));

  const worldSize = TILE_SIZE * 2 ** zoom;
  const originX = ((minX + maxX) / 2) * worldSize - width / 2;
  const originY = ((minY + maxY) / 2) * worldSize - height / 2;

  const centreLatitude = points.reduce((sum, point) => sum + point.lat, 0) / points.length;

  root.replaceChildren(
    tileLayer(zoom, originX, originY, width, height),
    trackOverlay(projected, worldSize, originX, originY),
    scaleBar(zoom, centreLatitude),
    attribution(),
  );
}

/*
 * Redraws on width changes only. ResizeObserver fires far more often than the
 * layout meaningfully changes, and every redraw rebuilds the <img> elements —
 * cheap on a warm cache, but a visible flicker if done on every pixel.
 */
export function drawTrackMapResponsively(root: HTMLElement, points: LatLon[]): void {
  let lastWidth = -1;
  let lastHeight = -1;

  const redraw = () => {
    const width = root.clientWidth;
    const height = root.clientHeight;
    if (Math.abs(width - lastWidth) < 4 && Math.abs(height - lastHeight) < 4) {
      return;
    }
    lastWidth = width;
    lastHeight = height;
    drawTrackMap(root, points);
  };

  redraw();
  new ResizeObserver(redraw).observe(root);
}
