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
 * 5. Key bar. While the keyboard is open, an optional bar above it sends keys
 *    the iOS keyboard does not provide. Esc and arrows, a new line, and
 *    one-shot modifiers are separate groups. The settings card switches each
 *    group. Cmd appears on iPad only. It sends synthetic keyboard events to the
 *    focused field.
 *
 * The patch changes layout, and the optional bar changes input. It runs inside
 * try/catch and removes every change on dispose. It is inert outside iOS and
 * iPadOS standalone display mode.
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
  /** Settings card slot key: the bundle package name. */
  const PACKAGE_NAME = "dsh-ios-pwa-fix";
  /** Public hook: `window.dispatchEvent(new Event("dsh-ios-pwa-resync"))` forces a pass. */
  const RESYNC_EVENT = "dsh-ios-pwa-resync";
  /** How long after the last viewport event to keep re-checking (ms). */
  const WATCHDOG_MS = 250;
  /** Hold a closed-looking band this long before releasing the pin (ms). */
  const CLOSE_GRACE_MS = 200;
  /** Ignore the band for this long after a rotation (ms). */
  const ROTATION_GRACE_MS = 350;
  /** Reject a band equal to the other orientation's layout height (ms). */
  const ROTATION_RESIDUE_MS = 3000;

  /**
   * Defaults. Override any of them for a device-local change with:
   *   const stored = JSON.parse(localStorage.getItem("dsh-ios-pwa-fix") || "{}")
   *   localStorage.setItem("dsh-ios-pwa-fix", JSON.stringify({ ...stored, strip: "off" }))
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

  /** Reject before the module loader hands over its `require`. */
  let requireModule = () => {
    throw new Error("client module require is unavailable");
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

  /* ------------------------------------------------------------------
   * Key bar
   *
   * The bar sends synthetic keyboard events to the focused field. The
   * composer's keymap receives them like a hardware keyboard. When the
   * target is a plain input or textarea, the bar moves the caret itself.
   * ---------------------------------------------------------------- */

  const KEY_BAR_ID = "dsh-ios-pwa-keybar";
  const KEY_BAR_STYLE_ID = "dsh-ios-pwa-keybar-style";
  const KEY_BAR_CLASS = "dsh-ios-keybar";
  const KEY_BAR_HEIGHT = 44;
  /** Key bar groups, in display order. */
  const ALL_KEY_BAR_GROUPS = ["esc", "tab", "modifiers", "arrows", "newline"];
  /** Locale dictionary namespace owned by this plugin. */
  const LOCALE_NS = "iosPwaFix";

  /**
   * Client copy for the settings card and the bar's accessible labels.
   *
   * The package locale files hold Plugin Manager meta only. The browser bundle
   * cannot import them without a build step, so the client dictionary is
   * registered with the client locale service here.
   */
  /* TODO: Move these to resource file after having a build system. */
  const CLIENT_DICTIONARY = {
    en: {
      "settings.title": "Key bar",
      "settings.description":
        "Extra keys above the on-screen keyboard. The switches apply to this browser.",
      "settings.master": "Show key bar",
      "settings.masterHint": "Shows the enabled groups above the on-screen keyboard.",
      "settings.esc": "Esc",
      "settings.escHint": "Adds the Escape key.",
      "settings.arrows": "Arrow keys",
      "settings.arrowsHint": "Adds the four arrow keys.",
      "settings.newline": "New line",
      "settings.newlineHint": "Adds a new line key. It sends Shift+Enter.",
      "settings.modifiers": "Modifier keys",
      "settings.modifiersHint": "Adds Ctrl, Alt, and Shift. It adds Cmd on iPad.",
      "settings.tab": "Tab",
      "settings.tabHint": "Adds the Tab key.",
      "keyBar.label": "Key bar",
      "keyBar.escape": "Escape",
      "keyBar.left": "Left arrow",
      "keyBar.up": "Up arrow",
      "keyBar.down": "Down arrow",
      "keyBar.right": "Right arrow",
      "keyBar.newline": "New line",
      "keyBar.ctrl": "Control",
      "keyBar.alt": "Alt",
      "keyBar.shift": "Shift",
      "keyBar.cmd": "Command",
    },
    zh: {
      "settings.title": "按键栏",
      "settings.description":
        "在屏幕键盘上方显示额外按键。这些开关仅对当前浏览器生效。",
      "settings.master": "显示按键栏",
      "settings.masterHint": "在屏幕键盘上方显示已开启的分组。",
      "settings.esc": "Esc",
      "settings.escHint": "添加Esc键。",
      "settings.arrows": "方向键",
      "settings.arrowsHint": "添加四个方向键。",
      "settings.newline": "换行",
      "settings.newlineHint": "添加换行键，发送Shift+Enter。",
      "settings.modifiers": "修饰键",
      "settings.modifiersHint": "添加Ctrl、Alt和Shift。在iPad上添加Cmd。",
      "settings.tab": "Tab",
      "settings.tabHint": "添加Tab键。",
      "keyBar.label": "按键栏",
      "keyBar.escape": "Esc",
      "keyBar.left": "左方向键",
      "keyBar.up": "上方向键",
      "keyBar.down": "下方向键",
      "keyBar.right": "右方向键",
      "keyBar.newline": "换行",
      "keyBar.ctrl": "Control",
      "keyBar.alt": "Alt",
      "keyBar.shift": "Shift",
      "keyBar.cmd": "Command",
      "keyBar.tab": "Tab",
    },
  };

  /** English, or Chinese when the browser language starts with `zh`. */
  function fallbackText() {
    let language = "en";
    try {
      language = String((window.navigator && window.navigator.language) || "en");
    } catch (_error) {
      language = "en";
    }
    const dictionary = language.toLowerCase().indexOf("zh") === 0 ? CLIENT_DICTIONARY.zh : CLIENT_DICTIONARY.en;
    return (key) => {
      if (dictionary[key] !== undefined) return dictionary[key];
      if (CLIENT_DICTIONARY.en[key] !== undefined) return CLIENT_DICTIONARY.en[key];
      return key;
    };
  }

  /** Keep only known groups, in display order, without duplicates. */
  function sanitizeKeyBarGroups(value) {
    if (!Array.isArray(value)) return [];
    const groups = value.slice();
    // Older selections grouped Esc with the arrows; split the value into both groups.
    if (groups.indexOf("navigation") !== -1) groups.push("esc", "arrows");
    return ALL_KEY_BAR_GROUPS.filter((group) => groups.indexOf(group) !== -1);
  }

  /** Read the master switch and groups from a stored settings object. */
  function keyBarSettingsFrom(stored) {
    const groups = Array.isArray(stored.keyBarGroups)
      ? sanitizeKeyBarGroups(stored.keyBarGroups)
      : ALL_KEY_BAR_GROUPS.slice();
    // Add Tab to a non-empty selection that predates the Tab group.
    if (
      Array.isArray(stored.keyBarGroups) &&
      stored.keyBarGroupsVersion !== 2 &&
      groups.length > 0 &&
      groups.indexOf("tab") === -1
    ) {
      groups.push("tab");
    }
    return { enabled: stored.keyBar !== false, groups: sanitizeKeyBarGroups(groups) };
  }

  /** Read the master switch and groups. */
  function readKeyBarSettings(windowRef) {
    try {
      const parsed = JSON.parse(windowRef.localStorage.getItem(STORAGE_KEY) || "{}") || {};
      return keyBarSettingsFrom(parsed);
    } catch (_error) {
      return { enabled: false, groups: ALL_KEY_BAR_GROUPS.slice() };
    }
  }

  const KEY_BAR_LISTENERS = new Set();

  /** Store the master switch and groups, then notify the patch and the card. */
  function writeKeyBarSettings(windowRef, value) {
    const next = {
      enabled: value && value.enabled === true,
      groups: sanitizeKeyBarGroups(value && value.groups),
    };
    try {
      let current = {};
      try {
        current = JSON.parse(windowRef.localStorage.getItem(STORAGE_KEY) || "{}") || {};
      } catch (_error) {
        current = {};
      }
      current.keyBar = next.enabled;
      current.keyBarGroups = next.groups;
      current.keyBarGroupsVersion = 2;
      windowRef.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch (_error) {
      // Private mode or a full store: the running patch still changes.
    }
    for (const listener of KEY_BAR_LISTENERS) {
      try {
        listener({ enabled: next.enabled, groups: next.groups.slice() });
      } catch (_error) {
        // One broken listener must not block the rest.
      }
    }
  }

  /** Observe the key bar switch; returns the unsubscribe function. */
  function subscribeKeyBar(listener) {
    KEY_BAR_LISTENERS.add(listener);
    return () => {
      KEY_BAR_LISTENERS.delete(listener);
    };
  }

  /** Modifier names and the event field each one writes. */
  const MODIFIERS = ["ctrl", "alt", "shift", "meta"];

  /** One button of the bar. A separator sits before a group. */
  const KEY_SPECS = [
    { label: "Esc", key: "Escape", labelKey: "keyBar.escape", group: "esc" },
    { label: "Tab", key: "Tab", labelKey: "keyBar.tab", group: "tab", separatorBefore: true },
    { label: "Ctrl", modifier: "ctrl", labelKey: "keyBar.ctrl", group: "modifiers", separatorBefore: true },
    { label: "Alt", modifier: "alt", labelKey: "keyBar.alt", group: "modifiers" },
    { label: "Shift", modifier: "shift", labelKey: "keyBar.shift", group: "modifiers" },
    { label: "Cmd", modifier: "meta", labelKey: "keyBar.cmd", group: "modifiers", ipadOnly: true },
    { label: "\u2190", key: "ArrowLeft", labelKey: "keyBar.left", group: "arrows", separatorBefore: true },
    { label: "\u2191", key: "ArrowUp", labelKey: "keyBar.up", group: "arrows" },
    { label: "\u2193", key: "ArrowDown", labelKey: "keyBar.down", group: "arrows" },
    { label: "\u2192", key: "ArrowRight", labelKey: "keyBar.right", group: "arrows" },
    { label: "\u21b5", key: "Enter", shift: true, labelKey: "keyBar.newline", group: "newline", separatorBefore: true },
  ];

  const NON_TEXT_INPUT_TYPES = [
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ];

  /** A field with selectionStart, such as input or textarea. */
  function isTextInput(element) {
    if (!element) return false;
    const tag = String(element.tagName || "").toUpperCase();
    if (tag !== "INPUT" && tag !== "TEXTAREA") return false;
    if (tag === "INPUT") {
      const type = String(element.type || "text").toLowerCase();
      if (NON_TEXT_INPUT_TYPES.indexOf(type) !== -1) return false;
    }
    return typeof element.selectionStart === "number";
  }

  /** A field the bar can send keys to. */
  function isEditable(element) {
    if (!element) return false;
    if (isTextInput(element)) return true;
    if (element.isContentEditable === true) return true;
    return typeof element.getAttribute === "function" && element.getAttribute("contenteditable") === "true";
  }

  /** The focused field, the composer, or the focused control. */
  function keyTarget(doc) {
    const active = doc.activeElement;
    if (isEditable(active)) return active;
    let composer = null;
    try {
      composer = doc.querySelector ? doc.querySelector("[data-composer-input]") : null;
    } catch (_error) {
      composer = null;
    }
    if (composer) return composer;
    return active && active !== doc.body ? active : doc.body;
  }

  const isWordCharacter = (character) => /[\w\u0080-\uffff]/.test(character);

  function lineStart(value, index) {
    if (index <= 0) return 0;
    return value.lastIndexOf("\n", index - 1) + 1;
  }

  function lineEnd(value, index) {
    if (index >= value.length) return value.length;
    const found = value.indexOf("\n", index);
    return found === -1 ? value.length : found;
  }

  function moveLine(value, index, direction) {
    const start = lineStart(value, index);
    const end = lineEnd(value, index);
    const column = index - start;
    if (direction < 0) {
      if (start === 0) return 0;
      const previousEnd = start - 1;
      const previousStart = lineStart(value, previousEnd);
      return Math.min(previousStart + column, previousEnd);
    }
    if (end >= value.length) return value.length;
    const nextStart = end + 1;
    return Math.min(nextStart + column, lineEnd(value, nextStart));
  }

  function wordStart(value, index) {
    let position = index;
    while (position > 0 && !isWordCharacter(value[position - 1])) position--;
    while (position > 0 && isWordCharacter(value[position - 1])) position--;
    return position;
  }

  function wordEnd(value, index) {
    let position = index;
    while (position < value.length && !isWordCharacter(value[position])) position++;
    while (position < value.length && isWordCharacter(value[position])) position++;
    return position;
  }

  function moveIndex(value, index, key, init) {
    const forward = key === "ArrowRight" || key === "ArrowDown";
    const position = Math.max(0, Math.min(value.length, index));
    if (key === "ArrowUp" || key === "ArrowDown") return moveLine(value, position, forward ? 1 : -1);
    if (init.metaKey) return forward ? lineEnd(value, position) : lineStart(value, position);
    if (init.ctrlKey || init.altKey) return forward ? wordEnd(value, position) : wordStart(value, position);
    return Math.max(0, Math.min(value.length, position + (forward ? 1 : -1)));
  }

  /** Move the caret in an input or textarea after the app did not handle the key. */
  function moveTextControl(target, key, init) {
    const value = String(target.value || "");
    const start = target.selectionStart;
    const end = target.selectionEnd;
    if (typeof start !== "number" || typeof end !== "number") return;
    const forward = key === "ArrowRight" || key === "ArrowDown";
    if (start !== end && !init.shiftKey) {
      const position = forward ? end : start;
      target.setSelectionRange(position, position);
      return;
    }
    let anchor = start;
    let focus = end;
    if (target.selectionDirection === "backward") {
      anchor = end;
      focus = start;
    }
    const next = moveIndex(value, focus, key, init);
    if (init.shiftKey) {
      target.setSelectionRange(Math.min(anchor, next), Math.max(anchor, next), next < anchor ? "backward" : "forward");
    } else {
      target.setSelectionRange(next, next);
    }
  }

  /** Move the caret in a contenteditable field after the app did not handle the key. */
  function moveContentEditable(windowRef, key, init) {
    const selection = windowRef.getSelection ? windowRef.getSelection() : null;
    if (!selection || typeof selection.modify !== "function") return;
    const forward = key === "ArrowRight" || key === "ArrowDown";
    let granularity = "character";
    if (key === "ArrowUp" || key === "ArrowDown") granularity = "line";
    else if (init.metaKey) granularity = "lineboundary";
    else if (init.ctrlKey || init.altKey) granularity = "word";
    selection.modify(init.shiftKey ? "extend" : "move", forward ? "forward" : "backward", granularity);
  }

  /** Insert text into a textarea and notify its listeners. */
  function insertTextareaText(windowRef, target, text) {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    if (typeof start !== "number" || typeof end !== "number") return;
    const value = String(target.value || "");
    target.value = value.slice(0, start) + text + value.slice(end);
    const caret = start + text.length;
    target.setSelectionRange(caret, caret);
    try {
      target.dispatchEvent(new windowRef.Event("input", { bubbles: true }));
    } catch (_error) {
      // A DOM without Event still has the inserted text.
    }
  }

  /** Apply the key when no app handler consumed the synthetic event. */
  function applyKeyFallback(windowRef, doc, target, spec, init) {
    if (spec.key === "Enter") {
      if (isTextInput(target) && String(target.tagName || "").toUpperCase() === "TEXTAREA") {
        insertTextareaText(windowRef, target, "\n");
      } else if (isEditable(target) && typeof doc.execCommand === "function") {
        try {
          doc.execCommand("insertLineBreak", false);
        } catch (_error) {
          // The insertion point may be inactive.
        }
      }
      return;
    }
    if (spec.key === "Tab") {
      if (isTextInput(target) && String(target.tagName || "").toUpperCase() === "TEXTAREA") {
        insertTextareaText(windowRef, target, "\t");
      }
      return;
    }
    if (
      spec.key !== "ArrowLeft" &&
      spec.key !== "ArrowRight" &&
      spec.key !== "ArrowUp" &&
      spec.key !== "ArrowDown"
    ) {
      return;
    }
    if (isTextInput(target)) moveTextControl(target, spec.key, init);
    else if (isEditable(target)) moveContentEditable(windowRef, spec.key, init);
  }

  /**
   * Build the bar, its buttons, and the one-shot modifier state.
   *
   * A pointerdown handler prevents focus from leaving the composer, so the
   * on-screen keyboard stays open while the bar is used.
   */
  function createKeyBar(windowRef, doc, t, platform, initialGroups) {
    const element = doc.createElement("div");
    element.id = KEY_BAR_ID;
    element.setAttribute("role", "toolbar");
    element.setAttribute("aria-label", t("keyBar.label"));

    const armed = new Set();
    const modifierButtons = {};
    const buttonsByGroup = { esc: [], tab: [], modifiers: [], arrows: [], newline: [] };
    const separatorsBefore = {};

    const paintModifiers = () => {
      for (const name of MODIFIERS) {
        const button = modifierButtons[name];
        if (button) button.setAttribute("aria-pressed", armed.has(name) ? "true" : "false");
      }
    };

    const clear = () => {
      armed.clear();
      paintModifiers();
    };

    const setGroups = (groups) => {
      const visible = sanitizeKeyBarGroups(groups);
      for (const group of ALL_KEY_BAR_GROUPS) {
        const on = visible.indexOf(group) !== -1;
        for (const button of buttonsByGroup[group]) button.style.display = on ? "" : "none";
        const separator = separatorsBefore[group];
        if (!separator) continue;
        // One separator before each visible group after the first visible one.
        const index = ALL_KEY_BAR_GROUPS.indexOf(group);
        const hasPrevious = ALL_KEY_BAR_GROUPS.slice(0, index).some((item) => visible.indexOf(item) !== -1);
        separator.style.display = on && hasPrevious ? "" : "none";
      }
    };

    const send = (spec) => {
      const target = keyTarget(doc);
      // The new line key keeps its meaning when a modifier is armed.
      const onlyShift = spec.shift === true;
      const init = {
        key: spec.key,
        code: spec.key,
        bubbles: true,
        cancelable: true,
        composed: true,
        ctrlKey: onlyShift ? false : armed.has("ctrl"),
        altKey: onlyShift ? false : armed.has("alt"),
        shiftKey: onlyShift || armed.has("shift"),
        metaKey: onlyShift ? false : armed.has("meta"),
        repeat: false,
        isComposing: false,
      };
      let prevented = false;
      try {
        const KeyboardEvent = windowRef.KeyboardEvent;
        const down = new KeyboardEvent("keydown", init);
        prevented = target.dispatchEvent(down) === false || down.defaultPrevented === true;
        target.dispatchEvent(new KeyboardEvent("keyup", init));
      } catch (_error) {
        // No KeyboardEvent: leave the field alone.
        prevented = true;
      }
      if (!prevented) applyKeyFallback(windowRef, doc, target, spec, init);
      clear();
    };

    const activate = (spec) => {
      if (spec.modifier) {
        if (armed.has(spec.modifier)) armed.delete(spec.modifier);
        else armed.add(spec.modifier);
        paintModifiers();
        return;
      }
      send(spec);
    };

    for (const spec of KEY_SPECS) {
      if (spec.ipadOnly && platform !== "ipad") continue;
      if (spec.separatorBefore) {
        const separator = doc.createElement("span");
        separator.className = "dsh-ios-pwa-keybar-sep";
        separatorsBefore[spec.group] = separator;
        element.appendChild(separator);
      }
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "dsh-ios-pwa-key";
      button.textContent = spec.label;
      button.setAttribute("aria-label", t(spec.labelKey));
      if (spec.modifier) {
        button.setAttribute("aria-pressed", "false");
        modifierButtons[spec.modifier] = button;
      }
      buttonsByGroup[spec.group].push(button);
      button.addEventListener("pointerdown", (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        activate(spec);
      });
      // Pointer events prevent focus on current WebKit; the compatibility
      // mouse event covers a browser that still focuses on mousedown.
      button.addEventListener("mousedown", (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
      });
      button.addEventListener("keydown", (event) => {
        if (event && (event.key === "Enter" || event.key === " " || event.key === "Spacebar")) {
          event.preventDefault();
          activate(spec);
        }
      });
      element.appendChild(button);
    }

    setGroups(initialGroups);
    return { element, clear, setGroups };
  }

  /** Register the dictionary and return the active translator, or the fallback. */
  function registerLocale(ctx) {
    const fallback = fallbackText();
    if (!ctx || typeof ctx.effect !== "function" || typeof ctx.get !== "function") return fallback;
    let locale = null;
    try {
      locale = ctx.get("locale");
    } catch (_error) {
      locale = null;
    }
    if (!locale || typeof locale.register !== "function") return fallback;
    ctx.effect(() => locale.register(LOCALE_NS, CLIENT_DICTIONARY));
    if (typeof locale.bind === "function") {
      try {
        return locale.bind(LOCALE_NS);
      } catch (_error) {
        return fallback;
      }
    }
    return fallback;
  }

  /** Register this bundle's settings card on the Plugins page when Slots exist. */
  function registerSettingsCard(ctx, t) {
    if (!ctx || typeof ctx.inject !== "function") return;
    ctx.inject(["slots"], (scope) => {
      try {
        if (!scope || !scope.slots || typeof scope.slots.register !== "function") return;
        if (!ensureReact()) return;
        scope.slots.inject("plugins.bundle.config", () =>
          scope.slots.register(
            {
              name: "plugins.bundle.config",
              key: PACKAGE_NAME,
              locale: LOCALE_NS,
              inject: () => ({ t }),
            },
            KeyBarSettings,
          ),
        );
      } catch (error) {
        console.warn("[dsh-ios-pwa-fix] settings card", error);
      }
    });
  }

  let ReactLib = null;

  function ensureReact() {
    if (ReactLib) return true;
    try {
      const module = requireModule("react");
      ReactLib = module && typeof module.createElement === "function" ? module : module && module.default;
      return !!(
        ReactLib &&
        typeof ReactLib.createElement === "function" &&
        typeof ReactLib.useState === "function" &&
        typeof ReactLib.useEffect === "function"
      );
    } catch (_error) {
      return false;
    }
  }

  /** The three switchable key groups, in display order. */
  const KEY_BAR_GROUPS = [
    { id: "esc", labelKey: "settings.esc", hintKey: "settings.escHint" },
    { id: "tab", labelKey: "settings.tab", hintKey: "settings.tabHint" },
    { id: "modifiers", labelKey: "settings.modifiers", hintKey: "settings.modifiersHint" },
    { id: "arrows", labelKey: "settings.arrows", hintKey: "settings.arrowsHint" },
    { id: "newline", labelKey: "settings.newline", hintKey: "settings.newlineHint" },
  ];

  const switchBoxStyle = (on) => ({
    boxSizing: "border-box",
    position: "relative",
    flex: "0 0 auto",
    width: "36px",
    height: "20px",
    padding: "2px",
    border: 0,
    borderRadius: "999px",
    background: on ? "var(--dsw-alias-brand-primary)" : "var(--dsw-alias-border-l3)",
    cursor: "pointer",
    transition: "background .12s ease",
  });

  const switchThumbStyle = (on) => ({
    display: "block",
    width: "16px",
    height: "16px",
    borderRadius: "50%",
    background: on ? "var(--dsw-alias-label-primary-foreground)" : "var(--dsw-alias-switch-thumb)",
    transform: on ? "translate(16px)" : "none",
    transition: "transform .12s ease",
  });

  /** The key bar section: one master switch and one switch per key group. */
  function KeyBarSettings(props) {
    const provided = props && typeof props.t === "function" ? props.t : null;
    const t = provided && provided("settings.title") !== "settings.title" ? provided : fallbackText();
    const h = ReactLib.createElement;
    const [state, setState] = ReactLib.useState(readKeyBarSettings(window));

    ReactLib.useEffect(() => subscribeKeyBar(setState), []);

    const write = (next) => {
      setState(next);
      writeKeyBarSettings(window, next);
    };

    const toggleMaster = () => {
      const current = readKeyBarSettings(window);
      write({ enabled: !current.enabled, groups: current.groups });
    };

    const toggleGroup = (group) => {
      const current = readKeyBarSettings(window);
      if (!current.enabled) return;
      const groups =
        current.groups.indexOf(group) === -1
          ? current.groups.concat(group)
          : current.groups.filter((item) => item !== group);
      write({ enabled: true, groups });
    };

    const switchButton = (label, on, onClick, disabled) =>
      h(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": on,
          "aria-label": label,
          onClick,
          disabled,
          style: {
            ...switchBoxStyle(on),
            cursor: disabled ? "default" : "pointer",
            opacity: disabled ? 0.5 : 1,
          },
        },
        h("span", { style: switchThumbStyle(on) }),
      );

    const hint = (text) =>
      h(
        "p",
        {
          style: {
            margin: 0,
            color: "var(--dsw-alias-label-tertiary)",
            fontSize: "12px",
            lineHeight: 1.5,
          },
        },
        text,
      );

    const rowLabelStyle = (enabled) => ({
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: "16px",
      color: "var(--dsw-alias-label-primary)",
      fontSize: "13px",
      lineHeight: 1.5,
      cursor: enabled ? "pointer" : "default",
    });

    const groupRow = (spec) => {
      const on = state.groups.indexOf(spec.id) !== -1;
      return h(
        "div",
        { key: spec.id, style: { display: "grid", gap: "4px" } },
        h(
          "label",
          { style: rowLabelStyle(state.enabled) },
          h("span", null, t(spec.labelKey)),
          switchButton(t(spec.labelKey), on, () => toggleGroup(spec.id), !state.enabled),
        ),
        hint(t(spec.hintKey)),
      );
    };

    return h(
      "section",
      { style: { display: "grid", gap: "12px" } },
      h(
        "div",
        { style: { display: "grid", gap: "4px" } },
        h(
          "h3",
          {
            style: {
              margin: 0,
              color: "var(--dsw-alias-label-primary)",
              fontSize: "14px",
              fontWeight: 600,
              lineHeight: 1.4,
            },
          },
          t("settings.title"),
        ),
        hint(t("settings.description")),
      ),
      h(
        "div",
        { style: { display: "grid", gap: "4px" } },
        h(
          "label",
          { style: rowLabelStyle(true) },
          h("span", null, t("settings.master")),
          switchButton(t("settings.master"), state.enabled, toggleMaster, false),
        ),
        hint(t("settings.masterHint")),
      ),
      h(
        "div",
        {
          style: {
            display: "grid",
            gap: "10px",
            paddingLeft: "12px",
            borderLeft: "2px solid var(--dsw-alias-border-l2)",
            opacity: state.enabled ? 1 : 0.55,
          },
        },
        KEY_BAR_GROUPS.map(groupRow),
      ),
    );
  }

  const KEY_BAR_CSS = [
    // The key bar sits at the top of the on-screen keyboard. It reserves the
    // same height at the bottom of the body, so the composer stays above it.
    `html.${ROOT_CLASS} {`,
    `  --dsh-ios-keybar-h: ${KEY_BAR_HEIGHT}px;`,
    "}",
    `html.${ROOT_CLASS}.${KEY_BAR_CLASS} body {`,
    "  padding-bottom: var(--dsh-ios-keybar-h, 44px) !important;",
    "}",
    `#${KEY_BAR_ID} {`,
    "  position: fixed;",
    "  left: 0;",
    "  right: 0;",
    "  top: calc(var(--dsh-ios-vvh, 100vh) - var(--dsh-ios-keybar-h, 44px));",
    "  height: var(--dsh-ios-keybar-h, 44px);",
    "  box-sizing: border-box;",
    "  display: none;",
    "  align-items: center;",
    "  gap: 4px;",
    "  padding: 0 6px;",
    "  background: var(--dsw-alias-bg-base, #ffffff);",
    "  border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));",
    "  z-index: 2147483646;",
    "  overflow: hidden;",
    "}",
    `html.${ROOT_CLASS}.${KEY_BAR_CLASS} #${KEY_BAR_ID} {`,
    "  display: flex;",
    "}",
    `#${KEY_BAR_ID} button {`,
    "  flex: 1 1 0;",
    "  min-width: 0;",
    "  height: 40px;",
    "  padding: 0 2px;",
    "  border: 0;",
    "  border-radius: 8px;",
    "  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06));",
    "  color: var(--dsw-alias-label-primary, #111111);",
    "  font: inherit;",
    "  font-size: 12px;",
    "  line-height: 1;",
    "  white-space: nowrap;",
    "  overflow: hidden;",
    "  -webkit-appearance: none;",
    "  appearance: none;",
    "  touch-action: manipulation;",
    "  -webkit-user-select: none;",
    "  user-select: none;",
    "  -webkit-touch-callout: none;",
    "}",
    `#${KEY_BAR_ID} button:active {`,
    "  background: var(--dsw-alias-interactive-bg-active, rgba(0, 0, 0, 0.12));",
    "}",
    `#${KEY_BAR_ID} button[aria-pressed="true"] {`,
    "  background: var(--dsw-alias-brand-primary, #247bbf);",
    "  color: var(--dsw-alias-label-primary-foreground, #ffffff);",
    "}",
    `#${KEY_BAR_ID} .dsh-ios-pwa-keybar-sep {`,
    "  flex: 0 0 1px;",
    "  align-self: center;",
    "  height: 20px;",
    "  margin: 0 2px;",
    "  background: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));",
    "}",
    "@media (max-width: 360px) {",
    `  #${KEY_BAR_ID} { gap: 3px; padding: 0 4px; }`,
    `  #${KEY_BAR_ID} button { font-size: 11px; }`,
    "}",
  ].join("\n");

  /** Mount the bar for one layout patch; returns its controller. */
  function mountKeyBar(windowRef, doc, env, t) {
    const root = doc.documentElement;
    let element = null;
    let style = null;
    let ready = false;
    let open = false;
    let clear = () => {};
    let setGroups = () => {};

    try {
      const oldStyle = doc.getElementById(KEY_BAR_STYLE_ID);
      if (oldStyle) oldStyle.remove();
      style = doc.createElement("style");
      style.id = KEY_BAR_STYLE_ID;
      style.textContent = KEY_BAR_CSS;
      doc.head.appendChild(style);

      const bar = createKeyBar(windowRef, doc, t, env.platform, []);
      element = bar.element;
      clear = bar.clear;
      setGroups = bar.setGroups;
      const oldBar = doc.getElementById(KEY_BAR_ID);
      if (oldBar) oldBar.remove();
      doc.body.appendChild(element);
      ready = true;
    } catch (error) {
      console.warn("[dsh-ios-pwa-fix] key bar", error);
      if (style) style.remove();
      style = null;
    }

    let stateKey = "";
    const update = () => {
      if (!ready) return;
      const value = readKeyBarSettings(windowRef);
      const key = open ? value.enabled + "|" + value.groups.join(",") : "closed";
      if (key === stateKey) return;
      stateKey = key;
      if (!open) {
        root.classList.remove(KEY_BAR_CLASS);
        clear();
        return;
      }
      setGroups(value.groups);
      if (value.enabled && value.groups.length > 0) {
        root.classList.add(KEY_BAR_CLASS);
        return;
      }
      root.classList.remove(KEY_BAR_CLASS);
      clear();
    };

    const unsubscribe = ready ? subscribeKeyBar(update) : () => {};

    return {
      show() {
        open = true;
        update();
      },
      hide() {
        open = false;
        update();
      },
      dispose() {
        open = false;
        unsubscribe();
        if (ready) root.classList.remove(KEY_BAR_CLASS);
        if (element) element.remove();
        if (style) style.remove();
        ready = false;
        element = null;
        style = null;
      },
    };
  }

  /** The key bar's module surface: install on a context, mount in a patch. */
  const KeyBar = {
    install(ctx) {
      let t = fallbackText();
      try {
        t = registerLocale(ctx);
      } catch (_error) {
        t = fallbackText();
      }
      try {
        registerSettingsCard(ctx, t);
      } catch (error) {
        console.warn("[dsh-ios-pwa-fix] settings card", error);
      }
      return t;
    },
    mount: mountKeyBar,
    get: () => readKeyBarSettings(window),
    set: (value) => writeKeyBarSettings(window, value),
    subscribe: subscribeKeyBar,
  };

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

      // The key bar owns its dictionary and settings card. Both exist on every
      // platform; the bar itself mounts only in the Home Screen app.
      const keyBarText = KeyBar.install(ctx);

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

      const keyBar = KeyBar.mount(windowRef, doc, env, keyBarText);

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
      let closedAt = -1;
      let closeTimer = 0;
      let rotationUntil = 0;
      let rotationFromHeight = 0;
      let rotationResidueUntil = 0;
      let rotationTimer = 0;
      let lastLayoutHeight = 0;
      let lastWidth = Math.round((viewport && viewport.width) || 0);

      const now = () => {
        const perf = windowRef.performance;
        return perf && typeof perf.now === "function" ? perf.now() : Date.now();
      };

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
        keyBar.show();
      };

      /** Put everything back the way the unpatched shell had it. */
      const release = () => {
        root.classList.remove(KEYBOARD_CLASS, LOCK_CLASS);
        root.style.removeProperty("--dsh-ios-vvh");
        root.style.setProperty("--dsh-ios-body-pad", stripPx + "px");
        body.style.removeProperty("height");
        keyBar.hide();
        appliedHeight = -1;
        keyboardOpen = false;
        closedAt = -1;
        if (closeTimer) {
          windowRef.clearTimeout(closeTimer);
          closeTimer = 0;
        }
      };

      /** Align the layout with the visible band: keyboard open, or full height. */
      const sync = (reason) => {
        if (!viewport) return;

        const stamp = now();
        const geo = geometry();
        const width = Math.round(viewport.width) || 0;

        // A rotation changes only the width. The old pin belongs to the old
        // orientation, so drop it and let the layout settle before pinning
        // again.
        if (width > 0 && lastWidth > 0 && width !== lastWidth) {
          lastWidth = width;
          rotationUntil = stamp + ROTATION_GRACE_MS;
          rotationFromHeight = lastLayoutHeight;
          rotationResidueUntil = stamp + ROTATION_RESIDUE_MS;
          if (keyboardOpen) release();
          if (rotationTimer) windowRef.clearTimeout(rotationTimer);
          rotationTimer = windowRef.setTimeout(() => {
            rotationTimer = 0;
            pass("rotation");
          }, ROTATION_GRACE_MS);
        } else if (width > 0) {
          lastWidth = width;
        }
        lastLayoutHeight = geo.layoutHeight;

        if (stamp < rotationUntil) return;

        if (!geo.open) {
          if (keyboardOpen) {
            // iPadOS reports the full height for a few frames during a scroll
            // or a rotation. Keep the pin until the closed state lasts.
            if (closedAt < 0) closedAt = stamp;
            if (stamp - closedAt >= CLOSE_GRACE_MS) {
              release();
            } else if (!closeTimer) {
              closeTimer = windowRef.setTimeout(() => {
                closeTimer = 0;
                pass("close");
              }, CLOSE_GRACE_MS - (stamp - closedAt));
            }
          }
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

        // A band that equals the other orientation's layout height is the
        // stale visual viewport, not a keyboard.
        if (stamp < rotationResidueUntil && rotationFromHeight > 0 && Math.abs(geo.height - rotationFromHeight) <= 8) {
          if (cfg.debug) {
            console.log("[dsh-ios-pwa-fix]", {
              reason,
              open: false,
              stale: rotationFromHeight,
              viewportHeight: geo.height,
              innerHeight: geo.layoutHeight,
            });
          }
          return;
        }

        if (closeTimer) {
          windowRef.clearTimeout(closeTimer);
          closeTimer = 0;
        }
        closedAt = -1;
        rotationFromHeight = 0;
        rotationResidueUntil = 0;

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
        if (closeTimer) windowRef.clearTimeout(closeTimer);
        if (rotationTimer) windowRef.clearTimeout(rotationTimer);
        frame = 0;
        settleTimer = 0;
        closeTimer = 0;
        rotationTimer = 0;
        release();
        keyBar.dispose();
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
    keyBar: KeyBar,
    inject: [],
  };
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

  window.__ModuleLoader__.load({
    id: PACKAGE_NAME,
    factory: (require) => {
      if (typeof require === "function") requireModule = require;
      return exports;
    },
  });
})();
