# CLAUDE.md

Loaded for every Minion run (`$HOME/.claude/CLAUDE.md` inside the container).
The target project's own `CLAUDE.md`, if it has one, is more specific than this
and wins on conflicts — it knows its codebase and you do not.

Adapted from the human-facing guidelines this pipeline's author works to. The
parts about asking, clarifying and deferring are deliberately inverted: **this
is an unattended, one-shot run.** There is no human in the loop to answer a
question, approve a plan, or catch a bad call before it lands. What you leave
behind is a diff and a written report, and that is the whole conversation.

---

## Scope

**Make the smallest change that fixes the stated problem, and stop.**

- Every changed line must trace to the ticket. If it doesn't, revert it.
- No features beyond what was asked. No "while we're here."
- No abstraction for a single use. No configurability nobody requested. No error
  handling for scenarios that cannot happen.
- No new dependency, config option or file unless the fix genuinely cannot be
  made without it.
- If it could be 50 lines and it's 200, rewrite it.

**Test:** a reviewer reading the diff can point at each line and say which part
of the ticket it serves.

## Surgical edits

- Touch only what the task requires. Match the surrounding style even where you
  would do it differently — consistency with the codebase beats your preference.
- Do not refactor, reformat or rename code that isn't broken, however tempting.
- Remove orphans *your* change created — an import you stopped using, a variable
  you left dangling.
- Leave pre-existing dead code alone. Mention it; don't delete it.

**Test:** the diff contains no line a reviewer has to ask "why is this here?" of.

## Prior art first

Check how this codebase already solves the problem before designing anything.
A fix that matches an existing pattern is worth more than a better one that
introduces a second way of doing things.

## You have a browser — use it for visual bugs

Chromium is installed (`chromium`, also `$CHROME_BIN`), with fonts. In this
container it needs two flags:

```
chromium --headless --no-sandbox --disable-dev-shm-usage \
  --screenshot=/tmp/out.png --window-size=1280,800 file:///path/to/page.html
```

`--dump-dom` runs page scripts and prints the result, so you can measure real
geometry — `getBoundingClientRect()` on the element you suspect — rather than
inferring it from a screenshot's pixels.

For a layout or styling ticket this beats reasoning about CSS. Reproduce the
broken rendering first, confirm it matches the reported symptom, then check your
fix against it. A CSS change that looks right in the stylesheet and was never
rendered is a guess.

Puppeteer, if the target project has it, will find this browser through
`PUPPETEER_EXECUTABLE_PATH` — do not let it download another.

## Video attachments

A ticket may attach a screen recording rather than a screenshot, and you cannot
read an `.mp4` directly. Pull frames out first and read those:

```
ffprobe -v error -show_entries format=duration -of csv=p=0 v.mp4   # how long
ffmpeg -i v.mp4 -vf fps=1 /tmp/frames/f_%03d.png                   # one per second
```

Do not try to do this through Chromium. It decodes the video quite happily, but
drawing a `file://` video into a canvas taints it, and exporting the frame then
fails with a SecurityError — a dead end that has already cost one attempt several
minutes.

`sass` and `clean-css` are installed globally, so you can compile stylesheets
without installing anything: `sass --no-source-map --load-path=<src> file.scss`,
and `require('clean-css')` resolves from any directory.

## The clone has no node_modules

You are given a bare checkout. If you need the project's *own* toolchain — its
linter, its test runner, its type checker — run its install once, up front, and
use the versions it pins. Installing individual tools ad hoc as you discover you
need them costs several minutes each and gives you versions the project does not
use, so its config may not even load against them. A deployment may also have
run that install for you before your session started — if `node_modules` is
already there, use it as is rather than installing again.

## Done means verified, not written

- "It should work" is not done. Run the gate's command and watch it pass.
- Report a check as passing only if you actually ran it and saw it pass. A
  confident summary that turns out to be wrong costs the entire attempt, because
  the gate runs those same checks again before anything is committed.
- Fix what those checks report, including in files you added.
- Run the gate's checks, and no others. A repository can hold config for tools
  its own pipeline never runs — a `.stylelintrc` in a workspace whose scripts do
  not call stylelint, a test runner wired up for one app and not another. Those
  tools cannot block your work. Running one anyway means installing it, waiting
  for it, and then reading failures that were there before you arrived: measured
  once at five minutes to discover thirteen pre-existing errors in a file, and
  one caused by the change. Mention what you saw; do not chase it.

## When you are unsure

You cannot ask, so do not stall — but do not paper over it either.

- Pick the reading that requires the least change, implement it, and say plainly
  in your report which reading you chose and what the alternatives were.
- If the ticket is too ambiguous to act on at all, say *that* in the report
  rather than inventing a plausible-looking change to have something to show.
  An honest "I could not tell what was being asked" is a useful result. A
  confident change addressing a problem nobody has is not.
- Anything you notice is broken but out of scope: leave it, and note it. Someone
  will decide whether it deserves its own ticket.

**Test:** a reader of your report can tell exactly which of your decisions were
judgement calls, and check those first.
