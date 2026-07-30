# Mimir Widgets

Small oEmbed-enabled widgets (a countdown timer, a Pomodoro timer) built to
embed cleanly into Mimir — paste a bare widget URL into a block and it
renders as a live card instead of a plain link.

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
