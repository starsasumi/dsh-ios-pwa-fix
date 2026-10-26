# dsh-ios-pwa-fix

Fixes the status bar and keyboard layout in the DeepSeek Harness web GUI when
it runs as a Home Screen app on iPhone and iPad. It adds an optional key bar
above the keyboard.

| before | after |
|---|---|
| The clock and battery cover the top of the page. | The page starts below the status bar. |
| The keyboard covers the message box. | The message box stays above the keyboard. |
| iOS zooms the page when you tap the message box. | The page keeps its size. |
| The system keyboard has no Esc, arrow, or modifier keys. | The optional key bar sends them to the focused field. |

It runs only on iOS and iPadOS in standalone display mode, which is how a Home
Screen app opens. A Safari tab keeps its layout. The key bar settings are visible
on every platform.

## Install

### DSH UI

1. Open **Plugins**.
2. Select **Add plugin**.
3. Enter `dsh-ios-pwa-fix`.
4. Select **Install**.

### CLI

```sh
dsh plugin --profile <profile> add dsh-ios-pwa-fix
```

Replace `<profile>` with the profile that runs the web GUI, usually `web`.

Reload the GUI. Then fully close the Home Screen app and open it again.

## Use the key bar

All key bar switches are on by default.

1. Open **Plugins**.
2. Open `dsh-ios-pwa-fix` under **Installed plugins**.
3. Under **Key bar**, check **Show key bar** and the key groups you want.
4. Open a session in the Home Screen app and focus the message box.

The bar appears above the keyboard while the keyboard is open. It shows only
the groups that are on. The group switches are disabled while **Show key bar**
is off.

| group | keys | action |
|---|---|---|
| Esc | Esc | Sends Escape to the focused field. |
| Tab | Tab | Sends Tab to the focused field. |
| Modifier keys | Ctrl, Alt, Shift, Cmd on iPad | Arms a one-shot modifier for the next bar key. |
| Arrow keys | left, up, down, right | Moves the caret. |
| New line | new line | Sends Shift+Enter. The composer inserts a line break. |

The bar shows a separator between visible groups. With all groups on, the order
is Esc, Tab, modifiers, arrows, new line.

A modifier applies to one key only. For example, tap Ctrl, then tap the left
arrow. The next arrow has no Ctrl. Cmd is available on iPad only.

The master and group switches are stored in this app's browser storage under
`localStorage["dsh-ios-pwa-fix"]`.

The bar sends keyboard events to the focused field. It does not type for the
app. A field or shortcut that ignores synthetic events ignores the bar too.

## Requirements

| item | value |
|---|---|
| DSH | 0.2.0 or later |
| OS | iOS or iPadOS 18 (tested) |
| display mode | Home Screen app |
| build step | none |
| dependencies | none |
| data access | none |

Tested on iPhone and iPad running iOS and iPadOS 18, in portrait and landscape.

## How it works

- The plugin reserves the status-bar strip only when the page spans the screen.
- While the keyboard is open, it pins the page to the visible band.
- It keeps text fields at 16px or more, so WebKit does not zoom on focus.
- The optional key bar sits at the top of the keyboard and reserves the same
  height at the bottom of the page.
- The bar sends synthetic keyboard events to the focused field. The composer
  handles them like a hardware keyboard.
- For a plain input or textarea, the bar moves the caret itself and inserts a
  newline in a textarea.
- The layout patch does not change text input or keyboard sounds.

## Troubleshooting

| symptom | action |
|---|---|
| The top of the page is clipped | In [Advanced settings](#advanced-settings), set `strip` to `"off"`. |
| The status bar covers text | In [Advanced settings](#advanced-settings), set `strip` to `"always"`. |
| The message box is still covered | Reload the GUI and reopen the app. If it remains, report the OS version and device model. |
| The plugin does nothing | Open the GUI as a Home Screen app, not a Safari tab. |
| The key bar does not appear | Turn on **Show key bar** and at least one group under **Key bar** in the plugin settings. Then focus a text field in the Home Screen app. |
| A key group is missing | Turn on its group switch. Cmd is available on iPad only. |
| A bar key does nothing | The focused field must accept that key. Report the field and the key. |
| iOS zooms the page when you tap the message box | Report the OS version and device model. |

## Advanced settings

These settings are for troubleshooting. The defaults work on tested devices.

Set `localStorage["dsh-ios-pwa-fix"]` to a JSON object in the Home Screen app.
Then close and open the app again.

```js
const settings = JSON.parse(localStorage.getItem("dsh-ios-pwa-fix") || "{}");
settings.strip = "off";
localStorage.setItem("dsh-ios-pwa-fix", JSON.stringify(settings));
```

| key | default | effect |
|---|---|---|
| `strip` | `"auto"` | `"auto"` skips the strip when the system already insets the page. `"always"` reserves it. `"off"` never reserves it. |
| `top` | `24` | Top strip height in CSS px when the system reports no inset. |
| `keyBar` | `true` | Master switch. Shows the key bar while the keyboard is open. |
| `keyBarGroups` | all groups | Groups to show: `"esc"`, `"tab"`, `"modifiers"`, `"arrows"`, and `"newline"`. The plugin settings switches write both keys. The old `"navigation"` value is read as `"esc"` and `"arrows"`. |

### About page zoom

Two different zoom values appear on iOS and iPadOS.

- **Automatic focus zoom**: WebKit enlarges the page when a text field is smaller
  than 16px. The message box is 14px before the patch. This is automatic and not
  a saved page-zoom setting. The plugin keeps text fields at 16px or more.
- **Page scale**: iPadOS desktop mode can use a page scale such as 0.75. This is
  not a bug. The plugin uses it to compare screen and layout sizes.

Retina pixel density does not cause either value.

## Uninstall

Remove the plugin from **Plugins**. Or run:

```sh
dsh plugin --profile <profile> remove dsh-ios-pwa-fix
```

## Development

```sh
npm test
npm pack --dry-run
```

The browser half is a hand-written bundle in `lib/client.js`. It has no build
step and no imports at load time. React comes from the browser module table only
when the settings card registers. The Host half in `lib/index.js` is a no-op
entry that lets the profile load the package. The test suite runs against a
stubbed DOM.

See [release-notes.md](release-notes.md) for changes.

### Environment detection

`detectEnvironment(win)` returns the values that gate the patch and can drive
future version-specific rules.

| field | value |
|---|---|
| `ios` | `true` on iOS or iPadOS. |
| `platform` | `"iphone"`, `"ipad"`, `"ipod"`, or `null`. |
| `version` | `{ major, minor, patch }`, or `null` when the user agent does not report it. |
| `standalone` | `true` in standalone or fullscreen display mode. |
| `displayMode` | `"standalone"`, `"fullscreen"`, or `"browser"`. |
| `desktopMode` | `true` for the Macintosh user agent of iPadOS desktop mode. |
| `touch` | `true` when `maxTouchPoints > 1`. |

Set `debug: true` to expose the result as `window.__dshIosPwaEnvironment`.

To force one layout check:

```js
window.dispatchEvent(new Event("dsh-ios-pwa-resync"))
```

## Limits

- The plugin runs only on iOS and iPadOS in standalone display mode.
- The key bar appears only while the on-screen keyboard is open and **Show key bar** is on.
- The key bar shows only the groups that are on. Cmd appears on iPad only.
- The key bar sends synthetic keyboard events. Some app or system shortcuts may
  ignore them.
- Tested on iOS and iPadOS 18. Other versions are not verified.
- The platform check reads the user agent. A future iPadOS version can change it.
- The layout rules depend on iOS. A future iOS version can change them.
- The plugin does not read or send data.

## License

MIT
