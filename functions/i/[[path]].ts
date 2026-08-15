/*
 * The read half of the image host. One key, two representations:
 *
 *   /i/<key>.<ext>   the bytes. What an <img src> wants, and what Slack,
 *                    Discord and iMessage unfurl natively.
 *   /i/<key>         an HTML page carrying the oEmbed discovery <link>. What
 *                    Mimir wants, since discovery works by fetching a *page*
 *                    and scanning its <head> (SKILL.md §2).
 *
 * Both forms in one catch-all rather than two routes, so they can't drift apart
 * about which key they mean or which object they read.
 *
 * The key charset is validated rather than escaped — the same call the amenity
 * slugs in api/nearby.ts make. R2 keys are arbitrary strings and `..` means
 * nothing to a bucket, so this isn't path traversal; it's that a route reading
 * whatever it's handed is a general R2 reader for every object in the bucket,
 * which is a different service from the one this is meant to be.
 */

const KEY_PATTERN = /^[a-z0-9]{8,24}$/;

/* Must match what api/upload.ts is willing to store: an extension here that the
 * upload side can't produce would be a URL nobody can ever mint, and one it can
 * produce but this rejects would be a dead link handed out at upload time. */
const EXTENSIONS = new Set(['jpg', 'png', 'gif', 'webp', 'avif']);

const CACHE_SECONDS = 60 * 60 * 24 * 365;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * The landing page for a key. Deliberately self-contained — no stylesheet link,
 * no script, no font — for the same reason public/404.html is: this page exists
 * to be fetched by machines and by people following a shared link, and anything
 * it referenced would be one more thing that can 404 underneath it.
 *
 * The <link> is emitted here rather than by functions/_middleware.ts because
 * that middleware injects into *built* widget HTML keyed by query string; this
 * page is generated per key and has no static file behind it.
 */
function landingPage(origin: string, key: string, direct: string, width: number, height: number): string {
  const pageUrl = `${origin}/i/${key}`;
  const oembedUrl = `${origin}/api/oembed?url=${encodeURIComponent(pageUrl)}&format=json`;
  const safeDirect = escapeHtml(direct);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Image — Mimir Widgets</title>
<link rel="alternate" type="application/json+oembed" href="${escapeHtml(oembedUrl)}" title="Image">
<meta property="og:type" content="website">
<meta property="og:image" content="${safeDirect}">
<meta property="og:image:width" content="${width}">
<meta property="og:image:height" content="${height}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${safeDirect}">
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #fdfdfe;
  }
  @media (prefers-color-scheme: dark) { body { background: #1a1a1c; } }
  img { max-width: 100%; max-height: 100vh; height: auto; display: block; }
</style>
</head>
<body>
<img src="${safeDirect}" width="${width}" height="${height}" alt="">
</body>
</html>
`;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env, params } = context;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  // A [[path]] catch-all hands back the segments after /i/. More than one means
  // a nested path, which this route has no concept of.
  const segments = Array.isArray(params.path) ? params.path : [params.path ?? ''];
  if (segments.length !== 1 || typeof segments[0] !== 'string') return notFound();

  const [requested] = segments;
  const dot = requested.lastIndexOf('.');
  const key = dot === -1 ? requested : requested.slice(0, dot);
  const extension = dot === -1 ? null : requested.slice(dot + 1);

  if (!KEY_PATTERN.test(key)) return notFound();
  if (extension !== null && !EXTENSIONS.has(extension)) return notFound();

  // `head` for anything that doesn't stream bytes — the landing page needs only
  // the dimensions in customMetadata, and a HEAD request by definition sends no
  // body. A `get` there would pull the whole image out of R2 to serve a few
  // hundred bytes of HTML.
  const wantsBytes = extension !== null && request.method === 'GET';
  const object: R2Object | R2ObjectBody | null = wantsBytes
    ? await env.IMAGES.get(key)
    : await env.IMAGES.head(key);
  if (object === null) return notFound();

  const width = Number(object.customMetadata?.width);
  const height = Number(object.customMetadata?.height);
  const contentType = object.httpMetadata?.contentType ?? 'application/octet-stream';
  const origin = new URL(request.url).origin;

  if (extension === null) {
    // Dimensions are what make this page's oEmbed response describe a shape; an
    // object without them can't produce a well-formed photo embed, so it isn't
    // served as one at all (api/oembed.ts refuses the same case).
    if (!Number.isInteger(width) || !Number.isInteger(height)) return notFound();

    const knownExtension = contentType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg';
    const direct = `${origin}/i/${key}.${EXTENSIONS.has(knownExtension) ? knownExtension : 'jpg'}`;
    return new Response(landingPage(origin, key, direct, width, height), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Short: the page is generated, and an image can't change under a key,
        // but this keeps a mistake from being cached for a year.
        'cache-control': 'public, max-age=3600',
      },
    });
  }

  // A fresh Response with an explicit header set, like the tile proxy — nothing
  // from storage passes through to the browser unexamined. `head` returns no
  // body at all, which is exactly what a HEAD response needs.
  return new Response(wantsBytes ? (object as R2ObjectBody).body : null, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-length': String(object.size),
      // Immutable is honest here: a key is minted per upload and never reused.
      'cache-control': `public, max-age=${CACHE_SECONDS}, immutable`,
      'x-content-type-options': 'nosniff',
      etag: object.httpEtag,
    },
  });
};
