/*
 * The whole point of this widget: a hike's track lives *in its own URL*, so
 * there is no server-side store, no upload, and no account — the Mimir note
 * holding the link is the only copy. That only works if a multi-thousand-point
 * GPX collapses to a few hundred URL characters, which is what this module
 * does: simplify away GPS jitter (Douglas-Peucker), delta-encode consecutive
 * fixed-point coordinates, zigzag-varint the deltas, base64url the bytes.
 *
 * Measured on a 12 km / 4 h track recorded at 1 Hz (14,400 points, ~1.3 MB of
 * GPX): 10 m of simplification leaves 169 points and 576 URL characters.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

export interface TrackPoint extends LatLon {
  ele?: number;
  time?: number;
}

/* 1e-5 degrees is ~1.1 m — finer than the simplification tolerance, so the
 * quantisation is never the thing losing detail. */
const SCALE = 1e5;

/* Byte 0 of every payload. Bumping this is how a future format change stays
 * distinguishable from an existing link someone already saved in a note. */
const FORMAT_VERSION = 1;

const EARTH_RADIUS_M = 6_371_000;
const METRES_PER_DEGREE = 111_320;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function encodeTrack(points: LatLon[]): string {
  const bytes: number[] = [FORMAT_VERSION];
  let previousLat = 0;
  let previousLon = 0;

  const pushVarint = (value: number) => {
    // Zigzag first: varints only encode unsigned, and half these deltas are
    // negative (heading south or west).
    let unsigned = value < 0 ? -value * 2 - 1 : value * 2;
    while (unsigned >= 0x80) {
      bytes.push((unsigned & 0x7f) | 0x80);
      unsigned = Math.floor(unsigned / 0x80);
    }
    bytes.push(unsigned);
  };

  for (const { lat, lon } of points) {
    const quantizedLat = Math.round(lat * SCALE);
    const quantizedLon = Math.round(lon * SCALE);
    pushVarint(quantizedLat - previousLat);
    pushVarint(quantizedLon - previousLon);
    previousLat = quantizedLat;
    previousLon = quantizedLon;
  }

  return bytesToBase64Url(new Uint8Array(bytes));
}

export function decodeTrack(payload: string): LatLon[] {
  const bytes = base64UrlToBytes(payload);
  if (bytes.length === 0 || bytes[0] !== FORMAT_VERSION) {
    throw new Error('Unrecognised track format');
  }

  const points: LatLon[] = [];
  let cursor = 1;
  let lat = 0;
  let lon = 0;

  const readVarint = (): number => {
    let unsigned = 0;
    let multiplier = 1;
    for (;;) {
      if (cursor >= bytes.length) {
        throw new Error('Truncated track');
      }
      const byte = bytes[cursor++];
      unsigned += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) {
        break;
      }
      multiplier *= 0x80;
    }
    return unsigned % 2 === 0 ? unsigned / 2 : -(unsigned + 1) / 2;
  };

  while (cursor < bytes.length) {
    lat += readVarint();
    lon += readVarint();
    points.push({ lat: lat / SCALE, lon: lon / SCALE });
  }

  if (points.length === 0) {
    throw new Error('Empty track');
  }
  return points;
}

export function distanceM(a: LatLon, b: LatLon): number {
  const latRad = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dLat = (b.lat - a.lat) * (Math.PI / 180);
  const dLon = (b.lon - a.lon) * (Math.PI / 180) * Math.cos(latRad);
  return Math.hypot(dLat, dLon) * EARTH_RADIUS_M;
}

export function trackLengthKm(points: LatLon[]): number {
  let metres = 0;
  for (let i = 1; i < points.length; i++) {
    metres += distanceM(points[i - 1], points[i]);
  }
  return metres / 1000;
}

export function elevationGainM(points: TrackPoint[]): number {
  /* A barometric/GPS altitude channel jitters by several metres at rest, so
   * summing every positive delta invents hundreds of metres of climb. Only
   * count a rise once it clears the noise floor, and reset the reference on a
   * comparable descent. */
  const NOISE_FLOOR_M = 3;
  let gain = 0;
  let reference: number | undefined;
  for (const { ele } of points) {
    if (ele === undefined) {
      continue;
    }
    if (reference === undefined) {
      reference = ele;
      continue;
    }
    const delta = ele - reference;
    if (delta >= NOISE_FLOOR_M) {
      gain += delta;
      reference = ele;
    } else if (delta <= -NOISE_FLOOR_M) {
      reference = ele;
    }
  }
  return Math.round(gain);
}

export function durationMinutes(points: TrackPoint[]): number | undefined {
  const stamped = points.filter((point) => point.time !== undefined);
  if (stamped.length < 2) {
    return undefined;
  }
  const span = stamped[stamped.length - 1].time! - stamped[0].time!;
  return span > 0 ? Math.round(span / 60_000) : undefined;
}

/* Perpendicular distance from `point` to segment a→b, in metres. Longitude is
 * scaled by cos(latitude) so the comparison is in real distance rather than
 * degrees, which would over-weight longitude away from the equator. */
function perpendicularDistanceM(point: LatLon, a: LatLon, b: LatLon, cosLat: number): number {
  const px = (point.lon - a.lon) * METRES_PER_DEGREE * cosLat;
  const py = (point.lat - a.lat) * METRES_PER_DEGREE;
  const bx = (b.lon - a.lon) * METRES_PER_DEGREE * cosLat;
  const by = (b.lat - a.lat) * METRES_PER_DEGREE;
  const lengthSquared = bx * bx + by * by;
  if (lengthSquared === 0) {
    return Math.hypot(px, py);
  }
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / lengthSquared));
  return Math.hypot(px - t * bx, py - t * by);
}

export function simplify<T extends LatLon>(points: T[], toleranceM: number): T[] {
  if (points.length < 3) {
    return points.slice();
  }
  const cosLat = Math.cos((points[0].lat * Math.PI) / 180);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // Iterative rather than recursive: a 14k-point track recursed per-point
  // would be a stack overflow on a long straight stretch.
  const pending: Array<[number, number]> = [[0, points.length - 1]];
  while (pending.length > 0) {
    const [low, high] = pending.pop()!;
    let farthest = -1;
    let farthestDistance = 0;
    for (let i = low + 1; i < high; i++) {
      const distance = perpendicularDistanceM(points[i], points[low], points[high], cosLat);
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthest = i;
      }
    }
    if (farthest !== -1 && farthestDistance > toleranceM) {
      keep[farthest] = 1;
      pending.push([low, farthest], [farthest, high]);
    }
  }

  return points.filter((_, index) => keep[index] === 1);
}

/* Strava-style privacy zone: drop whole points from both ends until `metres`
 * of track has been discarded, so a route recorded from the doorstep doesn't
 * publish the doorstep. */
export function trimEnds<T extends LatLon>(points: T[], metres: number): T[] {
  if (metres <= 0 || points.length < 3) {
    return points.slice();
  }

  let start = 0;
  let walked = 0;
  while (start < points.length - 1 && walked < metres) {
    walked += distanceM(points[start], points[start + 1]);
    start++;
  }

  let end = points.length - 1;
  walked = 0;
  while (end > start + 1 && walked < metres) {
    walked += distanceM(points[end - 1], points[end]);
    end--;
  }

  return points.slice(start, end + 1);
}

export function parseGpx(xml: string): TrackPoint[] {
  const document_ = new DOMParser().parseFromString(xml, 'application/xml');
  if (document_.querySelector('parsererror') !== null) {
    throw new Error("That file didn't parse as XML — is it really a GPX file?");
  }

  /* Unprefixed CSS type selectors match any namespace, unlike
   * getElementsByTagName's exact qualified-name match — so this works whether
   * the file declares the GPX namespace as default, prefixed, or not at all.
   * Routes and bare waypoints are accepted as fallbacks: plenty of planning
   * tools export a hike as <rte> rather than <trk>. */
  let nodes = document_.querySelectorAll('trkpt');
  if (nodes.length === 0) {
    nodes = document_.querySelectorAll('rtept');
  }
  if (nodes.length === 0) {
    nodes = document_.querySelectorAll('wpt');
  }

  const points: TrackPoint[] = [];
  for (const node of nodes) {
    const lat = Number(node.getAttribute('lat'));
    const lon = Number(node.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }
    const point: TrackPoint = { lat, lon };

    const eleText = node.querySelector('ele')?.textContent;
    const ele = eleText === undefined || eleText === null ? Number.NaN : Number(eleText);
    if (Number.isFinite(ele)) {
      point.ele = ele;
    }

    const timeText = node.querySelector('time')?.textContent;
    if (timeText !== undefined && timeText !== null) {
      const time = Date.parse(timeText);
      if (Number.isFinite(time)) {
        point.time = time;
      }
    }

    points.push(point);
  }

  if (points.length < 2) {
    throw new Error('No track points found in that file.');
  }
  return points;
}

export function trackName(xml: string): string | undefined {
  const document_ = new DOMParser().parseFromString(xml, 'application/xml');
  const name = document_.querySelector('trk > name, rte > name, metadata > name')?.textContent;
  return name?.trim() || undefined;
}
