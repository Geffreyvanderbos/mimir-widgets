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
which is why `WIDGETS`' `height` in `functions/api/oembed.ts` now also takes a
function of the target URL. A per-URL height still has to be a height the card
actually fits inside, with slack for a wrapped label — `body` centres its
content, so an underestimate clips the top and bottom alike.

**The nearby widget is the first one you drive rather than look at, and the
first with two panes.** `/nearby` is a live map beside a scrolling list of what
OpenStreetMap knows is around a point. Three things about it are load-bearing.

It hand-rolls the slippy map in `src/nearby-map.ts` rather than adding Leaflet —
but note that `src/hike-map.ts`'s anti-library comment doesn't transfer, because
that widget genuinely didn't want panning and this one is nothing but panning.
The reason here is narrower: what an embedded map needs is drag, integer zoom
and markers, and that is a few hundred lines against a first real runtime
dependency. What *doesn't* carry over from `hike-map.ts` is its draw model — it
rebuilds every `<img>` per draw, which is fine once and a flicker per frame at
60fps, so this one keeps a live `Map` of tile elements and only adds, removes
and repositions. Two things there are easy to get wrong and invisible until
someone tries it on a phone: `touch-action: none` on the map (without it a touch
drag scrolls the *host page* instead of panning), and taking pointer capture
only *after* the gesture passes the tap threshold — capturing on `pointerdown`
retargets the compatibility `click`, and every marker silently stops responding.

Overpass goes through `functions/api/nearby.ts` even though Overpass sends
`access-control-allow-origin: *` and needs no proxy. The privacy argument from
the hike tiles applies with more force — the payload here *is* someone's
location — and, separately, a browser-side fallback chain can't distinguish a
dead instance from a refused preflight. The client never composes Overpass QL:
it sends a coordinate and slugs, the Function looks them up in a fixed table.
Two things learned by measurement rather than reading: `overpass.osm.ch` is a
Swiss extract that answers a Dutch query `200` with zero elements, so a regional
instance in a fallback list is worse than no fallback (it ends the chain with a
confident wrong answer); and `overpass.kumi.systems` is a CNAME onto
`private.coffee`, so listing both is one machine wearing two names.

The list is not simply the nearest N, and it isn't flat. A nearest-60 over the
default set in a park came back 50 benches, 5 parking, 2 water, 2 cafés, 1
toilet — cities map benches by the dozen, so the thing you actually went looking
for is never near the top. `balance()` takes a round at a time across the
requested categories; on top of that the panel is a one-open-at-a-time
accordion, keyed by category and ordered by which one's nearest member is
closest. Five collapsed rows fit any frame this widget will be given, where a
flat list in a twelve-rem column is a scroll past three dozen benches. A
category with no results still gets a (disabled) row: "no toilet within 1.5 km"
is an answer, a missing row is not.

`?dogs=1` is the shape a filter takes when the data won't support the filter you
wanted. "Only dog-friendly cafés" sounds obvious and returns an empty card:
`dog=*` is an access tag for *paths* (120k co-occurrences with `highway` against
18.7k with `leisure`), and on eateries it's near-unmapped — 0 of 240 within 2 km
of Arnhem centre, 1 of 1880 in Amsterdam, 4 of 1209 in Berlin. So the flag does
only what the tag can back: drops explicit `dog=no`, floats explicit yes to the
top, keeps everything untagged, because unknown is not a refusal. Worth
generalising — before filtering on an OSM tag, count it in three cities first,
since an empty widget reads as broken rather than as honest.

"Look around here" re-queries at whatever the map is currently centred on, and
that origin lives in memory only — nothing is written to the address bar, to
history or to storage. The parameters stay the source of truth: a reload, or
anyone else opening the same note, lands back at the URL's coordinate. Worth
keeping that shape for any widget control that changes what's displayed, since
a URL that silently stopped describing what the embed shows is a URL that can no
longer be shared or re-embedded.

The slug table is a shorthand, not a ceiling. `?amenities=` also takes a raw
`key=value`, so any of OpenStreetMap's thousands of tags is reachable without a
deploy — `tourism=artwork` returns 115 hits around Sonsbeek and nobody had to
predict it. What keeps that safe is **the charset, not the allowlist**: keys and
values are matched against `^[a-z][a-z0-9_:]*$`-ish patterns and anything else
is *dropped rather than escaped*, since no real OSM tag needs escaping, so a
value that would is a value being used for something else. A bare key with no
value is refused too — `["building"]` is a far heavier query than
`["building"="yes"]`. Categories are capped at 8 per request because each one is
its own `out` statement on someone else's volunteer hardware. `/api/nearby?catalog=1`
publishes the named half, since otherwise it exists only in a `const` nobody
writing a URL will read. A slug is one `key=value` unless it sets `loose`, which
matches inside a semicolon list: a bin tagged `waste=trash;dog_excrement` is a
dog bin, and exact matching finds none of them.

The category's icon and label live in the *server's* table and travel back in
the response, which is why there's no client-side amenity table any more. Three
places draw a category — a map pin, an accordion header, the metadata strip —
and an icon defined in two files is one that eventually disagrees with itself.
It also means a category added server-side arrives already drawable.

**The very widget's hard part is the word list, not the code.** `/very` swaps an
adjective for one that doesn't need "very" in front of it. The lookup is a
hundred lines; `src/very-words.ts` is the widget. Three rules came out of
curating it, and they hold for any hand-built lexicon.

A *weak* synonym is unhelpful, a *wrong-sense* synonym gives bad advice, and
they are not the same bug — "very smart → intelligent" merely wastes the
lookup, "very sick → morbid" (preoccupied with death), "very cheap → stingy"
(price versus character) and "very suspicious → apprehensive" (nervous versus
distrustful) each send someone off with the wrong word. Sense errors are what
the curation pass is for; weak entries mostly dissolve on their own once every
headword carries three or four alternatives instead of one.

Where a headword genuinely has two senses, it gets two entries with a `sense`
label rather than one entry that quietly picks a side — `cheap`, `bright`,
`busy`, `close`, `hard`, `hurt`, `mad`, `short`, `sweet`. That's also why the
card renders a *list* of hits: the lookup returns every entry for the key, and both
groups draw.

A widget embedded without `?w=` deals a random entry on every load, and there
is a line to draw carefully there. Everywhere else in this repo a URL fully
describes what the embed shows, and SKILL.md §7's iframe is rebuilt on every
visit to a note — so a paramless `/very` genuinely does show a different word to
every reader, and to the same reader twice. That's the intent rather than a
lapse: a URL that carries no word never promised a particular one, and the point
of the paramless embed is to learn a word you didn't ask for. A `?w=` URL still
renders exactly what it says, and the shuffle button overrides it in memory
only, like `/nearby`'s "look around here".

What a random default *does* force is a distinction worth carrying to any widget
with one: an entry can be fine to look up yet wrong to volunteer. `horny`
belongs in the list — someone will type it — and does not belong appearing
unbidden in someone's notes, hence `onRequest: true`, which excludes an entry
from the random pick without hiding it from lookup. The pick is also over
distinct *words* rather than entries, or the nine two-sense headwords would
come up twice as often as the rest.

The rest is a matter of not making the reader spell things exactly: every
intensifier is peeled off the front (`really tired`, `so tired`, and `very
tired` are one question), a bounded Levenshtein catches a typo, and typing a
*replacement* rather than the thing being replaced points back at the headword
it came from. `pretty` is why the peeling stops when one token is left — it's
both an intensifier and a headword.

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
