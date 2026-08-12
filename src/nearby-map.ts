/*
 * A pannable, zoomable slippy map in ~300 lines, with no map library.
 *
 * This is not src/hike-map.ts with drag bolted on. That one rebuilds every
 * <img> per draw, which is right for a static picture of one hike and fatal
 * here: a rebuild per drag frame is a flicker per drag frame. This keeps a live
 * `Map` of tile elements keyed by z/x/y, and a redraw only adds what came into
 * view, removes what left, and repositions the rest.
 *
 * Leaflet would do all this, at ~40 kB plus a first runtime dependency for a
 * repo that currently has one. The interaction surface a widget-sized map needs
 * — drag, integer zoom, markers — is small enough to own outright.
 *
 * Tiles come from `/api/tiles/{z}/{x}/{y}` on this origin, never from
 * tile.openstreetmap.org directly, for the reason the hike widget states: the
 * tiles requested describe where the person is standing, and a direct <img src>
 * would hand that plus every viewer's IP to a third party.
 */

const TILE_SIZE = 256;

/* MAX_ZOOM must stay within the tile proxy's own bound (functions/api/tiles).
 * 18 is ~0.6 m/px — enough to tell which side of a path a bench is on. */
const MIN_ZOOM = 3;
const MAX_ZOOM = 18;

/* One tile of slack around the viewport, so a drag reveals loaded map rather
 * than the background colour while the next redraw catches up. */
const TILE_MARGIN = 1;

/* Below this a pointer sequence counts as a tap, not a drag — so a click that
 * wobbled a pixel still selects the marker under it, and a real drag that ended
 * on a marker doesn't. */
const TAP_SLOP_PX = 6;

const MERCATOR_LAT_LIMIT = 85.05112878;

export interface MapMarker {
  id: string;
  lat: number;
  lon: number;
  emoji: string;
  title: string;
}

export interface SlippyMap {
  setMarkers(markers: MapMarker[]): void;
  setActive(id: string | null): void;
  /** Pans only if the point isn't comfortably on screen already. */
  reveal(lat: number, lon: number): void;
  /** Where the map is looking now — what "around here" means after a pan. */
  centre(): { lat: number; lon: number };
  /** Moves the dot marking the point everything is measured from. */
  setOrigin(lat: number, lon: number): void;
  /** Recentres unconditionally, unlike `reveal`. */
  panTo(lat: number, lon: number): void;
}

interface Options {
  lat: number;
  lon: number;
  zoom: number;
  onSelect: (id: string) => void;
  /** Called for a tap on the map itself, i.e. a request to deselect. */
  onBackground: () => void;
}

/* Web Mercator normalised to 0..1 over the whole world; multiply by the world
 * size in pixels at a zoom to get pixel coordinates at that zoom. */
function projectX(lon: number): number {
  return (lon + 180) / 360;
}

function projectY(lat: number): number {
  const clamped = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, lat));
  const sin = Math.sin((clamped * Math.PI) / 180);
  return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
}

/* The inverses of the two above, for reading a coordinate back off the map. */
function unprojectLon(x: number): number {
  const wrapped = ((x % 1) + 1) % 1;
  return wrapped * 360 - 180;
}

function unprojectLat(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/* The zoom at which a circle of `radius` metres about `lat` fits a viewport
 * `width` px across, with room left for the pins on the rim. */
export function zoomForRadius(width: number, radius: number, lat: number): number {
  const metresPerPixelAtZ0 = 156_543.033_92 * Math.cos((lat * Math.PI) / 180);
  const wanted = (metresPerPixelAtZ0 * Math.max(width, 1)) / (2.4 * Math.max(radius, 1));
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(Math.log2(wanted))));
}

export function createMap(root: HTMLElement, options: Options): SlippyMap {
  const world = document.createElement('div');
  world.className = 'nearby-world';

  const here = document.createElement('div');
  here.className = 'nearby-here';
  here.title = 'Here';
  world.append(here);

  root.replaceChildren(world, controls(), attribution());

  /* The point results are measured from. It starts at the URL's coordinate and
   * only moves for a "look around here" — the URL stays the source of truth, so
   * a reload always comes back to it. */
  let originLat = options.lat;
  let originLon = options.lon;

  let zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(options.zoom)));
  /* World pixels at the current zoom, of the viewport's top-left corner. */
  let offsetX = 0;
  let offsetY = 0;
  /* The offset the tiles were last laid out at. Between redraws the difference
   * rides on the container's transform, which is a compositor move rather than
   * a hundred style writes. */
  let anchorX = 0;
  let anchorY = 0;
  let width = 0;
  let height = 0;

  const tiles = new Map<string, HTMLImageElement>();
  const markerEls = new Map<string, HTMLElement>();
  let markers: MapMarker[] = [];
  let activeId: string | null = null;

  function worldSize(): number {
    return TILE_SIZE * 2 ** zoom;
  }

  function centreOn(lat: number, lon: number): void {
    offsetX = projectX(lon) * worldSize() - width / 2;
    offsetY = projectY(lat) * worldSize() - height / 2;
    clampVertically();
  }

  /* Longitude wraps, latitude doesn't: dragging past the pole would otherwise
   * scroll the map off into empty background. */
  function clampVertically(): void {
    const size = worldSize();
    offsetY = size <= height ? (size - height) / 2 : Math.max(0, Math.min(size - height, offsetY));
  }

  let redrawHandle = 0;
  function scheduleRedraw(): void {
    if (redrawHandle !== 0) return;
    redrawHandle = requestAnimationFrame(() => {
      redrawHandle = 0;
      redraw();
    });
  }

  function redraw(): void {
    width = root.clientWidth;
    height = root.clientHeight;
    if (width === 0 || height === 0) return;

    clampVertically();
    anchorX = offsetX;
    anchorY = offsetY;
    world.style.transform = 'translate3d(0px, 0px, 0)';

    const count = 2 ** zoom;
    const firstX = Math.floor(offsetX / TILE_SIZE) - TILE_MARGIN;
    const lastX = Math.floor((offsetX + width) / TILE_SIZE) + TILE_MARGIN;
    const firstY = Math.floor(offsetY / TILE_SIZE) - TILE_MARGIN;
    const lastY = Math.floor((offsetY + height) / TILE_SIZE) + TILE_MARGIN;

    const wanted = new Set<string>();
    for (let ty = firstY; ty <= lastY; ty++) {
      if (ty < 0 || ty >= count) continue; // Past a pole: there is no tile.
      for (let tx = firstX; tx <= lastX; tx++) {
        // Keyed by the unwrapped column so two copies of the same tile either
        // side of the antimeridian stay two elements.
        const key = `${zoom}/${tx}/${ty}`;
        wanted.add(key);
        let tile = tiles.get(key);
        if (tile === undefined) {
          const wrappedX = ((tx % count) + count) % count;
          tile = document.createElement('img');
          tile.className = 'nearby-tile';
          tile.src = `/api/tiles/${zoom}/${wrappedX}/${ty}`;
          tile.alt = '';
          tile.decoding = 'async';
          tile.draggable = false;
          tiles.set(key, tile);
          world.append(tile);
        }
        tile.style.left = `${tx * TILE_SIZE - offsetX}px`;
        tile.style.top = `${ty * TILE_SIZE - offsetY}px`;
      }
    }

    for (const [key, tile] of tiles) {
      if (!wanted.has(key)) {
        tile.remove();
        tiles.delete(key);
      }
    }

    placePin(here, originLat, originLon);
    for (const marker of markers) {
      const element = markerEls.get(marker.id);
      if (element !== undefined) placePin(element, marker.lat, marker.lon);
    }
  }

  function placePin(element: HTMLElement, lat: number, lon: number): void {
    const size = worldSize();
    let x = projectX(lon) * size - offsetX;
    // The world repeats east-west, so a pin can be a whole world away from the
    // viewport and still be the one to draw; bring it to the nearest copy.
    while (x < -size / 2) x += size;
    while (x > size / 2) x -= size;
    element.style.left = `${x}px`;
    element.style.top = `${projectY(lat) * size - offsetY}px`;
  }

  function zoomBy(step: number, focalX: number, focalY: number): void {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom + step));
    if (next === zoom) return;
    // Keep whatever is under the focal point under it afterwards, so a pinch or
    // a wheel zooms into what you were looking at, not into the centre.
    const scale = 2 ** (next - zoom);
    offsetX = (offsetX + focalX) * scale - focalX;
    offsetY = (offsetY + focalY) * scale - focalY;
    zoom = next;
    // Every tile belongs to the old zoom; none can be reused.
    for (const tile of tiles.values()) tile.remove();
    tiles.clear();
    redraw();
  }

  function controls(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'nearby-zoom';
    for (const [step, glyph, label] of [
      [1, '+', 'Zoom in'],
      [-1, '−', 'Zoom out'],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nearby-zoom-button';
      button.textContent = glyph;
      button.title = label;
      button.setAttribute('aria-label', label);
      // Without this the press starts a drag on the map underneath as well.
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', () => zoomBy(step, width / 2, height / 2));
      box.append(button);
    }
    return box;
  }

  function attribution(): HTMLElement {
    const credit = document.createElement('div');
    credit.className = 'nearby-attribution';
    const link = document.createElement('a');
    link.href = 'https://www.openstreetmap.org/copyright';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'OpenStreetMap';
    credit.append('© ', link);
    credit.addEventListener('pointerdown', (event) => event.stopPropagation());
    return credit;
  }

  /* --- interaction ----------------------------------------------------- */

  const pointers = new Map<number, { x: number; y: number }>();
  const captured = new Set<number>();
  let travelled = 0;
  let pinchDistance = 0;

  root.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) travelled = 0;
    if (pointers.size === 2) pinchDistance = spread();
    root.classList.add('is-dragging');
  });

  // On `window`, not on the map: a drag that starts within a few pixels of the
  // map's edge has its first move land outside the element, so an element-level
  // listener would never see it — and, never seeing it, would never cross the
  // threshold that takes pointer capture. The drag would die on contact with
  // the edge, which is exactly where a pan most often starts.
  window.addEventListener('pointermove', (event) => {
    const previous = pointers.get(event.pointerId);
    if (previous === undefined) return;
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    travelled += Math.abs(dx) + Math.abs(dy);

    // Capture is taken only once the gesture is unambiguously a drag. Taking it
    // on pointerdown would retarget the compatibility click to this element,
    // and the markers — children of it — would stop being clickable at all.
    if (travelled > TAP_SLOP_PX && !captured.has(event.pointerId)) {
      captured.add(event.pointerId);
      root.setPointerCapture(event.pointerId);
    }

    if (pointers.size >= 2) {
      pinch();
      return;
    }

    offsetX -= dx;
    offsetY -= dy;
    clampVertically();
    world.style.transform = `translate3d(${anchorX - offsetX}px, ${anchorY - offsetY}px, 0)`;
    scheduleRedraw();
  });

  function spread(): number {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function pinch(): void {
    const now = spread();
    if (pinchDistance === 0 || now === 0) return;
    const ratio = now / pinchDistance;
    // Integer zoom levels only, so a pinch steps rather than scaling smoothly.
    // Fractional zoom means scaling tile images, which looks worse than a step
    // and costs a lot more code.
    if (ratio > 1.6 || ratio < 0.625) {
      const [a, b] = [...pointers.values()];
      const box = root.getBoundingClientRect();
      zoomBy(
        ratio > 1 ? 1 : -1,
        (a.x + b.x) / 2 - box.left,
        (a.y + b.y) / 2 - box.top,
      );
      pinchDistance = now;
    }
  }

  function endPointer(event: PointerEvent): void {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    captured.delete(event.pointerId);
    if (pointers.size < 2) pinchDistance = 0;
    if (pointers.size === 0) {
      root.classList.remove('is-dragging');
      scheduleRedraw();
    }
  }

  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  // A tap on the map that wasn't a drag and didn't land on a marker clears the
  // selection — the same gesture that dismisses a callout on any map app.
  root.addEventListener('click', (event) => {
    if (travelled > TAP_SLOP_PX) return;
    if ((event.target as HTMLElement).closest('.nearby-marker, .nearby-zoom, .nearby-attribution')) {
      return;
    }
    options.onBackground();
  });

  root.addEventListener('dblclick', (event) => {
    // A drag that happens to end where the last one did pairs into a dblclick,
    // and zooming on the end of a pan is never what was meant.
    if (travelled > TAP_SLOP_PX) return;
    const box = root.getBoundingClientRect();
    zoomBy(1, event.clientX - box.left, event.clientY - box.top);
  });

  // Only a *deliberate* wheel zooms: a bare wheel over an embedded map should
  // scroll the note it sits in, not silently zoom the map out from under the
  // reader. Ctrl/⌘ is the escape hatch — and a trackpad pinch already arrives
  // as a wheel event with ctrlKey set, so pinch-to-zoom works on a laptop too.
  root.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const box = root.getBoundingClientRect();
      zoomBy(event.deltaY < 0 ? 1 : -1, event.clientX - box.left, event.clientY - box.top);
    },
    { passive: false },
  );

  /* --- public surface --------------------------------------------------- */

  function setMarkers(next: MapMarker[]): void {
    markers = next;
    for (const element of markerEls.values()) element.remove();
    markerEls.clear();

    for (const marker of markers) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nearby-marker';
      button.dataset.id = marker.id;
      button.title = marker.title;
      button.setAttribute('aria-label', marker.title);
      const glyph = document.createElement('span');
      glyph.className = 'nearby-marker-glyph';
      glyph.textContent = marker.emoji;
      button.append(glyph);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        // A drag that happens to finish over a marker still fires a click on
        // it; only a tap should select.
        if (travelled > TAP_SLOP_PX) return;
        options.onSelect(marker.id);
      });
      markerEls.set(marker.id, button);
      world.append(button);
    }
    if (activeId !== null) setActive(activeId);
    redraw();
  }

  function setActive(id: string | null): void {
    activeId = id;
    for (const [markerId, element] of markerEls) {
      element.classList.toggle('is-active', markerId === id);
    }
  }

  function centre(): { lat: number; lon: number } {
    const size = worldSize();
    return {
      lat: unprojectLat((offsetY + height / 2) / size),
      lon: unprojectLon((offsetX + width / 2) / size),
    };
  }

  function setOrigin(lat: number, lon: number): void {
    originLat = lat;
    originLon = lon;
    placePin(here, originLat, originLon);
  }

  function reveal(lat: number, lon: number): void {
    // Nothing has been measured yet — the answer can arrive before the frame
    // has laid out — and centring on a zero-width box puts the pin nowhere.
    if (width === 0 || height === 0) return;
    const size = worldSize();
    const x = projectX(lon) * size - offsetX;
    const y = projectY(lat) * size - offsetY;
    // The inset keeps a revealed pin clear of the metadata strip and the zoom
    // buttons rather than technically-on-screen underneath them.
    const inset = 56;
    if (x >= inset && x <= width - inset && y >= inset && y <= height - inset) return;
    centreOn(lat, lon);
    redraw();
  }

  /* Redraws on a real size change only. ResizeObserver fires far more often
   * than the box meaningfully changes, and the centre is preserved across the
   * ones that matter so a resized card doesn't wander off the place. */
  let lastWidth = -1;
  let lastHeight = -1;
  const observer = new ResizeObserver(() => {
    const nextWidth = root.clientWidth;
    const nextHeight = root.clientHeight;
    if (Math.abs(nextWidth - lastWidth) < 2 && Math.abs(nextHeight - lastHeight) < 2) return;
    if (lastWidth > 0) {
      offsetX -= (nextWidth - lastWidth) / 2;
      offsetY -= (nextHeight - lastHeight) / 2;
    }
    lastWidth = nextWidth;
    lastHeight = nextHeight;
    width = nextWidth;
    height = nextHeight;
    redraw();
  });

  width = root.clientWidth;
  height = root.clientHeight;
  lastWidth = width;
  lastHeight = height;
  centreOn(options.lat, options.lon);
  redraw();
  observer.observe(root);

  function panTo(lat: number, lon: number): void {
    if (width === 0 || height === 0) return;
    centreOn(lat, lon);
    redraw();
  }

  return { setMarkers, setActive, reveal, centre, setOrigin, panTo };
}
