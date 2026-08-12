# Widget ideas

Brainstormed candidates for future widgets, scoped to what SKILL.md allows:
fixed height, client-rendered TS reading `?query=` params, no `<script>` in
the oEmbed `html` (bare iframe only), no autoplaying audio/popups/tracking,
`prefers-color-scheme` theming, and (for the localStorage ones) namespaced +
self-expiring persisted state per §7.

## Batch 1 — no external APIs

1. **Countup timer** — `?since=` a past date, shows elapsed time ticking live
   ("142 days, 3:14:52").
2. **Dice roller** — `?dice=2d6`, roll button, shows result + history of last
   few rolls.
3. **Coin flip** — heads/tails with a simple flip animation, `?label=` for
   what it's deciding.
4. **Random picker** — `?options=a,b,c`, picks one on click, useful for "who
   goes first."
5. **Progress bar toward a goal** — `?target=100&current=42&label=`, static
   value in the URL, re-embed to update.
6. **Days-in-review streak tracker** — `?id=`, click "done today" button,
   persists streak count to localStorage.
7. **Simple stopwatch** — start/pause/lap, resumes via localStorage like
   Pomodoro.
8. **Unit converter** — `?from=mi&to=km&value=5`, static conversion display.
9. **Moon phase display** — computed client-side from date math, `?label=`,
   no API needed.
10. **Word/character counter scratchpad** — small textarea with live count,
    persisted per `?id=` to localStorage.
11. **QR code generator** — `?text=`, drawn client-side to canvas (embedded
    algorithm, no CDN).
12. **Color palette preview** — `?colors=%23ff0000,%2300ff00`, swatches with
    hex/rgb labels and copy buttons.
13. **Base64/URL encode-decode tool** — `?text=&mode=encode`, tiny utility
    card.
14. **Habit checklist** — `?items=a,b,c&id=`, checkboxes persisted daily to
    localStorage, resets at local midnight.
15. **Typing speed test** — short fixed passage, WPM/accuracy on completion,
    no persistence needed.
16. **Lorem ipsum / placeholder text generator** — `?paragraphs=&type=`, copy
    button like the dummy widget.
17. **Tip calculator** — `?bill=&percent=`, static computed split, maybe
    adjustable via a couple of inputs.
18. **Countdown to next occurrence of a recurring event** — `?weekday=fri&time=17:00&label=`,
    computes the next matching date/time client-side.
19. **Currency/exchange-rate snapshot** — could go either static (Batch 1) or
    live (see Batch 2 #17 for the live version).
20. **Sunrise/sunset times** — `?lat=&lon=`, could be computed client-side
    with a sun-position formula (no API), see Batch 2 #8 for the API version.

## Batch 2 — open, no-key, CORS-friendly APIs (callable from a sandboxed
cross-origin iframe)

1. **ISS live location** — `wheretheiss.at` API, shows current lat/lon (and
   optionally a mini map) on a poll interval.
2. **Random dog photo** — `dog.ceo` API, `?breed=` optional filter, new
   photo on click.
3. **Random cat photo** — `thecatapi.com`, same shape as the dog widget.
4. **Dictionary lookup** — `dictionaryapi.dev`, `?word=`, shows definition/
   part of speech/phonetic.
5. **Public holiday countdown** — `date.nager.at` `/NextPublicHolidays/{countryCode}`,
   `?country=US`, next holiday + days remaining.
6. **Crypto price ticker** — CoinGecko `simple/price`, `?coin=bitcoin&vs=usd`,
   polls periodically.
7. **Nearby earthquakes** — USGS earthquake GeoJSON feed, `?lat=&lon=&radius=`,
   lists recent quakes by magnitude.
8. **Sunrise/sunset via API** — Open-Meteo's sunrise/sunset fields (already
   using Open-Meteo for weather), `?lat=&lon=`.
9. **Random inspirational quote** — `quotable.io` (or `zenquotes.io`),
   refresh button.
10. **Random Wikipedia article teaser** — Wikipedia REST API `page/random/summary`,
    title + first sentence + thumbnail.
11. **Advice slip** — `api.adviceslip.com`, one-liner advice, refresh button.
12. **Trivia question card** — `opentdb.com`, `?category=&difficulty=`, reveal-
    answer interaction.
13. **Chuck Norris joke** — `api.chucknorris.io`, refresh button.
14. **Rhyme/word association finder** — `api.datamuse.com`, `?word=`, list of
    related words.
15. **Air quality index** — Open-Meteo air-quality API, `?lat=&lon=`, current
    AQI + pollutant breakdown.
16. **Country facts card** — `restcountries.com`, `?country=`, flag/capital/
    population/currency.
17. **Live exchange rate** — `frankfurter.app` (no key), `?from=&to=&amount=`.
18. **GitHub repo stats card** — `api.github.com/repos/{owner}/{repo}`, stars/
    forks/open issues, `?repo=owner/name`.
19. **Cat fact** — `catfact.ninja`, refresh button.
20. **Number trivia** — `numbersapi.com`, `?number=` or `random`, a fun fact
    about the number.

Bonus, not scored into the 20/20 above but worth keeping in mind:
- **Dad/programming joke** — `icanhazdadjoke.com` or `official-joke-api`.
- **"On this day" historical events** — Wikipedia's On This Day REST API,
  `?month=&day=`.
- **Next space launch countdown** — Launch Library 2 API
  (`ll.thespacedevs.com`), countdown to the next scheduled launch.
- **Random activity suggestion** — `boredapi.com/api/activity`, "bored?
  click for something to do."
