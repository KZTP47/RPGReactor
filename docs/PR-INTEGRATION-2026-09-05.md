# Pull request integration — 2026-09-05

Integrated GitHub `origin/main` at `f6150b2` with local development at
`32e127c`. The histories contained 8 remote-only and 43 local-only commits.
Both pull requests were already merged on GitHub, and both PR heads had
passing clean-checkout and GUI-smoke jobs:

- [#44 — State descriptions and UI gauge fix](https://github.com/Psychronic-Games/RPGReactor/pull/44)
- [#45 — Forge Project Tools](https://github.com/Psychronic-Games/RPGReactor/pull/45)

The only textual merge conflict was in `editor/src/I18nManager.js`; both the
local BGM-sequence translations and incoming Project Tools keys were retained.
The merge preserves the local development history and does not change the
owner's uncommitted Fleagus model, System settings, or project metadata.

## Verification

The combined tree's full Node suite reports **2,655 passed, 3 failed**. All
three failures are the previously recorded `stock-interfaces.test.cjs` Demo
resolution/baseline mismatches; no additional failures appeared. Syntax checks
passed for 1,077 source JavaScript files, and patch whitespace checks passed.
The full suite includes the incoming state-description, Project Tools, and
gauge regressions, plus canonical/bundled runtime consistency.

The native NW.js save smoke passed on Chromium 144.0.7559.59. The Web
persistence smoke passed on retry, including IndexedDB persistence and reload;
its first attempt timed out in a WebDriver request. The retry only added
request tracing to the harness, without changing application code.

Local logs: `/tmp/rr-pr-integration-full.log`,
`/tmp/rr-pr-integration-nw.log`, `/tmp/rr-pr-integration-web.log`, and
`/tmp/rr-pr-integration-web-retry.log`.
This remains a development tree with known failures, not a release candidate.

## Open findings in Project Tools

These were reproduced against a disposable filesystem fixture. They are
upstream feature defects, not textual merge conflicts, and are not fixed by
this integration:

1. **A subsequent editor save can overwrite a tool's saved changes.**
   `_handleSave` replaces the database JSON on disk but leaves the loaded
   `DatabaseManager.data` unchanged. Saving through `DatabaseManager.saveJSON`
   then restores the old record. The tool asks the user to reload, but the
   host does not enforce that reload or reconcile the editor's working data.
   The bridge needs coordinated database state, stale-edit checks, and the
   existing project ownership/write lifecycle.
2. **Image path containment follows symlinks outside the image tree.**
   `_handleImage` checks the lexical resolved path, then uses `statSync` and
   `readFileSync`, which follow symlinks. An `img/linked.png` symlink pointing
   to a text file outside `img/` was returned as a successful image response.
   Filesystem containment needs to account for symlinks in files and parent
   directories. The iframe sandbox does not restrict host-side file reads.

The passing bridge tests cover ordinary path traversal and file whitelists,
but do not cover these two workflows. No project-supplied HTML was executed
as part of this review.
