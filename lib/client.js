/**
 * dsh-ios-pwa-fix — Browser half.
 *
 * Keeps the DSH web GUI usable as an iOS/iPadOS Home Screen app.
 *
 * 1. Status bar. The app uses standalone display mode, so iOS may draw the status
 *    bar over the page. If the page spans the screen, reserve a strip at the top
 *    and paint it with the app background. If the platform already insets the
 *    page, reserve nothing.
 *
 * 2. Keyboard. iOS shrinks the visual viewport but not the layout viewport. While
 *    the keyboard covers the layout viewport, pin the shell to the visible band,
 *    so the composer stays above the keyboard.
 *
 * 3. Geometry. The layout height is `documentElement.clientHeight`, not
 *    `window.innerHeight`: on iOS, `innerHeight` moves with the keyboard and
 *    scroll. `visualViewport.offsetTop` can be the document scroll; when it
 *    matches `scrollY`, the visible band starts at the top of the layout
 *    viewport.
 *
 * 4. Text fields. Keep the font size at 16px or more, so WebKit does not apply
 *    its automatic focus zoom.
 *
 * The patch changes layout only. It runs inside try/catch and removes every
 * change on dispose. It is inert outside iOS and iPadOS standalone display mode.
 */
/*
 * One IIFE keeps every helper out of the global scope. Generic top-level names
 * can collide with other client bundles. Top-level const declarations would also
 * fail when HMR executes the bundle again.
 */
(() => {
  const STORAGE_KEY = "dsh-ios-pwa-fix";
  const STYLE_ID = "dsh-ios-pwa-fix-style";
  const STRIP_ID = "dsh-ios-pwa-fix-strip";
  const ROOT_CLASS = "dsh-ios-pwa";
  const KEYBOARD_CLASS = "dsh-ios-keyboard";
  const LOCK_CLASS = "dsh-ios-locked";
  /** Public hook: `window.dispatchEvent(new Event("dsh-ios-pwa-resync"))` forces a pass. */
  const RESYNC_EVENT = "dsh-ios-pwa-resync";
  /** How long after the last viewport event to keep re-checking (ms). */
  const WATCHDOG_MS = 250;

  /**
   * Defaults. Override any of them for a device-local change with:
   *   localStorage.setItem("dsh-ios-pwa-fix", JSON.stringify({ strip: "off" }))
   */
  const DEFAULTS = {
    /** Strip height when the platform reports no `env(safe-area-inset-top)`. */
    top: 24,
    /** Reserve the strip: "auto" skips it when the platform already insets the page. */
    strip: "auto",
    /** Smallest visual-viewport shortfall treated as the keyboard. */
    minOverlap: 60,
    /** When to normalise iOS's reveal-scroll: "onOpen" | "always" | "off". */
    scrollReset: "onOpen",
    /** Keep re-checking the geometry while the keyboard is open. */
    watchdog: true,
    /** Pin the document's own scroll while the keyboard is open. */
    lockScroll: true,
    /** Log the computed geometry on every sync. */
    debug: false,
  };

  /** Merge the defaults with the localStorage override; never throw on bad JSON. */
  function settings(windowRef) {
    let override = {};
    try {
      override = JSON.parse(windowRef.localStorage.getItem(STORAGE_KEY) || "{}") || {};
    } catch (_error) {
      override = {};
    }
    const merged = Object.assign({}, DEFAULTS, override);
    if (typeof merged.top !== "number" || !(merged.top >= 0)) merged.top = DEFAULTS.top;
    if (typeof merged.minOverlap !== "number" || merged.minOverlap < 0) merged.minOverlap = DEFAULTS.minOverlap;
    if (["onOpen", "always", "off"].indexOf(merged.scrollReset) === -1) merged.scrollReset = DEFAULTS.scrollReset;
    merged.watchdog = merged.watchdog !== false;
    merged.lockScroll = merged.lockScroll !== false;
    if (["auto", "always", "off"].indexOf(merged.strip) === -1) merged.strip = DEFAULTS.strip;
    return merged;
  }

  /**
   * Height of the status-bar strip to reserve, in CSS px.
   *
   * Use the safe-area inset when it is reported. Otherwise, reserve the strip
   * only when the page spans the screen. Compare the screen and the layout
   * viewport in device points: layout CSS px multiplied by the current page
   * scale (iPadOS desktop mode can report 0.75). A page that already starts
   * below the status bar reports a gap of 20pt or more and gets no strip.
   */
  function statusBarHeight(windowRef, doc, cfg) {
    if (cfg.strip === "off") return 0;
    const probe = doc.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden";
    doc.body.appendChild(probe);
    const measured = Math.round(probe.getBoundingClientRect().height);
    probe.remove();
    if (cfg.strip === "always") return measured > 0 ? measured : Math.round(cfg.top);
    const screenHeight = windowRef.screen && windowRef.screen.height ? Math.round(windowRef.screen.height) : 0;
    const viewport = windowRef.visualViewport;
    const scale = viewport && viewport.scale > 0 ? viewport.scale : 1;
    const element = doc.documentElement;
    const layoutHeight = Math.round((element && element.clientHeight) || windowRef.innerHeight);
    if (screenHeight - layoutHeight * scale >= 20) return 0;
    return measured > 0 ? measured : Math.round(cfg.top);
  }

  /* ------------------------------------------------------------------
   * Environment detection
   *
   * These functions read navigator and matchMedia only. They do not touch
   * the DOM. Future patches can use the platform and version to apply
   * version-specific rules.
   * ---------------------------------------------------------------- */

  /** Return "iphone", "ipad", "ipod", or null. */
  function iosPlatform(ua, nav) {
    if (/iPad/.test(ua)) return "ipad";
    if (/iPhone/.test(ua)) return "iphone";
    if (/iPod/.test(ua)) return "ipod";
    // iPadOS desktop mode reports a Macintosh user agent and has touch.
    if (/Macintosh/.test(ua) && Number(nav.maxTouchPoints) > 1) return "ipad";
    return null;
  }

  /** Return { major, minor, patch } from the user agent, or null. */
  function iosVersion(ua) {
    const match = /(?:CPU (?:iPhone )?OS|OS) (\d+)[_.](\d+)(?:[_.](\d+))?/.exec(ua);
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0) };
  }

  /** Return "standalone", "fullscreen", or "browser". */
  function displayMode(windowRef) {
    const nav = windowRef.navigator || {};
    if (nav.standalone === true) return "standalone";
    const mm = windowRef.matchMedia;
    if (typeof mm !== "function") return "browser";
    if (mm("(display-mode: fullscreen)").matches) return "fullscreen";
    if (mm("(display-mode: standalone)").matches) return "standalone";
    return "browser";
  }

  /** Describe the current platform and display mode. */
  function detectEnvironment(windowRef) {
    const nav = windowRef.navigator || {};
    const ua = String(nav.userAgent || "");
    const mode = displayMode(windowRef);
    const platform = iosPlatform(ua, nav);
    const touch = Number(nav.maxTouchPoints) > 1;
    return {
      ios: platform !== null,
      platform,
      version: iosVersion(ua),
      standalone: mode !== "browser",
      displayMode: mode,
      desktopMode: /Macintosh/.test(ua) && touch,
      touch,
    };
  }

  /** Apply only on iOS or iPadOS in a standalone display mode. */
  function shouldApply(env) {
    return env.ios && env.standalone;
  }

  /** @param ctx - Browser application context. */
  function apply(ctx) {
    try {
      const windowRef = window;
      const doc = windowRef.document;
      const cfg = settings(windowRef);
      const env = detectEnvironment(windowRef);
      if (cfg.debug) {
        try {
          windowRef.__dshIosPwaEnvironment = env;
        } catch (_error) {
          // A read-only window object: the console log still works.
        }
        console.log("[dsh-ios-pwa-fix] environment", env);
      }
      if (!shouldApply(env)) return;
      // Re-materialisation (HMR) must not stack a second patch on top of the first.
      if (doc.getElementById(STYLE_ID)) return;

      const style = doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = [
        // A padded body has a content box of height - strip, and #root{height:100%}
        // resolves against that box. The shell would then be one screen tall while
        // pushed down by the strip, so its bottom would fall outside the body.
        // Carry the strip on the body when the keyboard is closed, and on #root when
        // the keyboard is open.
        `html.${ROOT_CLASS} body {`,
        "  box-sizing: border-box !important;",
        "  padding-top: var(--dsh-ios-body-pad, 0px) !important;",
        "}",
        `html.${ROOT_CLASS} #root {`,
        "  height: var(--dsh-ios-root-h, 100%) !important;",
        "}",
        `html.${ROOT_CLASS}.${KEYBOARD_CLASS} body {`,
        "  height: var(--dsh-ios-vvh, 100%) !important;",
        "}",
        `html.${ROOT_CLASS}.${KEYBOARD_CLASS} #root {`,
        "  box-sizing: border-box !important;",
        "  padding-top: var(--dsh-ios-top, 0px) !important;",
        "}",
        // WebKit applies an automatic focus zoom when a text field is under
        // 16px. The zoom decouples the visual and layout viewports and
        // persists after blur.
        `html.${ROOT_CLASS} input,`,
        `html.${ROOT_CLASS} textarea,`,
        `html.${ROOT_CLASS} [contenteditable="true"] {`,
        "  font-size: max(16px, 1em) !important;",
        "}",
        // A body as tall as the visible band is scrollable; iOS scrolls it for the
        // caret, which moves the composer out from under the pinned band. Pin it.
        `html.${ROOT_CLASS}.${LOCK_CLASS},`,
        `html.${ROOT_CLASS}.${LOCK_CLASS} body {`,
        "  overflow: hidden !important;",
        "}",
        `#${STRIP_ID} {`,
        "  position: fixed;",
        "  top: 0;",
        "  left: 0;",
        "  right: 0;",
        "  height: var(--dsh-ios-top, 0px);",
        "  background: var(--dsw-alias-bg-base, #ffffff);",
        "  z-index: 2147483647;",
        "  pointer-events: none;",
        "}",
      ].join("\n");
      doc.head.appendChild(style);

      const strip = doc.createElement("div");
      strip.id = STRIP_ID;
      doc.body.appendChild(strip);

      const root = doc.documentElement;
      const body = doc.body;
      root.classList.add(ROOT_CLASS);
      /** Reserved top strip: painted as a band, and carried as padding so nothing hides. */
      const stripPx = statusBarHeight(windowRef, doc, cfg);
      root.style.setProperty("--dsh-ios-top", stripPx + "px");
      root.style.setProperty("--dsh-ios-body-pad", stripPx + "px");

      const viewport = windowRef.visualViewport;
      const raf =
        typeof windowRef.requestAnimationFrame === "function"
          ? windowRef.requestAnimationFrame.bind(windowRef)
          : (fn) => windowRef.setTimeout(fn, 16);
      const caf =
        typeof windowRef.cancelAnimationFrame === "function" ? windowRef.cancelAnimationFrame.bind(windowRef) : () => {};

      let frame = 0;
      let settleTimer = 0;
      let running = false;
      let appliedHeight = -1;
      let keyboardOpen = false;

      const resetScroll = () => {
        if (windowRef.scrollX !== 0 || windowRef.scrollY !== 0) windowRef.scrollTo(0, 0);
      };

      /**
       * Resolve the visible band inside the layout viewport.
       *
       * The layout height is `documentElement.clientHeight`. On iOS,
       * `innerHeight` follows the keyboard and scroll, so it cannot be used
       * here.
       *
       * `visualViewport.offsetTop` is the band offset in overlay mode. On iOS
       * it can equal the document scroll when the keyboard resizes the layout
       * viewport. In that case the band starts at 0 and only its height
       * shrinks.
       */
      const geometry = () => {
        const offsetTop = Math.round(viewport.offsetTop);
        const height = Math.round(viewport.height);
        const element = doc.documentElement;
        const clientHeight = element ? element.clientHeight : 0;
        const layoutHeight = Math.round(clientHeight > 0 ? clientHeight : windowRef.innerHeight);
        const scrolled = Math.round(windowRef.scrollY);
        let bandTop = Math.abs(offsetTop - scrolled) <= 2 ? 0 : offsetTop;
        if (bandTop < 0) bandTop = 0;
        if (bandTop > layoutHeight) bandTop = layoutHeight;
        const bandBottom = bandTop + height;
        const overlap = layoutHeight - bandBottom;

        if (overlap <= cfg.minOverlap) {
          return { open: false, bandTop, height, layoutHeight, bandBottom, overlap, pinned: 0 };
        }
        return {
          open: true,
          bandTop,
          height,
          layoutHeight,
          bandBottom,
          overlap,
          pinned: bandBottom - bandTop,
        };
      };

      /** Write the geometry to the DOM. Every write is visible to the next read. */
      const paint = (geo) => {
        root.style.setProperty("--dsh-ios-vvh", geo.bandBottom + "px");
        // Set it inline as well, so the next read cannot observe a half-applied
        // state and "correct" a value that was already right.
        body.style.height = geo.bandBottom + "px";
        // The shell already carries the strip as its own padding, so the body
        // must not also have it.
        root.style.setProperty("--dsh-ios-body-pad", "0px");
        root.classList.add(KEYBOARD_CLASS);
        if (cfg.lockScroll) root.classList.add(LOCK_CLASS);
      };

      /** Put everything back the way the unpatched shell had it. */
      const release = () => {
        root.classList.remove(KEYBOARD_CLASS, LOCK_CLASS);
        root.style.removeProperty("--dsh-ios-vvh");
        root.style.setProperty("--dsh-ios-body-pad", stripPx + "px");
        body.style.removeProperty("height");
        appliedHeight = -1;
        keyboardOpen = false;
      };

      /** Align the layout with the visible band: keyboard open, or full height. */
      const sync = (reason) => {
        if (!viewport) return;

        const geo = geometry();

        if (!geo.open) {
          if (keyboardOpen) release();
          if (cfg.debug) {
            console.log("[dsh-ios-pwa-fix]", {
              reason,
              open: false,
              bandTop: geo.bandTop,
              viewportHeight: geo.height,
              innerHeight: geo.layoutHeight,
              overlap: geo.overlap,
            });
          }
          return;
        }

        // The first pass of this keyboard-open episode is what
        // `scrollReset: "onOpen"` normalises; after that iOS is left alone.
        const episode = !keyboardOpen;

        // Only touch the DOM when the number actually moved. The watchdog runs
        // every frame while the keyboard is up, and repainting an unchanged
        // height would keep iOS re-laying out for no reason.
        if (episode || geo.bandBottom !== appliedHeight) {
          paint(geo);
          appliedHeight = geo.bandBottom;
        }
        keyboardOpen = true;

        if (cfg.scrollReset === "always" || (cfg.scrollReset === "onOpen" && episode)) {
          resetScroll();
        }

        if (cfg.debug) {
          console.log("[dsh-ios-pwa-fix]", {
            reason,
            open: true,
            bandTop: geo.bandTop,
            viewportHeight: geo.height,
            bandBottom: geo.bandBottom,
            innerHeight: geo.layoutHeight,
            pinned: geo.pinned,
            overlap: geo.overlap,
            appliedHeight,
          });
        }
      };

      /**
       * Run one pass, then keep checking while the keyboard is open.
       *
       * A watchdog pass runs on each animation frame. A settle pass runs 250ms
       * after the last event and repeats while the keyboard stays open. Both are
       * off when `watchdog` is false.
       */
      const pass = (reason) => {
        sync(reason);
        if (!keyboardOpen) return;
        if (!cfg.watchdog) return;

        if (!frame) {
          frame = raf(() => {
            frame = 0;
            pass("watchdog");
          });
        }
        if (!settleTimer) {
          settleTimer = windowRef.setTimeout(() => {
            settleTimer = 0;
            if (keyboardOpen) pass("settle");
          }, WATCHDOG_MS);
        }
      };

      const onEvent = (reason) => {
        if (!running) return;
        // A fresh event restarts the settle window.
        if (settleTimer) {
          windowRef.clearTimeout(settleTimer);
          settleTimer = 0;
        }
        pass(reason);
      };

      const onResize = () => onEvent("resize");
      const onScroll = () => onEvent("scroll");
      const onResync = () => onEvent("resync");

      if (viewport) {
        viewport.addEventListener("resize", onResize);
        viewport.addEventListener("scroll", onScroll);
      }
      windowRef.addEventListener("resize", onResize);
      windowRef.addEventListener("scroll", onScroll);
      windowRef.addEventListener("orientationchange", onResize);
      windowRef.addEventListener(RESYNC_EVENT, onResync);
      running = true;
      pass("init");

      ctx.effect(() => () => {
        running = false;
        if (viewport) {
          viewport.removeEventListener("resize", onResize);
          viewport.removeEventListener("scroll", onScroll);
        }
        windowRef.removeEventListener("resize", onResize);
        windowRef.removeEventListener("scroll", onScroll);
        windowRef.removeEventListener("orientationchange", onResize);
        windowRef.removeEventListener(RESYNC_EVENT, onResync);
        if (frame) caf(frame);
        if (settleTimer) windowRef.clearTimeout(settleTimer);
        frame = 0;
        settleTimer = 0;
        release();
        root.classList.remove(ROOT_CLASS);
        root.style.removeProperty("--dsh-ios-top");
        root.style.removeProperty("--dsh-ios-body-pad");
        strip.remove();
        style.remove();
      });
    } catch (error) {
      // Layout-only patch: never take the interface down with it.
      console.warn("[dsh-ios-pwa-fix]", error);
    }
  }

  const exports = {
    apply,
    detectEnvironment,
    shouldApply,
    inject: [],
  };
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

  window.__ModuleLoader__.load({
    id: "dsh-ios-pwa-fix",
    factory: () => exports,
  });
})();
