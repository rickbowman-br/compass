/*!
 * Compass embedded feedback widget.
 *
 * Installed on a page Compass does not serve, with one tag:
 *
 *   <script src="https://compass.example.com/embed/widget.js"
 *           data-compass-token="cmpfb_…" defer></script>
 *
 * ## The one rule that matters most in this file
 *
 * Every comment body and author name rendered here was typed by a member of the
 * public and is being painted into a document that belongs to someone else. So
 * this file never assigns `innerHTML`, `outerHTML`, or `insertAdjacentHTML` — not
 * once, and not for a value that "looks safe". Text reaches the DOM through
 * `textContent` and structure through `createElement`. The only string that ever
 * becomes markup is the stylesheet below, which is a literal authored here and
 * contains no interpolation; it is assigned with `textContent` on a `<style>`
 * element rather than `innerHTML` so even that is not an exception to the rule.
 *
 * ## Why there is no build step
 *
 * The file is served verbatim from `public/`, so it is plain ES2018 in one IIFE:
 * no imports, no transpilation, no bundler. That also means it is outside ESLint,
 * `tsc`, and the colour gate, which only scan `.ts`/`.tsx` (and the colour gate
 * only `app/` and `components/`). `__tests__/embed-widget.test.ts` loads *this
 * file* off disk and executes it, and is the only automated check on these bytes.
 * Assume nothing else will catch a mistake here.
 *
 * ## Fail soft, everywhere
 *
 * An uncaught error in this script becomes a bug report against a page whose
 * owner did not write it. Every entry point and every async boundary is wrapped,
 * and a failure degrades a feature rather than the page.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */

  /**
   * The single global this file claims. It doubles as the double-inclusion guard:
   * two copies of this tag on one page (a partial re-render, a tag manager firing
   * twice, a developer pasting the snippet into both a layout and a page) must
   * mount one widget, not two overlapping ones.
   */
  var GLOBAL_KEY = "__compassFeedbackWidget";

  /**
   * The attribute names are `data-compass-*`, and that is not a stylistic choice.
   * `components/settings/feedback-sources-panel.tsx` generates the snippet Compass
   * hands an admin to paste, and it emits `data-compass-token`. If this file looked
   * for anything else it would silently ignore a correctly configured page — a page
   * that *looks* right in View Source, which is the worst kind of bug to chase. The
   * prefix also keeps these attributes from colliding with the host page's own
   * tooling, since they live on a script tag in a document Compass does not own.
   * Do not "tidy" these names without changing that file in the same commit.
   */
  var TOKEN_ATTR = "data-compass-token";
  var PAGE_PATH_ATTR = "data-compass-page-path";

  /** Mirrors MAX_BODY_LENGTH in app/api/embed/comments/route.ts. */
  var MAX_BODY_LENGTH = 4000;
  /** Mirrors MAX_SELECTOR_LENGTH in the same route. */
  var MAX_SELECTOR_LENGTH = 1000;

  /** ~24 polls/minute, the same cadence as the popup, well inside 120 reads/min. */
  var POLL_INTERVAL_MS = 2500;
  /** Matches the popup's own ceiling so neither outlives the other. */
  var POLL_CEILING_MS = 10 * 60 * 1000;
  /**
   * How long to keep polling after the popup is first seen closed. The visitor may
   * legitimately close it *after* signing in — the handoff is already deposited by
   * then — so a closed popup is a hint to stop soon, never an instant failure.
   */
  var POLL_CLOSED_GRACE_MS = 45 * 1000;

  /** Capture caps. Wide enough to read, small enough to stay far under the 400 KiB server cap. */
  var CAPTURE_MAX_WIDTH = 480;
  var CAPTURE_JPEG_QUALITY = 0.7;
  /** Mirrors EMBED_SCREENSHOT_MAX_BYTES in lib/embed-screenshots.ts. */
  var CAPTURE_MAX_BYTES = 400 * 1024;
  /**
   * A CSP that forbids our origin in `script-src` makes the vendor tag fire neither
   * `load` nor `error` in some browsers, so the capture would hang forever without
   * this. A hung capture is invisible; a skipped one is not.
   */
  var VENDOR_LOAD_TIMEOUT_MS = 8000;

  /* ------------------------------------------------------------------ *
   * Configuration, read from our own script tag
   * ------------------------------------------------------------------ */

  /**
   * `document.currentScript` is the correct source and is right whenever this file
   * is loaded by a plain (even `defer`red) classic script tag.
   *
   * It is `null` in three cases that all happen in practice, hence the fallback: a
   * module or `async` load, evaluation from a callback rather than during parsing,
   * and any test harness that evaluates this source directly rather than fetching
   * it through a tag — which is exactly what `__tests__/embed-widget.test.ts` does.
   * The fallback query keys off the token attribute because that is the one
   * attribute the install snippet is guaranteed to carry.
   */
  function resolveScriptTag() {
    var current = document.currentScript;
    if (current && current.getAttribute && current.getAttribute(TOKEN_ATTR)) return current;
    return document.querySelector("script[" + TOKEN_ATTR + "]");
  }

  var scriptTag = resolveScriptTag();
  if (!scriptTag) return;

  var embedToken = (scriptTag.getAttribute(TOKEN_ATTR) || "").trim();
  if (!embedToken) return;

  /**
   * The API origin is derived from where this file was loaded from, never
   * hard-coded. Compass runs on a different host per deployment (production,
   * previews, self-hosted), and the same bytes have to work on all of them.
   *
   * `src` is empty if someone inlined this source instead of linking it; the page's
   * own origin is then the only defensible guess.
   */
  var API_BASE;
  try {
    var rawSrc = scriptTag.getAttribute("src");
    API_BASE = rawSrc ? new URL(rawSrc, window.location.href).origin : window.location.origin;
  } catch (err) {
    // A `src` that will not parse. This script's own origin is the only sensible
    // fallback, and it is the right answer in every case but a malformed tag.
    warn("script src", err);
    API_BASE = window.location.origin;
  }

  var pagePath = (scriptTag.getAttribute(PAGE_PATH_ATTR) || "").trim() || window.location.pathname;

  if (window[GLOBAL_KEY]) return;
  // Claimed before any async work starts, so a second copy of the tag that begins
  // evaluating while our first fetch is in flight still bails.
  window[GLOBAL_KEY] = { mounted: false };

  /* ------------------------------------------------------------------ *
   * Small utilities
   * ------------------------------------------------------------------ */

  /** Wraps a callback so a throw inside it can never reach the host page. */
  function guarded(label, fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (err) {
        warn(label, err);
        return undefined;
      }
    };
  }

  function warn(label, err) {
    try {
      if (window.console && window.console.warn) {
        window.console.warn("[compass-feedback] " + label, err);
      }
    } catch (ignored) {
      /**
       * A page whose console has been replaced with something that throws is not
       * worth failing over, and this is the one place that cannot report its own
       * failure.
       *
       * `void` is how the rest of this file discards a value it must name but will
       * not use. The binding cannot simply be omitted: `catch {}` is ES2019 and this
       * file targets ES2018, and the repository's lint rules do not exempt an unused
       * caught error however it is spelled.
       */
      void ignored;
    }
  }

  /**
   * The only way an element is built in this file.
   *
   * `text` goes through `textContent`, which is what makes an author name of
   * `<img src=x onerror=alert(1)>` render as those characters instead of becoming
   * an element. Attributes are set individually via `setAttribute` — never by
   * assembling a markup string.
   */
  function make(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key) && attrs[key] != null) {
          node.setAttribute(key, String(attrs[key]));
        }
      }
    }
    if (text != null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && isFinite(value);
  }

  function scrollLeft() {
    return typeof window.scrollX === "number" ? window.scrollX : window.pageXOffset || 0;
  }

  function scrollTop() {
    return typeof window.scrollY === "number" ? window.scrollY : window.pageYOffset || 0;
  }

  function docWidth() {
    var el = document.documentElement;
    return Math.max((el && el.scrollWidth) || 0, 1);
  }

  function docHeight() {
    var el = document.documentElement;
    return Math.max((el && el.scrollHeight) || 0, 1);
  }

  function relativeTime(iso) {
    var then = Date.parse(iso);
    if (!isFinite(then)) return "";
    var seconds = Math.round((Date.now() - then) / 1000);
    if (seconds < 0) return "just now";
    if (seconds < 45) return "just now";
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    var days = Math.round(hours / 24);
    if (days < 30) return days + (days === 1 ? " day ago" : " days ago");
    var months = Math.round(days / 30);
    if (months < 12) return months + (months === 1 ? " month ago" : " months ago");
    var years = Math.round(months / 12);
    return years + (years === 1 ? " year ago" : " years ago");
  }

  /* ------------------------------------------------------------------ *
   * Visitor token storage
   * ------------------------------------------------------------------ */

  /**
   * Where the visitor's credential lives, and why it is safe for it to live there.
   *
   * This `localStorage` belongs to **the prototype page's origin, not Compass's**.
   * Every script on that page can read it, including any third-party tag the page
   * owner has installed. That is the whole reason the credential kept here is a
   * scoped, short-lived visitor token minted by POST /api/embed/session rather than
   * the visitor's portal session cookie: a leaked portal session would authorize
   * the roadmap and the feedback portal for thirty days, while a leaked visitor
   * token authorizes commenting through this one feedback source until it expires.
   * See lib/embed-visitor.ts for the other half of that argument.
   *
   * The key is scoped by a suffix of the embed token so two widgets on the same
   * origin (two prototypes on one static host) do not share an identity. A suffix
   * and not the whole token, so the key is not a second copy of a credential.
   */
  var STORAGE_KEY = "compass.embedFeedback.visitor." + embedToken.slice(-12);

  /**
   * Safari in private mode throws on `localStorage` access, and some corporate
   * builds disable it outright. Degrading to a value held in this closure keeps the
   * widget fully usable for the life of the page instead of breaking boot; the
   * visitor simply signs in again on the next navigation.
   */
  var memoryStore = null;
  var storageWorks = true;

  function readStored() {
    var raw = null;
    if (storageWorks) {
      try {
        raw = window.localStorage.getItem(STORAGE_KEY);
      } catch (err) {
        // Worth saying out loud once: the symptom a developer sees otherwise is a
        // visitor who has to sign in again on every page, with no clue why.
        warn("storage read", err);
        storageWorks = false;
      }
    }
    if (raw == null) raw = memoryStore;
    if (!raw) return null;

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Only this widget writes this key, so anything unparseable means another
      // script is using it too — which the developer needs to know about.
      warn("storage parse", err);
      return null;
    }
    if (!parsed || typeof parsed.token !== "string" || !parsed.token) return null;

    // `expiresAt` is honoured locally so an expired token is not presented at all.
    // The server is still the authority — it re-checks on every request — but not
    // sending a credential we already know is dead saves a pointless round trip and
    // keeps the widget from rendering a signed-in state it cannot back up.
    if (parsed.expiresAt) {
      var expires = Date.parse(parsed.expiresAt);
      if (isFinite(expires) && expires <= Date.now()) {
        clearStored();
        return null;
      }
    }
    return parsed;
  }

  function writeStored(token, expiresAt) {
    var raw = JSON.stringify({ token: token, expiresAt: expiresAt || null });
    memoryStore = raw;
    if (!storageWorks) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, raw);
    } catch (err) {
      warn("storage write", err);
      storageWorks = false;
    }
  }

  function clearStored() {
    memoryStore = null;
    if (!storageWorks) return;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      warn("storage clear", err);
      storageWorks = false;
    }
  }

  function visitorToken() {
    var stored = readStored();
    return stored ? stored.token : null;
  }

  /* ------------------------------------------------------------------ *
   * API layer
   * ------------------------------------------------------------------ */

  var state = {
    artifactId: null,
    comments: [],
    identity: null, // { email, name } once signed in
    open: false,
    picking: false,
    readBlocked: false, // set by a 403; see refreshComments
    draftAnchor: null,
    pendingCapture: null,
    selectedId: null,
    busy: false
  };

  /**
   * Every request to Compass goes through here, so the invariants hold in one place.
   *
   * - `Authorization: Bearer <embedToken>` always. It says *this page may talk to
   *   this feedback source*; it is not an identity.
   * - `X-Compass-Visitor` only when we actually hold a visitor token.
   * - **`credentials` is deliberately never set.** The default (`same-origin`) sends
   *   no cookies on a cross-origin request, which is what we want. Setting
   *   `"include"` would be worse than useless: the server never returns
   *   `Access-Control-Allow-Credentials`, so a credentialed request fails the CORS
   *   check outright and the widget would stop working entirely.
   * - Never resolves to a rejected promise for an HTTP error. Callers branch on
   *   `result.ok` / `result.status`; only a genuine network failure surfaces as
   *   `result.networkError`.
   */
  function request(path, options) {
    options = options || {};
    var headers = { Authorization: "Bearer " + embedToken };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (!options.anonymous) {
      var visitor = visitorToken();
      if (visitor) headers["X-Compass-Visitor"] = visitor;
    }

    var init = { method: options.method || "GET", headers: headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);

    return window
      .fetch(API_BASE + "/api/embed" + path, init)
      .then(function (response) {
        var parse =
          response && typeof response.json === "function"
            ? response.json().catch(function () {
                return null;
              })
            : Promise.resolve(null);
        return parse.then(function (data) {
          var result = {
            ok: !!response.ok,
            status: response.status,
            data: data,
            rateLimited: response.status === 429,
            authRequired: response.status === 401 && !!data && data.code === "PORTAL_AUTH_REQUIRED"
          };

          // A PORTAL_AUTH_REQUIRED 401 from any endpoint means the same thing — the
          // visitor is not signed in here — and the recovery is always to forget the
          // token and offer sign-in.
          //
          // The nonce poll is the one caller that opts out via `ignoreAuthCode`,
          // because on POST /api/embed/session that same code means "this nonce is
          // not claimable (yet)", which is the normal answer while the visitor is
          // still reading their email. Treating it as a session failure there would
          // abort every sign-in on its first poll.
          if (result.authRequired && !options.ignoreAuthCode) {
            clearStored();
            state.identity = null;
          }
          return result;
        });
      })
      .catch(function (err) {
        warn("request failed: " + path, err);
        return { ok: false, status: 0, data: null, networkError: true };
      });
  }

  /* ------------------------------------------------------------------ *
   * Shadow DOM shell
   * ------------------------------------------------------------------ */

  /**
   * The entire stylesheet, and the only string in this file that becomes CSS.
   *
   * It is a literal authored here with no interpolation of any kind — no API value,
   * no visitor input, nothing from the host page — which is why it is safe to hand
   * to the parser. It is still assigned with `textContent` rather than `innerHTML`,
   * so this file contains zero uses of the forbidden sinks and a reviewer can grep
   * for them and expect no hits.
   *
   * Colours are literal hex. Tailwind classes would do nothing inside a shadow root
   * and the repository's colour gate does not scan this file, so there is no token
   * system to honour here.
   *
   * `:host { all: initial }` is what stops the host page's inherited properties
   * (font, colour, line-height, letter-spacing, text-transform) from leaking in.
   * Shadow DOM already blocks the page's *selectors*; it does not block inheritance,
   * so without this a page with `body { text-transform: uppercase }` would shout.
   * Our own inline styles on the host element win over it, being inline.
   */
  var CSS = [
    ":host { all: initial; }",
    ".layer { position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;",
    "  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;",
    "  font-size: 14px; line-height: 1.45; color: #1f2430; text-align: left; letter-spacing: normal;",
    "  text-transform: none; font-weight: 400; font-style: normal; -webkit-font-smoothing: antialiased; }",
    ".layer * { box-sizing: border-box; }",

    /* Launcher */
    ".launcher { pointer-events: auto; position: fixed; right: 20px; bottom: 20px; display: flex;",
    "  align-items: center; gap: 8px; height: 44px; padding: 0 16px; border: 0; border-radius: 22px;",
    "  background: #1f2430; color: #ffffff; font: inherit; font-weight: 500; cursor: pointer;",
    "  box-shadow: 0 6px 20px rgba(15, 18, 25, 0.28); transition: background-color 120ms ease, transform 120ms ease; }",
    ".launcher:hover { background: #343b4d; }",
    ".launcher:active { transform: scale(0.97); }",
    ".launcher:focus-visible { outline: 2px solid #ffffff; outline-offset: 2px; }",
    ".launcher .count { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px;",
    "  background: #4f7cff; color: #ffffff; font-size: 12px; line-height: 20px; text-align: center; }",

    /* Panel */
    ".panel { pointer-events: auto; position: fixed; right: 20px; bottom: 76px; display: none;",
    "  flex-direction: column; width: 360px; max-width: calc(100vw - 40px); max-height: min(70vh, 620px);",
    "  border: 1px solid #dfe3ec; border-radius: 14px; background: #ffffff; overflow: hidden;",
    "  box-shadow: 0 18px 48px rgba(15, 18, 25, 0.22); }",
    ".panel[data-open='true'] { display: flex; }",
    ".head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 10px; border-bottom: 1px solid #eef0f6; }",
    ".title { flex: 1; margin: 0; font-size: 14px; font-weight: 600; }",
    ".iconbtn { display: inline-flex; align-items: center; justify-content: center; min-width: 30px;",
    "  height: 30px; padding: 0 9px; border: 1px solid #dfe3ec; border-radius: 8px; background: #ffffff;",
    "  color: #1f2430; font: inherit; font-size: 12px; cursor: pointer; transition: background-color 120ms ease; }",
    ".iconbtn:hover { background: #f3f5fa; }",
    ".iconbtn:focus-visible { outline: 2px solid #4f7cff; outline-offset: 1px; }",
    ".iconbtn[aria-pressed='true'] { background: #1f2430; border-color: #1f2430; color: #ffffff; }",
    ".who { padding: 8px 12px; border-bottom: 1px solid #eef0f6; background: #f8f9fc; font-size: 12px;",
    "  color: #5b6278; display: flex; align-items: center; gap: 8px; }",
    ".who .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".body { flex: 1; overflow-y: auto; padding: 4px 12px 12px; }",

    /* Messages */
    ".msg { margin: 10px 0 0; padding: 8px 10px; border-radius: 8px; font-size: 12px; }",
    ".msg[data-tone='error'] { background: #fdeceb; color: #8a1c14; }",
    ".msg[data-tone='info'] { background: #eef2ff; color: #2b3a7a; }",
    ".msg:empty { display: none; }",

    /* Threads */
    ".empty { margin: 18px 0; color: #5b6278; font-size: 13px; }",
    ".thread { margin-top: 12px; padding-top: 12px; border-top: 1px solid #eef0f6; }",
    ".thread:first-child { border-top: 0; }",
    ".thread[data-selected='true'] { background: #f4f7ff; border-radius: 8px; padding: 10px; }",
    ".meta { display: flex; align-items: baseline; gap: 6px; font-size: 12px; color: #5b6278; }",
    ".author { color: #1f2430; font-weight: 600; }",
    ".text { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }",
    ".shot { display: block; margin-top: 8px; max-width: 100%; border: 1px solid #dfe3ec; border-radius: 6px; }",
    ".replies { margin: 8px 0 0; padding-left: 10px; border-left: 2px solid #eef0f6; }",
    ".reply { margin-top: 8px; }",

    /* Composer */
    ".composer { border-top: 1px solid #eef0f6; padding: 10px 12px 12px; background: #ffffff; }",
    ".chip { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; padding: 5px 8px;",
    "  border-radius: 999px; background: #eef2ff; color: #2b3a7a; font-size: 11px; }",
    ".chip .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".chip button { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer;",
    "  text-decoration: underline; padding: 0; }",
    "textarea { display: block; width: 100%; min-height: 62px; max-height: 180px; padding: 8px;",
    "  border: 1px solid #dfe3ec; border-radius: 8px; background: #ffffff; color: #1f2430; font: inherit;",
    "  font-size: 13px; resize: vertical; }",
    "textarea:focus-visible { outline: 2px solid #4f7cff; outline-offset: -1px; }",
    ".row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }",
    ".count { flex: 1; font-size: 11px; color: #5b6278; }",
    ".count[data-over='true'] { color: #8a1c14; font-weight: 600; }",
    ".send { border: 0; border-radius: 8px; padding: 7px 14px; background: #4f7cff; color: #ffffff;",
    "  font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }",
    ".send:hover { background: #3f68e0; }",
    ".send[disabled] { background: #b9c3dd; cursor: not-allowed; }",
    ".send:focus-visible { outline: 2px solid #1f2430; outline-offset: 2px; }",

    /* Pick mode + pins */
    ".hl { position: fixed; pointer-events: none; border: 2px solid #4f7cff;",
    "  background: rgba(79, 124, 255, 0.12); border-radius: 3px; display: none; z-index: 1; }",
    ".hl[data-on='true'] { display: block; }",
    ".hint { pointer-events: none; position: fixed; left: 50%; top: 18px; transform: translateX(-50%);",
    "  display: none; padding: 7px 14px; border-radius: 999px; background: #1f2430; color: #ffffff;",
    "  font-size: 12px; box-shadow: 0 6px 20px rgba(15, 18, 25, 0.28); }",
    ".hint[data-on='true'] { display: block; }",
    ".pin { pointer-events: auto; position: fixed; width: 26px; height: 26px; padding: 0;",
    "  border: 2px solid #ffffff; border-radius: 50% 50% 50% 2px; background: #4f7cff; color: #ffffff;",
    "  font: inherit; font-size: 11px; font-weight: 600; cursor: pointer;",
    "  box-shadow: 0 2px 8px rgba(15, 18, 25, 0.3); }",
    ".pin:focus-visible { outline: 2px solid #1f2430; outline-offset: 2px; }",
    ".pin[data-selected='true'] { background: #1f2430; }",

    /* An operator who asked for less motion gets none of ours. */
    "@media (prefers-reduced-motion: reduce) {",
    "  .layer *, .layer *::before, .layer *::after { transition: none !important; animation: none !important; }",
    "}"
  ].join("\n");

  var host = null;
  var shadow = null;
  var ui = {};

  function mount() {
    host = document.createElement("div");
    host.setAttribute("data-compass-feedback", "");
    /**
     * The only styling this file puts on the host page. A near-maximal z-index
     * because the widget has to sit above whatever the prototype does, and a
     * zero-size fixed box so the host itself can never intercept a click; the
     * interactive pieces inside the shadow root are `position: fixed` in their own
     * right and opt back into pointer events individually.
     *
     * Caveat worth knowing: a `transform`, `filter`, or `will-change` on an ancestor
     * creates a containing block for `position: fixed`, so appending to `<body>`
     * would break positioning on a page that transforms the body. We append to
     * `<html>` to keep that surface as small as possible.
     */
    host.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;margin:0;padding:0;border:0;z-index:2147483000;";

    shadow = host.attachShadow({ mode: "open" });

    var style = document.createElement("style");
    // `textContent`, not `innerHTML`. See the note above CSS.
    style.textContent = CSS;
    shadow.appendChild(style);

    var layer = make("div", { "class": "layer" });

    ui.hint = make("div", { "class": "hint", "data-compass": "hint", "data-on": "false" },
      "Click any element to comment on it \u2014 press Escape to cancel");
    ui.highlight = make("div", { "class": "hl", "data-compass": "highlight", "data-on": "false" });
    ui.pins = make("div", { "class": "pins", "data-compass": "pins" });

    ui.launcher = make(
      "button",
      { type: "button", "class": "launcher", "data-compass": "launcher", "aria-label": "Open Compass feedback", "aria-expanded": "false" }
    );
    ui.launcherLabel = make("span", null, "Feedback");
    ui.launcherCount = make("span", { "class": "count", "data-compass": "count" });
    ui.launcherCount.hidden = true;
    ui.launcher.appendChild(ui.launcherLabel);
    ui.launcher.appendChild(ui.launcherCount);

    ui.panel = make("div", {
      "class": "panel",
      "data-compass": "panel",
      "data-open": "false",
      role: "dialog",
      "aria-label": "Compass feedback",
      "aria-modal": "false",
      tabindex: "-1"
    });

    var head = make("div", { "class": "head" });
    head.appendChild(make("h2", { "class": "title" }, "Feedback"));
    ui.pick = make(
      "button",
      { type: "button", "class": "iconbtn", "data-compass": "pick", "aria-pressed": "false", "aria-label": "Comment on an element" },
      "Pick element"
    );
    ui.close = make(
      "button",
      { type: "button", "class": "iconbtn", "data-compass": "close", "aria-label": "Close feedback" },
      "\u2715"
    );
    head.appendChild(ui.pick);
    head.appendChild(ui.close);
    ui.panel.appendChild(head);

    ui.who = make("div", { "class": "who", "data-compass": "who" });
    ui.panel.appendChild(ui.who);

    ui.body = make("div", { "class": "body", "data-compass": "threads" });
    ui.panel.appendChild(ui.body);

    ui.composer = make("div", { "class": "composer" });
    ui.chip = make("div", { "class": "chip", "data-compass": "anchor-chip" });
    ui.chip.hidden = true;
    ui.composer.appendChild(ui.chip);
    ui.input = make("textarea", {
      "data-compass": "composer-body",
      "aria-label": "Your feedback",
      placeholder: "Describe what you see\u2026",
      maxlength: String(MAX_BODY_LENGTH + 200)
    });
    ui.composer.appendChild(ui.input);
    var row = make("div", { "class": "row" });
    ui.count = make("span", { "class": "count", "data-compass": "counter", "data-over": "false" });
    ui.send = make(
      "button",
      { type: "button", "class": "send", "data-compass": "composer-submit" },
      "Send"
    );
    row.appendChild(ui.count);
    row.appendChild(ui.send);
    ui.composer.appendChild(row);
    ui.message = make("div", { "class": "msg", "data-compass": "message", role: "status", "aria-live": "polite" });
    ui.composer.appendChild(ui.message);
    ui.panel.appendChild(ui.composer);

    layer.appendChild(ui.hint);
    layer.appendChild(ui.highlight);
    layer.appendChild(ui.pins);
    layer.appendChild(ui.panel);
    layer.appendChild(ui.launcher);
    shadow.appendChild(layer);

    (document.documentElement || document.body).appendChild(host);
    window[GLOBAL_KEY].mounted = true;

    wireEvents();
    updateCounter();
    renderIdentity();
  }

  /**
   * `data-tone="error"` uses `role="alert"`; informational notices stay
   * `role="status"`. Swapping the role with the tone is deliberate: a failed submit
   * must interrupt a screen reader, a "signed in" confirmation must not.
   */
  function setMessage(text, tone) {
    if (!ui.message) return;
    ui.message.textContent = text || "";
    ui.message.setAttribute("data-tone", tone || "info");
    ui.message.setAttribute("role", tone === "error" ? "alert" : "status");
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function renderIdentity() {
    if (!ui.who) return;
    clear(ui.who);

    if (state.identity) {
      var name = state.identity.name || state.identity.email || "you";
      ui.who.appendChild(make("span", { "class": "grow" }, "Signed in as " + name));
      var out = make("button", { type: "button", "class": "iconbtn", "data-compass": "signout" }, "Sign out");
      out.addEventListener("click", guarded("signout", signOut));
      ui.who.appendChild(out);
      return;
    }

    ui.who.appendChild(make("span", { "class": "grow" }, "Sign in to leave feedback."));
    var inBtn = make(
      "button",
      { type: "button", "class": "iconbtn", "data-compass": "signin", "aria-label": "Sign in to leave feedback" },
      "Sign in"
    );
    inBtn.addEventListener("click", guarded("signin", function () {
      beginSignIn();
    }));
    ui.who.appendChild(inBtn);
  }

  function updateCounter() {
    if (!ui.count || !ui.input) return;
    var length = ui.input.value.trim().length;
    var over = length > MAX_BODY_LENGTH;
    ui.count.textContent = length + " / " + MAX_BODY_LENGTH;
    ui.count.setAttribute("data-over", over ? "true" : "false");
    if (ui.send) ui.send.disabled = !!state.busy || over;
  }

  /**
   * A screenshot URL arrives in an API response, so it is treated as untrusted even
   * though the server validated it: only an absolute http(s) URL becomes an `img`
   * `src`. That refuses `javascript:` and `data:` outright rather than relying on
   * `<img>` happening to ignore them.
   */
  function safeImageUrl(value) {
    if (typeof value !== "string" || !value) return null;
    try {
      var parsed = new URL(value, API_BASE);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
      return parsed.href;
    } catch (err) {
      // Silent: this runs once per rendered comment, so a thread full of hostile
      // URLs must not turn into a console flood on the host page.
      void err;
      return null;
    }
  }

  function renderComment(comment, isReply) {
    var wrap = make("div", { "class": isReply ? "reply" : "thread", "data-compass": isReply ? "reply" : "thread" });
    wrap.setAttribute("data-comment-id", String(comment.id));
    if (!isReply && state.selectedId === comment.id) wrap.setAttribute("data-selected", "true");

    var meta = make("div", { "class": "meta" });
    // Author name via textContent: it is chosen by whoever signed in.
    meta.appendChild(make("span", { "class": "author" }, comment.authorName || "Someone"));
    meta.appendChild(make("span", null, relativeTime(comment.createdAt)));
    if (comment.edited) meta.appendChild(make("span", null, "\u00b7 edited"));
    wrap.appendChild(meta);

    // The XSS-critical line. `make(..., body)` assigns textContent, so a body of
    // `<img src=x onerror=alert(1)>` becomes those 29 characters on screen and no
    // element in the tree. __tests__/embed-widget.test.ts asserts exactly that.
    wrap.appendChild(make("p", { "class": "text", "data-compass": "comment-body" }, comment.body || ""));

    if (!isReply && comment.anchor) {
      var shot = safeImageUrl(comment.anchor.screenshotUrl);
      if (shot) {
        var img = make("img", {
          "class": "shot",
          "data-compass": "screenshot",
          src: shot,
          alt: "Screenshot of the element this comment is about",
          loading: "lazy"
        });
        wrap.appendChild(img);
      }
    }

    if (!isReply) {
      var replies = comment.replies && comment.replies.length ? comment.replies : [];
      if (replies.length) {
        var list = make("div", { "class": "replies" });
        for (var i = 0; i < replies.length; i++) list.appendChild(renderComment(replies[i], true));
        wrap.appendChild(list);
      }
      wrap.appendChild(buildReplyForm(comment));
    }

    return wrap;
  }

  function buildReplyForm(comment) {
    var form = make("div", { "data-compass": "reply-form" });
    form.setAttribute("data-comment-id", String(comment.id));

    var input = make("textarea", {
      "data-compass": "reply-body",
      "aria-label": "Reply to " + (comment.authorName || "this comment"),
      placeholder: "Reply\u2026"
    });
    input.setAttribute("data-comment-id", String(comment.id));

    var send = make("button", { type: "button", "class": "send", "data-compass": "reply-submit" }, "Reply");
    send.setAttribute("data-comment-id", String(comment.id));
    send.addEventListener("click", guarded("reply", function () {
      submitComment({ body: input.value, parentId: comment.id, input: input });
    }));

    var holder = make("div", { "class": "row" });
    holder.appendChild(input);
    holder.appendChild(send);
    form.appendChild(holder);
    return form;
  }

  function renderThreads() {
    if (!ui.body) return;
    clear(ui.body);

    if (state.readBlocked) {
      ui.body.appendChild(
        make(
          "p",
          { "class": "empty", "data-compass": "read-blocked" },
          "Existing feedback is not published for this workspace, so earlier comments are hidden here. You can still leave new feedback."
        )
      );
      return;
    }

    if (!state.comments.length) {
      ui.body.appendChild(
        make("p", { "class": "empty", "data-compass": "empty" }, "No feedback on this page yet. Be the first.")
      );
      return;
    }

    for (var i = 0; i < state.comments.length; i++) {
      ui.body.appendChild(renderComment(state.comments[i], false));
    }
  }

  function renderChip() {
    if (!ui.chip) return;
    clear(ui.chip);
    if (!state.draftAnchor) {
      ui.chip.hidden = true;
      return;
    }
    ui.chip.hidden = false;
    var label = state.draftAnchor.label || "element";
    ui.chip.appendChild(make("span", { "class": "grow" }, "Commenting on " + label));
    var drop = make("button", { type: "button", "data-compass": "anchor-clear" }, "remove");
    drop.addEventListener("click", guarded("anchor-clear", function () {
      state.draftAnchor = null;
      state.pendingCapture = null;
      renderChip();
    }));
    ui.chip.appendChild(drop);
  }

  function renderCount() {
    if (!ui.launcherCount) return;
    var total = 0;
    for (var i = 0; i < state.comments.length; i++) {
      total += 1 + ((state.comments[i].replies && state.comments[i].replies.length) || 0);
    }
    if (total > 0) {
      ui.launcherCount.textContent = String(total);
      ui.launcherCount.hidden = false;
    } else {
      ui.launcherCount.textContent = "";
      ui.launcherCount.hidden = true;
    }
  }

  function renderAll() {
    renderThreads();
    renderChip();
    renderCount();
    renderPins();
    updateCounter();
  }

  /* ------------------------------------------------------------------ *
   * Pins
   * ------------------------------------------------------------------ */

  /**
   * Where a stored anchor lands in the *viewport* right now.
   *
   * The selector is tried first: if it still resolves, it is the truth, because the
   * element may have moved or resized since the comment was left. The fingerprint
   * ratios are the fallback for the common case where the markup changed enough to
   * break the selector but the layout is broadly the same — they are fractions of
   * the document scroll size, so they survive a viewport of a different width.
   */
  function anchorViewportRect(anchor) {
    if (!anchor) return null;

    if (anchor.elementSelector) {
      try {
        var found = document.querySelector(anchor.elementSelector);
        // Our own host is excluded so a selector that happens to match it cannot
        // pin a comment to the widget.
        if (found && found !== host && !host.contains(found)) {
          var rect = found.getBoundingClientRect();
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        }
      } catch (err) {
        // An invalid selector is data, not a crash. Fall through to the ratios.
        // Silent because this runs for every pin on every animation frame while the
        // visitor scrolls.
        void err;
      }
    }

    var fp = anchor.elementFingerprint;
    if (fp && isFiniteNumber(fp.rectXRatio) && isFiniteNumber(fp.rectYRatio)) {
      var dw = docWidth();
      var dh = docHeight();
      return {
        left: fp.rectXRatio * dw - scrollLeft(),
        top: fp.rectYRatio * dh - scrollTop(),
        width: isFiniteNumber(fp.rectWRatio) ? fp.rectWRatio * dw : 0,
        height: isFiniteNumber(fp.rectHRatio) ? fp.rectHRatio * dh : 0
      };
    }
    return null;
  }

  function renderPins() {
    if (!ui.pins) return;
    clear(ui.pins);

    for (var i = 0; i < state.comments.length; i++) {
      var comment = state.comments[i];
      if (!comment.anchor) continue;
      var rect = anchorViewportRect(comment.anchor);
      if (!rect) continue;

      var pin = make(
        "button",
        {
          type: "button",
          "class": "pin",
          "data-compass": "pin",
          "aria-label": "Feedback from " + (comment.authorName || "someone") + ": " + String(comment.body || "").slice(0, 80)
        },
        String(i + 1)
      );
      pin.setAttribute("data-comment-id", String(comment.id));
      if (state.selectedId === comment.id) pin.setAttribute("data-selected", "true");
      positionPin(pin, rect);
      pin.addEventListener("click", guarded("pin-click", (function (id) {
        return function () {
          state.selectedId = id;
          openPanel();
          renderAll();
          focusThread(id);
        };
      })(comment.id)));
      ui.pins.appendChild(pin);
    }
  }

  function positionPin(pin, rect) {
    // Nudged up and left so the pin straddles the element's top-left corner rather
    // than covering its first characters.
    pin.style.left = Math.round(rect.left - 8) + "px";
    pin.style.top = Math.round(rect.top - 8) + "px";
    // Entirely off-screen pins are hidden rather than left to pile up at an edge.
    var off = rect.top > window.innerHeight + 40 || rect.top < -60 ||
      rect.left > window.innerWidth + 40 || rect.left < -60;
    pin.style.visibility = off ? "hidden" : "visible";
  }

  function focusThread(id) {
    if (!ui.body) return;
    var node = ui.body.querySelector('[data-compass="thread"][data-comment-id="' + cssEscape(id) + '"]');
    if (node && typeof node.scrollIntoView === "function") {
      try {
        node.scrollIntoView({ block: "nearest" });
      } catch (err) {
        // Older browsers reject the options object; where the thread scrolls to is
        // cosmetic, so this is not worth a word to anyone.
        void err;
      }
    }
  }

  /** Comment ids are cuids, but they arrive from the API, so quote defensively. */
  function cssEscape(value) {
    return String(value).replace(/["\\]/g, "\\$&");
  }

  /**
   * Repositioning is rAF-throttled because `scroll` fires far faster than a frame
   * and each pass reads layout. One read-and-write per frame is the cheapest correct
   * cadence; anything more is wasted work on the host page's scroll thread.
   */
  var frame = 0;
  function scheduleReposition() {
    if (frame) return;
    frame = window.requestAnimationFrame(function () {
      frame = 0;
      try {
        var pins = ui.pins ? ui.pins.childNodes : [];
        for (var i = 0; i < pins.length; i++) {
          var pin = pins[i];
          var id = pin.getAttribute && pin.getAttribute("data-comment-id");
          if (!id) continue;
          var comment = findComment(id);
          if (!comment) continue;
          var rect = anchorViewportRect(comment.anchor);
          if (rect) positionPin(pin, rect);
        }
        if (state.picking && pickTarget) highlight(pickTarget);
      } catch (err) {
        warn("reposition", err);
      }
    });
  }

  function findComment(id) {
    for (var i = 0; i < state.comments.length; i++) {
      if (state.comments[i].id === id) return state.comments[i];
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Element picking
   * ------------------------------------------------------------------ */

  var pickTarget = null;

  function startPicking() {
    state.picking = true;
    if (ui.pick) ui.pick.setAttribute("aria-pressed", "true");
    if (ui.hint) ui.hint.setAttribute("data-on", "true");
    closePanel(true);
    document.addEventListener("mousemove", onPickMove, true);
    document.addEventListener("click", onPickClick, true);
  }

  function stopPicking() {
    state.picking = false;
    pickTarget = null;
    if (ui.pick) ui.pick.setAttribute("aria-pressed", "false");
    if (ui.hint) ui.hint.setAttribute("data-on", "false");
    if (ui.highlight) ui.highlight.setAttribute("data-on", "false");
    document.removeEventListener("mousemove", onPickMove, true);
    document.removeEventListener("click", onPickClick, true);
  }

  /**
   * `event.target` rather than `document.elementFromPoint`. The overlay would have
   * to be excluded from hit-testing for `elementFromPoint` to see past it, and the
   * event's own target is both cheaper and already correct.
   */
  function eventTarget(event) {
    var target = event.target;
    if (!target || target.nodeType !== 1) return null;
    if (target === host || (host && host.contains(target))) return null;
    /**
     * A click on our own launcher or panel must never be read as a pick.
     *
     * A browser retargets an event crossing a shadow boundary to the host, so the
     * `contains` check above is normally enough. This second check does not depend
     * on that: it asks the node directly which tree it belongs to, which is correct
     * whether or not retargeting happened — and it is what keeps the widget's own
     * buttons working while pick mode is armed.
     */
    if (typeof target.getRootNode === "function" && shadow && target.getRootNode() === shadow) return null;
    if (target === document.documentElement || target === document.body) return null;
    return target;
  }

  var onPickMove = guarded("pick-move", function (event) {
    var target = eventTarget(event);
    if (!target) return;
    pickTarget = target;
    highlight(target);
  });

  function highlight(target) {
    if (!ui.highlight) return;
    var rect = target.getBoundingClientRect();
    ui.highlight.style.left = Math.round(rect.left) + "px";
    ui.highlight.style.top = Math.round(rect.top) + "px";
    ui.highlight.style.width = Math.round(rect.width) + "px";
    ui.highlight.style.height = Math.round(rect.height) + "px";
    ui.highlight.setAttribute("data-on", "true");
  }

  var onPickClick = guarded("pick-click", function (event) {
    var target = eventTarget(event);
    if (!target) return;
    // The click is swallowed: the visitor meant "comment on this", not "activate
    // this", and letting a prototype's own handler run would navigate away from the
    // comment they are about to write.
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();

    anchorTo(target);
    stopPicking();
    openPanel();
    if (ui.input && typeof ui.input.focus === "function") ui.input.focus();
  });

  /**
   * Builds the anchor and kicks the capture off immediately.
   *
   * The rasterise is the slow part, and starting it here means it runs while the
   * visitor types rather than after they press Send.
   */
  function anchorTo(target) {
    var selector = cssPath(target);
    var fingerprint = fingerprintOf(target);
    state.draftAnchor = {
      elementSelector: selector,
      elementFingerprint: fingerprint,
      label: describe(target)
    };
    state.pendingCapture = captureDataUrl(target);
    renderChip();
    renderPins();
  }

  function describe(target) {
    var tag = (target.tagName || "element").toLowerCase();
    var text = (target.textContent || "").replace(/\s+/g, " ").trim();
    return text ? tag + " \u201c" + text.slice(0, 40) + "\u201d" : tag;
  }

  /**
   * A CSS path good enough to re-find the element on the next visit, and short
   * enough for the route's 1000-character ceiling. Stops at the first stable id,
   * and disambiguates siblings with `:nth-of-type`.
   */
  function cssPath(target) {
    try {
      var parts = [];
      var node = target;
      var depth = 0;
      while (node && node.nodeType === 1 && depth < 10) {
        var id = node.getAttribute("id");
        // Only an id that is a valid bare CSS identifier. A generated id like
        // `:r3:` from a UI framework would produce a selector that throws.
        if (id && /^[A-Za-z][\w-]*$/.test(id)) {
          parts.unshift("#" + id);
          break;
        }
        var piece = node.tagName.toLowerCase();
        var parent = node.parentElement;
        if (parent) {
          var siblings = [];
          var kids = parent.children;
          for (var i = 0; i < kids.length; i++) {
            if (kids[i].tagName === node.tagName) siblings.push(kids[i]);
          }
          if (siblings.length > 1) {
            piece += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
          }
        }
        parts.unshift(piece);
        node = parent;
        depth++;
      }
      var selector = parts.join(" > ");
      // Over the cap it would be dropped server-side anyway; sending null is honest.
      return selector && selector.length <= MAX_SELECTOR_LENGTH ? selector : null;
    } catch (err) {
      // A selector is an optimisation; the fingerprint ratios still place the pin.
      void err;
      return null;
    }
  }

  /**
   * Exactly the six fields the route keeps — `tag`, `text`, and the four ratios.
   * Anything else is rebuilt away server-side (see `fingerprint` in the comments
   * route), so sending more would be noise that reads as intent.
   *
   * The ratios are fractions of the document scroll size rather than the viewport,
   * so they mean the same thing when the comment is read back on a different screen.
   */
  function fingerprintOf(target) {
    var rect = target.getBoundingClientRect();
    var dw = docWidth();
    var dh = docHeight();
    var out = { tag: String(target.tagName || "").toLowerCase().slice(0, 40) };

    var text = (target.textContent || "").replace(/\s+/g, " ").trim();
    if (text) out.text = text.slice(0, 200);

    var ratios = {
      rectXRatio: (rect.left + scrollLeft()) / dw,
      rectYRatio: (rect.top + scrollTop()) / dh,
      rectWRatio: rect.width / dw,
      rectHRatio: rect.height / dh
    };
    for (var key in ratios) {
      if (Object.prototype.hasOwnProperty.call(ratios, key) && isFiniteNumber(ratios[key])) {
        out[key] = ratios[key];
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Screenshots
   * ------------------------------------------------------------------ */

  var vendorPromise = null;

  /**
   * Injects the vendored html-to-image, and only when a capture is actually needed.
   *
   * Lazily, because most visitors never anchor a comment to an element and the
   * library is far larger than this widget — making every prototype page pay for it
   * on load would be the single biggest cost of installing the widget.
   */
  function loadHtmlToImage() {
    if (window.htmlToImage) return Promise.resolve(window.htmlToImage);
    if (vendorPromise) return vendorPromise;

    vendorPromise = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = API_BASE + "/vendor/html-to-image.js";
      script.async = true;
      script.setAttribute("data-compass-feedback-vendor", "");

      var settled = false;
      var timer = window.setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error("html-to-image did not load in time"));
      }, VENDOR_LOAD_TIMEOUT_MS);

      function finish(err) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (err) reject(err);
        else if (window.htmlToImage) resolve(window.htmlToImage);
        else reject(new Error("html-to-image loaded without its global"));
      }

      script.onload = function () {
        finish(null);
      };
      script.onerror = function () {
        // The usual cause is the host page's `script-src` refusing our origin.
        finish(new Error("html-to-image was blocked"));
      };
      (document.head || document.documentElement).appendChild(script);
    });
    return vendorPromise;
  }

  /**
   * Resolves the colour to paint behind a transparent element.
   *
   * A capture of an element whose own background is `transparent` composites onto
   * nothing and reads as black in a JPEG, which has no alpha channel. Walking up
   * for the first opaque ancestor background reproduces what the visitor actually
   * saw; white is the fallback because a prototype on a default page is white.
   */
  function backgroundColorFor(target) {
    try {
      var node = target;
      var depth = 0;
      while (node && node.nodeType === 1 && depth < 12) {
        var color = window.getComputedStyle(node).backgroundColor;
        if (color && color !== "transparent" && !/^rgba\([^)]*,\s*0\s*\)$/.test(color)) return color;
        node = node.parentElement;
        depth++;
      }
    } catch (err) {
      // Fall through to white. A wrong backdrop behind a transparent element is a
      // cosmetic flaw in a screenshot, not something to report.
      void err;
    }
    return "#ffffff";
  }

  /**
   * Rasterises `target` to a JPEG data URL, or resolves `null`.
   *
   * **Never rejects.** A capture is decoration on a comment; the brief is explicit
   * that a failed capture must not block the submission, so every failure path —
   * the library not loading, a CSP refusal, a `SecurityError` from a tainted
   * canvas, a missing 2D context, an oversized result — lands on the same `null`.
   *
   * `toCanvas` rather than `toJpeg`, because two things have to happen to the
   * rasterised pixels that `toJpeg` does not expose: scaling down to the 480px cap,
   * and filling a background colour underneath so a transparent element is not
   * flattened onto black.
   */
  function captureDataUrl(target) {
    return loadHtmlToImage()
      .then(function (lib) {
        if (!lib || typeof lib.toCanvas !== "function") throw new Error("html-to-image has no toCanvas");
        var rect = target.getBoundingClientRect();
        var width = Math.max(1, Math.round(rect.width) || 1);
        var height = Math.max(1, Math.round(rect.height) || 1);
        return lib.toCanvas(target, {
          backgroundColor: backgroundColorFor(target),
          // 1, not the device ratio: a retina capture of a 480px box is four times
          // the bytes for detail nobody reviewing a comment needs.
          pixelRatio: 1,
          canvasWidth: width,
          canvasHeight: height
        });
      })
      .then(function (canvas) {
        if (!canvas) throw new Error("no canvas");
        var sourceWidth = Math.max(1, canvas.width || 1);
        var sourceHeight = Math.max(1, canvas.height || 1);
        var scale = sourceWidth > CAPTURE_MAX_WIDTH ? CAPTURE_MAX_WIDTH / sourceWidth : 1;
        var outWidth = Math.max(1, Math.round(sourceWidth * scale));
        var outHeight = Math.max(1, Math.round(sourceHeight * scale));

        var out = document.createElement("canvas");
        out.width = outWidth;
        out.height = outHeight;
        var ctx = out.getContext ? out.getContext("2d") : null;
        if (!ctx) throw new Error("no 2d context");
        ctx.fillStyle = backgroundColorFor(target);
        ctx.fillRect(0, 0, outWidth, outHeight);
        ctx.drawImage(canvas, 0, 0, sourceWidth, sourceHeight, 0, 0, outWidth, outHeight);

        var dataUrl = out.toDataURL("image/jpeg", CAPTURE_JPEG_QUALITY);
        // The route accepts only a strict `data:image/(png|jpeg|webp);base64,` URL
        // with no parameters and no whitespace. A browser that produced anything
        // else (a stub `data:,`, a PNG because JPEG is unsupported) is not worth
        // sending to be rejected.
        if (typeof dataUrl !== "string" || dataUrl.indexOf("data:image/jpeg;base64,") !== 0) {
          throw new Error("unexpected data URL");
        }
        var payload = dataUrl.slice("data:image/jpeg;base64,".length);
        // 3/4 of the base64 length is the decoded size; the server caps it at 400 KiB
        // and returns 413. Checking here turns a guaranteed failed request into a
        // silently absent screenshot.
        if (Math.floor((payload.length * 3) / 4) > CAPTURE_MAX_BYTES) {
          throw new Error("capture too large");
        }
        return dataUrl;
      })
      .catch(function (err) {
        warn("capture skipped", err);
        return null;
      });
  }

  /**
   * Uploads a captured data URL and resolves its stored URL, or `null`.
   *
   * Deferred to submit time rather than fired at anchor time, because this endpoint
   * requires a visitor token and the visitor frequently has not signed in yet when
   * they pick an element. Doing it here means one small request in a path that is
   * already making one, instead of a 401 that would clear their session mid-compose.
   * The expensive half — the rasterise — already happened in the background.
   */
  function uploadScreenshot(dataUrl) {
    if (!dataUrl) return Promise.resolve(null);
    return request("/screenshot", { method: "POST", body: { dataUrl: dataUrl } })
      .then(function (result) {
        if (result.ok && result.data && typeof result.data.url === "string") return result.data.url;
        return null;
      })
      .catch(function (err) {
        warn("screenshot upload skipped", err);
        return null;
      });
  }

  /* ------------------------------------------------------------------ *
   * Sign-in
   * ------------------------------------------------------------------ */

  var signIn = { nonce: null, popup: null, timer: 0, startedAt: 0, closedAt: 0 };
  /** What the visitor was doing when we discovered they needed to sign in. */
  var pendingIntent = null;

  /**
   * 32 CSPRNG bytes as 64 lowercase hex characters, which is what the server's
   * `/^[0-9a-f]{64}$/` demands.
   *
   * `Math.random()` would be a real vulnerability and not a style issue: this nonce
   * is the single-use bearer of a sign-in handoff, so a predictable one lets a
   * stranger claim somebody else's freshly minted visitor token. Returns `null`
   * rather than falling back to anything weaker if the platform has no CSPRNG.
   */
  function createNonce() {
    var crypto = window.crypto || window.msCrypto;
    if (!crypto || typeof crypto.getRandomValues !== "function") return null;
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    var hex = "";
    for (var i = 0; i < bytes.length; i++) {
      // +0x100 then drop the leading "1" — the cheap way to zero-pad to two digits.
      hex += (bytes[i] + 0x100).toString(16).slice(1);
    }
    return hex;
  }

  function cancelSignIn() {
    if (signIn.timer) window.clearTimeout(signIn.timer);
    signIn.timer = 0;
    signIn.nonce = null;
    signIn.popup = null;
    signIn.startedAt = 0;
    signIn.closedAt = 0;
  }

  /**
   * Opens the popup and starts polling for the handoff.
   *
   * A second press starts over — new nonce, new popup — rather than being ignored.
   * A visitor who closed the popup, or let it time out, has no other way back, and
   * the old nonce is either spent or expiring anyway.
   */
  function beginSignIn() {
    cancelSignIn();

    var nonce = createNonce();
    if (!nonce) {
      setMessage("This browser cannot start a secure sign-in.", "error");
      return;
    }

    signIn.nonce = nonce;
    signIn.startedAt = Date.now();

    /**
     * The only URL that ever carries the embed token, and the reason the whole flow
     * exists: the popup runs on the Compass origin, so the visitor types their email
     * into a page with a Compass address bar and the embedding page never sees their
     * address or their magic link. No visitor token goes here — there isn't one yet,
     * and this is exactly the request that mints it.
     */
    var url =
      API_BASE + "/embed/signin?token=" + encodeURIComponent(embedToken) + "&nonce=" + encodeURIComponent(nonce);

    try {
      // No `noopener`: we need the handle back, because `popup.closed` is the only
      // signal that the visitor gave up. The popup is on our own origin, so it is
      // not a window we are exposing ourselves to.
      signIn.popup = window.open(url, "compass-feedback-signin", "width=460,height=640,menubar=no,toolbar=no");
    } catch (err) {
      warn("popup", err);
      signIn.popup = null;
    }
    if (!signIn.popup) {
      // A blocked popup is common and recoverable, so say what to do about it.
      setMessage("Allow pop-ups for this site, then press Sign in again.", "error");
    } else {
      setMessage("Finish signing in in the new window \u2014 this will catch up on its own.", "info");
    }

    scheduleSignInPoll();
  }

  function scheduleSignInPoll() {
    // First poll is one interval out, not immediate: nobody signs in within 0ms, and
    // an immediate request would just spend read quota to be told "not yet".
    signIn.timer = window.setTimeout(guarded("signin-poll", pollSignIn), POLL_INTERVAL_MS);
  }

  function popupClosed() {
    // `closed` is the *only* property readable on a cross-origin window; touching
    // anything else throws a SecurityError. Wrapped anyway, because a popup that was
    // never opened is `null`.
    try {
      return !!(signIn.popup && signIn.popup.closed);
    } catch (err) {
      // `closed` is the one property a cross-origin window will hand over, and if
      // even that throws the safe reading is "still open" — giving up on a sign-in
      // that is actually in progress is the worse mistake. Silent because this is
      // read on every poll.
      void err;
      return false;
    }
  }

  function pollSignIn() {
    var nonce = signIn.nonce;
    if (!nonce) return;

    if (Date.now() - signIn.startedAt > POLL_CEILING_MS) {
      cancelSignIn();
      setMessage("That sign-in timed out. Press Sign in to try again.", "error");
      return;
    }

    // A closed popup starts a grace period instead of ending the attempt: the
    // visitor may well have signed in and then closed it, in which case the handoff
    // is already waiting for the very next poll.
    if (popupClosed()) {
      if (!signIn.closedAt) signIn.closedAt = Date.now();
      if (Date.now() - signIn.closedAt > POLL_CLOSED_GRACE_MS) {
        cancelSignIn();
        setMessage("Sign-in was cancelled. Press Sign in to try again.", "error");
        return;
      }
    }

    request("/session", {
      method: "POST",
      body: { nonce: nonce },
      anonymous: true,
      // See the note in `request`: here PORTAL_AUTH_REQUIRED means "not yet".
      ignoreAuthCode: true
    }).then(
      guarded("signin-claim", function (result) {
        // A nonce change means a newer attempt superseded this one mid-flight.
        if (signIn.nonce !== nonce) return;

        if (result.ok && result.data && typeof result.data.token === "string") {
          // Returned exactly once — persisted before anything else can throw.
          writeStored(result.data.token, result.data.expiresAt);
          state.identity = { email: result.data.email, name: result.data.name };
          try {
            if (signIn.popup) signIn.popup.close();
          } catch (err) {
            // Closing a window we opened but do not own is best-effort.
            void err;
          }
          cancelSignIn();
          renderIdentity();
          setMessage("Signed in. " + (state.identity.email || ""), "info");

          // Pick up whatever they were trying to do when we interrupted them.
          var resume = pendingIntent;
          pendingIntent = null;
          if (resume) resume();
          return;
        }

        if (result.rateLimited) {
          // Back off a whole extra interval rather than hammering a closed door.
          signIn.timer = window.setTimeout(guarded("signin-poll", pollSignIn), POLL_INTERVAL_MS * 2);
          return;
        }

        scheduleSignInPoll();
      })
    );
  }

  function signOut() {
    // Revokes only the widget's visitor session. The visitor's portal session in
    // another tab is deliberately untouched — see the DELETE handler's note.
    request("/session", { method: "DELETE" }).then(
      guarded("signout-done", function () {
        clearStored();
        state.identity = null;
        cancelSignIn();
        renderIdentity();
        setMessage("Signed out.", "info");
      })
    );
  }

  function requireSignIn(intent) {
    pendingIntent = intent || null;
    renderIdentity();
    setMessage("Sign in to post this \u2014 your comment is kept.", "info");
    openPanel();
  }

  /* ------------------------------------------------------------------ *
   * Reads and writes
   * ------------------------------------------------------------------ */

  function refreshSession() {
    // Asked on every boot rather than trusting what is in storage. The token there
    // may have expired, been revoked from another tab, or been minted for a
    // different source — all of which come back as `{ signedIn: false }`.
    return request("/session").then(
      guarded("session-read", function (result) {
        if (result.ok && result.data && result.data.signedIn) {
          state.identity = { email: result.data.email, name: result.data.name };
        } else {
          state.identity = null;
          if (result.ok) clearStored();
        }
        renderIdentity();
      })
    );
  }

  function refreshComments() {
    // A 403 is a standing configuration answer, not a transient failure, so it is
    // latched. Re-asking on every panel open would spend the read quota discovering
    // the same thing forever.
    if (state.readBlocked) return Promise.resolve();

    return request("/comments?pagePath=" + encodeURIComponent(pagePath)).then(
      guarded("comments-read", function (result) {
        if (result.status === 403) {
          state.readBlocked = true;
          renderAll();
          return;
        }
        if (result.rateLimited) {
          setMessage("Too many requests just now \u2014 try again in a moment.", "error");
          return;
        }
        if (!result.ok || !result.data) return;

        state.artifactId = result.data.artifactId || null;
        state.comments = Array.isArray(result.data.comments) ? result.data.comments : [];
        renderAll();
      })
    );
  }

  /**
   * One path for a root comment and a reply.
   *
   * The 4000-character ceiling is enforced here, before any network call, because
   * the server's rejection would cost the visitor their draft and a submit-quota
   * slot to learn something the widget already knew.
   */
  function submitComment(options) {
    var body = String(options.body || "").trim();
    var parentId = options.parentId || null;
    var input = options.input || null;

    if (!body) {
      setMessage("Write something first.", "error");
      return;
    }
    if (body.length > MAX_BODY_LENGTH) {
      setMessage("That is " + body.length + " characters. The limit is " + MAX_BODY_LENGTH + ".", "error");
      return;
    }
    if (state.busy) return;

    if (!visitorToken()) {
      // No token means the submit would 401 anyway. Ask first, and re-run this exact
      // submit once they are back.
      requireSignIn(function () {
        submitComment(options);
      });
      return;
    }

    state.busy = true;
    updateCounter();
    setMessage(parentId ? "Sending your reply\u2026" : "Sending your feedback\u2026", "info");

    // Only a root comment carries an anchor; a reply inherits its parent's, and the
    // route ignores one sent alongside `parentId`, so none is built here.
    var capture = parentId ? Promise.resolve(null) : state.pendingCapture || Promise.resolve(null);

    capture
      .then(function (dataUrl) {
        return parentId ? null : uploadScreenshot(dataUrl);
      })
      .then(function (screenshotUrl) {
        var payload = { body: body };
        if (parentId) {
          payload.parentId = parentId;
        } else {
          // Both required by the route, both capped at 2048. `pageUrl` is the full
          // location so a reviewer can open exactly what the visitor saw; `pagePath`
          // is what groups a thread.
          payload.pageUrl = String(window.location.href).slice(0, 2048);
          payload.pagePath = String(pagePath).slice(0, 2048);
          if (state.draftAnchor) {
            if (state.draftAnchor.elementSelector) payload.elementSelector = state.draftAnchor.elementSelector;
            if (state.draftAnchor.elementFingerprint) payload.elementFingerprint = state.draftAnchor.elementFingerprint;
          }
          if (screenshotUrl) payload.screenshotUrl = screenshotUrl;
        }
        return request("/comments", { method: "POST", body: payload });
      })
      .then(
        guarded("submit-done", function (result) {
          state.busy = false;

          if (result.authRequired) {
            // `request` already forgot the token. Offer sign-in rather than an error:
            // nothing is wrong, they are simply not signed in here.
            requireSignIn(function () {
              submitComment(options);
            });
            updateCounter();
            return;
          }
          if (result.rateLimited) {
            setMessage("Too many submissions just now \u2014 try again in a moment.", "error");
            updateCounter();
            return;
          }
          if (!result.ok) {
            var message = result.data && typeof result.data.error === "string"
              ? result.data.error
              : "That could not be sent. Please try again.";
            setMessage(message, "error");
            updateCounter();
            return;
          }

          if (input) input.value = "";
          if (!parentId) {
            if (ui.input) ui.input.value = "";
            state.draftAnchor = null;
            state.pendingCapture = null;
          }
          setMessage("Thanks \u2014 that has been sent.", "info");
          updateCounter();
          renderChip();
          refreshComments();
        })
      );
  }

  /* ------------------------------------------------------------------ *
   * Panel open/close and events
   * ------------------------------------------------------------------ */

  function openPanel() {
    state.open = true;
    if (ui.panel) ui.panel.setAttribute("data-open", "true");
    if (ui.launcher) ui.launcher.setAttribute("aria-expanded", "true");
  }

  function closePanel(keepFlag) {
    state.open = false;
    if (ui.panel) ui.panel.setAttribute("data-open", "false");
    if (ui.launcher) ui.launcher.setAttribute("aria-expanded", "false");
    if (!keepFlag && state.picking) stopPicking();
  }

  function wireEvents() {
    ui.launcher.addEventListener("click", guarded("launcher", function () {
      if (state.open) {
        closePanel();
        return;
      }
      openPanel();
      if (ui.panel && typeof ui.panel.focus === "function") ui.panel.focus();
    }));

    ui.close.addEventListener("click", guarded("close", function () {
      closePanel();
      if (ui.launcher && typeof ui.launcher.focus === "function") ui.launcher.focus();
    }));

    ui.pick.addEventListener("click", guarded("pick", function () {
      if (state.picking) stopPicking();
      else startPicking();
    }));

    ui.send.addEventListener("click", guarded("send", function () {
      submitComment({ body: ui.input.value, input: ui.input });
    }));

    ui.input.addEventListener("input", guarded("input", updateCounter));

    // Escape unwinds one layer at a time: pick mode first, then the panel.
    document.addEventListener("keydown", guarded("keydown", function (event) {
      if (event.key !== "Escape" && event.keyCode !== 27) return;
      if (state.picking) {
        stopPicking();
        openPanel();
        return;
      }
      if (state.open) {
        closePanel();
        if (ui.launcher && typeof ui.launcher.focus === "function") ui.launcher.focus();
      }
    }), true);

    // `passive` so the widget never delays the host page's scrolling.
    window.addEventListener("scroll", scheduleReposition, { passive: true, capture: true });
    window.addEventListener("resize", scheduleReposition, { passive: true });
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  function boot() {
    mount();
    // Both reads are fired and neither is awaited by the other: the identity check
    // and the thread read are independent, and two requests is well inside the
    // 120/min read budget.
    refreshSession();
    refreshComments();
  }

  try {
    if (document.body) {
      boot();
    } else {
      // `defer` normally guarantees a body, but an `async` or dynamically injected
      // copy of this tag can run before one exists.
      document.addEventListener("DOMContentLoaded", guarded("boot", boot), { once: true });
    }
  } catch (err) {
    warn("boot failed", err);
  }
})();
