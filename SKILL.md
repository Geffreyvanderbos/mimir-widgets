---
name: mimir-widget
description: Build a small web widget that renders as a live, interactive card when its URL is pasted into Mimir (the outliner/notes app), by making it an oEmbed provider. Use when someone wants to make an embeddable widget, card, or mini-app for Mimir, make their own URL "unfurl" or embed in a Mimir note, write an oEmbed endpoint or discovery link for Mimir, or debug why their page shows as a plain link or a blank frame inside Mimir. Covers the discovery contract, iframe sizing, theming, persistent state, hosting headers, a complete Cloudflare Pages template, and curl checks.
---

# Building a Mimir widget

Mimir turns a bare `https://` URL pasted into a block into a live embed via
[oEmbed](https://oembed.com/), the same way it handles YouTube or Spotify. A
**widget** is a small web page of your own (a countdown, a timer, a poll, a
map) plus an oEmbed endpoint that tells Mimir to show that page in a fixed-
height iframe. The page's query string is its whole configuration:
`https://widgets.example/countdown?date=2026-12-25&label=Christmas` is one
card, and a different query string is a different card.

You need three things, and all of them are served by *your* host:

1. **The widget page**, served at a public https URL.
2. **A discovery `<link>`** in that page's raw HTML, pointing at your oEmbed
   endpoint with the page's own full URL as `?url=`.
3. **The oEmbed endpoint**, returning JSON whose `html` is a single `<iframe>`
   back at the page.

## Workflow

1. Pin down what the widget shows and which query parameters configure it.
   Every parameter needs a sensible default, so a bare URL still renders
   something useful.
2. Decide the card's height (§4). If the height depends on a parameter, write
   the formula and a clamp for it now.
3. Build the page: plain HTML/CSS/JS reading `URLSearchParams`, following
   §5–§8. A framework is almost never worth it at this size.
4. Add the discovery `<link>` injection and the oEmbed endpoint (§1–§3). The
   [template](#template-cloudflare-pages) below does both.
5. Make sure the host doesn't send `X-Frame-Options` or a restrictive
   `frame-ancestors` on widget routes ([troubleshooting](#faq--troubleshooting)).
6. Run the [curl checks](#verify-with-curl) against the deployed URL, then paste
   the URL into a Mimir note to look at the result.

## The rules

### §1. Serve oEmbed JSON (and only JSON)

At an https endpoint, given `?url=<the widget page's full URL>`, return:

```json
{
  "version": "1.0",
  "type": "rich",
  "provider_name": "Your Widgets",
  "title": "Countdown: Christmas",
  "html": "<iframe src=\"https://widgets.example/countdown?date=2026-12-25&amp;label=Christmas\" width=\"100%\" height=\"140\" frameborder=\"0\"></iframe>",
  "width": 600,
  "height": 140
}
```

- `type` is `"rich"` for a widget (`"video"` only for actual video; see
  [photo](#optional-embedding-a-picture-instead-of-a-card) for images).
- Mimir never reads XML oEmbed. Ignore `format=xml`.
- **Only describe your own pages.** Reject any `?url=` whose origin isn't
  yours, or your endpoint becomes a way to make Mimir iframe anything.
- **Escape the `src` attribute** (`&` → `&amp;`, `"` → `&quot;`). The URL
  carries user-chosen query values, and an unescaped quote breaks out of the
  attribute.

### §2. Put the discovery `<link>` in the raw HTML, per request

Mimir finds your endpoint by fetching the page and scanning its `<head>` for:

```html
<link rel="alternate" type="application/json+oembed"
      href="https://widgets.example/api/oembed?url=<this page's full URL, URL-encoded>&format=json">
```

Two requirements, and both trip people up:

- **It must be in the HTTP response body.** Mimir streams the raw HTML and
  never runs JavaScript. A tag your client-side JS adds after load does not
  exist as far as Mimir is concerned.
- **Its `href` must encode the exact URL requested, query string included.**
  A static HTML file with a hard-coded `<link>` is wrong for every
  configuration except one. Generate the tag per request with SSR, a template,
  or an edge rewrite (the template below uses Cloudflare's `HTMLRewriter`).

### §3. Make `html` exactly one `<iframe>` and no `<script>`

When the `html` is **exactly one `<iframe>` tag with no `<script>`** and its
`src` is a public https URL, Mimir loads that URL as a real cross-origin
iframe. It gets full JS, its own persistent storage, and the sandbox
`allow-scripts allow-same-origin allow-popups`.

Anything else (inline scripts, several elements, blockquote-style embed
markup) gets injected via `srcdoc` into an opaque-origin frame instead:
`allow-scripts` only, with no storage and no cookies. It still renders, but
degraded. Point the iframe at your real page and put all the behaviour there.

### §4. Sizing: fluid width, one fixed height

Mimir reads dimensions in this order:

1. **`width="100%"` plus a pixel `height` on the `<iframe>` tag** means any
   column width at exactly this height. Use this for widgets. It is also what
   Spotify's oEmbed does. Mirror the height in the top-level `height` field,
   and put any nominal number (such as `600`) in `width`.
2. **Pixel `width` and `height` on both the tag and the top-level fields**
   means keep this aspect ratio. Use it for something video-shaped.
3. Neither: Mimir guesses. Don't rely on it.

**The frame can't resize after load.** Mimir doesn't listen for `postMessage`
resize requests on the direct-iframe path. Pick the height your card needs and
design so it never changes over the widget's lifetime:

- Content whose size varies (search results, a list that loads) goes in a
  **fixed-height region that scrolls internally**, so the card doesn't grow.
- Selecting or expanding something must not change the card's total height.
  Use overlays, accordions with one item open, or ellipsis.
- A two-pane layout must not stack at narrow widths, since stacking needs a
  taller frame than the one you reported. Let the panes narrow instead.
- The height is fixed before anyone's column width is known, so leave slack
  for text that wraps at narrow widths.

**The height may depend on a parameter** (e.g. `?n=5` rows means a taller
card). It is still one fixed height per URL, computed in the oEmbed endpoint.
If you do this:

- Clamp the parameter to the same range in the endpoint and in the page, or
  the two drift apart and the card clips.
- Parse with `Math.round(Number(value)) || fallback`. `Number(null)` is `0`,
  not `NaN`, so an `isFinite` check treats a missing parameter as an explicit
  zero.

### §5. Theme with `prefers-color-scheme` (there's no other channel)

Mimir has no in-app theme toggle and passes no theme to the iframe: no query
parameter and no `postMessage`. It follows the OS setting, so your own
`@media (prefers-color-scheme: dark)` always matches what surrounds the card.
Implement both schemes. A light-only widget glares in a dark note.

### §6. Look native: no card chrome, and fill the frame

**Don't draw your own outer border, border-radius, shadow or card
background.** Mimir already wraps the iframe in a rounded, hairline-bordered
panel, and a second one inside it reads as a rectangle within a rectangle.
The iframe's edge is the card's edge. Use internal padding only.

**Fill the reported height.** Content that sits at the top with empty
background below it looks like a card floating in a taller box. Make
`html, body` full height and flex-centre the content:

```css
html, body { margin: 0; height: 100%; }
body { display: flex; justify-content: center;
       align-items: center; align-items: safe center; }
```

Use `safe center`, not plain `center`. If the content is ever taller than the
frame, plain centring overflows at *both* ends, and the part above the top
can't be scrolled to. `safe` falls back to top-aligned so only the bottom
overflows. The plain `center` line before it covers engines without `safe`. If your height is an estimate (it depends on how much text wraps),
go further: give the content `align-self: stretch` and let it scroll.

Recommended tokens, so the card sits naturally in Mimir:

| Token | Light | Dark |
|---|---|---|
| Font | `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`, 16px / 1.6 | same |
| Background | `#fdfdfe` | `#1a1a1c` |
| Ink | `#1b1b1b` | `#dcdcde` |
| Muted ink | `#5d5d5f` | `#98989d` |
| Accent | `#006fdc` | `#409cff` |
| Hairline | `hsla(0,0%,0%,.12)` | `hsla(0,0%,100%,.11)` |

Dark ink deliberately stops short of pure white, which glows harshly on a
dark background.

### §7. State: the URL is the config, storage is for progress

**The iframe is destroyed and rebuilt every time the note is opened.**
In-memory state (a running `setInterval`, a variable) is gone each time. On
the direct-iframe path (§3) you do get real `localStorage` and cookies for
your origin, so a timer can store its end time and resume on load.

- **Namespace keys by the query string**, e.g.
  `` `pomodoro:${location.search}` ``. Storage is per origin, so two
  differently configured embeds would otherwise share a key.
- **Expire your own entries.** There's no uninstall step, and a config that
  is no longer embedded never loads again to clean up after itself. Store a
  timestamp with each entry, and on every load sweep *all* keys under your
  prefix, deleting any past a TTL (a countdown past its date, a timer idle
  for 30 days).
- **In-widget controls override parameters in memory only.** A "search here"
  button or a text field may change what's shown, but never write back to the
  address bar, history or storage. The URL has to keep describing what a
  reload, or another reader of the same note, will see.
- **Everything in the URL is public to readers of the note.** It also reaches
  your oEmbed endpoint as `?url=`. A per-user API key as a parameter is only
  acceptable if it's free, revocable and can't spend money or read private
  data. Anything more sensitive belongs server-side.

### §8. Etiquette: you're running inside someone's notes

- https only. Mimir won't accept an http target.
- No sound unless the person pressed something in the widget first. Browsers
  block audio without a gesture anyway, and a note that beeps on open is
  hostile.
- No popups, no `window.open` without a click, and no analytics or tracking.
  The reader pasted a URL into a note; they never visited your site.
- Avoid third-party requests (web fonts, CDNs, direct tile servers). They
  slow the load, and each one tells a third party that someone opened this
  note. If a third-party API sees location or other personal data, proxy it
  through your own server.
- Clipboard writes can be refused in a cross-origin frame. Fall back to
  `document.execCommand('copy')`, then to selecting the text.

## Template (Cloudflare Pages)

A complete single-widget site. The same shape works on any host that can
rewrite HTML per request (Express, Next.js, Deno, a PHP template): what
matters is the rules above, not the platform.

```
public/_headers
functions/_middleware.ts      # injects the discovery <link>
functions/api/oembed.ts       # the oEmbed endpoint
countdown/index.html          # the widget page (served at /countdown)
```

**`functions/_middleware.ts`**:

```ts
const WIDGET_PATHS = ['/countdown'];

export const onRequest: PagesFunction = async ({ request, next }) => {
  const url = new URL(request.url);
  if (!WIDGET_PATHS.includes(url.pathname.replace(/\/$/, ''))) return next();

  const response = await next();
  if (!(response.headers.get('content-type') ?? '').includes('text/html')) return response;

  const oembed = new URL('/api/oembed', url.origin);
  oembed.searchParams.set('url', url.toString());
  oembed.searchParams.set('format', 'json');

  return new HTMLRewriter()
    .on('head', {
      element(el) {
        el.append(
          `<link rel="alternate" type="application/json+oembed" href="${oembed.toString()}" title="Countdown">`,
          { html: true },
        );
      },
    })
    .transform(response);
};
```

**`functions/api/oembed.ts`**:

```ts
interface Widget {
  height: number | ((target: URL) => number);
  title: (target: URL) => string;
}

const WIDGETS: Record<string, Widget> = {
  '/countdown': {
    height: 140,
    title: (t) => `Countdown: ${t.searchParams.get('label') ?? 'Countdown'}`,
  },
};

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

export const onRequest: PagesFunction = async ({ request }) => {
  const self = new URL(request.url);
  let target: URL;
  try {
    target = new URL(self.searchParams.get('url') ?? '');
  } catch {
    return new Response('Missing or invalid url', { status: 400 });
  }
  if (target.origin !== self.origin) return new Response('url must be same-origin', { status: 400 });

  const widget = WIDGETS[target.pathname.replace(/\/$/, '')];
  if (!widget) return new Response('Unknown widget', { status: 404 });

  const height = typeof widget.height === 'function' ? widget.height(target) : widget.height;
  return Response.json(
    {
      version: '1.0',
      type: 'rich',
      provider_name: 'Your Widgets',
      provider_url: self.origin,
      title: widget.title(target),
      html: `<iframe src="${escapeAttr(target.toString())}" width="100%" height="${height}" frameborder="0"></iframe>`,
      width: 600,
      height,
    },
    { headers: { 'cache-control': 'public, max-age=3600' } },
  );
};
```

**`public/_headers`** (Pages adds `X-Frame-Options: SAMEORIGIN` by default,
which blocks the embed; remove it on widget routes only):

```
/countdown
  ! X-Frame-Options
/countdown/*
  ! X-Frame-Options
```

**`countdown/index.html`**:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Countdown</title>
  <style>
    :root { --bg:#fdfdfe; --ink:#1b1b1b; --muted:#5d5d5f; --accent:#006fdc; --hairline:hsla(0,0%,0%,.12); }
    @media (prefers-color-scheme: dark) {
      :root { --bg:#1a1a1c; --ink:#dcdcde; --muted:#98989d; --accent:#409cff; --hairline:hsla(0,0%,100%,.11); }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; }
    body {
      font: 16px/1.6 -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      color: var(--ink); background: var(--bg);
      display: flex; justify-content: center;
      align-items: center; align-items: safe center;
    }
    .content { width: 100%; padding: 0 1.25rem; }
    .label { font-size: .85rem; color: var(--muted); margin: 0 0 .85rem; padding-bottom: .85rem; border-bottom: 1px solid var(--hairline); }
    .clock { font-size: 2rem; font-variant-numeric: tabular-nums; color: var(--accent); }
  </style>
</head>
<body>
  <div class="content">
    <p class="label" id="label"></p>
    <div class="clock" id="clock" aria-live="polite"></div>
  </div>
  <script type="module">
    const params = new URLSearchParams(location.search);
    const target = new Date(params.get('date') ?? `${new Date().getFullYear() + 1}-01-01`);
    document.getElementById('label').textContent = params.get('label') ?? 'Countdown';
    const clock = document.getElementById('clock');
    const tick = () => {
      const s = Math.max(0, Math.floor((target - Date.now()) / 1000));
      clock.textContent = `${Math.floor(s / 86400)}d ${Math.floor(s / 3600) % 24}h ${Math.floor(s / 60) % 60}m ${s % 60}s`;
    };
    tick();
    setInterval(tick, 1000);
  </script>
</body>
</html>
```

To add a widget, add its path to `WIDGET_PATHS`, give it an entry in `WIDGETS`,
add it to `_headers`, and create its page. Test locally with
`npx wrangler pages dev <build-output-dir>`. Plain `vite dev` or a static file
server does *not* run Functions, so the `<link>` and endpoint won't exist there.

## Optional: embedding a picture instead of a card

If the URL represents an image, return oEmbed `type: "photo"` instead:

```json
{ "version": "1.0", "type": "photo", "provider_name": "Your Images",
  "url": "https://img.example/i/abc123.jpg", "width": 1600, "height": 900 }
```

- **Leave out `html` entirely.** Its absence is what makes Mimir build the
  `<img>` itself. Adding one routes the response back onto the iframe path.
- **`width` and `height` are mandatory** and must be the image's real pixel
  size. Mimir sizes the panel from that ratio. If you don't know them, return a
  404 rather than a photo without them.
- Discovery still fetches a *page*: serve an HTML page with the `<link>` (e.g.
  `/i/abc123`) separately from the image bytes (`/i/abc123.jpg`).

## Verify with curl

`curl` doesn't run JavaScript, so it sees exactly what Mimir's discovery sees.
Run these against the deployed URL (or `wrangler pages dev`):

```bash
PAGE='https://widgets.example/countdown?date=2026-12-25&label=Christmas'

# 1. The discovery link is in the raw HTML, and its url= is this exact page, query included
curl -s "$PAGE" | grep -o '<link[^>]*json+oembed[^>]*>'

# 2. The endpoint returns JSON whose html is one <iframe> with a pixel height
curl -s "https://widgets.example/api/oembed?url=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$PAGE")&format=json"

# 3. Nothing forbids framing (this should print nothing)
curl -sI "$PAGE" | grep -iE 'x-frame-options|frame-ancestors'
```

Then paste `$PAGE` into a Mimir block and check it in both light and dark mode,
at a narrow and a wide column.

## FAQ / troubleshooting

**The URL stays a plain link.** Discovery failed. Run check 1: the `<link>` is
missing from the raw HTML (usually because JS injected it), or it points at an
endpoint that errors. Also check that the target is https.

**A blank frame, with a console error like `Refused to display '…' in a frame
because it set 'X-Frame-Options' to 'SAMEORIGIN'`.** The widget page must not
send `X-Frame-Options`, or a `Content-Security-Policy: frame-ancestors` that
excludes Mimir. Remove them on widget routes only, and keep them on pages that
aren't meant to be embedded. On Cloudflare Pages, which adds the header by
default, use the `_headers` removal shown in the template. Other hosts have an
equivalent per-path header override.

**I removed it in `_headers` and it's still there.** If the domain is on a
Cloudflare zone (not just `*.pages.dev`), check **Rules → Transform Rules →
Managed Transforms** for "Add security headers". It's zone-wide, separate from
Pages, and also adds `X-Frame-Options: SAMEORIGIN`. Remove it with a
**Response Header** Transform Rule matching your widget host, action *Remove*
`X-Frame-Options`. A *Request* Header rule looks similar but does nothing here.

**It renders, but storage doesn't persist and some features break.** Your
`html` isn't a single bare iframe, so Mimir fell back to the sandboxed `srcdoc`
path (§3).

**A rectangle inside a rectangle, or blank space under the card.** You drew
your own border, radius or background, or the content doesn't fill the
reported height (§6).

**The top and bottom of the card are both cut off.** The content is taller
than the reported height and `body` centres it. Raise the height, or use
`align-items: safe center` / `align-self: stretch` (§6).

**It's the wrong theme.** Mimir follows the OS theme only. Implement
`prefers-color-scheme: dark` (§5).

Working examples of all of the above (timers, maps, a departure board, an
image host) are at
[github.com/Geffreyvanderbos/mimir-widgets](https://github.com/Geffreyvanderbos/mimir-widgets).
