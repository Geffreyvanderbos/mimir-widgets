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

## 6. Visual tokens, for widgets that want to look native

Not required, but recommended so an embedded widget doesn't look like a
foreign object dropped into someone's notes:

| Token | Light | Dark |
|---|---|---|
| Font | `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`, `16px`/`1.6` line-height | same |
| Accent | `#006fdc` | `#409cff` |
| Background | `#fdfdfe` | `#1a1a1c` |
| Ink (text) | `#1B1B1B` | `#dcdcde` (deliberately capped below pure white — see note below) |
| Hairline border | `hsla(0,0%,0%,0.12)` | `hsla(0,0%,100%,0.11)` |
| Border radius | `12px` (matches the rounding of the panel your iframe sits inside) | same |

Dark-mode text intentionally stops short of pure white — Mimir caps it
around 87% (per NN/g's dark-mode-halation research and Material Design's
dark-theme guidance) rather than using `#fff`, which reads as harsh/glowing
on a dark background. Worth carrying over if your widget shows body text.

## 7. Etiquette, since your widget runs inside someone's sandboxed notes app

- https-only. Mimir refuses to even validate an http target.
- No autoplaying audio, no unsolicited `window.open`/popups, no
  analytics/tracking scripts — the person embedding you didn't navigate to
  your site, they pasted a URL into a note.
- No external font/CDN requests if avoidable — keeps load fast and sidesteps
  CSP/sandboxing surprises.

## 8. Reference implementations

- `countdown/index.html` + `src/countdown.ts` — reads `?date=` and
  `?label=`, ticks a live countdown client-side. Fixed 140px height.
- `pomodoro/index.html` + `src/pomodoro.ts` — reads `?work=` and `?rest=`
  (minutes), a start/pause timer cycling work/rest. Fixed 280px height.
- `functions/api/oembed.ts` — the oEmbed JSON endpoint both widgets share.
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
