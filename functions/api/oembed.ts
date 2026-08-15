// Fixed per-widget heights, matched to each widget's actual rendered card.
// Reported both as a fluid-width/fixed-height <iframe> tag (width="100%"
// height="NNN") and mirrored in the top-level oEmbed width/height fields.
// Mimir's Rust side reads the *iframe tag's* dimensions as authoritative
// (a literal height alongside a non-pixel width means "any width, this
// tall") — the same shape Spotify's own oEmbed response uses.
interface Widget {
  // A function for the one widget whose card grows with a parameter — /train
  // renders however many departures ?n= asks for.
  height: number | ((target: URL) => number);
  title: (target: URL) => string;
}

const WIDGETS: Record<string, Widget> = {
  '/countdown': {
    height: 140,
    title: (target) => `Countdown: ${target.searchParams.get('label') ?? 'Countdown'}`,
  },
  '/pomodoro': { height: 280, title: () => 'Pomodoro Timer' },
  '/weather': { height: 180, title: () => 'Weather Forecast' },
  '/calc': { height: 200, title: () => 'Calculator' },
  '/dummy': { height: 300, title: () => 'Dummy Outline Generator' },
  // 280 rather than 240 since the unit keys landed under the custom field:
  // eight presets wrap to two rows, and that case now measures ~257.
  '/timer': { height: 280, title: () => 'Timer' },
  '/hike': {
    height: 320,
    title: (target) => `Hike: ${target.searchParams.get('label') ?? 'Map'}`,
  },
  '/color': {
    height: 320,
    // `||`, not `??`: an unencoded `?c=#663399` arrives with `c` present but
    // empty, since the `#` started the fragment.
    title: (target) => `Color: ${target.searchParams.get('c') || '#006fdc'}`,
  },
  '/train': {
    // Label row plus footer, then one line per departure. Must stay in step
    // with src/train.ts's own clamp on ?n=.
    height: (target) => {
      const requested = Math.round(Number(target.searchParams.get('n'))) || 3;
      return 120 + Math.min(Math.max(requested, 1), 6) * 26;
    },
    title: (target) =>
      `Departures: ${target.searchParams.get('from') ?? '?'} → ` +
      `${target.searchParams.get('to') ?? '?'}`,
  },
  '/holidays': {
    // Countdown block, then one line per upcoming holiday. Must stay in step
    // with src/holidays.ts's own clamp on ?n=. The card itself measures about
    // 135 + 25n; the slack on top of that is what lets a long ?label= wrap to
    // a second line without the frame clipping — and it clips at *both* ends,
    // since body centres its content rather than anchoring it to the top.
    height: (target) => {
      const requested = Math.round(Number(target.searchParams.get('n'))) || 4;
      return 160 + Math.min(Math.max(requested, 1), 8) * 26;
    },
    title: (target) =>
      `Public holidays: ${target.searchParams.get('country')?.toUpperCase() ?? '?'}`,
  },
  // Taller than the other map widget on purpose: this one isn't a picture of a
  // route but a map you drive, next to a list that has to show enough rows for
  // scrolling to be the point rather than the whole content.
  '/nearby': {
    height: 420,
    title: (target) => `Nearby: ${target.searchParams.get('label') ?? 'Places'}`,
  },
  // Field, a fixed-height results track, one line of footer — the track is
  // what keeps this constant across a one-synonym hit and a six-row "did you
  // mean", so the height never has to follow the lookup.
  '/very': {
    height: 250,
    title: (target) => {
      const word = target.searchParams.get('w')?.trim();
      return word ? `Not "very ${word}"` : 'Very Dictionary';
    },
  },
  '/fx': {
    height: 180,
    title: (target) =>
      `${target.searchParams.get('from')?.toUpperCase() ?? 'EUR'} → ` +
      `${target.searchParams.get('to')?.toUpperCase() ?? 'USD'}`,
  },
};

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/*
 * The one response here that isn't an iframe. `/i/<key>` is a stored image, and
 * oEmbed has a type for exactly that — `photo`, which carries a bare image URL
 * and its true dimensions instead of markup.
 *
 * The absence of `html` is load-bearing, not an omission: a consumer with no
 * markup to mount is what makes it build the <img> itself, at the shape given
 * by width/height, rather than dropping the response as unembeddable. Adding an
 * `html` key "for compatibility" would route it back onto the markup path and
 * undo the whole point.
 *
 * Which is also why an image with no recorded dimensions gets a 404 rather than
 * a dimensionless photo response: a consumer that can't read a shape has to
 * guess one, and a guessed shape is a letterboxed or cropped picture.
 */
const IMAGE_PATH = /^\/i\/([a-z0-9]{8,24})$/;

async function photoResponse(target: URL, key: string, env: Env): Promise<Response> {
  const object = await env.IMAGES.head(key);
  if (object === null) return new Response('Unknown image', { status: 404 });

  const width = Number(object.customMetadata?.width);
  const height = Number(object.customMetadata?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    return new Response('Image has no recorded dimensions', { status: 404 });
  }

  const contentType = object.httpMetadata?.contentType ?? 'image/jpeg';
  const extension = contentType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg';

  return new Response(
    JSON.stringify({
      version: '1.0',
      type: 'photo',
      provider_name: 'Mimir Widgets',
      provider_url: target.origin,
      url: `${target.origin}/i/${key}.${extension}`,
      width,
      height,
    }),
    {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=3600',
      },
    },
  );
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const requestUrl = new URL(context.request.url);
  const targetParam = requestUrl.searchParams.get('url');
  if (!targetParam) {
    return new Response('Missing url parameter', { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(targetParam);
  } catch {
    return new Response('Invalid url parameter', { status: 400 });
  }

  // Only ever describe our own pages — never proxy an arbitrary URL through
  // this endpoint's oEmbed response.
  if (target.origin !== requestUrl.origin) {
    return new Response('url must be same-origin', { status: 400 });
  }

  const targetPath = target.pathname.replace(/\/$/, '');

  // Checked before the widget table: an image is described by its own response
  // shape, and shares nothing with the fixed-height iframe every entry there
  // produces.
  const image = IMAGE_PATH.exec(targetPath);
  if (image !== null) {
    return photoResponse(target, image[1], context.env);
  }

  const widget = WIDGETS[targetPath];
  if (widget === undefined) {
    return new Response('Unknown widget path', { status: 404 });
  }

  const height = typeof widget.height === 'function' ? widget.height(target) : widget.height;
  const title = widget.title(target);

  const iframeSrc = escapeAttr(target.toString());
  const body = {
    version: '1.0',
    type: 'rich',
    provider_name: 'Mimir Widgets',
    provider_url: requestUrl.origin,
    title,
    html: `<iframe src="${iframeSrc}" width="100%" height="${height}" frameborder="0"></iframe>`,
    width: 600,
    height,
  };

  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=3600',
    },
  });
};
