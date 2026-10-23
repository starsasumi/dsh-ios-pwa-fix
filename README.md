# dsh-ios-pwa-fix

Fixes the status bar and keyboard layout in the DeepSeek Harness web GUI when
it runs as a Home Screen app on iPhone and iPad.

| before | after |
|---|---|
| The clock and battery cover the top of the page. | The page starts below the status bar. |
| The keyboard covers the message box. | The message box stays above the keyboard. |
| iOS zooms the page when you tap the message box. | The page keeps its size. |

It runs only on iOS and iPadOS in standalone display mode, which is how a Home
Screen app opens. A Safari tab is unchanged.

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

## Troubleshooting

| symptom | action |
|---|---|
| The top of the page is clipped | In [Advanced settings](#advanced-settings), set `strip` to `"off"`. |
| The status bar covers text | In [Advanced settings](#advanced-settings), set `strip` to `"always"`. |
| The message box is still covered | Reload the GUI and reopen the app. If it remains, report the OS version and device model. |
| The plugin does nothing | Open the GUI as a Home Screen app, not a Safari tab. |
| iOS zooms the page when you tap the message box | Report the OS version and device model. |

## Advanced settings

These settings are for troubleshooting. The defaults work on tested devices.

Set `localStorage["dsh-ios-pwa-fix"]` to a JSON object in the Home Screen app.
Then close and open the app again.

```js
localStorage.setItem("dsh-ios-pwa-fix", JSON.stringify({ strip: "off" }));
```

| key | default | effect |
|---|---|---|
| `strip` | `"auto"` | `"auto"` skips the strip when the system already insets the page. `"always"` reserves it. `"off"` never reserves it. |
| `top` | `24` | Top strip height in CSS px when the system reports no inset. |

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
step and no imports. The Host half in `lib/index.js` is a no-op entry that lets
the profile load the package.

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
- Tested on iOS and iPadOS 18. Other versions are not verified.
- The platform check reads the user agent. A future iPadOS version can change it.
- The layout rules depend on iOS. A future iOS version can change them.
- The plugin does not read or send data.

## License

MIT
