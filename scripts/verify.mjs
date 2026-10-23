#!/usr/bin/env node
/**
 * verify.mjs — checks the browser half against a stubbed DOM.
 *
 * The stub cannot prove how iOS lays out a Home Screen app. It checks the patch
 * logic: standalone gating, strip selection, keyboard pinning, measured iOS
 * geometry, watchdog, scroll policy, and cleanup.
 *
 *   node scripts/verify.mjs
 */
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, "..", "lib", "client.js");
const STORAGE_KEY = "dsh-ios-pwa-fix";

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`}`);
};

const findStyle = (b, needle) => {
  const el = b.registry.find((e) => e.id === "dsh-ios-pwa-fix-style");
  return el ? el.textContent.includes(needle) : false;
};

/** A DOM just big enough for the patch, with every hook it touches made observable. */
function makeEnvironment({ standalone = true, navigatorStandalone = standalone, displayMode = standalone ? "standalone" : "browser", userAgent = "iPad", maxTouchPoints = 5, envTop = 0, stored = null, innerHeight = 1194, offsetTop = 0, layoutHeight = 0, screenHeight = 0, scale = 1 } = {}) {
  const registry = [];
  const listeners = { window: {}, viewport: {} };
  const frames = [];
  const timers = [];
  const scrolledTo = [];
  const console_ = { log: [], warn: [] };
  const store = new Map(stored === null ? [] : [[STORAGE_KEY, JSON.stringify(stored)]]);

  const el = (tag) => {
    const node = {
      tagName: tag,
      id: "",
      textContent: "",
      cssText: "",
      parent: null,
      children: [],
      _classes: new Set(),
      style: (() => {
        const style = {
          _p: {},
          height: "",
          setProperty(k, v) { this._p[k] = v; },
          removeProperty(k) {
            delete this._p[k];
            if (k === "height") style.height = "";
          },
          getPropertyValue(k) { return this._p[k]; },
        };
        return style;
      })(),
      classList: {
        add: (...c) => c.forEach((x) => node._classes.add(x)),
        remove: (...c) => c.forEach((x) => node._classes.delete(x)),
        contains: (c) => node._classes.has(c),
      },
      appendChild(child) {
        child.parent = node;
        node.children.push(child);
        if (child.id) registry.push(child);
        return child;
      },
      remove() {
        if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
        const i = registry.indexOf(node);
        if (i !== -1) registry.splice(i, 1);
      },
      getBoundingClientRect: () => ({ height: envTop, width: 0 }),
    };
    return node;
  };

  const documentElement = el("html");
  // iOS keeps `innerHeight` moving with the keyboard and with scroll. Tests opt
  // in to `clientHeight`, so the default cases still use `innerHeight`.
  if (layoutHeight > 0) documentElement.clientHeight = layoutHeight;
  const body = el("body");
  const head = el("head");
  const doc = {
    documentElement,
    body,
    head,
    createElement: el,
    getElementById: (id) => registry.find((e) => e.id === id) ?? null,
  };

  const viewport = {
    height: innerHeight,
    offsetTop,
    scale,
    width: 834,
    addEventListener: (t, fn) => { (listeners.viewport[t] ??= []).push(fn); },
    removeEventListener: (t, fn) => { listeners.viewport[t] = (listeners.viewport[t] ?? []).filter((f) => f !== fn); },
  };

  const windowRef = {
    document: doc,
    innerHeight,
    scrollX: 0,
    scrollY: 0,
    screen: { height: screenHeight > 0 ? screenHeight : innerHeight },
    navigator: { standalone: navigatorStandalone, maxTouchPoints, userAgent },
    matchMedia: (q) => {
      if (q === "(display-mode: fullscreen)") return { matches: displayMode === "fullscreen" };
      if (q === "(display-mode: standalone)") return { matches: displayMode === "standalone" };
      return { matches: false };
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    visualViewport: viewport,
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    cancelAnimationFrame: (id) => { if (typeof id === "number" && id > 0) frames.splice(id - 1, 1); },
    setTimeout: (cb, ms) => { timers.push({ cb, ms }); return timers.length; },
    clearTimeout: (id) => { if (id > 0) timers[id - 1] = { cb: null, ms: 0 }; },
    scrollTo: (x, y) => scrolledTo.push([x, y]),
    addEventListener: (t, fn) => { (listeners.window[t] ??= []).push(fn); },
    removeEventListener: (t, fn) => { listeners.window[t] = (listeners.window[t] ?? []).filter((f) => f !== fn); },
    __ModuleLoader__: { load: (def) => { windowRef.__def = def; } },
  };

  const flush = () => {
    const batch = frames.splice(0, frames.length);
    for (const cb of batch) if (cb) cb();
  };
  const runTimers = () => {
    const batch = timers.splice(0, timers.length);
    for (const t of batch) if (t.cb) t.cb();
  };
  const fireViewportEvent = (type = "resize") => {
    (listeners.viewport[type] ?? []).forEach((f) => f());
    flush();
  };

  return {
    windowRef, doc, documentElement, body, registry, listeners, frames, timers, scrolledTo,
    console: console_, flush, fireViewportEvent, viewport, runTimers,
  };
}

/** Loads the bundle into a fresh environment and applies it; returns the patch and a disposer. */
function boot(envOptions) {
  const env = makeEnvironment(envOptions);
  const sink = { log: (...a) => env.console.log.push(a), warn: (...a) => env.console.warn.push(a) };
  new Function("window", "console", readFileSync(SOURCE, "utf8"))(env.windowRef, sink);
  const exported = env.windowRef.__def.factory(() => { throw new Error("no requires expected"); });
  let disposer = null;
  exported.apply({ effect: (fn) => { disposer = fn(); } });
  env.dispose = () => disposer?.();
  env.exports = exported;
  return env;
}

const topVar = (b) => b.documentElement.style.getPropertyValue("--dsh-ios-top");
const heightVar = (b) => b.documentElement.style.getPropertyValue("--dsh-ios-vvh");
const bodyPadVar = (b) => b.documentElement.style.getPropertyValue("--dsh-ios-body-pad");
const inlineHeight = (b) => b.body.style.height;
const keyboard = (b) => b.documentElement.classList.contains("dsh-ios-keyboard");
const locked = (b) => b.documentElement.classList.contains("dsh-ios-locked");
const setBand = (b, height, offsetTop = 0) => {
  b.viewport.height = height;
  b.viewport.offsetTop = offsetTop;
};

console.log("dsh-ios-pwa-fix — browser half, stubbed DOM\n");

console.log("Safari tab: stays inert");
{
  const b = boot({ standalone: false });
  check("no style injected", b.registry.length, 0);
  check("no root class", b.documentElement.classList.contains("dsh-ios-pwa"), false);
}

console.log("\nEnvironment detection");
{
  const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
  const b = boot({ standalone: true, userAgent: ua });
  const env = b.exports.detectEnvironment(b.windowRef);
  check("iPhone is iOS", env.ios, true);
  check("iPhone platform", env.platform, "iphone");
  check("iPhone version", env.version, { major: 18, minor: 0, patch: 0 });
  check("iPhone display mode", env.displayMode, "standalone");
  check("iPhone is not desktop mode", env.desktopMode, false);
}
{
  const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";
  const b = boot({ standalone: true, userAgent: ua, stored: { debug: true } });
  check("debug exposes the environment", b.windowRef.__dshIosPwaEnvironment.platform, "iphone");
}
{
  const ua = "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15";
  const b = boot({ standalone: true, userAgent: ua });
  const env = b.exports.detectEnvironment(b.windowRef);
  check("iPad platform", env.platform, "ipad");
  check("iPad version", env.version, { major: 17, minor: 4, patch: 0 });
}
{
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
  const b = boot({ standalone: true, userAgent: ua, maxTouchPoints: 5 });
  const env = b.exports.detectEnvironment(b.windowRef);
  check("iPadOS desktop mode is iPad", env.platform, "ipad");
  check("iPadOS desktop mode has no UA version", env.version, null);
  check("iPadOS desktop mode is flagged", env.desktopMode, true);
  check("iPadOS desktop mode activates", b.registry.length > 0, true);
}
{
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
  const b = boot({ standalone: true, userAgent: ua, maxTouchPoints: 0 });
  check("macOS is not iOS", b.exports.detectEnvironment(b.windowRef).ios, false);
  check("macOS is inert", b.registry.length, 0);
}
{
  const b = boot({ standalone: true, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
  check("Windows is not iOS", b.exports.detectEnvironment(b.windowRef).ios, false);
  check("Windows standalone is inert", b.registry.length, 0);
}
{
  const b = boot({ standalone: true, userAgent: "Mozilla/5.0 (Linux; Android 14)" });
  check("Android standalone is inert", b.registry.length, 0);
}
{
  const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";
  const b = boot({ navigatorStandalone: true, displayMode: "browser", userAgent: ua });
  check("navigator.standalone activates on iOS", b.registry.length > 0, true);
}
{
  const ua = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)";
  const b = boot({ navigatorStandalone: false, displayMode: "standalone", userAgent: ua });
  check("display-mode standalone activates on iPad", b.registry.length > 0, true);
}
{
  const ua = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)";
  const b = boot({ navigatorStandalone: false, displayMode: "fullscreen", userAgent: ua });
  check("display-mode fullscreen activates on iPad", b.registry.length > 0, true);
}
{
  const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";
  const b = boot({ navigatorStandalone: false, displayMode: "browser", userAgent: ua });
  check("iOS Safari tab is inert", b.registry.length, 0);
}

console.log("\nHome Screen app: reserves the status-bar strip");
{
  const b = boot({ standalone: true, envTop: 0 });
  check("style injected once", b.registry.filter((e) => e.id === "dsh-ios-pwa-fix-style").length, 1);
  check("strip element injected", b.registry.some((e) => e.id === "dsh-ios-pwa-fix-strip"), true);
  check("falls back to 24px", topVar(b), "24px");
}
{
  const b = boot({ standalone: true, envTop: 44 });
  check("env(safe-area-inset-top) wins", topVar(b), "44px");
}
{
  const b = boot({ standalone: true, envTop: 0, stored: { top: 30 } });
  check("top override applies", topVar(b), "30px");
}

console.log("\nStrip selection");
{
  // iPhone: screen 874pt, layout 812pt. The page is already below the status bar.
  const b = boot({ standalone: true, envTop: 0, layoutHeight: 812, screenHeight: 874 });
  check("no strip when the page is inset", topVar(b), "0px");
}
{
  const b = boot({ standalone: true, envTop: 0, layoutHeight: 1194, screenHeight: 1194 });
  check("strip kept when the page spans the screen", topVar(b), "24px");
}
{
  // iPad desktop mode: 1468 CSS px at page scale 0.75 = 1101pt of a 1133pt screen.
  const b = boot({ standalone: true, envTop: 0, layoutHeight: 1468, screenHeight: 1133, scale: 0.75 });
  check("iPad at scale 0.75 is inset", topVar(b), "0px");
}
{
  const b = boot({ standalone: true, envTop: 0, layoutHeight: 812, screenHeight: 874, stored: { strip: "always" } });
  check("strip:always reserves the strip", topVar(b), "24px");
}
{
  const b = boot({ standalone: true, envTop: 0, layoutHeight: 812, screenHeight: 874, stored: { strip: "off" } });
  check("strip:off reserves nothing", topVar(b), "0px");
}
{
  const b = boot({ standalone: true, envTop: 24 });
  check("body carries the strip while closed", bodyPadVar(b), "24px");
  check("band and padding agree", topVar(b), bodyPadVar(b));
}

console.log("\nBox model: the shell spans the band exactly");
{
  const b = boot({ standalone: true, envTop: 24 });
  check("stylesheet applies the strip to the body", findStyle(b, "--dsh-ios-body-pad"), true);
  check("stylesheet gives #root the strip while open", findStyle(b, "html.dsh-ios-pwa.dsh-ios-keyboard #root"), true);
  check("body padding defaults to 0", findStyle(b, "padding-top: var(--dsh-ios-body-pad, 0px)"), true);

  setBand(b, 874);
  b.fireViewportEvent();
  check("band pinned", heightVar(b), "874px");
  check("body padding collapsed", bodyPadVar(b), "0px");
  check("strip reserved by #root", topVar(b), "24px");

  setBand(b, 1194);
  b.fireViewportEvent();
  check("body padding returns", bodyPadVar(b), "24px");
}

console.log("\nKeyboard opens: shell pinned to the visible band");
{
  const b = boot({ standalone: true, envTop: 24 });
  setBand(b, 874);
  b.fireViewportEvent();
  check("keyboard class added", keyboard(b), true);
  check("height = band bottom", heightVar(b), "874px");
  check("inline body height agrees", inlineHeight(b), "874px");
}
{
  const b = boot({ standalone: true, envTop: 24, offsetTop: 40 });
  setBand(b, 834, 40);
  b.fireViewportEvent();
  check("height includes the band offset", heightVar(b), "874px");
}

console.log("\nA band past the layout viewport is not a keyboard band");
{
  const b = boot({ standalone: true, envTop: 24 });
  setBand(b, 874, 400);
  b.fireViewportEvent();
  check("no keyboard band", keyboard(b), false);
  check("no height override", heightVar(b), undefined);
  check("no inline height", inlineHeight(b), "");
}
{
  const b = boot({ standalone: true, envTop: 24 });
  setBand(b, 10, 1192);
  b.fireViewportEvent();
  check("degenerate band is not pinned", [keyboard(b), heightVar(b)], [false, undefined]);
}
{
  const b = boot({ standalone: true, envTop: 24 });
  setBand(b, 874, 60);
  b.fireViewportEvent();
  check("in-range partial scroll is honoured", heightVar(b), "934px");
}

console.log("\nEvery height change is applied");
{
  const b = boot({ standalone: true, envTop: 24, stored: { watchdog: false } });
  setBand(b, 874);
  b.fireViewportEvent();
  const heights = [heightVar(b)];
  for (let i = 1; i <= 6; i++) {
    setBand(b, 874 + i * 3);
    b.fireViewportEvent();
    heights.push(heightVar(b));
  }
  check("six 3px steps all apply", heights, ["874px", "877px", "880px", "883px", "886px", "889px", "892px"]);
}

console.log("\nWatchdog repairs a silent adjustment");
{
  const b = boot({ standalone: true, envTop: 24 });
  setBand(b, 874);
  b.fireViewportEvent();
  check("initial pin", heightVar(b), "874px");

  setBand(b, 834);
  b.flush();
  check("the next frame repairs silent drift", heightVar(b), "834px");
  check("a frame is re-armed", b.frames.length > 0, true);

  setBand(b, 814);
  b.runTimers();
  check("the settle timer repairs later drift", heightVar(b), "814px");
  check("timer delay is the watchdog window", b.timers.some((t) => t.cb !== null && t.ms === 250), true);
}
{
  const b = boot({ standalone: true, envTop: 24, stored: { watchdog: false } });
  setBand(b, 874);
  b.fireViewportEvent();
  setBand(b, 834);
  b.fireViewportEvent();
  const afterEvent = heightVar(b);
  check("an event-driven change still applies", afterEvent, "834px");

  b.flush();
  setBand(b, 794);
  b.flush();
  b.runTimers();
  check("watchdog:false leaves silent drift alone", heightVar(b), afterEvent);
  check("watchdog:false re-arms no frame", b.frames.length, 0);
}
{
  const b = boot({ standalone: true, envTop: 24 });
  setBand(b, 874);
  b.fireViewportEvent();
  check("a frame is pending", b.frames.length > 0, true);
  b.dispose();
  check("dispose cancels the pending frame", b.frames.length, 0);
}

console.log("\nDocument scroll is pinned only while the keyboard is open");
{
  const b = boot({ standalone: true, envTop: 24 });
  check("not locked before the keyboard", locked(b), false);
  check("lock CSS is present", findStyle(b, "dsh-ios-locked"), true);
  setBand(b, 874);
  b.fireViewportEvent();
  check("locked while open", locked(b), true);
  setBand(b, 1194);
  b.fireViewportEvent();
  check("unlocked when closed", locked(b), false);
}
{
  const b = boot({ standalone: true, envTop: 24, stored: { lockScroll: false } });
  setBand(b, 874);
  b.fireViewportEvent();
  check("lockScroll:false never locks", locked(b), false);
}

console.log("\nscrollReset policy");
{
  const b = boot({ standalone: true, envTop: 24, stored: { watchdog: false } });
  b.windowRef.scrollY = 96;
  setBand(b, 874);
  b.fireViewportEvent();
  check("onOpen resets once", b.scrolledTo.length, 1);

  b.windowRef.scrollY = 140;
  setBand(b, 870);
  b.fireViewportEvent();
  b.windowRef.scrollY = 200;
  b.fireViewportEvent("scroll");
  check("onOpen leaves later scroll alone", b.scrolledTo.length, 1);

  setBand(b, 1194);
  b.fireViewportEvent();
  setBand(b, 874);
  b.windowRef.scrollY = 120;
  b.fireViewportEvent();
  check("a new episode resets again", b.scrolledTo.length, 2);
}
{
  const b = boot({ standalone: true, envTop: 24, stored: { scrollReset: "always", watchdog: false } });
  b.windowRef.scrollY = 50;
  setBand(b, 874);
  b.fireViewportEvent();
  b.windowRef.scrollY = 90;
  setBand(b, 864);
  b.fireViewportEvent();
  check("always resets on every event", b.scrolledTo.length >= 2, true);
}
{
  const b = boot({ standalone: true, envTop: 24, stored: { scrollReset: "off", watchdog: false } });
  b.windowRef.scrollY = 50;
  setBand(b, 874);
  b.fireViewportEvent();
  check("off never touches scroll", b.scrolledTo.length, 0);
}

console.log("\nKeyboard closes, and a small shortfall is not a keyboard");
{
  const b = boot({ standalone: true, envTop: 24, stored: { watchdog: false } });
  setBand(b, 874);
  b.fireViewportEvent();
  setBand(b, 1194);
  b.fireViewportEvent();
  check("keyboard class removed", keyboard(b), false);
  check("height override removed", heightVar(b), undefined);
  check("inline body height removed", inlineHeight(b), "");

  setBand(b, 1154);
  b.fireViewportEvent();
  check("40px shortfall ignored at minOverlap 60", keyboard(b), false);
}
{
  const b = boot({ standalone: true, envTop: 24, stored: { minOverlap: 10, watchdog: false } });
  setBand(b, 1154);
  b.fireViewportEvent();
  check("minOverlap:10 treats 40px as a keyboard", keyboard(b), true);
}

console.log("\nMeasured iOS state: innerHeight collapses, offsetTop tracks scroll");
{
  const b = boot({ standalone: true, envTop: 24, layoutHeight: 812 });
  b.windowRef.innerHeight = 553;
  b.windowRef.scrollY = 259;
  b.viewport.offsetTop = 259;
  b.viewport.height = 364;
  b.fireViewportEvent();
  check("keyboard is detected", keyboard(b), true);
  check("shell is pinned to the visible height", heightVar(b), "364px");
  check("body height agrees", inlineHeight(b), "364px");
}

console.log("\nManual resync hook");
{
  const b = boot({ standalone: true, envTop: 24, stored: { watchdog: false } });
  check("hook listener registered", (b.listeners.window["dsh-ios-pwa-resync"] ?? []).length, 1);
  setBand(b, 874);
  (b.listeners.window["dsh-ios-pwa-resync"] ?? []).forEach((f) => f());
  b.flush();
  check("dispatching the event re-reads geometry", heightVar(b), "874px");
}

console.log("\nDispose: every trace removed");
{
  const b = boot({ standalone: true, envTop: 24 });
  setBand(b, 874);
  b.fireViewportEvent();
  b.dispose();
  check("style removed", b.registry.some((e) => e.id === "dsh-ios-pwa-fix-style"), false);
  check("strip removed", b.registry.some((e) => e.id === "dsh-ios-pwa-fix-strip"), false);
  check("root classes removed", [...b.documentElement._classes], []);
  check("height variables removed", [heightVar(b), topVar(b)], [undefined, undefined]);
  check("inline body height removed", inlineHeight(b), "");
  check("viewport listeners removed", (b.listeners.viewport.resize ?? []).length, 0);
  check("window listeners removed", (b.listeners.window.resize ?? []).length, 0);
  check("resync listener removed", (b.listeners.window["dsh-ios-pwa-resync"] ?? []).length, 0);
}

console.log("\nBundle re-execution (HMR)");
{
  const context = createContext({
    window: { __ModuleLoader__: { load: () => {} } },
    console: { log() {}, warn() {} },
  });
  let error = null;
  try {
    runInContext(readFileSync(SOURCE, "utf8"), context);
    runInContext(readFileSync(SOURCE, "utf8"), context);
  } catch (caught) {
    error = String(caught && caught.message);
  }
  check("two runs do not collide in the global scope", error, null);
}

console.log("\nSecond materialisation (HMR) does not stack a second patch");
{
  const b = boot({ standalone: true, envTop: 24 });
  b.exports.apply({ effect: () => {} });
  check("still one style element", b.registry.filter((e) => e.id === "dsh-ios-pwa-fix-style").length, 1);
  check("still one strip element", b.registry.filter((e) => e.id === "dsh-ios-pwa-fix-strip").length, 1);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
