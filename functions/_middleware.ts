// Mimir's oEmbed discovery streams raw HTML and regex-scans it for a
// <link rel="alternate" type="application/json+oembed"> tag — it never runs
// JS. So the tag has to be in the server response, and its href has to
// encode *this exact request's* URL, which is why this can't be a static
// build-time <link> baked into the HTML file.
const WIDGET_PATHS = ['/countdown', '/pomodoro', '/weather', '/calc', '/dummy'];

export const onRequest: PagesFunction = async (context) => {
  const { request, next } = context;
  const url = new URL(request.url);
  const normalizedPath = url.pathname.replace(/\/$/, '');

  if (!WIDGET_PATHS.includes(normalizedPath)) {
    return next();
  }

  const response = await next();
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) {
    return response;
  }

  const oembedUrl = new URL('/api/oembed', url.origin);
  oembedUrl.searchParams.set('url', url.toString());
  oembedUrl.searchParams.set('format', 'json');

  return new HTMLRewriter()
    .on('head', {
      element(el) {
        el.append(
          `<link rel="alternate" type="application/json+oembed" href="${oembedUrl.toString()}" title="Mimir Widget">`,
          { html: true },
        );
      },
    })
    .transform(response);
};
