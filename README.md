# LogFormatter

LogFormatter is a small static web app for reading Minecraft and Minecraft mod development log files in a cleaner, easier-to-scan format.

It is designed for noisy plain-text logs where repeated lines, mixed sources, and large amounts of debug output make troubleshooting difficult.

## What The App Does

The app reads a plain-text log file in the browser, parses it into structured JavaScript objects, and then lets you inspect the output in two main ways:

- `Group by Category`
  Sorts parsed logs into sections such as `loader`, `mod-list`, `mixin`, `rendering`, `resource-loading`, `worldgen`, `server-lifecycle`, `player-event`, `chat`, `auth`, `warning`, `error`, and `unknown`.

- `Fold Repeated Lines`
  Collapses consecutive repeated logs into grouped entries using a stable fold key so repeated spam is easier to inspect.

## What It Works For

The app is primarily aimed at:

- Minecraft mod development output logs
- Fabric-style runtime logs
- Forge/FML-style log output
- mixed build + runtime output copied from IDEs or terminals
- plain-text `.txt` and `.log` files

Examples of useful use cases:

- checking mod loading output
- scanning worldgen spam for patterns
- spotting auth, save, rendering, or lifecycle messages
- reducing repeated debug line noise
- browsing categories without manually searching through a full raw log

## How It Works

1. The user uploads a plain-text log file in the browser.
2. The file is read with `File.text()`.
3. `parseLogFile(...)` splits the file into lines and parses each log block into a JavaScript object.
4. Each parsed object may include fields such as:
   - `type`
   - `category`
   - `timestamp`
   - `thread`
   - `level`
   - `logger`
   - `message`
   - `summary`
   - `fold`
   - `details`
5. The UI renders those parsed logs either:
   - grouped by `category`
   - or folded by repeated `fold.key`

## Supported File Types

The app currently accepts:

- `.txt`
- `.log`

The file must be readable plain text.

## Restrictions And Current Limitations

This is not a universal parser for every log format.

Current limitations include:

- it is optimized for Minecraft and mod development logs, not arbitrary application logs
- some unfamiliar log formats will still fall into the `unknown` category
- it relies on pattern matching, so unusual custom mod logger formats may not parse cleanly
- repeated-line folding currently works on consecutive repeated entries, not every matching line across the whole file
- very unusual encodings or non-text files are not supported
- there is no backend, database, or persistent storage; everything happens in the browser

## What The Categories Mean

Categories are heuristics, not official Minecraft log classes.

Common categories include:

- `loader`
- `mod-list`
- `startup`
- `resource-loading`
- `worldgen`
- `rendering`
- `server-lifecycle`
- `player-event`
- `chat`
- `auth`
- `warning`
- `error`
- `unknown`

## UI Behavior

- category sections are collapsible
- folded repeated-line entries are also collapsible
- raw log content is shown inside each rendered listing for inspection
- upload validation prevents unsupported file types from being processed

## Notes

- parsing is done entirely client-side
- no log data is uploaded to a server by the app itself
- the parser is rule-based and can be extended with more formats over time
