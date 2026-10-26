# AGENTS.md

Orientation for agents working on `dsh-ios-pwa-fix`.

## What this project is

A DSH client plugin for the DeepSeek Harness web GUI. It keeps the GUI usable
as an iPhone or iPad Home Screen app:

- reserves the status-bar strip when the page spans the screen;
- pins the page to the visible band while the on-screen keyboard is open;
- keeps text fields at 16px or more, so WebKit does not zoom on focus;
- offers an optional key bar with Esc, Tab, arrows, a new line, and modifiers.

The key bar has a master switch and five group switches: Esc, Tab, modifiers,
arrow keys, and new line. All switches default on. The bar shows only the enabled
groups, with a separator between visible groups. Cmd appears on iPad only.

It is a browser layout patch with an optional input bar. It starts no service
and reads no data. The key bar sends synthetic keyboard events to the focused
field. The layout patch is inert outside iOS and iPadOS standalone display mode.
The settings card is visible on every platform.

## Repository layout

| path | role |
|---|---|
| `package.json` | Bundle declaration: `dsh.bundle.patch`, `dsh.client`, locale, and icon. |
| `cordis.patch.yml` | Loader row `id: ios-pwa-fix`, `name: dsh-ios-pwa-fix`. |
| `lib/index.js` | Host half. A no-op entry so the profile can load the package. |
| `lib/client.js` | Browser half. Hand-written bundle. No build step. |
| `scripts/verify.mjs` | Stubbed-DOM test suite. |
| `locale/en.json`, `locale/zh.json` | Plugin Manager title and description. |
| `icon.svg` | Plugin Manager artwork. |
| `README.md` | User documentation. Not a changelog. |
| `release-notes.md` | Brief, publishable release notes. |

## How the plugin loads

- The Host applies `cordis.patch.yml` and inserts the loader row.
- `package.json` declares `dsh.client` with `platform: "web"` and
  `immediately: true`, so the browser materialises the bundle at boot.
- The `id` in `lib/client.js` must equal the resolved package name:
  `dsh-ios-pwa-fix`.
- The bundle is written directly in the built-bundle format:
  `window.__ModuleLoader__.load({ id, factory })`.
- Re-materialisation is guarded by the style element, so one layout patch stays
  active.
- The key bar feature registers its settings card into `plugins.bundle.config`
  under the package name. It needs `slots`; React is loaded from the browser
  module table only when the card registers. The layout patch only calls
  `KeyBar.install`, `KeyBar.mount`, `show`, `hide`, and `dispose`.

## Browser half

Read the header of `lib/client.js` first. The main pieces:

| piece | behavior |
|---|---|
| `detectEnvironment` | Reads the user agent, display mode, page scale, and touch. |
| `statusBarHeight` | Reserves the strip only when the page spans the screen. |
| `geometry` | Uses `documentElement.clientHeight`, not `innerHeight`. |
| `sync` | Pins or releases the shell. Holds the pin through closed-looking transients. |
| `pass` | Runs one pass, then a watchdog frame and a settle pass while open. |
| `paint` | Writes the pinned height, then asks the key bar to show. |
| `release` | Restores the body height, padding, and classes; asks the key bar to hide. |
| `createKeyBar` | Builds the bar, its key groups, and the one-shot modifiers. |
| `setGroups` | Shows the enabled key groups and one separator between visible groups. |
| `KeyBar.install` | Registers the dictionary and settings card on every platform. |
| `KeyBar.mount` | Builds the bar and its own style, then subscribes to settings. |
| `send` | Sends keydown and keyup to the focused field. |
| `applyKeyFallback` | Moves the caret or inserts a newline or tab for plain inputs. |
| `KeyBarSettings` | Renders the master switch and the five group switches. |
| `dispose` | Removes listeners, timers, frames, style, strip, bar, and subscription. |

Stability rules:

- A closed-looking band is held for `CLOSE_GRACE_MS` before release.
- A width change drops the pin and waits `ROTATION_GRACE_MS`.
- A band equal to the other orientation's layout height is rejected for
  `ROTATION_RESIDUE_MS`.

Every DOM change is removed on dispose. The whole patch runs inside `try/catch`.

## Knobs

Read from `localStorage["dsh-ios-pwa-fix"]` as JSON at apply time.

| key | default | effect |
|---|---|---|
| `strip` | `"auto"` | `"auto"`, `"always"`, or `"off"`. |
| `top` | `24` | Strip height in CSS px when no inset is reported. |
| `minOverlap` | `60` | Smallest shortfall treated as the keyboard. |
| `scrollReset` | `"onOpen"` | `"onOpen"`, `"always"`, or `"off"`. |
| `watchdog` | `true` | Keep checking while the keyboard is open. |
| `lockScroll` | `true` | Pin document scroll while open. |
| `keyBar` | `true` | Master switch for the key bar. |
| `keyBarGroups` | all groups | Groups to show: `"esc"`, `"tab"`, `"modifiers"`, `"arrows"`, `"newline"`. The switches write both keys. |
| `debug` | `false` | Log geometry and expose `window.__dshIosPwaEnvironment`. |

## Build, test, install

There is no build step.

```sh
npm test
npm pack --dry-run
```

The test suite is the only automated check. Keep it green. Add a check for each
behavior change.

To run a local copy in a profile:

```sh
cd <profile-directory>
pnpm add file:<absolute-path-to-this-repo>
```

The profile's `node_modules` entry can be a copy or a link. Re-run the install
after each edit when it is a copy. Reload the GUI, then fully close and reopen
the Home Screen app. The Host re-reads the bundle and updates the bundle revision
without a restart.

To verify the served bundle, fetch the GUI boot graph and inspect the
`dsh-ios-pwa-fix` entry and its revision. Do not print launch tokens, session
cookies, or full HTML.

## Conventions

- The README is user documentation. Keep it short. Do not add issue logs,
  measurement notes, or change history.
- Keep history, measurements, and device findings outside the repository.
- Keep `release-notes.md` brief and suitable for publishing.
- Use 2-space indentation.
- Comments describe the current state, not the history.
- Keep the browser half in the built-bundle format. It loads no module before
  `apply`; the settings card requires React from the browser module table.
- Do not claim a layout or key bar fix works from a test run. The test suite uses
  a stubbed DOM. Only an iPad or iPhone session can verify layout and the bar.
- The layout patch does not change text insertion or system keyboard sounds. The
  optional key bar sends keyboard events to the focused field. Do not add text
  insertion outside those events.
