# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Commands

```sh
npm run dev        # Vite dev server (widget pages only — no discovery <link>, no oEmbed endpoint)
npm run build      # tsc --noEmit -> vite build, writes dist/
npm run pages:dev   # wrangler pages dev dist — full stack: static pages + Functions
```

`npm run dev` does not exercise `functions/` at all (Vite doesn't know about
Cloudflare Pages Functions), so it's only useful for iterating on a widget's
own markup/behavior. To test the discovery `<link>` injection or the oEmbed
JSON endpoint, build first and run `npm run pages:dev`, which serves the
built `dist/` through Wrangler's local Pages runtime (Functions included).

## Architecture

Vanilla TypeScript + Vite, no framework — each widget is a tiny, self-
contained page (a countdown, a timer); a framework would be pure overhead.
Multi-page build (`vite.config.ts`'s `rollupOptions.input`): one HTML entry
per widget, plus the landing page, all sharing `src/style.css`.

**Why this needs a server, not just a static site.** oEmbed discovery works
by a consumer (Mimir) fetching a widget's page and looking for
`<link rel="alternate" type="application/json+oembed" href="...">` in its
`<head>` — see [[SKILL.md]] for the full spec this repo exists to
demonstrate. Critically, Mimir's discovery **streams raw HTML and never
executes JavaScript**, so that `<link>` must already be present in the HTTP
response, and its `href` must encode *that exact request's* full URL
(including query params like `?date=`/`?label=`) as the oEmbed target. A
static build-time HTML file can't do that — the same `countdown/index.html`
is served for every date/label combination. `functions/_middleware.ts`
solves this with Cloudflare Pages' `HTMLRewriter`, injecting the correct
per-request `<link>` into the static HTML on the way out. `functions/
api/oembed.ts` is the matching oEmbed JSON endpoint, keyed by `?url=`.

**Widget pages are plain client-rendered TS**, reading their config from
`URLSearchParams` — `src/countdown.ts` (`?date=`, `?label=`), `src/
pomodoro.ts` (`?work=`, `?rest=`). This is fine precisely because they're
loaded as direct cross-origin iframes (see SKILL.md §3), not sandboxed
`srcdoc` content, so full JS/timers/DOM work normally.

**Fixed heights, not responsive-height.** `WIDGET_HEIGHTS` in `functions/
api/oembed.ts` reports each widget's height as a fluid-width/fixed-height
`<iframe>` tag, which the *consumer's* embed logic (Mimir's oEmbed client)
treats as authoritative. There is deliberately no postMessage-based
autosize here — that channel only exists for embeds Mimir renders via
`srcdoc`, and these widgets intentionally take the direct-iframe path
instead (see SKILL.md §3-4), so a widget's height is fixed once and for
all rather than dynamic.

**`public/_headers` strips `X-Frame-Options` on the widget routes.** Cloudflare
Pages sets `X-Frame-Options: SAMEORIGIN` on every response by default — found
the hard way, on the very first real embed attempt in Mimir, as a blank frame
plus a browser console error. That header exists to *prevent* cross-origin
framing, which is the entire point of a widget, so it has to be explicitly
removed (Cloudflare's `_headers` syntax: `! Header-Name`) on `/countdown` and
`/pomodoro` — deliberately left in place everywhere else (the landing page has
no reason to be embedded). See the FAQ in `SKILL.md` for the third-party-
facing version of this gotcha, since it'll bite any widget host, not just
Cloudflare Pages.

**The hike widget puts its whole payload in the URL, and proxies its tiles.**
`?t=` carries an entire GPX track (see `src/hike-codec.ts`), which is the point:
no upload endpoint, no server-side store, no account — the Mimir note holding
the link is the only copy of the route. The corollary is that the *basemap* is
then the only remaining privacy leak, and a direct `tile.openstreetmap.org`
`<img src>` would be a bad one: the requested tiles reveal where you walked,
and every viewer of the note reveals their IP to a third party. Hence
`functions/api/tiles/[z]/[x]/[y].ts` — a same-origin proxy, so the tile server
only ever sees Cloudflare, the embed makes zero cross-origin requests, and a
keyed provider's token could later live server-side instead of in a widget URL.
It bounds zoom and x/y to its own tile grid specifically so it can't be used as
a general-purpose image proxy.

**The train widget carries someone else's API key in its URL, on purpose.**
`/train` is a departure board for one NS route, and the NS Reisinformatie API
needs a per-user subscription key. Keeping a key server-side would make this
*Geffrey's* departure board on Geffrey's quota — so `?key=` is a parameter like
any other, and the widget is route-agnostic until someone fills in their own.
The trade is real and worth stating plainly: the key is visible to anyone who
can read the note, it rides along in the discovery `<link>` the middleware
injects and in the `?url=` of the oEmbed request, and it is not a secret once
embedded. NS keys are free, unscoped to an account's data, and revocable, which
is what makes that trade acceptable here; it would not be for a keyed API that
can spend money or read personal data. Never commit a real key to this repo —
the landing page shows `key=YOUR_KEY`.

Two smaller notes on it. The gateway sends `access-control-allow-origin: *`, so
unlike the hike tiles this one needs no proxy — the browser calls NS directly.
And `/train` is the first widget whose height depends on a parameter (`?n=`),
which is why `WIDGET_HEIGHTS`' `height` in `functions/api/oembed.ts` now also
takes a function of the target URL.

## Conventions

- No comments except where they explain non-obvious *why* — never restate
  what a line of code already says.
- Strict `tsc --noEmit` (`strict`, `noUnusedLocals`/`noUnusedParameters`) is
  the first step of `build`, same rigor as the main Mimir repo.
- **UI verification is Geffrey's job, not Claude's.** Write the widget, run
  `tsc`/`build`, verify the discovery `<link>` and oEmbed JSON with `curl`
  against `wrangler pages dev` — but don't self-verify visually (no
  screenshots, no Playwright). Hand off via a local dev URL or a Cloudflare
  Pages preview deploy for Geffrey to actually look at, and to test the
  real embed inside Mimir.
