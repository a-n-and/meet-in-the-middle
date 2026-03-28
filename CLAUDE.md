# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

Open `index.html` directly in a browser — no build step or server required. For local development with proper origin headers (needed by Nominatim's `User-Agent` enforcement), serve with any static file server:

```bash
npx serve .
# or
python -m http.server 8080
```

There are no dependencies to install. Leaflet 1.9.4 is loaded from unpkg CDN at runtime.

## Architecture

Three files, no framework, no bundler:

- **`index.html`** — Static shell. All dynamic content (person cards, suggestion cards) is injected by `app.js`. The sidebar and map container are the two top-level regions.
- **`style.css`** — Design system via CSS custom properties at `:root`. All colors, spacing, and component styles live here. Person colors (`--c0` through `--c5`) are defined here but applied inline via JS using the `COLORS` array constant.
- **`app.js`** — All logic. No modules; one flat script with sections separated by comments.

### Data flow in `app.js`

`runSearch()` is the main orchestrator. It runs four sequential async phases, each updating the progress UI:

1. **Geocode** (`geocodeAll`) — Calls Nominatim for each person's address sequentially with a 1100ms delay (rate limit compliance). Updates `person.coords` and places Leaflet markers.
2. **Find POIs** (`findPOIs` → `queryOverpass`) — POSTs an Overpass QL query centered on the centroid. Auto-expands radius 2km → 4km → 8km if results are sparse.
3. **Route** (`routePeopleToPOI` → `routeOnce`) — For each candidate POI, fires parallel OSRM requests (one per person) with a 200ms gap between POIs. Returns `null` on failure (graceful degradation).
4. **Score** (`scorePOI`) — Fairness score = `1 - (0.6 * CV_of_durations + 0.4 * avg_duration_penalty)`. Falls back to straight-line distance at 40 km/h if OSRM returned fewer than 2 valid routes.

### State

Global mutable state at the top of `app.js`:
- `people[]` — array of `{ id, label, color, address, coords, marker }`. Coords/marker are `null` until geocoded.
- `scoredPOIs[]` — final ranked POI list, each extended with a `scoring` object from `scorePOI()`.
- `suggestionMarkers[]`, `routeLines[]`, `centroidMarker` — Leaflet layer references, cleaned up before each search run.

### Map interactions

`activateCard(idx, panMap)` is the single handler for both hover and click on suggestion cards. It updates card CSS classes, swaps marker icons (`poiDivIcon`), and calls `drawRouteLines()`. `deactivateCard()` reverses all of this. Both are also triggered by clicking the numbered POI markers on the map.

### External APIs

All requests are browser `fetch` — no proxy needed (all three APIs support CORS):

| API | Purpose | Key constraint |
|---|---|---|
| Nominatim | Geocoding | 1 req/sec max; `User-Agent` header required |
| Overpass | POI search | POST with `data=<urlencoded-ql>`; `out center` needed for way/relation geometry |
| OSRM | Drive-time routing | Coordinates are `lng,lat` order (not lat,lng) |

## Git workflow

Commit and push to GitHub after every meaningful change:

```bash
git add <files>
git commit -m "short description of what and why"
git push
```

Remote: `https://github.com/a-n-and/meet-in-the-middle`
