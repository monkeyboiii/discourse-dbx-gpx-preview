import { ajax } from "discourse/lib/ajax";
import { withPluginApi } from "discourse/lib/plugin-api";
import I18n, { i18n } from "discourse-i18n";

export default {
  name: "dbx-gpx-preview",

  initialize() {
    withPluginApi("1.0.0", (api) => {
      const PROCESSED_ATTR = "data-dbx-gpx-processed";

      // Resolution promises keyed by upload://<base62>.gpx; failures are evicted so
      // a transient blip doesn't poison retries. See README § "Short-url resolution".
      const resolveCache = new Map();

      // Pre-flight scan results keyed by resolved file URL.
      const scanCache = new Map();

      // gpx.studio locale path segments confirmed to exist; everything else uses
      // the default (English) routes.
      const EMBED_LOCALES = { zh_CN: "zh" };

      function setting(name, fallback) {
        const v =
          typeof settings !== "undefined" && settings ? settings[name] : undefined;
        return v === undefined || v === null || v === "" ? fallback : v;
      }

      function baseUrl() {
        return String(setting("gpx_studio_base_url", "https://gpx.studio"))
          .trim()
          .replace(/\/+$/, "");
      }

      function localePath(route) {
        const lang = EMBED_LOCALES[I18n.currentLocale()];
        return `${baseUrl()}${lang ? `/${lang}` : ""}${route}`;
      }

      function embedUrl(fileUrl, hash) {
        const options = {
          files: [fileUrl],
          elevation: {
            show: !!setting("show_elevation", true),
            height: Number(setting("elevation_height", 170)) || 170,
            controls: true,
            fill: "none",
          },
          distanceMarkers: !!setting("distance_markers", true),
          directionMarkers: !!setting("direction_markers", false),
          distanceUnits: "metric",
          theme: "system",
        };

        const query = encodeURIComponent(JSON.stringify(options));
        return `${localePath("/embed")}?options=${query}${hash || ""}`;
      }

      function editorUrl(fileUrl) {
        const files = encodeURIComponent(JSON.stringify([fileUrl]));
        return `${localePath("/app")}?files=${files}`;
      }

      // { fileUrl } for a directly embeddable href, { shortForm, href? } for
      // short-urls needing resolution, null for non-gpx/unusable anchors.
      function gpxSource(anchor) {
        // Composer preview's first render cooks attachments as href="/404" +
        // data-orig-href="upload://…" before the async href lookup lands.
        const orig = anchor.dataset.origHref;
        if (orig && /^upload:\/\/[A-Za-z0-9]+\.gpx$/i.test(orig)) {
          return { shortForm: orig };
        }

        let url;
        try {
          url = new URL(anchor.getAttribute("href"), window.location.origin);
        } catch {
          return null;
        }

        if (url.protocol !== "https:") return null;
        if (!/\.gpx$/i.test(url.pathname)) return null;
        // Authed URLs — the embed's plain fetch() can't follow. See README § "Deferred".
        if (url.pathname.startsWith("/secure-uploads/")) return null;

        if (url.origin === window.location.origin) {
          const m = url.pathname.match(/^\/uploads\/short-url\/([A-Za-z0-9]+\.gpx)$/i);
          if (m) {
            return { shortForm: `upload://${m[1]}`, href: url.href };
          }
          // Other forum-origin paths aren't fetchable by the embed.
          return null;
        }

        return { fileUrl: url.href };
      }

      function rebase(finalUrl) {
        const cdn = String(setting("uploads_cdn_url", "")).trim().replace(/\/+$/, "");
        if (!cdn) return finalUrl.href;
        try {
          return `${new URL(cdn).origin}${finalUrl.pathname}${finalUrl.search}`;
        } catch {
          return finalUrl.href;
        }
      }

      function lookupResolve(shortForm) {
        return ajax("/uploads/lookup-urls", {
          type: "POST",
          data: { short_urls: [shortForm] },
        })
          .then((uploads) => {
            const hit =
              uploads?.find?.((u) => u.short_url === shortForm) || uploads?.[0];
            return hit?.url ? new URL(hit.url, window.location.origin).href : null;
          })
          .catch(() => null);
      }

      function headResolve(href) {
        return fetch(href, { method: "HEAD" })
          .then((r) => {
            if (!r.ok) return null;
            const final = new URL(r.url, window.location.origin);
            // No redirect happened — a forum-origin URL is useless to the embed.
            if (final.origin === window.location.origin) return null;
            return rebase(final);
          })
          .catch(() => null);
      }

      function resolveFileUrl(source) {
        if (source.fileUrl) {
          return Promise.resolve(source.fileUrl);
        }

        const key = source.shortForm;
        if (resolveCache.has(key)) {
          return resolveCache.get(key);
        }

        // lookup-urls requires login (returns the CDN-mapped URL); anonymous viewers
        // fall back to following the short-url redirect.
        const p = (api.getCurrentUser() ? lookupResolve(key) : Promise.resolve(null))
          .then((u) => u || (source.href ? headResolve(source.href) : null))
          .then((result) => {
            if (result === null) {
              resolveCache.delete(key);
            }
            return result;
          });

        resolveCache.set(key, p);
        return p;
      }

      function collectPoints(text) {
        const points = { trk: [], rte: [], wpt: [] };
        const re = /<(trkpt|rtept|wpt)\b([^>]*)>/gi;
        let m;

        while ((m = re.exec(text)) !== null) {
          const attrs = m[2];
          const lat = parseFloat((attrs.match(/\blat\s*=\s*"([^"]*)"/i) || [])[1]);
          const lon = parseFloat((attrs.match(/\blon\s*=\s*"([^"]*)"/i) || [])[1]);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;

          const kind = m[1].toLowerCase();
          points[kind === "trkpt" ? "trk" : kind === "rtept" ? "rte" : "wpt"].push([
            lat,
            lon,
          ]);
        }

        return points;
      }

      // MapLibre reads #zoom/lat/lon from the iframe URL (the embed builds its map
      // with hash: true and zoom: 0). See README § "Camera hash".
      function cameraHash(points) {
        if (!points.length) return "";

        let minLat = 90,
          maxLat = -90,
          minLon = 180,
          maxLon = -180;
        for (const [lat, lon] of points) {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        }

        // A span wider than a hemisphere means the track wraps the antimeridian;
        // re-measure in a 0–360 frame so the centre lands on the track, not its far side.
        if (maxLon - minLon > 180) {
          minLon = 180;
          maxLon = -180;
          for (const [, lon] of points) {
            const shifted = lon < 0 ? lon + 360 : lon;
            if (shifted < minLon) minLon = shifted;
            if (shifted > maxLon) maxLon = shifted;
          }
        }

        const centerLat = (minLat + maxLat) / 2;
        let centerLon = (minLon + maxLon) / 2;
        if (centerLon > 180) centerLon -= 360;
        const span = Math.max(
          maxLat - minLat,
          (maxLon - minLon) * Math.cos((centerLat * Math.PI) / 180)
        );
        const zoom =
          span > 0 ? Math.max(1, Math.min(16, Math.log2(360 / span) - 1.2)) : 14;

        return `#${zoom.toFixed(2)}/${centerLat.toFixed(5)}/${centerLon.toFixed(5)}`;
      }

      // Decides embed vs fallback. Any <rtept> poisons the whole file — the embed
      // crashes on route-derived points. See README § "Pre-flight".
      function classify(points) {
        if (points.rte.length) return "route";

        const distinctTrack = new Set(points.trk.map((p) => `${p[0]},${p[1]}`)).size;
        if (points.trk.length >= 2 && distinctTrack >= 2) return "track";
        if (points.wpt.length) return "waypoints";
        return "empty";
      }

      function scanFile(fileUrl) {
        if (scanCache.has(fileUrl)) {
          return scanCache.get(fileUrl);
        }

        const p = fetch(fileUrl)
          .then((r) => (r.ok ? r.text() : null))
          .then((text) => {
            if (text === null) return null;
            const points = collectPoints(text);
            return {
              kind: classify(points),
              hash: cameraHash(points.trk.concat(points.wpt, points.rte)),
            };
          })
          .catch(() => null)
          .then((result) => {
            if (result === null) {
              scanCache.delete(fileUrl);
            }
            return result;
          });

        scanCache.set(fileUrl, p);
        return p;
      }

      function buildPreview(anchor, source) {
        anchor.setAttribute(PROCESSED_ATTR, "true");

        const wrapper = document.createElement("div");
        wrapper.className = "dbx-gpx-preview";

        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-default dbx-gpx-preview__toggle";
        button.textContent = i18n(themePrefix("preview_button"));

        const loadingNote = document.createElement("span");
        loadingNote.className = "dbx-gpx-preview__loading";
        loadingNote.textContent = i18n(themePrefix("loading"));

        const errorNote = document.createElement("span");
        errorNote.className = "dbx-gpx-preview__error";
        errorNote.textContent = i18n(themePrefix("load_failed"));

        wrapper.append(button, loadingNote, errorNote);

        let content = null;
        let gen = 0;

        function hide() {
          gen++;
          // Remove (not hide) so the WebGL context is released.
          content?.remove();
          content = null;
          wrapper.classList.remove(
            "dbx-gpx-preview--open",
            "dbx-gpx-preview--loading",
            "dbx-gpx-preview--failed"
          );
          button.textContent = i18n(themePrefix("preview_button"));
        }

        function fail() {
          wrapper.classList.remove("dbx-gpx-preview--loading");
          wrapper.classList.add("dbx-gpx-preview--failed");
        }

        function embed(fileUrl, hash) {
          const frame = document.createElement("iframe");
          frame.src = embedUrl(fileUrl, hash);
          frame.title = anchor.textContent.trim() || "GPX";
          frame.style.height = `${Number(setting("preview_height", 520)) || 520}px`;
          frame.allowFullscreen = true;
          frame.setAttribute("allow", "fullscreen");
          // No sandbox — tried and reverted, see README § "No iframe sandbox".
          frame.addEventListener("load", () =>
            wrapper.classList.remove("dbx-gpx-preview--loading")
          );
          return frame;
        }

        function unsupported(kind, fileUrl) {
          const box = document.createElement("div");
          box.className = "dbx-gpx-preview__unsupported";

          const note = document.createElement("p");
          note.textContent = i18n(
            themePrefix(kind === "route" ? "unsupported_route" : "unsupported_empty")
          );
          box.appendChild(note);

          if (kind === "route") {
            const link = document.createElement("a");
            link.href = editorUrl(fileUrl);
            link.target = "_blank";
            link.rel = "noopener";
            link.className = "btn btn-small";
            link.textContent = i18n(themePrefix("open_in_studio"));
            box.appendChild(link);
          }

          wrapper.classList.remove("dbx-gpx-preview--loading");
          return box;
        }

        function show() {
          const myGen = ++gen;
          wrapper.classList.remove("dbx-gpx-preview--failed");
          wrapper.classList.add("dbx-gpx-preview--open", "dbx-gpx-preview--loading");
          button.textContent = i18n(themePrefix("hide_button"));

          resolveFileUrl(source)
            .then((fileUrl) => {
              if (myGen !== gen || content || !wrapper.isConnected) return null;
              if (!fileUrl) {
                fail();
                return null;
              }
              return scanFile(fileUrl).then((scan) => ({ fileUrl, scan }));
            })
            .then((resolved) => {
              if (!resolved || myGen !== gen || content || !wrapper.isConnected) {
                return;
              }

              const { fileUrl, scan } = resolved;
              if (!scan) {
                fail();
                return;
              }

              content =
                scan.kind === "track" || scan.kind === "waypoints"
                  ? embed(fileUrl, scan.hash)
                  : unsupported(scan.kind, fileUrl);
              wrapper.appendChild(content);
            });
        }

        button.addEventListener("click", () => {
          if (wrapper.classList.contains("dbx-gpx-preview--open")) {
            hide();
          } else {
            show();
          }
        });

        const block = anchor.closest("p, li, td, th, dd, figcaption, blockquote");
        if (block && (block.tagName === "TD" || block.tagName === "TH")) {
          // A block <div> can't sit between table cells — keep it inside the cell.
          anchor.after(wrapper);
        } else {
          (block || anchor).after(wrapper);
        }
        return wrapper;
      }

      // Whether this post holds a claimed trail, keyed by post id. A miss is remembered
      // as null: almost every GPX post is somebody's ordinary attachment, and asking the
      // forum again on every re-render would be one request per scroll.
      const trailCache = new Map();

      function loadTrail(postId) {
        if (trailCache.has(postId)) return Promise.resolve(trailCache.get(postId));
        const p = ajax(`/dbx/trails/post/${postId}.json`)
          .then((trail) => {
            trailCache.set(postId, trail);
            return trail;
          })
          .catch(() => {
            // 404 is the ordinary answer here — this post is not a claimed trail.
            trailCache.set(postId, null);
            return null;
          });
        trailCache.set(postId, p);
        return p;
      }

      /**
       * The one control that decides whether a ride is on the public map.
       *
       * It lives on the post because the post is the trail: it holds the file, its owner
       * owns the trail, and deleting it takes the trail off the map. Putting the switch
       * anywhere else would mean two places to look for the same fact.
       */
      function addVisibilityToggle(wrapper, postId) {
        loadTrail(postId).then((trail) => {
          if (!trail?.secret || !wrapper.isConnected) return;

          const row = document.createElement("div");
          row.className = "dbx-gpx-preview__visibility";

          const note = document.createElement("span");
          const button = document.createElement("button");
          button.type = "button";
          button.className = "btn btn-small";

          let state = trail.visibility;
          let secret = trail.secret;

          function paint() {
            const isPublic = state === "public";
            note.textContent = i18n(
              themePrefix(isPublic ? "trail_is_public" : "trail_is_private")
            );
            button.textContent = i18n(
              themePrefix(isPublic ? "trail_make_private" : "trail_make_public")
            );
            row.classList.toggle("dbx-gpx-preview__visibility--public", isPublic);
          }

          button.addEventListener("click", () => {
            const next = state === "public" ? "private" : "public";
            button.disabled = true;
            ajax(`/dbx/trails/${secret}/visibility.json`, {
              type: "POST",
              data: { visibility: next },
            })
              .then((updated) => {
                state = updated.visibility;
                // Going private mints a fresh secret, so the control has to adopt it or
                // the next tap addresses a trail that no longer answers to that name.
                secret = updated.secret || secret;
                trailCache.set(postId, updated);
                paint();
              })
              .catch(() => {
                note.textContent = i18n(themePrefix("trail_toggle_failed"));
              })
              .finally(() => {
                button.disabled = false;
              });
          });

          paint();
          row.append(note, button);
          wrapper.appendChild(row);
        });
      }

      function decorate(el, helper) {
        const post = helper?.getModel?.();
        for (const anchor of [...el.querySelectorAll("a.attachment[href]")]) {
          if (anchor.hasAttribute(PROCESSED_ATTR)) continue;
          if (anchor.closest("aside.quote, .dbx-gpx-preview")) continue;

          const source = gpxSource(anchor);
          if (!source) continue;

          const wrapper = buildPreview(anchor, source);
          // Only the owner is asked, and only in a real post stream: the composer
          // preview has no post id, and a reader has no say over somebody else's trail.
          if (wrapper && post?.id && post?.yours) {
            addVisibilityToggle(wrapper, post.id);
          }
        }
      }

      // eslint-disable-next-line no-console
      console.info("[dbx-gpx-preview] initializer active");

      // No onlyStream: runs in BOTH the post stream and the composer preview
      // (click-to-load keeps that cheap — see README § "Click-to-load").
      api.decorateCookedElement(decorate, {
        id: "dbx-gpx-preview",
        afterAdopt: true,
      });
    });
  },
};
