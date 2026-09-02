---
kind: note
status: current
summary: Lean record of the 2026-08-10 scoping that produced this component. Full research lives in gpx-pre.md + gpx-mvp-scope.md at the DirtBikeX…
---

# Research conclusions (distilled)

Lean record of the 2026-08-10 scoping that produced this component. Full research lives in
`gpx-pre.md` + `gpx-mvp-scope.md` at the DirtBikeX umbrella root (uncommitted); this file is what
travels with the repo. Conclusions only.

## Decision

**Hosted gpx.studio embed + this theme component, click-to-load.** Rejected: native
Leaflet/MapLibre renderer in Discourse (months of map UX gpx.studio already has), raw-paste
iframes (no UX control, needs `allowed iframes`), self-hosting now (see tiles below), plugin-first
(server metadata/topic-list previews are a later, separable layer). Viewing/upload on iOS must be
polished; editing is desktop-only (embed's Open-in-GPX-Studio → full editor).

## Facts the decision rests on (verified 2026-08-10)

- **CORS is already done**: Caddy sends `Access-Control-Allow-Origin: *` on every
  `uploads-cdn.<apex>` response (`infra/Caddyfile:41`; confirmed live with a `gpx.studio`
  Origin, HEAD allowed). No infra change for the hosted embed.
- Uploads live on the `uploads-cdn` subdomain → cross-origin to the forum **regardless** of where
  a viewer is hosted; "self-host = same-origin = no CORS" is false on this stack.
- `secure_uploads` / `login_required` / `prevent_anons_from_downloading_files` all OFF → every
  GPX is public. The embed's plain `fetch()` can never do authed fetches; turning
  `secure_uploads` on later breaks this architecture (accepted, Strava-norm posture).
- **Hosted embeds are keyless** (default liberty basemaps, `key:''`). **Self-hosting loses them**:
  `styles/tiles/fonts.gpx.studio` are CORS-locked to origin `https://gpx.studio`, endpoints
  hardcoded (gpx.studio issue #358) → a self-host must bring its own MapTiler key (key-gated even
  for `style.json`) or tile stack. `gpx_studio_base_url` is the lever when that day comes.
- Embed contract: `/[[language]]/embed?options=<urlencoded JSON>` (`files[]`, `elevation{…}`,
  `distanceMarkers`, `directionMarkers`, units, `theme`); zh among 13 UI languages; no
  ready/height postMessage (issue #302 open) — `onload` ≠ route rendered.
- `allowed iframes` is a cook-time sanitizer; JS-injected iframes bypass it and core CSP sets no
  `frame-src` → no settings/CSP change needed (same reason the Douyin/Bilibili component works).
- gpx.studio = GitHub Pages/Fastly; mainland China (one supported market, audience is global) is
  a degradation tier — component must fail visibly-gracefully there. Self-host behind first-party
  CF is the remedy if CN viewing quality earns priority.

## iOS app facts that shaped the component

- Post webviews allow third-party iframes unconditionally (no `isMainFrame` checks) — the
  Douyin/Bilibili spine proves it.
- Topic prefetch fully executes JS on up to 2 unseen pages, and decoration also runs in the
  composer preview → **click-to-load is mandatory**, not a preference.
- Attachment taps dead-end in-app (no WKDownload/QuickLook) → in-app, the preview button *is*
  the experience.
- No WKUIDelegate → `target=_blank` (Open-in-GPX-Studio) silently no-ops in-app; acceptable,
  editing is desktop-scoped.
- Composer `<input type=file>` presents the native picker with no delegate → upload works once
  `.gpx` is in `authorized extensions` (10 MB cap already set).
- Embed shows WGS-84; native MapKit surfaces show GCJ-02 display coords inside mainland China —
  per-surface consistent, side-by-side disagreement near CN venues is accepted.

## Resolved during build review (2026-08-10, verified against pinned core + live forum)

- Cooked non-secure attachment hrefs are **always** `/uploads/short-url/…` (never the CDN URL),
  and the forum's 302 targets the **raw OCI bucket URL** (`s3_use_cdn_url_for_all_uploads`
  defaults false, unset in infra) — which happens to serve its own `ACAO: *` (live-verified).
- Hence the component's dual resolution: signed-in → core `POST /uploads/lookup-urls`
  (auth-required, returns the CDN-mapped URL); anon → HEAD-follow the redirect, re-based onto
  the `uploads_cdn_url` setting when set.
- Composer preview's first render cooks attachments as `href="/404"` +
  `data-orig-href="upload://…"` — component reads `data-orig-href`.

## File-shape RCA (2026-08-10, executed — real gpx.studio lib compiled and run in Node)

The embed renders only well-formed `<trk>` files; three *different* root causes account for every
failure seen, and none of them is in this component. Real-world exports (Strava, Komoot, Wikiloc,
Gaia, 两步路) are `<trk>` files and work.

| Symptom | Root cause | Fix here |
|---|---|---|
| Route-only GPX renders **nothing**, console `TypeError: … (reading 'distance')` | `convertRouteToTrack` builds TrackPoints with no index → `_data.index` undefined → `statistics.local.data[undefined].distance` throws; stats run **eagerly** in `GPXStatisticsTree`'s constructor, so the file dies before any layer draws. Any `<rtept>` poisons the file even alongside a valid `<trk>`. (Second crash site when points lack `<ele>`.) | Pre-flight routes these to the fallback card |
| Waypoint-only GPX draws markers but stays at **world zoom** | Waypoint extents live in a separate `wptBounds` the fit path never reads; `global.bounds` keeps its sentinel → `validBounds` false → `fitBounds` never called. Throws nothing, so error handling can't catch it | Camera hash supplies the view |
| Zero-extent file blank at 0.00 km | Not a library bug — the `sample-*.gpx` fixtures repeat **one coordinate** (40.7128,−74.0060) for all 176/1765/18078 points; zero-area bbox trips `finalizeFitBounds`'s `SW >= NE` guard | Pre-flight shows the no-track card |

Proven by control, not by reading: re-stamping `_data.index` on the 46 route points makes the same
`getStatistics()` call succeed (11.194 km, valid bounds). **Corollary: `sample-*.gpx`-style
byte-filler files are useless as test fixtures** — build a corpus from real exports plus one Garmin
route file for the `<rte>` case.

Key lever found: the embed builds MapLibre with `zoom: 0` and **`hash: true`**, so `#zoom/lat/lon`
on the iframe URL sets the initial camera from outside — no upstream change, and `fitBoundsOnLoad`
still overrides it when a track loads.

## Open gates at time of build

1. On-device: WebGL-in-iframe, map-pan vs scroll, dark mode inside the app webview.
2. Prod settings parity (recon was staging-only).
3. CN in-country characterization (expectation-setting only).
