/**
 * Exports a deck to PowerPoint as one full-bleed image per slide.
 *
 *   bun export-pptx.mts [deck.html] [out.pptx] [notes.md]
 *
 * Defaults to the 60-minute cut and its notes. The slides go in as images, so
 * nothing in the result is editable — the HTML deck stays the source of truth
 * and this is a hand-off artefact. Speaker notes are carried across, so the
 * .pptx is self-contained for someone presenting it in PowerPoint.
 *
 * Two things this needs that the repo does not depend on, because neither is
 * worth a project dependency for a docs export:
 *
 *   - a Chromium and a playwright-core to drive it. Set CHROME_PATH and
 *     PLAYWRIGHT_MODULE, or let the defaults below find a local install.
 *   - pptxgenjs: `bun add -d pptxgenjs`, or run this from a directory that has
 *     it installed.
 *
 * The .pptx is gitignored: it is ~11 MB and rebuilt from the HTML in seconds.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const DECK = process.argv[2] ?? 'instrumenta-field-report-60min.html'
const OUT = process.argv[3] ?? DECK.replace(/\.html$/, '.pptx')
/** The two decks and their notes are named by hand, so map rather than derive. */
const NOTES = process.argv[4] ?? (DECK.includes('-60min') ? 'speaker-notes-60min-ru.md' : 'speaker-notes-full-ru.md')

/** The deck's stage is a fixed 1280×720 box; 2× gives a 2560×1440 image per slide. */
const STAGE = { width: 1280, height: 720 }
const SCALE = 2

const CHROME =
  process.env.CHROME_PATH ??
  `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`
const PLAYWRIGHT =
  process.env.PLAYWRIGHT_MODULE ??
  '/home/cgs/npb/webui/tools/kaz-8713-cert-repro/node_modules/playwright-core/index.js'

function need(path: string, what: string, fix: string): void {
  if (!existsSync(path)) {
    console.error(`missing ${what}: ${path}\n  ${fix}`)
    process.exit(1)
  }
}
need(DECK, 'deck', 'pass the deck as the first argument')
need(CHROME, 'a Chromium binary', 'set CHROME_PATH to one, e.g. from ~/.cache/ms-playwright')
need(PLAYWRIGHT, 'playwright-core', 'set PLAYWRIGHT_MODULE to its index.js')

// ---------------------------------------------------------------------------
// 1. Render every slide.
//
// The floating nav and the progress bar are chrome for reading the deck in a
// browser, not part of a slide — they would otherwise be baked into every
// image. The stage transform is reset so the capture is 1:1 rather than
// whatever scale the current window happened to produce.
// ---------------------------------------------------------------------------
const shots = join(tmpdir(), `pptx-slides-${process.pid}`)
rmSync(shots, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })

const { chromium } = await import(PLAYWRIGHT)
const browser = await chromium.launch({ executablePath: CHROME })
const page = await browser.newPage({ viewport: STAGE, deviceScaleFactor: SCALE })
await page.goto(`file://${join(process.cwd(), DECK)}`, { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
await page.addStyleTag({
  content: '#hud,#bar{display:none !important} #viewport{padding:0 !important} #stage{transform:none !important}',
})

const count: number = await page.evaluate(() => document.querySelectorAll('.slide').length)
const stage = await page.$('#stage')
for (let i = 1; i <= count; i++) {
  await page.evaluate(
    (k: number) => document.querySelectorAll('.slide').forEach((s, j) => s.classList.toggle('active', j === k - 1)),
    i,
  )
  await page.waitForTimeout(120)
  await stage!.screenshot({ path: join(shots, `slide-${String(i).padStart(3, '0')}.png`) })
}
await browser.close()
console.log(`rendered ${count} slides`)

// ---------------------------------------------------------------------------
// 2. Speaker notes, one section per slide.
//
// The notes are Markdown keyed by `### N. Title`; PowerPoint's notes field is
// plain text, so the markup is flattened rather than dropped.
// ---------------------------------------------------------------------------
const notes = new Map<number, string>()
if (existsSync(NOTES)) {
  const md = readFileSync(NOTES, 'utf8')
  const heads = [...md.matchAll(/^### (\d+)\. (.+)$/gm)]
  heads.forEach((m, i) => {
    const body = md
      .slice(m.index! + m[0].length, i + 1 < heads.length ? heads[i + 1].index! : md.length)
      .replace(/^## .*$/gm, '')
      .replace(/^---$/gm, '')
      .replace(/\*\*(.+?)\*\*/gs, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s*[-*]\s+/gm, '• ')
      .replace(/^\s*>\s?/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    notes.set(Number(m[1]), `${m[2].replace(/\s*`\[[^\]]+\]`/, '').trim()}\n\n${body}`)
  })
  if (notes.size !== count) console.warn(`! notes cover ${notes.size} slides, deck has ${count}`)
} else {
  console.warn(`! no notes at ${NOTES} — exporting slides without them`)
}

// ---------------------------------------------------------------------------
// 3. Build the deck.
//
// LAYOUT_16x9 is 10in × 5.625in, the same 16:9 the stage renders at, so each
// image covers its slide exactly — no crop, no letterbox.
// ---------------------------------------------------------------------------
let pptxgen: any
try {
  pptxgen = (await import('pptxgenjs')).default
} catch {
  console.error('missing pptxgenjs\n  bun add -d pptxgenjs')
  process.exit(1)
}

const pres = new pptxgen()
pres.layout = 'LAYOUT_16x9'
pres.author = 'Instrumenta'
pres.title = DECK.replace(/\.html$/, '')

for (const [i, file] of readdirSync(shots).sort().entries()) {
  const slide = pres.addSlide()
  slide.addImage({ path: join(shots, file), x: 0, y: 0, w: 10, h: 5.625 })
  const n = notes.get(i + 1)
  if (n) slide.addNotes(n)
}

await pres.writeFile({ fileName: OUT })
rmSync(shots, { recursive: true, force: true })
console.log(`wrote ${OUT} — ${count} slides, ${notes.size} with notes`)
