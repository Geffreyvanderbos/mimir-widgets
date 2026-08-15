# Mimir Widgets

Small oEmbed-enabled widgets (a countdown timer, a Pomodoro timer, an Apple
Watch-style timer, a next-day weather forecast, a plaintext calculator, a
dummy-outline generator, a hike map whose whole GPX track lives in its own
URL) built to embed cleanly
into Mimir — paste a bare widget URL into a block and it renders as a live
card instead of a plain link.

See [`SKILL.md`](./SKILL.md) for the spec on building your own
Mimir-friendly widget (hand it to an LLM), and `CLAUDE.md` for how this
repo itself is put together.

## Development

```sh
npm install
npm run dev          # iterate on widget markup/behavior
npm run build        # tsc --noEmit -> vite build
npm run pages:dev    # full stack via wrangler, including the oEmbed Functions
```

Deployed via Cloudflare Pages (GitHub integration) at `widgets.geff.re`.

## The image host

`/upload` is a private page that puts an image in R2 and hands back a URL that
embeds as a real picture (oEmbed `type: "photo"`). It needs two things that are
deliberately not in this repo:

- an R2 bucket bound as `IMAGES` (declared in `wrangler.toml`, created in the
  Cloudflare dashboard), and
- `UPLOAD_TOKEN`, a Pages **secret** — `openssl rand -hex 32`.

For local runs, put the same token in a `.dev.vars` file (gitignored) and start
wrangler with `--r2 IMAGES` for a local bucket.
