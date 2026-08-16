# SponsorBlock Lite

A minimal Violentmonkey userscript that auto-skips sponsor segments on YouTube using the [SponsorBlock](https://sponsor.ajay.app/) API — without the UI overhead of the official browser extension.

> **Note:** This script was vibecoded — written through an extended back-and-forth with an AI assistant (Claude) rather than hand-written from scratch. It's been tested and works as intended, but review the code yourself before running it, as you should with any userscript that touches your browsing.

## Why this exists

The official SponsorBlock browser extension is great, but it comes with a few things I didn't want:

- It modifies YouTube's own UI in several places, and not all of that is possible to fully disable.
- I wanted something lightweight: a single userscript file, configuration done directly in the script itself, no "Pride" design toggle.

So this is a from-scratch reimplementation of just the part I actually use: fetching segment data and skipping/marking it, with essentially zero footprint on YouTube's native look and feel.

## Features

- Auto-skips sponsor/self-promo segments during playback (configurable).
- Draws subtle colored markers on YouTube's native progress bar — no separate UI, no injected panels.
- Fully configurable: which categories are fetched, which are shown, which are skipped, and what colors they use.

## How it works

1. **Detect which video is active.** YouTube is a single-page app, so navigating between videos never triggers a full page reload. The script listens for YouTube's own `yt-navigate-finish` event (plus a polling fallback) to detect when the active video ID changes.

2. **Look up segments.** For the current video ID, the script hashes it with SHA-256 and sends only the first few hex characters to the SponsorBlock API — the same k-anonymous hash-prefix lookup the official extension uses. The request only ever asks for the categories the script is configured to use (see [Configuration](#configuration)). Results are cached in memory for the life of the browser tab.

3. **Draw timeline markers.** Once segment data and the video's duration are known, colored bars are overlaid directly on YouTube's own progress bar element, positioned by percentage. This tracks the real progress bar's size, position, and hover behavior automatically, without touching YouTube's native chapter data.

4. **Auto-skip during playback.** A `timeupdate` listener on the video element checks the current playback position against known segments on every tick. When playback enters a segment configured to be skipped, playback jumps to the segment's end — unless you manually seeked into that exact segment on purpose, in which case the script backs off and lets you watch it.

5. **Stay in sync with YouTube's quirks.** A few defensive mechanisms handle things outside the script's control: markers re-render whenever the video's real duration becomes known (YouTube reuses the same `<video>` element across ads and content, so duration can change after the first render); a periodic check re-attaches to a new video element or rebuilds the marker overlay if YouTube's own UI updates wipe it out; and skip targets are clamped below the real video duration to avoid a flicker loop at the very end of a video.

## Installation

1. Install a userscript manager, such as [Violentmonkey](https://violentmonkey.github.io/). It doesn't rely on anything manager- or browser-specific beyond the standard `GM_xmlhttpRequest`/`@connect` metadata common across all of them.
2. Open [sponsorblock-lite.user.js](https://github.com/8555/sponsorblock-lite/raw/refs/heads/main/sponsorblock-lite.user.js) from this repository — your userscript manager should detect it and offer to install it (click on the Raw button if not).
3. Alternatively, open your userscript manager's dashboard, create a new script, and paste in the contents of `sponsorblock-lite.user.js`.
4. Reload any open YouTube tabs.

No further setup is required — it works immediately with sensible defaults (see below).

## Configuration

All configuration is done directly inside the script file, in a clearly marked block near the top. Open it in your userscript manager's editor and adjust the constants there.

| Setting | What it controls |
|---|---|
| `API_BASE` | Which SponsorBlock server to query. Defaults to the official public instance. |
| `MARK_CATEGORIES` | Which segment categories get a colored marker drawn on the timeline. |
| `SKIP_CATEGORIES` | Which segment categories get automatically skipped during playback. |
| `CATEGORY_COLORS` | Marker color per category (hex codes). |
| `FALLBACK_COLOR` | Color used for any marked category without an explicit entry in `CATEGORY_COLORS`. |
| `HASH_PREFIX_LENGTH` | How many hex characters of the video-ID hash are sent to the API (affects the anonymity/precision tradeoff — 4 is SponsorBlock's own recommended minimum). |

A few important details:

- **`MARK_CATEGORIES` and `SKIP_CATEGORIES` are fully independent.** A category can be in one, the other, both, or neither. A category in `SKIP_CATEGORIES` but not `MARK_CATEGORIES` is still skipped, it just won't get a timeline marker. A category in `MARK_CATEGORIES` but not `SKIP_CATEGORIES` is shown on the timeline but never auto-skipped, so you can see it and manually seek in if you're curious.
- **The API request only ever asks for the union of both lists**, computed automatically — never anything hardcoded and never more than the script will actually use.
- **Forward-compatible with new SponsorBlock categories.** If SponsorBlock adds a new category in the future, this script keeps working with zero code changes — a category not listed in either config array is simply never requested, cached, marked, or skipped. To start using a new category, just add its name to `MARK_CATEGORIES` and/or `SKIP_CATEGORIES` (and optionally give it a color in `CATEGORY_COLORS`).
- See the [SponsorBlock category reference](https://wiki.sponsor.ajay.app/w/Types) for the full, current list of valid category names.

## Compatibility

Tested on **Firefox with Violentmonkey**. It doesn't rely on anything Firefox- or Violentmonkey-specific, so it should also work on other browsers and other userscript managers (Tampermonkey, Greasemonkey, etc.), but those combinations haven't been verified. If you run into issues on a different setup, feel free to open an issue or a pull request.
