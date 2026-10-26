# Release notes

## 1.2.0

- Added the key bar: master switch and five groups, all on by default.
- Added the **iOS Web App Fix** title, description, and icon.

## 1.1.0

- Fixed slow layout and blank areas after rotation.

## 1.0.0

- First public release: status-bar strip, keyboard pin, 16px text fields.

## Known issues

These issues reproduce in DSH without this plugin:

- A predictive-text suggestion can insert only a space after an edit.
- The iPad keyboard hide key can play several clicks.

The layout patch changes layout only. The optional key bar sends keyboard events
to the focused field. The plugin does not change system keyboard sounds.
