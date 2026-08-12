# Building a Mimir-friendly oEmbed widget

This is a spec for building a small web page that embeds cleanly into
Mimir — an outliner that turns a bare `https://` URL pasted into a block
into a live rich embed, the same way it handles a YouTube or Spotify link,
via [oEmbed](https://oembed.com/). Hand this
document to an LLM along with what you want the widget to do (e.g. "a
countdown timer" or "a mini poll"), and it should be able to produce a
widget that embeds well on the first try. `countdown/` and `pomodoro/` in
this repo are reference implementations of everything below.

## 1. Serve valid oEmbed JSON

At some https endpoint, given a `?url=<the widget page's URL>` query
parameter, return oEmbed JSON:

```json
{
  "version": "1.0",
  "type": "rich",
  "provider_name": "Your Widget Site",
  "title": "A short description",
  "html": "<iframe src=\"...\" width=\"100%\" height=\"140\" frameborder=\"0\"></iframe>",
  "width": 600,
  "height": 140
}
```

`type` should be `"rich"` (or `"video"` for an actual video). **JSON only —
Mimir never reads XML oEmbed**, so don't bother supporting `&format=xml`.

## 2. Advertise the endpoint from the widget page itself

Mimir discovers this by fetching the widget page's HTML and scanning it for:

```html
<link rel="alternate" type="application/json+oembed"
      href="https://your-site.example/api/oembed?url=<the current page's own URL, url-encoded>&format=json">
```

**This has to be in the raw HTML response — Mimir's discovery streams the
page over the network and never executes JavaScript.** If your widget is a
client-rendered SPA, you cannot inject this tag from your own JS; it must
come from your server/edge (a template, SSR, or — as in this repo — a
Cloudflare Pages `_middleware.ts` using `HTMLRewriter` to inject it per
request, since each page instance's URL, and therefore its correct `href`,
differs by query string). See `functions/_middleware.ts` in this repo for
a working example.

## 3. Prefer a single bare `<iframe>`, no `<script>`, in your `html`

Mimir's backend inspects your oEmbed response's `html` field. If it is
**exactly one `<iframe>` tag and contains no `<script>` tag**, and that
iframe's `src` is a public https URL, Mimir loads your widget as a real
cross-origin iframe pointed straight at your `src` — full JS, full storage,
full functionality, sandboxed only with `allow-scripts allow-same-origin
allow-popups` (safe because your frame is genuinely cross-origin from
Mimir's own document).

If your `html` is anything else (inline `<script>`, multiple elements,
blockquote-style embed markup), Mimir instead injects it via `srcdoc` into
an *opaque-origin* sandboxed frame: `allow-scripts` only, no
`allow-same-origin`, no persistent storage, no cookies. Your widget will
still render, but degraded — so for anything beyond the simplest static
markup, make your `html` a plain iframe pointing at your own real page.

## 4. Sizing

Mimir reads dimensions in this priority order:

1. **Fluid width + fixed pixel height on the `<iframe>` tag itself**
   (`width="100%" height="140"`) → treated as authoritative: "any column
   width, exactly this tall." Use this for a fixed-layout card widget —
   this is what both widgets in this repo do, and what Spotify's own oEmbed
   response does.
2. **Literal pixel `width` and `height` on both the iframe tag and the
   top-level oEmbed fields** → treated as a fixed aspect ratio to preserve
   at any column width. Use this for something video-shaped.
3. If neither, Mimir falls back to guessing — don't rely on this; always
   supply real dimensions.

There's no way to have your widget's own JS resize the frame on the
direct-iframe path (Mimir doesn't listen for `postMessage` there — that
autosize channel only exists for the `srcdoc` fallback, and you don't
control when you land there). Pick a height your widget actually needs and
report it; don't design a widget whose height varies over its lifetime.

## 5. Theming: use `prefers-color-scheme`, there's no other channel

Mimir has no way to tell your iframe which theme it's currently in — no
query parameter, no `postMessage`. It purely follows the OS-level
`prefers-color-scheme`, with no independent in-app light/dark toggle of its
own. So your widget's own `@media (prefers-color-scheme: dark)` will
always match what Mimir is actually rendering — implement that, and you're
correctly themed with zero coordination needed. See `src/style.css` in
this repo for a full light/dark token set matching Mimir's own colors.

## 6. Visual tokens — and don't draw your own card chrome

Not required, but recommended so an embedded widget doesn't look like a
foreign object dropped into someone's notes:

| Token | Light | Dark |
|---|---|---|
| Font | `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`, `16px`/`1.6` line-height | same |
| Accent | `#006fdc` | `#409cff` |
| Background | `#fdfdfe` | `#1a1a1c` |
| Ink (text) | `#1B1B1B` | `#dcdcde` (deliberately capped below pure white — see note below) |

Dark-mode text intentionally stops short of pure white — Mimir caps it
around 87% (per NN/g's dark-mode-halation research and Material Design's
dark-theme guidance) rather than using `#fff`, which reads as harsh/glowing
on a dark background. Worth carrying over if your widget shows body text.

**Do not give your widget its own outer border, border-radius, drop shadow,
or card background.** Mimir's `.embed-panel` already draws a rounded,
hairline-bordered container around your iframe — adding a second one inside
produces a visibly nested "rectangle within a rectangle" look (confirmed by
actually embedding a first draft of these widgets: see the FAQ below). Treat
the iframe's edge as the card's edge; your page should render flush to it,
with only internal text padding, not an outer bordered box.

**Fill the frame exactly — don't let content sit top-aligned with slack
space below it.** Since you're reporting a fixed height (§4), your page's
actual rendered content should occupy that full height, not float at the
top with empty background underneath. The simplest way: make `body` a flex
container (`display: flex; align-items: center; justify-content: center;`
on `html, body { height: 100% }`) so your content is vertically centered
and the whole frame reads as one intentional shape, not a card floating in
a taller empty box. See `src/style.css` and `src/countdown.ts`/`pomodoro.ts`
in this repo — plain `.widget-content` divs, no card wrapper.

## 7. Persistent state: localStorage/cookies work, but namespace and expire them yourself

On the direct-iframe path (§3), Mimir grants `allow-same-origin`, so your
widget gets real, persistent `localStorage`/cookies scoped to your own
origin — the same as if someone had visited it in a browser tab. This
survives navigating away from the Mimir page and back, even though the
iframe itself is destroyed and recreated on every visit (so any *in-memory*
JS state — a running `setInterval`, a variable — is gone each time). A
Pomodoro-style widget can resume exactly where it left off by reading its
remaining time from storage on load instead of always starting fresh.

Two things to get right if you do this:

**Namespace by more than origin.** `localStorage` is scoped per *origin*,
not per query string. Two instances of the same widget with different
config (`?work=25&rest=5` vs `?work=50&rest=10`) will collide on the same
storage keys unless you namespace explicitly — key off the URL's own
`search` string (or an explicit `?id=` the person embedding it sets), not
just a fixed key name.

**Expire your own entries — nothing else will.** There's no install/
uninstall step for a widget and no server to run a cleanup job; a person
can create an unbounded number of distinctly-configured embeds (a new
countdown date, a new labeled timer) over time, each leaving its own
storage key behind forever if nothing prunes it. Store a timestamp
alongside your state and, on every load, sweep your own namespace: delete
any key under your prefix whose timestamp is older than some TTL you pick
(a countdown past its target date, or a Pomodoro untouched for 30+ days,
are both reasonable "this is stale" signals) — not just check the current
instance's own key, since a config that's no longer embedded anywhere will
never load again to prune itself.

## 8. Etiquette, since your widget runs inside someone's sandboxed notes app

- https-only. Mimir refuses to even validate an http target.
- No autoplaying audio, no unsolicited `window.open`/popups, no
  analytics/tracking scripts — the person embedding you didn't navigate to
  your site, they pasted a URL into a note.
- No external font/CDN requests if avoidable — keeps load fast and sidesteps
  CSP/sandboxing surprises.

## 9. Reference implementations

- `countdown/index.html` + `src/countdown.ts` — reads `?date=` and
  `?label=`, ticks a live countdown client-side. Fixed 140px height.
- `pomodoro/index.html` + `src/pomodoro.ts` — reads `?work=` and `?rest=`
  (minutes), a start/pause timer cycling work/rest. Fixed 280px height.
  Persists its running state to namespaced `localStorage` (§7) so it
  resumes at the correct remaining time — fast-forwarding through any
  work/rest cycles that elapsed — after the iframe is destroyed and
  recreated by navigating away and back. Chimes on each phase change (one
  tone into rest, two back into work) via a synthesized Web Audio tone —
  no audio file, and only ever triggered by a live phase transition after
  the person has clicked Start themselves, never on load.
- `timer/index.html` + `src/timer.ts` — reads `?presets=` (a comma-separated
  list of durations; bare numbers are minutes, with `45s`, `1:30`,
  `1:30:00`, `2h` and compound units like `1h09m` also parsing),
  offering them as Apple Watch-style circular buttons alongside a free-text
  field for an ad-hoc duration. Counts down on a depleting SVG ring and
  rings a synthesized bell — three struck partials, no audio file — at zero.
  Fixed 240px height. Persists the running timer to namespaced
  `localStorage` (§7) so it resumes at the correct remaining time after the
  iframe is destroyed and recreated; a timer that expired while away lands
  on the finished screen silently, since there was no user gesture that load
  to unlock audio on (§8).
- `weather/index.html` + `src/weather.ts` — reads `?lat=`, `?lon=`, and
  `?label=`, fetches the coming hours' forecast (temperature, precipitation
  chance, weather-code icon) at 3-hour steps client-side from the
  [Open-Meteo](https://open-meteo.com/) API (no key required), showing as
  many columns as comfortably fit the embed's actual width. Fixed 180px
  height.
- `fx/index.html` + `src/fx.ts` — reads `?from=`, `?to=` and `?amount=`, and
  converts one currency into another over a 30-day sparkline, from the
  [Frankfurter](https://frankfurter.dev/) API — no key, and it answers with
  `access-control-allow-origin: *`, so it's fetched client-side like the
  weather widget rather than proxied. Fixed 180px height. One request serves
  the whole card: the range endpoint's last point *is* the current rate, and
  both interactions — editing the amount, and the swap button, which inverts
  every point — are arithmetic on the series already in hand, so nothing after
  load touches the network. The sparkline is an SVG with
  `preserveAspectRatio="none"` and `vector-effect="non-scaling-stroke"`, which
  fills the embed's real width without a resize listener and without a stroke
  that stretches with it.
- `dummy/index.html` + `src/dummy.ts` — reads `?blocks=` and `?depth=`,
  generates a dash-prefixed outline (two spaces per indent level) from a
  bundled public-domain corpus, with a copy button. Fixed 300px height; the
  output scrolls internally rather than growing the page, since the reported
  height can't vary with the block count (§4). Its clipboard write falls
  back to `document.execCommand('copy')`, then to just selecting the text,
  since a consumer's `Permissions-Policy` may withhold `clipboard-write`
  from a cross-origin frame.
- `hike/index.html` + `src/hike.ts` — reads `?t=`, a whole recorded GPX track
  compressed into the URL itself, and draws it over a basemap. Fixed 320px
  height. `src/hike-codec.ts` does the compression (Douglas-Peucker
  simplification → delta → zigzag varint → base64url; a 31 km hike recorded at
  1 Hz lands in ~520 characters) and `src/hike-map.ts` the static slippy-map
  render — Web Mercator projection, best-fit zoom, absolutely-positioned tiles,
  track as SVG, no map library. Distance, climb and duration ride along as
  three short scalar params (`?km=`, `?g=`, `?d=`) measured from the
  full-resolution track, rather than as per-point elevation and time channels
  that would roughly double the payload. `gpx/index.html` + `src/gpx.ts` is the
  builder that turns a `.gpx` file into such a URL entirely in the browser —
  deliberately *not* in `WIDGET_PATHS`, since it's a normal page on the site
  rather than an embed.
- `functions/api/tiles/[z]/[x]/[y].ts` — same-origin basemap tile proxy for the
  hike widget, so the embed makes no third-party requests at all.
- `functions/api/oembed.ts` — the oEmbed JSON endpoint all widgets share.
- `functions/_middleware.ts` — the discovery-`<link>` injection.

## FAQ / gotchas

**My widget loads fine in a browser tab but shows a blank frame in Mimir,
with a console error like `Refused to display '...' in a frame because it
set 'X-Frame-Options' to 'SAMEORIGIN'`.** If you're on Cloudflare Pages:
Pages sets `X-Frame-Options: SAMEORIGIN` on every response by default,
which blocks exactly the cross-origin framing an embeddable widget needs.
Remove it on your widget routes with a `_headers` file in your build
output (or `public/`, if using Vite):

```
/your-widget-path
  ! X-Frame-Options
/your-widget-path/*
  ! X-Frame-Options
```

Leave it in place on any page you don't intend to be embedded (a landing
page, for instance) — the default is a reasonable one, it's just wrong for
the specific routes a consumer is meant to iframe. See `public/_headers`
in this repo for the working example. Other static hosts have an
equivalent per-path header override; the fix is the same regardless of
host — a widget page must not send a restrictive `X-Frame-Options` (or a
`Content-Security-Policy: frame-ancestors` that excludes the consumer).

**I removed it from Pages and it's still blocked.** If your widget domain
sits on a Cloudflare zone (not just a `*.pages.dev` subdomain), check
**Rules → Transform Rules → Managed Transforms** for a bundled toggle like
"Add security headers" — it's a separate, zone-wide feature from anything
Pages itself sends, and it also injects `X-Frame-Options: SAMEORIGIN` (plus
`X-Content-Type-Options`, `Referrer-Policy`, etc.), with no per-host
exception on that settings page. Fix it with a **Response Header**
Transform Rule (not a Request Header one — those look similar in the UI but
only touch what Cloudflare sends to your origin, not what it sends back to
the browser, and won't do anything here): match `http.host eq
"your-widget-host"`, action **Remove** → `X-Frame-Options`. A regular
Transform Rule can strip a header a Managed Transform already added.

**My widget shows a visibly nested rectangle-in-a-rectangle, with extra
blank space below the card.** You gave your widget its own border/
border-radius/card background, doubling up on Mimir's `.embed-panel`
chrome, and/or your content doesn't fill the full declared height. See §6.
