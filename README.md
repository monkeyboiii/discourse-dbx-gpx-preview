# DirtBikeX GPX Preview — theme component

Decorates cooked `.gpx` attachment links with a click-to-load [gpx.studio](https://gpx.studio) map embed (MapLibre, elevation profile, waypoints, stats). Sibling of `discourse-bdi-native-embed` — same decorate-cooked architecture, simpler job (attachments cook as plain anchors; no onebox to reclaim). Research conclusions travel with this repo in [RESEARCH.md](agents.d/modules/research.md) (distilled from `gpx-mvp-scope.md` + `gpx-pre.md` at the umbrella root).

```text
a.attachment[href$=.gpx] ──decorate──► [Preview track] ──click──► resolve short-url ──► pre-flight fetch
                                                                                             │
                              download link always kept                    scan lat/lon ─────┤
                                                                                             │
                                            track / waypoints ◄──── classify ────► route / no-track
                                                    │                                        │
                    <iframe {base}/embed?options={files:[url]}#zoom/lat/lon>          fallback card
                      gpx.studio fetches the same (cached) URL                     (download + Open in studio)
```

## Layout

| Concern | Where | Notes |
|---|---|---|
| Decoration + embed build | [javascripts/discourse/initializers/dbx-gpx-preview.js](javascripts/discourse/initializers/dbx-gpx-preview.js) | Single initializer, all logic |
| Sizing, loading/error states | [common/common.scss](common/common.scss) | Height inline from setting; `max-height: 75vh` clamps phones |
| Settings | [settings.yml](settings.yml) | `gpx_studio_base_url` is the self-host lever |
| Strings | [locales/en.yml](locales/en.yml), [locales/zh_CN.yml](locales/zh_CN.yml) | Other locales fall back to en |

## Architecture decisions

### Click-to-load, never auto-embed
The iOS app prefetches topic pages with full JS execution (up to 2 unseen pages), and decoration also runs in the composer preview (no `onlyStream`, matching native-embed) — auto-embedding would boot hidden MapLibre WebGL instances per prefetch and per keystroke. So decoration inserts only a button; the iframe exists strictly between Preview and Hide clicks, and Hide **removes** it to release the WebGL context. NOT done: gpx-pre.md's size-tiered auto-preview.

### Pre-flight scan decides embed vs fallback
The embed fails **silently** on several real file shapes (its load chain has no `.catch`, and two of the three failure modes throw nothing at all — see [RESEARCH.md](agents.d/modules/research.md) § "File-shape RCA"). So on click, after resolving the URL, the component fetches the GPX itself — the same URL the iframe will fetch, so it is browser/CDN-cached and doubles as a health check the embed cannot give us — regex-scans `lat`/`lon` off `trkpt`/`rtept`/`wpt`, and classifies:

| Shape | Action | Why |
|---|---|---|
| ≥2 distinct track points | embed | the working case |
| any `<rtept>` | fallback card + Open-in-gpx.studio | route-derived points crash the embed's stats (upstream, poisons the file even when a `<trk>` is also present) |
| waypoints only | embed | markers draw fine; the camera hash supplies the view the embed can't |
| no/degenerate coordinates | fallback card | nothing to draw at any zoom |

A failed pre-flight fetch now surfaces as the error note instead of a silent grey map. NOT done: normalizing route files into tracks — that needs a URL the iframe can fetch, i.e. a Worker route (see Deferred).

### Camera hash pins the initial view
The embed constructs MapLibre with `zoom: 0` **and `hash: true`**, so the iframe's URL fragment is a camera control: the component appends `#<zoom>/<lat>/<lon>` computed from the scanned bbox. This is what fixes waypoint-only files, which the embed can never fit on its own (waypoint extents live in a separate `wptBounds` its fit path never reads). Purely additive for normal tracks — `fitBoundsOnLoad` still overrides it once the track parses — and it removes the globe-flash before that happens. Zoom is `log2(360/span) − 1.2`, clamped 1–16, with a 0–360 re-frame for antimeridian-crossing tracks.

### Insert after the attachment, never replace it
The download anchor is the progressive-enhancement floor and always survives. In the iOS app that floor is currently broken anyway (attachment taps main-frame-navigate and dead-end — no WKDownload/QuickLook), so in-app the preview button *is* the experience; fixing attachment taps is an app-side item, not this component's.

### Short-url resolution through core's lookup-urls, HEAD fallback for anon
Cooked non-secure attachment hrefs are **always** forum-origin `/uploads/short-url/…` (core bakes `short_path`; `upload-protocol.js:148`) — never the CDN URL — and the forum's 302 goes to the **raw OCI bucket URL**, not uploads-cdn (`s3_use_cdn_url_for_all_uploads` defaults false; verified against pinned core + live forum, 2026-08-10). So on click: signed-in viewers resolve via core's `POST /uploads/lookup-urls` (auth-required; returns the CDN-mapped URL — CF-cached path, no raw bucket host leaked to gpx.studio); anonymous viewers fall back to a same-origin HEAD fetch following the redirect (raw OCI URL — works because OCI itself serves `ACAO: *`, live-verified against multiple Origins), re-based onto `uploads_cdn_url` when that setting is set. A result still on the forum origin is treated as failure, and **failures are evicted from the cache** so Hide → Preview genuinely retries. The composer preview's first render cooks attachments as `href="/404"` + `data-orig-href="upload://…"`; the component reads `data-orig-href`, so the button appears immediately.

### No iframe sandbox (tried, reverted)
v0 shipped `sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"` to block top-navigation. During MVP verify the sandboxed embed booted with an **empty file list** (UI up, world zoom, `0.00 km`, no error — `Embedding.svelte`'s file fetch has no `.catch`/`response.ok` check) while the `/app` route loaded the same file fine top-level via Open-in. The sandbox was the only delta from the proven native-embed template (none of its iframes sandbox), and the embed's boot path runs `settings.initialize()` where WebKit's sandboxed-iframe storage `SecurityError` (thrown even with `allow-same-origin`) is a known hazard — so the sandbox was dropped. Residual risk accepted: modern browsers already require user activation for cross-origin iframe → top navigation. Open-in-GPX-Studio (`target=_blank`) works on desktop; in-app it silently no-ops (no WKUIDelegate — known app wart), so the iOS app **hides that button inside the iframe** via its injected stylesheet (`iOS/App/WebKit/Resources/discourse-overrides.css`, which rides `forMainFrameOnly: false`). Nothing this component ships can style the embed — cross-origin iframes are unreachable from the parent page, so app-side injection is the only lever.

### Hosted gpx.studio by default; self-host is a settings flip plus a tile problem
Hosted embeds need no map key (the default liberty basemaps are keyless). A self-hosted copy loses them — `styles/tiles/fonts.gpx.studio` are CORS-locked to origin `https://gpx.studio` (gpx.studio issue #358) — and must bring its own MapTiler key. `gpx_studio_base_url` exists so that lever is config, not code.

### No `allowed_iframes` or CSP change
`allowed iframes` is a cook-time sanitizer over posted markup; JS-injected iframes never pass through it, and Discourse's CSP sets no `frame-src`. Same reason native-embed's Douyin/Bilibili iframes need no settings.

## Deferred

- **GPX normalizer** so route-only files embed instead of falling back: rewrite `<rte>`→`<trk>` (and drop degenerate points) behind a Worker route on the landing worker, mirroring native-embed's `shortlink_resolver_url` precedent; upload URLs are content-hashed so the response caches immutably. Only worth building if real uploads turn out to be route-heavy — the fallback card already keeps those files honest.
- **Upstream fixes worth filing** (both tiny, benefit everyone): `convertRouteToTrack` should pass the point index (the crash), and the fit-bounds path should fall back to `wptBounds` when a file has no track (the world zoom). Plus the missing `.catch` in the embed's load chain.
- Embed locale map beyond `zh_CN → zh` (verify against gpx.studio `languages.ts` before adding entries — a wrong path segment 404s the embed).
- External (non-attachment) `.gpx` URLs — attachments only for now.
- Native iOS viewer intercepting the preview affordance (MapKit + Swift Charts; EMOJI_MODULE pattern).
- Loading state is approximate: iframe `onload` fires before the route renders (gpx.studio #302, open); a ready postMessage needs a fork/self-host.
- Secure-uploads support — architecturally out (the embed's plain `fetch()` can't authenticate); see `gpx-mvp-scope.md` § privacy.
- Topic-list SVG previews + server-side GPX metadata (plugin territory; candidate home: event-filters plugin).
- Infra release integration on migration to a git repo: `install.sh` zip step, `versions.lock` `deploy: discourse-component` entry, `release.sh` FIRST_PARTY list, `gen-versions.sh` mapping — mirror native-embed's four touchpoints.

## Operator setup

| Step | Where | Note |
|---|---|---|
| `authorized extensions` += `gpx` | Admin → Settings → Files | Per env; without it `.gpx` can't upload and nothing cooks as an attachment |
| Build zip | `cd discourse-dbx-gpx-preview && zip -rqX ../discourse-dbx-gpx-preview.zip . -x '.git*'` | Mirrors `infra/install.sh:81` |
| Install component | Admin → Customize → Themes → Install → From your device → `discourse-dbx-gpx-preview.zip` | Then add as component to the active theme |
| `uploads_cdn_url` setting | component settings → `https://uploads-cdn.<apex>` per env | Keeps anonymous-viewer map fetches on the CDN instead of the raw OCI endpoint |
| `allowed iframes` | — | **No change needed** (JS-injected iframe) |
| Caddy / CF | — | **No change needed** (ACAO `*` live on uploads-cdn; raw OCI endpoint serves its own `ACAO: *`) |

## Debugging

- **"No button appears"** — anchor isn't `a.attachment` (file predates `.gpx` authorization → rebake the post) or sits inside a quote.
- **"Button, then error note"** — resolution failed; check Network for `POST /uploads/lookup-urls` (signed-in) or `HEAD /uploads/short-url/…` (anon). Failures aren't cached — Hide → Preview retries for real.
- **"Map loads but no track / world zoom / 0.00 km"** — pre-flight should now prevent this; if it still happens the file classified as `track` but the embed choked. Open devtools on the iframe (its load chain has no `.catch`, so failures are silent). Known signatures: `TypeError: … (reading 'distance')` in `_elevationComputation` = the upstream route-point crash (means a `<rtept>` slipped past the scan); a CORS error = verify with `curl -sI -H 'Origin: https://gpx.studio' <file url>`. See [RESEARCH.md](agents.d/modules/research.md) § "File-shape RCA" for the three distinct causes.
- **"Fallback card on a file that looks fine"** — the scan found `<rtept>` (any route element routes the file to fallback) or fewer than 2 distinct track coordinates. Check with `grep -c '<rtept' file.gpx` and `grep -o 'lat="[^"]*" lon="[^"]*"' file.gpx | sort -u | wc -l`.
- **"Blank/grey box in the iOS app"** — WebGL-in-iframe or gpx.studio unreachable on that network (CN); the error note only covers resolve failures, not in-iframe failures (#302 — no signal exists).
- **"Duplicate buttons after edit"** — `data-dbx-gpx-processed` guard regression.

## Manual verification

1. Staging: authorize `gpx`, install zip, add component to active theme.
2. Post a topic with a `.gpx` attachment (public category). Confirm cooked HTML shows the download link + one **Preview track** button.
3. Click Preview: map renders, fits track, elevation profile shows, and it opens **at the track** (no globe flash). In Network confirm the resolved file URL is on uploads-cdn (signed-in) — anon in a private window should still work via the OCI fallback.
3b. Shape coverage — post one file of each kind and confirm: a normal `<trk>` export embeds; a **waypoint-only** file embeds with markers at the right place (not world zoom); a **route-only** (`<rte>`) file shows the fallback card whose Open-in-gpx.studio link opens the track; a file with no usable coordinates shows the no-track card. Classification is unit-verified in the scratchpad harness against all six sample files.
4. Hide → iframe removed from DOM; Preview again → reloads.
5. Composer: attach a `.gpx`, confirm the preview pane shows the button and typing stays smooth (no iframe until clicked).
6. iOS app: open the topic — button visible, map interactive, scroll vs pan acceptable, dark mode sane. This is scope-doc gate 2.
7. Set profile locale to 简体中文 (`zh_CN`) → button/labels in zh, embed under `/zh/embed`. (`zh_TW` intentionally falls back to en strings and the default embed route.)
