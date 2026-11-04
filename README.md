# social-scheduler

Schedules a week of approved posts on X (and, in the same weekly pass, Substack Notes and Threads) through each platform's own native scheduler, driven from a local SQLite queue. No paid scheduling service.

## Architecture

```
SQLite queue (approved items)  ->  schedule-x.mjs  ->  chrome-bridge.mjs  ->  AppleScript  ->  signed-in Chrome tab  ->  X's native scheduler
```

- **No API keys, no stored credentials:** it works inside the browser session you are already signed into.
- **Platform posts on its own servers:** once scheduled, the computer can be off.

## Files

### `schedule-x.mjs`

1. Reads the queue: `editorialItems` rows whose JSON has `destinationPlatform = 'X/Twitter'`, `reviewState = 'Ready'`, a `scheduledAt`, and `status != 'Scheduled'`, ordered by time.
2. Skips items whose time has passed or that are over 280 characters.
3. Fills X's composer with `document.execCommand('insertText')` and checks the composer text matches the queue item exactly.
4. Sets X's schedule picker (six native `<select>` elements; month first, because it rewrites the day options) and reads the picker summary back.
5. Presses Schedule only with `--commit`, then marks the row `status = 'Scheduled'`.

```
node schedule-x.mjs                    # dry run, every Ready item
node schedule-x.mjs --limit 1          # dry run, first item
node schedule-x.mjs --limit 1 --commit
node schedule-x.mjs --commit
```

It runs dry by default and never posts immediately. Each item prints SCHEDULED, SKIP or FAILED with the reason, plus a summary at the end.

### `chrome-bridge.mjs`

A narrow bridge to Google Chrome over AppleScript: `list`, `focus`, `read`, `eval`, `nav`. It refuses any host other than `substack.com`, `x.com` and `threads.com`. Requires Chrome's "Allow JavaScript from Apple Events" (View > Developer).

## Config

| Variable | Default | Purpose |
|---|---|---|
| `QUEUE_DB` | `~/content-queue.sqlite3` | path to the SQLite queue |

## The weekly workflow around it

1. The week's material comes in; an AI agent drafts one queue item per platform with a time slot. Anything that needs judgement goes to a review list.
2. Every item is approved by a person before anything loads.
3. The agent loads Substack, then X (this script), then Threads, in their native schedulers.
4. Verification reads each platform's own scheduled list and counts; an item only counts once it appears there.
5. Each load runs through the following Monday, so no day is empty while the next week is prepared.

Built with AI coding agents (Claude Code and Codex) from my briefs; I designed the workflow and its rules and approve every week.
