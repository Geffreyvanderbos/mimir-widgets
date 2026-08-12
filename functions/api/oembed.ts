// Fixed per-widget heights, matched to each widget's actual rendered card.
// Reported both as a fluid-width/fixed-height <iframe> tag (width="100%"
// height="NNN") and mirrored in the top-level oEmbed width/height fields.
// Mimir's Rust side reads the *iframe tag's* dimensions as authoritative
// (a literal height alongside a non-pixel width means "any width, this
// tall") — the same shape Spotify's own oEmbed response uses.
interface Widget {
  height: number;
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
  '/timer': { height: 240, title: () => 'Timer' },
  '/hike': {
    height: 320,
    title: (target) => `Hike: ${target.searchParams.get('label') ?? 'Map'}`,
  },
  '/color': {
    height: 320,
    title: (target) => `Color: ${target.searchParams.get('c') ?? '#006fdc'}`,
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

export const onRequest: PagesFunction = async (context) => {
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
  const widget = WIDGETS[targetPath];
  if (widget === undefined) {
    return new Response('Unknown widget path', { status: 404 });
  }

  const { height } = widget;
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
