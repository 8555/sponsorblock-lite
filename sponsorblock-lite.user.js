// ==UserScript==
// @name         SponsorBlock Lite
// @version      1.0.0
// @description  A lightweight alternative to the official SponsorBlock browser extension.
// @author       github.com/8555
// @match        https://www.youtube.com/*
// @match        https://youtube.com/*
// @grant        GM_xmlhttpRequest
// @connect      sponsor.ajay.app
// @run-at       document-idle
// ==/UserScript==

(function () {
    "use strict";

    // =====================================================================
    // CONFIGURATION — everything you're likely to want to tweak lives here.
    // See README.md for a full explanation of these settings and how the
    // script works overall.
    // =====================================================================
    //
    // SponsorBlock category reference: https://wiki.sponsor.ajay.app/w/Types

    // The SponsorBlock server to query. https://sponsor.ajay.app is the
    // official public instance; community mirrors exist but aren't
    // guaranteed to be reliable/complete for live lookups.
    const API_BASE = "https://sponsor.ajay.app";

    // Which categories to show as timeline markers. See the docs link
    // above for what each category name means.
    const MARK_CATEGORIES = [
        "selfpromo",
        "sponsor"
    ];

    // Which categories to AUTO-SKIP during playback.
    const SKIP_CATEGORIES = [
        "selfpromo",
        "sponsor"
    ];

    // Timeline marker color per category. Falls back to FALLBACK_COLOR if
    // a category has no entry here.
    const CATEGORY_COLORS = {
        sponsor: "#81d4fa",
        selfpromo: "#81d4fa"
    };

    // Color used for any marked category not present in CATEGORY_COLORS
    // above (e.g. a brand new category SponsorBlock adds later).
    const FALLBACK_COLOR = "#bdbdbd";

    // Hash prefix length (in hex characters) sent to the server — see
    // sha256HexPrefix below. 4 is SponsorBlock's own recommended minimum.
    // Raising this narrows the result set (slightly less anonymous,
    // marginally less data transferred); lowering it isn't supported by
    // the API.
    const HASH_PREFIX_LENGTH = 4;

    // =====================================================================
    // End of configuration.
    // =====================================================================

    const MARK_SET = new Set(MARK_CATEGORIES);
    const SKIP_SET = new Set(SKIP_CATEGORIES);

    // Union of MARK_CATEGORIES and SKIP_CATEGORIES, computed rather than
    // hardcoded. Sent to the API, and also kept as a Set for fast lookups.
    const REQUEST_CATEGORIES = Array.from(new Set([...MARK_CATEGORIES, ...SKIP_CATEGORIES]));
    const REQUEST_SET = new Set(REQUEST_CATEGORIES);

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    // In-memory cache: videoID -> array of [start, end, category] segments.
    // Cleared on full page reload; persists across SPA navigations within a session.
    const segmentCache = new Map();

    let currentVideoID = null;
    let currentVideoEl = null;
    let currentSegments = [];
    let timeupdateHandler = null;
    let durationchangeHandler = null;
    let seekingHandler = null;

    // Set to true immediately before we programmatically move currentTime to
    // skip a segment, so the seeking handler can tell "we did this" apart
    // from "the user just scrubbed the seek bar".
    let programmaticSeek = false;

    // The segment (by reference into currentSegments) the user manually
    // seeked into and is presumably choosing to watch. Auto-skip is
    // suppressed for this one segment until playback moves past it.
    let suppressedSegment = null;

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    // Extracts the current video ID from the page URL (handles both
    // /watch?v=... and /shorts/... paths).
    function getVideoID() {
        const url = new URL(location.href);
        if (url.pathname === "/watch") {
            return url.searchParams.get("v");
        }
        const shortsMatch = url.pathname.match(/^\/shorts\/([^/?]+)/);
        if (shortsMatch) return shortsMatch[1];
        return null;
    }

    // Hashes `text` with SHA-256 and returns the first `length` hex
    // characters. Used to turn a video ID into the k-anonymous prefix sent
    // to the SponsorBlock API, so the server never sees the full video ID.
    async function sha256HexPrefix(text, length) {
        const enc = new TextEncoder().encode(text);
        const digest = await crypto.subtle.digest("SHA-256", enc);
        const bytes = Array.from(new Uint8Array(digest));
        const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
        return hex.slice(0, length);
    }

    // Thin Promise wrapper around GM_xmlhttpRequest for a GET request that
    // expects a JSON response. Resolves to null on a 404 (server's way of
    // saying "no data for this hash prefix"), rejects on any other failure.
    function gmGetJSON(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url,
                headers: { Accept: "application/json" },
                onload(res) {
                    if (res.status === 404) {
                        resolve(null);
                        return;
                    }
                    if (res.status < 200 || res.status >= 300) {
                        reject(new Error(`SponsorBlock API returned status ${res.status}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(res.responseText));
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror(err) {
                    reject(err);
                },
                ontimeout() {
                    reject(new Error("SponsorBlock API request timed out"));
                }
            });
        });
    }

    // Returns the [start, end, category] segments for `videoID` matching
    // MARK_CATEGORIES/SKIP_CATEGORIES, from cache if available, otherwise
    // via a hash-prefix lookup (see sha256HexPrefix). A single lookup
    // typically returns data for several videos sharing that hash prefix —
    // all of them get cached, not just the one we asked about, since we
    // already paid for the request.
    async function fetchSegments(videoID) {
        if (segmentCache.has(videoID)) {
            return segmentCache.get(videoID);
        }

        const prefix = await sha256HexPrefix(videoID, HASH_PREFIX_LENGTH);

        const params = new URLSearchParams();
        params.set("categories", JSON.stringify(REQUEST_CATEGORIES));
        params.set("actionTypes", JSON.stringify(["skip"]));

        const url = `${API_BASE}/api/skipSegments/${prefix}?${params.toString()}`;

        let data;
        try {
            data = await gmGetJSON(url);
        } catch (e) {
            console.warn("[SponsorBlock Lite] fetch failed:", e);
            return [];
        }

        if (!data) return [];

        for (const entry of data) {
            const segs = (entry.segments || [])
                .filter((s) => s.actionType === "skip" && REQUEST_SET.has(s.category) && Array.isArray(s.segment) && s.segment.length === 2)
                .map((s) => [s.segment[0], s.segment[1], s.category])
                .sort((a, b) => a[0] - b[0]);
            segmentCache.set(entry.videoID, segs);
        }

        return segmentCache.get(videoID) || [];
    }

    // Locates the active YouTube <video> element, scoped strictly inside
    // the player container so unrelated <video> elements elsewhere on the
    // page (e.g. hover-preview clips on recommended thumbnails) are never
    // mistaken for it.
    function findVideoElement() {
        const player = document.querySelector("#movie_player, .html5-video-player");
        if (!player) return null;
        return player.querySelector("video.html5-main-video") || player.querySelector("video");
    }

    // Locates the full-width progress bar (slider) element. Deliberately
    // targets this rather than .ytp-progress-list, which YouTube splits
    // into one narrow sub-element per chapter on videos with native
    // chapters — .ytp-progress-bar is the one element that always spans
    // the true 0-100% timeline.
    function findProgressBar() {
        return document.querySelector(".html5-video-player .ytp-progress-bar");
    }

    // Removes the marker overlay from the page, if present.
    function clearMarkers() {
        const existing = document.getElementById("sblite-markers");
        if (existing) existing.remove();
    }

    // Draws colored segment markers onto the progress bar, for segments
    // whose category is in MARK_CATEGORIES. Positions and widths are
    // expressed as percentages of `duration`, so the overlay automatically
    // tracks the real progress bar's size/position without any manual
    // layout math. Non-interactive (pointer-events: none) throughout, so
    // it never blocks scrubbing, hovering, or clicking.
    function renderMarkers(segments, duration) {
        clearMarkers();
        if (!segments || !segments.length || !duration) return;

        const markable = segments.filter((seg) => MARK_SET.has(seg[2]));
        if (!markable.length) return;

        const progressBar = findProgressBar();
        if (!progressBar) return;

        const container = document.createElement("div");
        container.id = "sblite-markers";
        Object.assign(container.style, {
            position: "absolute",
            top: "0",
            left: "0",
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            zIndex: "30"
        });

        for (const [start, end, category] of markable) {
            const left = Math.max(0, Math.min(100, (start / duration) * 100));
            const width = Math.max(0, Math.min(100 - left, ((end - start) / duration) * 100));

            const marker = document.createElement("div");
            Object.assign(marker.style, {
                position: "absolute",
                top: "0",
                left: `${left}%`,
                width: `${width}%`,
                height: "100%",
                backgroundColor: CATEGORY_COLORS[category] || FALLBACK_COLOR,
                pointerEvents: "none"
            });
            container.appendChild(marker);
        }

        progressBar.appendChild(container);
    }

    // Whether a duration value is usable (not missing, NaN, or zero).
    // video.duration reports NaN/0 before metadata loads, so this check
    // recurs anywhere we're about to do math with a duration.
    function isValidDuration(duration) {
        return typeof duration === "number" && duration > 0 && !Number.isNaN(duration);
    }

    // Returns the first segment tuple that contains `time`, or null if
    // `time` doesn't fall inside any segment.
    function findSegmentAt(time, segments) {
        for (const seg of segments) {
            if (time >= seg[0] && time < seg[1]) return seg;
        }
        return null;
    }

    // Whether a segment's category is configured to be auto-skipped.
    function isSkippable(seg) {
        return SKIP_SET.has(seg[2]);
    }

    // Removes all event listeners previously attached by
    // attachPlaybackHandlers, if any. Called before attaching to a
    // (possibly new) <video> element to avoid listener leaks/duplicates.
    function detachPlaybackHandlers() {
        if (currentVideoEl) {
            if (timeupdateHandler) currentVideoEl.removeEventListener("timeupdate", timeupdateHandler);
            if (durationchangeHandler) currentVideoEl.removeEventListener("durationchange", durationchangeHandler);
            if (seekingHandler) currentVideoEl.removeEventListener("seeking", seekingHandler);
        }
        timeupdateHandler = null;
        durationchangeHandler = null;
        seekingHandler = null;
    }

    // Wires up the core playback behavior on `videoEl`: auto-skip on
    // "timeupdate", manual-seek detection on "seeking" (so deliberately
    // seeking into a segment suppresses the next auto-skip for it), and
    // marker re-rendering on "durationchange" (since YouTube can reuse the
    // same <video> element across ads/content with a changing duration).
    function attachPlaybackHandlers(videoEl) {
        detachPlaybackHandlers();
        programmaticSeek = false;
        suppressedSegment = null;

        timeupdateHandler = () => {
            if (!currentSegments.length) return;
            const seg = findSegmentAt(videoEl.currentTime, currentSegments);

            if (!seg) {
                suppressedSegment = null;
                return;
            }

            // Not in SKIP_CATEGORIES (may still be in MARK_CATEGORIES and
            // shown on the timeline) — leave it playing.
            if (!isSkippable(seg)) return;

            if (seg === suppressedSegment) {
                return;
            }

            // Clamp the skip target below the real video duration. Segment end
            // times are community-submitted and sometimes land at/past the
            // actual duration; seeking there gets silently clamped back down by
            // the browser, which then still satisfies our t < end check on the
            // next tick — causing a rapid skip loop that flickers between the
            // last frame and YouTube's own end screen.
            const duration = videoEl.duration;
            let target = seg[1];
            if (isValidDuration(duration) && target >= duration) {
                target = Math.max(seg[0], duration - 0.25);
            }

            // Nothing meaningful left to skip to (segment runs to the very end).
            if (target <= videoEl.currentTime) return;

            programmaticSeek = true;
            videoEl.currentTime = target;
        };

        seekingHandler = () => {
            if (programmaticSeek) {
                programmaticSeek = false;
                return;
            }
            suppressedSegment = findSegmentAt(videoEl.currentTime, currentSegments);
        };

        durationchangeHandler = () => {
            if (currentSegments.length && isValidDuration(videoEl.duration)) {
                renderMarkers(currentSegments, videoEl.duration);
            }
        };

        videoEl.addEventListener("timeupdate", timeupdateHandler);
        videoEl.addEventListener("durationchange", durationchangeHandler);
        videoEl.addEventListener("seeking", seekingHandler);
        currentVideoEl = videoEl;

        durationchangeHandler();
    }

    // Entry point run whenever the active video ID changes: resets state,
    // (re)attaches playback handlers to the current <video> element, fetches
    // segments for the new video, and renders markers once both the
    // segments and the video's duration are available.
    async function handleVideoChange() {
        const videoID = getVideoID();
        if (!videoID || videoID === currentVideoID) return;

        currentVideoID = videoID;
        currentSegments = [];
        clearMarkers();

        const videoEl = findVideoElement();
        if (!videoEl) return;

        attachPlaybackHandlers(videoEl);

        const segments = await fetchSegments(videoID);
        if (videoID !== currentVideoID) return;
        currentSegments = segments;

        if (isValidDuration(videoEl.duration)) {
            renderMarkers(currentSegments, videoEl.duration);
        }
    }

    document.addEventListener("yt-navigate-finish", () => {
        setTimeout(handleVideoChange, 300);
    });

    let lastHref = location.href;
    setInterval(() => {
        if (location.href !== lastHref) {
            lastHref = location.href;
            setTimeout(handleVideoChange, 300);
        }
    }, 1000);

    setInterval(() => {
        const videoEl = findVideoElement();
        if (videoEl && videoEl !== currentVideoEl) {
            attachPlaybackHandlers(videoEl);
        }
        if (currentSegments.length && !document.getElementById("sblite-markers") && videoEl && isValidDuration(videoEl.duration)) {
            renderMarkers(currentSegments, videoEl.duration);
        }
    }, 2000);

    handleVideoChange();
})();
