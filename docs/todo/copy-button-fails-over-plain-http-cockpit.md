---
type: bug
status: open
date: 2026-08-24
source: session e51bd41f-5fad-402f-b5b7-ebdb1acf2f4e
---

# Cockpit's OUT/LOG copy button can't work when Cockpit is reached over plain HTTP

The copy-to-clipboard button added in `9b04186` (`src/foreman/ui.html`) uses
`navigator.clipboard`, which the browser only exposes in a secure context. `localhost`
qualifies, but Cockpit reached by IP over plain `http://` — the way it's actually accessed in
this session — does not, so the button always shows "Copy failed" there instead of copying
anything. This was a known tradeoff at implementation time (surface the failure honestly
rather than fail silently), not an oversight, but it means the feature is effectively
non-functional for the deployment pattern Cockpit is normally opened with. A `document.execCommand('copy')`-based fallback, or serving Cockpit over HTTPS, would fix
the actual copying rather than just the error message.
