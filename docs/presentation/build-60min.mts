/**
 * Builds the 60-minute cut of the deck from the full 85-minute one.
 *
 * The short deck is generated, never hand-edited: edit
 * `instrumenta-field-report.html` and re-run `bun build-60min.mts`, or the two
 * will drift. Slide numbering inside the deck is produced by its own script at
 * load time, so removing sections renumbers everything automatically — this is
 * only safe because the deck carries no cross-references to slide or part
 * numbers in its prose — those were removed deliberately, since "see part 07"
 * means nothing to an audience. The divider assertion below is a structure
 * check, not a dependency.
 *
 * CUT lists slide numbers **in the full deck**. To change the running time,
 * add or remove numbers here and re-run; the script prints the resulting
 * count and an estimate.
 */

const FULL = 'instrumenta-field-report.html'
const SHORT = 'instrumenta-field-report-60min.html'

/** Slides dropped for the 60-minute cut, with the reason each one survives elsewhere. */
const CUT: Array<[number, string]> = [
  [6, 'ticket shape — the 96%/1–2-commits headline is already on slide 5'],
  [11, "Foreman's loop — the split on slide 10 carries the point"],
  [12, 'three state sources — internal design detail, not needed for the argument'],
  [16, 'nine statuses — the short cut never needs the vocabulary'],
  [18, 'subscription vs API key — answered in Q&A if asked'],
  [20, 'attempts tab — the Cockpit shot on slide 19 already shows the product'],
  [23, 'codebase size — a stat, not an argument'],
  [34, 'the ticket — the diff on slide 35 opens with it anyway'],
  [40, 'four instruction files — the deepest harness detail'],
  [41, 'skills by category — slide 42 makes the skills case better'],
  [46, 'subagents — mentioned in passing on slide 36'],
  // Whole "What broke" section — cut for the 60-minute version.
  [49, 'divider — the "What broke" section does not run in the short cut'],
  [50, 'the ADR table'],
  [51, 'the empty-diff story'],
  [52, 'retries removed, not added'],
  [53, 'known gaps'],
  [61, 'limits and budgets — detail the room will not retain'],
  [63, 'the first version landing — status detail, not part of the argument'],
  [62, 'access table — least privilege is carried by slides 57–60'],
]

const html = await Bun.file(FULL).text()

// Split on the slide boundary, keeping the head/tail around the sections.
const marker = '<section class="slide'
const head = html.slice(0, html.indexOf(marker))
const rest = html.slice(html.indexOf(marker))
const tailStart = rest.lastIndexOf('</section>') + '</section>'.length
const tail = rest.slice(tailStart)
const body = rest.slice(0, tailStart)

const slides = body.split(marker).filter(Boolean).map((s) => marker + s)
if (slides.length !== 66) console.warn(`! expected 66 slides in the full deck, found ${slides.length}`)

const cutSet = new Set(CUT.map(([n]) => n))
const kept = slides.filter((_, i) => !cutSet.has(i + 1))

// Part dividers are the only signposts the audience gets, so losing one by
// accident would silently merge two sections of the talk. The short cut drops
// exactly one on purpose — "What broke" — so six must survive, not seven.
const dividers = kept.filter((s) => s.includes('class="slide part"')).length
if (dividers !== 6) throw new Error(`expected 6 part dividers to survive, found ${dividers}`)

let out = head + kept.join('') + tail
out = out.replace('<title>Instrumenta Field Report</title>', '<title>Instrumenta Field Report — 60 min</title>')
out = out.replace(
  '<div class="eyebrow">Engineering review &middot; 09 September 2026</div>',
  '<div class="eyebrow">Engineering review &middot; 09 September 2026 &middot; 60-minute cut</div>',
)

await Bun.write(SHORT, out)

/**
 * Speaking time per slide, by what the slide actually holds. A flat average
 * over slide count is wrong here: seven part dividers take seconds, while a
 * full-page screenshot or the prompt slide takes well over a minute.
 */
function minutes(s: string): number {
  if (s.includes('class="slide part"')) return 0.3
  if (s.includes('title-slide')) return 0.6
  if (s.includes('shot-full')) return 1.5
  if (s.includes('<pre')) return 1.6
  if ((s.match(/<tr>/g) || []).length >= 7) return 1.7
  if (s.includes('<svg')) return 1.6
  if (s.includes('class="callout')) return 1.4
  return 1.1
}
const sum = (a: string[]) => Math.round(a.reduce((t, s) => t + minutes(s), 0))

// ---------------------------------------------------------------------------
// Speaker notes for the short deck, generated from the full notes.
//
// The short deck renumbers itself 1..N, so a presenter reading notes against it
// needs numbering that matches what is on screen — not the full deck's. Section
// bodies are copied verbatim; only the `### N.` headings and the part headers
// (slide ranges, per-part minutes) are recomputed.
// ---------------------------------------------------------------------------
const NOTES_FULL = 'speaker-notes-full-ru.md'
const NOTES_SHORT = 'speaker-notes-60min-ru.md'

const notes = await Bun.file(NOTES_FULL).text()

// The full notes state the cut list in prose. Nothing enforces that by itself,
// so a slide added to CUT here and forgotten there would leave the notes lying
// about which slides the short deck contains.
const stated = notes.match(/\*\*Что выброшено в 60-минутной версии\*\*[^:]*:\s*([\d,\s\n]+)\./)
if (!stated) throw new Error('notes no longer state the cut list — update the guard or the notes')
const statedNums = stated[1].split(',').map((x) => Number(x.trim())).filter(Boolean).sort((a, b) => a - b)
const cutNums = [...cutSet].sort((a, b) => a - b)
if (statedNums.join() !== cutNums.join())
  throw new Error(`notes say the cut is [${statedNums}] but CUT is [${cutNums}] — fix ${NOTES_FULL}`)

/** Which part each full-deck slide belongs to, taken from the deck itself. */
const partOf = slides.map((s) => (s.match(/data-part="([^"]+)"/) || [, ''])[1])

/** Full-deck slide number -> short-deck slide number. */
const renum = new Map<number, number>()
let next = 1
slides.forEach((_, i) => { if (!cutSet.has(i + 1)) renum.set(i + 1, next++) })

const lines = notes.split('\n')
const firstSlide = lines.findIndex((l) => /^### \d+\. /.test(l))
const qaStart = lines.findIndex((l) => l.startsWith('## Ожидаемые вопросы'))
if (firstSlide < 0 || qaStart < 0) throw new Error('notes structure changed: cannot find the slide sections or the Q&A block')
const preamble = lines.slice(0, firstSlide)
// The preamble slice runs up to the first `### N.`, so it still carries the old
// part header (and its rule) for the first part. Those are regenerated below.
while (preamble.length && (preamble.at(-1)!.trim() === '' || preamble.at(-1) === '---' || preamble.at(-1)!.startsWith('## ')))
  preamble.pop()
const qa = lines.slice(qaStart)

type Section = { num: number; lines: string[] }
const sections: Section[] = []
let cur: Section | null = null
for (const l of lines.slice(firstSlide, qaStart)) {
  const m = l.match(/^### (\d+)\. /)
  if (m) { cur = { num: Number(m[1]), lines: [l] }; sections.push(cur); continue }
  if (l.startsWith('## ') || l === '---') continue   // part headers are regenerated below
  if (cur) cur.lines.push(l)
}
if (sections.length !== slides.length) throw new Error(`notes cover ${sections.length} slides, deck has ${slides.length}`)

/** Russian part labels, keyed by the deck's own data-part value. */
const LABEL: Record<string, string> = {
  Instrumenta: 'Вступление',
  Frame: 'Вступление',
  '01 Why': 'Часть 01 — Почему',
  '02 Build': 'Часть 02 — Как устроено',
  '03 Results': 'Часть 03 — Что получилось',
  '04 One PR': 'Часть 04 — Один PR целиком',
  '05 Harness': 'Часть 05 — Харнесс в webui',
  '06 Failures': 'Часть 06 — Что ломалось',
  '07 Next': 'Часть 07 — Куда идём',
  Close: 'Финал',
}

const groups: Array<{ label: string; nums: number[] }> = []
for (const s of sections) {
  if (!renum.has(s.num)) continue
  const label = LABEL[partOf[s.num - 1]] ?? partOf[s.num - 1]
  if (groups.at(-1)?.label !== label) groups.push({ label, nums: [] })
  groups.at(-1)!.nums.push(s.num)
}

const notesOut: string[] = []
for (const g of groups) {
  const mins = Math.round(g.nums.reduce((t, n) => t + minutes(slides[n - 1]), 0))
  const from = renum.get(g.nums[0])!, to = renum.get(g.nums.at(-1)!)!
  notesOut.push('---', '', `## ${g.label} — ${from === to ? `слайд ${from}` : `слайды ${from}–${to}`} (${mins} мин)`, '')
  for (const n of g.nums) {
    const body = [...sections.find((x) => x.num === n)!.lines]
    body[0] = body[0].replace(/^### \d+\. /, `### ${renum.get(n)}. `).replace(/\s*`\[нет в 60-мин\]`/, '')
    while (body.length && body.at(-1)!.trim() === '') body.pop()
    notesOut.push(...body, '')
  }
}

const notesHead = preamble
  .join('\n')
  .replace(/^# .*$/m, '# Instrumenta — текстовка докладчика (60 минут)')
  .replace(/## Две версии деки[\s\S]*?(?=\*\*Управление декой)/, [
    `Дека: \`${SHORT}\` — ${kept.length} слайдов, ≈${sum(kept)} минут доклада.`,
    '',
    `Это **сокращённая** версия. Полная (${slides.length} слайдов, ≈${sum(slides)} мин) и текстовка`,
    'к ней лежат рядом: `instrumenta-field-report.html` и `speaker-notes-full-ru.md`.',
    '',
    '> Файл **генерируется** из `speaker-notes-full-ru.md` скриптом `build-60min.mts`.',
    '> Править руками бессмысленно — правки уедут при следующей пересборке.',
    '> Меняете полную текстовку → гоняете скрипт.',
    '',
    'Номера слайдов здесь — по короткой деке, то есть совпадают с тем, что на экране.',
    '',
    '',
  ].join('\n'))

await Bun.write(NOTES_SHORT, [notesHead.trimEnd(), '', ...notesOut, '---', '', ...qa].join('\n'))

console.log(`full  : ${slides.length} slides  ~${sum(slides)} min   notes: ${NOTES_FULL}`)
console.log(`short : ${kept.length} slides  ~${sum(kept)} min  (${cutSet.size} cut)   notes: ${NOTES_SHORT}`)
console.log(`\nwritten: ${SHORT}, ${NOTES_SHORT}\n`)
console.log('cut from the full deck:')
for (const [n, why] of CUT) console.log(`  ${String(n).padStart(2)} — ${why}`)
