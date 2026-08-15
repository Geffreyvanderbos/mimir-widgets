/**
 * The bindings the Functions run with. Every other function in this repo is a
 * pure request handler with no environment at all — these two exist only for
 * the private image host (`/api/upload`, `/i/<key>`).
 *
 * Neither value is in this repo. `IMAGES` is an R2 binding declared in
 * wrangler.toml and attached by Cloudflare; `UPLOAD_TOKEN` is a Pages *secret*,
 * set in the dashboard and mirrored into a gitignored `.dev.vars` for local
 * runs. A public repo is the reason the token is a secret rather than a
 * `[vars]` entry — see CLAUDE.md.
 */
interface Env {
  IMAGES: R2Bucket;
  UPLOAD_TOKEN: string;
}
