#!/usr/bin/env node
/**
 * DOC CITATION GUARD — step 7 phase 7a, Part 0.
 *
 * WHY THIS EXISTS, AND WHY IT EXISTS *FIRST*.
 *
 * `docs/` cites code and tests by `file#Lnn`. Nothing checked those anchors. CI
 * ran lint -> typecheck -> test -> build and nothing else, so an anchor that
 * slid, or a file that was renamed, produced a document that READ as precise and
 * pointed at the wrong line. That is worse than a vague citation: it spends the
 * reader's trust and returns nothing.
 *
 * It has already happened here. Step 6 phase 3d's anchors drifted, and phase 4
 * responded rationally — by retreating to file-level links, trading precision for
 * a guarantee it could actually keep. This script buys the precision back by
 * making the guarantee mechanical, which is the only basis on which line-level
 * citation is honest.
 *
 * THE FOUR CHECKS, AND WHY THE LAST TWO ARE THE ONES THAT MATTER.
 *
 *   1. The target path resolves.
 *   2. Every line number is within the target file's length.
 *  2b. The anchor line is NOT BLANK. (Added by the OPEN-19 fix.)
 *   3. CONTENT. Where the link TEXT contains a quoted string or an
 *      identifier-shaped token, that literal must appear in the target file
 *      within PROXIMITY lines of the anchor —
 *  3a. EXCEPT where the link text is entirely a record id, which must point AT
 *      the heading that declares it. (Added by the OPEN-19 fix.)
 *   4. LABEL. Where the link TEXT itself carries a `:<line>` reference — the
 *      `file.ts:132` / `:158` form this repo writes constantly — that number
 *      must equal the anchor it is attached to.
 *
 * ================= WHAT THE OPEN-19 FIX CHANGED, AND WHY ====================
 *
 * The register recorded three blind mechanisms, and BUILDING FIXTURES FOR THEM
 * SHOWED ONE WAS MIS-DIAGNOSED. It said a bare `[ADR-NNN](DECISIONS.md#Lnnn)`
 * had "no literal, so check 3 has nothing to match". Not so: `literalsFrom`
 * extracts `ADR-NNN`, `normalise` keeps it, and the old heading filter matched
 * it — a fixture anchoring such a link far from its heading FAILS on the
 * unmodified checker, and so does one pointing at the wrong ADR's heading.
 *
 * The two landed drifts (+1 and +2 on the ADR headings) passed for a different
 * reason: THE ±5 WINDOW ABSORBED THEM. That is why 3a exists and why it is
 * scoped to record-id links only — the window is right for everything else.
 *
 * The other two mechanisms are real and are closed by 2b, which needs neither a
 * literal nor a label and therefore reaches the citations the content checks
 * skip: a label number that agrees with a wrong anchor (check 4 compares the two
 * halves of a link to each other and never opens the file, so both can agree and
 * both be wrong), and citations carrying neither a literal nor a label.
 *
 * THE CHECKER IS NOW CHECKED. `npm run docs:check:self` runs a fixture corpus of
 * known-bad and known-good citations against this file. It is the acceptance gate
 * the OPEN-19 fix needed and could not get from `docs:check` itself: a change to
 * the checker cannot be proven by the checker's own verdict on the live corpus,
 * because that verdict is the thing under test.
 *
 * Checks 1 and 2 catch deletions and truncations only. A citation that slides
 * twenty lines because somebody added an import passes both of them, every time
 * — the file still exists and the line still exists, it just says something else
 * now. Check 3 is the one that catches the slide, and it is affordable precisely
 * because the docs ALREADY cite tests by their `it(...)` name in the link text.
 * It asserts, mechanically, the thing the author was already asserting by hand.
 *
 * CHECK 4 CLOSES A GAP THE OTHER THREE ARE STRUCTURALLY BLIND TO, and it is the
 * cheapest check here: it touches no file at all. Checks 1-3 all validate the
 * ANCHOR — the `#L267` half, which is what the reader's browser follows. Nothing
 * ever read the LABEL — the `PROJECT_BRIEF.md:266` half, which is what the
 * reader's EYE follows. So the two halves of one citation could disagree, and did:
 *
 *   [PROJECT_BRIEF.md:266](PROJECT_BRIEF.md#L267)
 *
 * The anchor was right (:267 is the DoD checkbox); the label said 266, and CI was
 * green because no check had ever read the label. A reader quoting that citation
 * into a review, or grepping `sed -n '266p'`, lands one line off and finds a
 * different checkbox. The document reads as precise and is not.
 *
 * It is a PURE STRING COMPARISON — both halves are inside the link, so there is
 * no filesystem access and nothing to cache. That also means it stays correct when
 * the target file is unreadable for any other reason, which is why it runs before
 * the path check rather than after.
 *
 * EQUALITY, NOT PROXIMITY. Check 3 deliberately allows a PROXIMITY window because
 * a prose citation legitimately points a line or two into a block. A label has no
 * such excuse: it is the same citation's own other half, written by the same hand
 * in the same breath, so anything but equality is drift.
 *
 * Run: `npm run docs:check`. Wired into CI as its OWN step, so a failure reads
 * as "citation drift" rather than as a buried test failure.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The root whose `docs/` is checked. Defaults to the repo, and the override
 * exists for ONE reason: so this checker can be run against a fixture corpus.
 *
 * A change to this file cannot be proven by this file's verdict on the live
 * docs — that verdict is the thing under test, and "docs:check is green" is
 * exactly as true of a checker that has stopped checking. The corpus in
 * `scripts/fixtures/docs-check/` is the acceptance gate instead: known-bad trees
 * that must FAIL and known-good trees that must PASS, run by
 * `npm run docs:check:self`.
 *
 * It is an env var rather than an argument so the production invocation stays
 * `node scripts/check-doc-citations.mjs` with nothing to get wrong.
 */
const REPO_ROOT = process.env.DOCS_CHECK_ROOT
  ? resolve(process.env.DOCS_CHECK_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = join(REPO_ROOT, 'docs');

/**
 * How far from the anchor a cited literal may appear.
 *
 * Not zero. A citation to an `it(...)` name legitimately points at the `it(` line
 * OR a line or two into the body, and a range citation `#La-Lb` points at a span
 * whose first line is often a comment. Zero would force the docs to be
 * character-exact about something they have no reason to be exact about, and the
 * guard would be gamed by loosening the link text rather than fixing the anchor.
 *
 * Not large either. The drift this catches is the twenty-line slide; a window
 * wide enough to absorb that catches nothing. Five is tight enough that a real
 * slide fails and loose enough that ordinary editing inside the cited block does
 * not.
 */
const PROXIMITY = 5;

/** `[text](path#L12)` and `[text](path#L12-L34)`. */
const CITATION = /\[([^\]]*)\]\(([^)\s#]+)#L(\d+)(?:-L(\d+))?\)/g;

/**
 * A `:<line>` or `:<from>-<to>` reference inside the human-visible LABEL.
 *
 * This repo writes labels in exactly two shapes and both end in this form:
 * `helpers.ts:132`, `migration.sql:22-33`, `interceptor:74-95`, `ADR-006:291`,
 * and the bare continuation `:158` that follows a full citation to the same file.
 *
 * NO NEGATIVE LOOKBEHIND ON THE COLON, and the first draft had one. Guarding
 * against a clock-like `12:30` by refusing a digit before the colon looked free
 * and was not: `ADR-006:291` has a digit before its colon too, so the guard
 * silently skipped one of the very citations it exists to check. The guard was
 * blind on its first run and reported green for that link. Dropping the
 * lookbehind recovers it and — verified against the whole corpus at the time,
 * 96 label-bearing citations — introduces no false positive, because a link
 * LABEL in this repo is a citation label, not prose carrying times or ratios.
 *
 * That is the lesson this file already teaches about content checks, applied to
 * itself: a narrowing added for a hazard nobody has met, which quietly removes
 * a case somebody has, is a worse trade than the false positive it avoided.
 *
 * The optional `L` in the range tail accepts `:74-L95` as well as `:74-95`; both
 * spellings mean the same thing and neither should be a failure.
 */
const LABEL_REF = /:(\d+)(?:\s*-\s*L?(\d+))?(?!\d)/g;

/**
 * Pull every line reference out of a link label.
 *
 * EVERY reference found must match the anchor, not just the last one. The
 * tempting alternative — check only the trailing `<name>:<line>`, since that is
 * where this repo puts it — would let a label carrying two references have one
 * of them rot silently, which is the exact shape of defect this check exists to
 * end. A label that genuinely needs to mention a different line belongs in its
 * own citation, where it gets checked like everything else.
 *
 * Returns `[]` for a label with no reference at all (most of them), which is not
 * a failure: a label reading `` `EXPECTED_DEFINER_FUNCTIONS` `` claims a literal,
 * not a line, and check 3 is what holds it to that.
 */
function labelRefsFrom(linkText) {
  const refs = [];
  for (const m of linkText.matchAll(LABEL_REF)) {
    refs.push({
      from: Number(m[1]),
      to: m[2] === undefined ? undefined : Number(m[2]),
      text: m[0].trim(),
    });
  }
  return refs;
}

/**
 * Literals worth checking, pulled out of the link TEXT.
 *
 * Two shapes, because the docs use two:
 *   * a quoted string — `\`encodeCursor\``, 'matches case-insensitively', "..."
 *   * a bare identifier-shaped token — helpers.ts:132, assertion names, symbols
 *
 * Deliberately NOT every word. A link reading "the interceptor" must not force
 * the word "interceptor" to appear at that line; the guard would then be noise,
 * and noise gets suppressed. Only things that LOOK like they came out of the
 * source are checked against the source.
 */
function literalsFrom(linkText) {
  const out = [];

  // Backtick-quoted, single-quoted and double-quoted spans.
  for (const m of linkText.matchAll(/`([^`]+)`|'([^']+)'|"([^"]+)"/g)) {
    const value = m[1] ?? m[2] ?? m[3] ?? '';
    if (value.trim().length >= 3) out.push(value.trim());
  }

  // Bare tokens that look like code: an identifier carrying a `.`, `_`, `(` or
  // `::`, or a `file.ext:line` reference. `interceptor:74-95` and `cursor.ts`
  // qualify; `the`, `guard`, `see` do not.
  for (const m of linkText.matchAll(/(?<![`'"\w])([A-Za-z_$][\w$]*(?:[._][\w$]+)+)(?![\w$])/g)) {
    const token = m[1];
    if (token && token.length >= 4) out.push(token);
  }

  // Hyphenated record identifiers — `ADR-009`, `OPEN-7`, `MB001`. These are the
  // commonest link text in this repo's doc-to-doc citations and the pattern above
  // deliberately misses them (it requires a `.` or `_` separator), so an ADR link
  // was getting only the path and line checks. Added when that gap was noticed
  // while writing the step-7a citations — the guard is only worth keeping if it
  // covers the citations actually being written.
  for (const m of linkText.matchAll(/(?<![`'"\w-])([A-Z]{2,6}-?\d{2,4})(?![\w-])/g)) {
    if (m[1]) out.push(m[1]);
  }

  return [...new Set(out)];
}

/**
 * A cited literal may be spelled for prose and still be the same literal.
 *
 * `helpers.ts:132` in a link text is a FILE REFERENCE, not a string that appears
 * inside helpers.ts — the path half is already checked by check 1, so only the
 * tail is worth matching, and usually not even that. Reduced here rather than
 * dropped in `literalsFrom`, so the reduction is visible in one place.
 */
function normalise(literal, targetPath) {
  // `file.ext:123` / `file.ext:123-456` — the anchor already proves the location.
  if (/^[\w.-]+\.(ts|mjs|sql|md|json|yml)(:\d+(-\d+)?)?$/i.test(literal)) return null;
  // `:158`-style continuation links carry no content claim.
  if (/^:?\d+(-L?\d+)?$/.test(literal)) return null;

  // A literal that appears in the TARGET'S OWN PATH is naming the file, not
  // claiming something is written inside it — `[ADR-006:291](ADR-006-membership-
  // model.md#L291)` is a file reference, and check 1 already proves the file. The
  // rule is general rather than an `ADR-` special case, and it is narrow: it
  // leaves `[ADR-009](DECISIONS.md#L387)` fully checked, because `DECISIONS.md`
  // does not contain "ADR-009" in its name and the link genuinely does claim that
  // heading is at that line.
  //
  // Added when the hyphenated-identifier rule above produced its first false
  // positive. A guard that cries wolf gets suppressed, which costs more than the
  // one citation it would have caught.
  // `targetPath` here is the raw markdown link target, which is always
  // forward-slashed, so no separator normalisation is needed.
  if (targetPath.includes(literal)) return null;

  return literal;
}

function haystackFor(lines, from, to) {
  const lo = Math.max(1, from - PROXIMITY);
  const hi = Math.min(lines.length, (to ?? from) + PROXIMITY);
  return lines.slice(lo - 1, hi).join('\n');
}

function main() {
  if (!existsSync(DOCS_DIR)) {
    console.error(`docs/ not found at ${DOCS_DIR}`);
    process.exit(1);
  }

  const docs = readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();

  /** Read each target once — several docs cite the same file dozens of times. */
  const fileCache = new Map();
  const readTarget = (path) => {
    if (!fileCache.has(path)) {
      fileCache.set(path, readFileSync(path, 'utf8').split('\n'));
    }
    return fileCache.get(path);
  };

  const failures = [];
  let checked = 0;
  let contentChecked = 0;
  let labelChecked = 0;

  for (const doc of docs) {
    const docPath = join(DOCS_DIR, doc);
    const docLines = readFileSync(docPath, 'utf8').split('\n');

    docLines.forEach((line, index) => {
      const docLine = index + 1;

      for (const match of line.matchAll(CITATION)) {
        const [, linkText, rawTarget, rawFrom, rawTo] = match;
        const from = Number(rawFrom);
        const to = rawTo === undefined ? undefined : Number(rawTo);
        checked += 1;

        const where = `${relative(REPO_ROOT, docPath)}:${docLine}`;
        const cite = `[${linkText}](${rawTarget}#L${rawFrom}${rawTo ? `-L${rawTo}` : ''})`;

        // ---- 4. the LABEL agrees with its own anchor ----------------------
        // Runs FIRST because it is pure string work on the two halves of this
        // link: no file is read, so it stays meaningful even when the target
        // below turns out not to resolve. A label and an anchor that disagree
        // are a defect regardless of what the target says.
        const labelRefs = labelRefsFrom(linkText);
        let labelDrifted = false;
        for (const ref of labelRefs) {
          if (ref.from === from && ref.to === to) continue;
          labelDrifted = true;
          failures.push({
            where,
            cite,
            why:
              `label says ${ref.text} but the anchor points at ` +
              `L${from}${to === undefined ? '' : `-L${to}`} \u2014 the reader's eye and the ` +
              `reader's browser would land on different lines`,
          });
        }
        if (labelRefs.length > 0) labelChecked += 1;
        if (labelDrifted) continue;

        // ---- 1. the target path resolves -----------------------------------
        const targetPath = resolve(DOCS_DIR, rawTarget);
        if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
          failures.push({
            where,
            cite,
            why: `target does not resolve: ${relative(REPO_ROOT, targetPath)}`,
          });
          continue;
        }

        // ---- 2. the line number(s) are inside the file ---------------------
        const lines = readTarget(targetPath);
        const length = lines.length;

        if (to !== undefined && to < from) {
          failures.push({ where, cite, why: `inverted range: L${from}-L${to}` });
          continue;
        }
        const highest = to ?? from;
        if (from < 1 || highest > length) {
          failures.push({
            where,
            cite,
            why: `line ${highest} is past the end of ${relative(REPO_ROOT, targetPath)} (${length} lines)`,
          });
          continue;
        }

        // ---- 2b. THE ANCHOR LINE IS NOT BLANK ------------------------------
        //
        // THE CHEAPEST CHECK HERE AND THE ONE THAT WOULD HAVE CAUGHT THE MOST.
        // It needs no literal and no label, so it reaches the citations every
        // other content check skips: 116 of 212 carry no checkable literal and
        // 77 carry no label reference, and four carry neither — those four rested
        // entirely on "the path resolves" and "the file has that many lines".
        //
        // WHY BLANK IS THE RIGHT SIGNAL. Nobody cites a blank line on purpose. A
        // citation lands on one for exactly one reason: content was inserted
        // above it and the anchor slid off the thing it named onto the gap beside
        // it. That is the entire shape of the drift this repo has landed twice —
        // the tenant/abuse hardening PR's +1 and the E2E PR's +2 both pushed ADR
        // anchors onto the blank line above their heading, and `docs:check`
        // reported green both times.
        //
        // It found SIX live citations on the first run, every one real drift:
        // a spec's assertion cited one line late, `CLAUDE.md`'s append-only table
        // cited at the gap above it, a helpers array cited past its closing
        // bracket. None of them were caught by anything else.
        //
        // A RANGE'S START LINE COUNTS. `#L46-L52` beginning on a blank is the
        // same defect wearing a range: `CLAUDE.md#L46-L52` pointed at the gap
        // above the heading it meant. A range legitimately STARTS on a comment or
        // a prose line — that stays allowed, and only blank is refused.
        const anchorLine = lines[from - 1] ?? '';
        if (anchorLine.trim() === '') {
          failures.push({
            where,
            cite,
            why:
              `the anchor points at a BLANK line (L${from}) — an anchor lands on a ` +
              `blank when content was inserted above it and the citation slid off ` +
              `what it named`,
          });
          continue;
        }

        // ---- 3. the content check -----------------------------------------
        const literals = literalsFrom(linkText)
          .map((l) => normalise(l, rawTarget))
          .filter(Boolean);
        if (literals.length === 0) continue;

        const haystack = haystackFor(lines, from, highest);

        // A link whose ENTIRE text is a record id — `[ADR-012](DECISIONS.md#L491)`
        // — is pointing at that record's HEADING, so it is checked against heading
        // lines only, not against any mention in the window.
        //
        // WHY THIS IS TIGHTER AND WHY IT HAD TO BE. A document that discusses its
        // own record ids mentions them in prose constantly, so the plain
        // substring check matches a passing reference and reports green. That
        // happened, live, while writing step 7a: an `[ADR-012]` anchor drifted 15
        // lines when content was inserted above it, and the window happened to
        // contain the words "ADR-012's scope" four lines away. Path and line were
        // still valid, so checks 1 and 2 saw nothing either — the citation was
        // wrong and every check passed.
        //
        // Restricting to headings removes the coincidence: prose mentions a
        // record, a heading DECLARES it, and a record-id link means the latter.
        const headingOnly = /^[A-Z]{2,6}-?\d{2,4}$/.test(linkText.trim());
        contentChecked += 1;

        if (headingOnly) {
          // ---- 3a. A HEADING-ANCHORED CITATION IS EXACT, NOT PROXIMATE ------
          //
          // THE PROXIMITY WINDOW IS WHAT LET THE DRIFT THROUGH, and this is the
          // narrow place it can be removed without cost.
          //
          // The window exists for a real case, argued in its own comment above
          // and still correct: prose legitimately points a line or two into a
          // block, an `it(...)` citation may land on the `it(` line or inside the
          // body, a range may start on a comment. Removing it globally would
          // force character-exactness the docs have no reason to keep, and the
          // guard would be gamed by loosening link text rather than fixing
          // anchors. So it is NOT removed globally.
          //
          // But a link whose ENTIRE text is a record id is not prose pointing
          // into a block. It claims one thing: "this record is DECLARED here."
          // A declaration is a single line, so "within five lines" is not a
          // tolerance for that claim — it is a hole. Both landed drifts sat in
          // it: a +1 or +2 shift leaves the heading comfortably inside ±5, so
          // every ADR citation in the repo could be off by one or two and green.
          //
          // Exactness here also closes a case the blank rule alone cannot:
          // `ISOLATION.md:343` cited an `it(...)` name four lines above a blank
          // anchor — the blank rule catches that one, but the same slide onto a
          // NON-blank line would still pass on the window. For heading anchors
          // that residual is now gone.
          const isHeading = anchorLine.trimStart().startsWith('#');
          const missing = literals.filter((literal) => !anchorLine.includes(literal));

          if (!isHeading || missing.length > 0) {
            failures.push({
              where,
              cite,
              why: !isHeading
                ? `a record-id citation must point AT the heading that declares it, ` +
                  `and L${from} is not a heading`
                : `the heading at L${from} does not declare ` +
                  missing.map((m) => JSON.stringify(m)).join(', ') +
                  ` — a record-id citation is exact, not within ${PROXIMITY} lines`,
            });
          }
          continue;
        }

        const missing = literals.filter((literal) => !haystack.includes(literal));

        if (missing.length > 0) {
          failures.push({
            where,
            cite,
            why:
              `cited literal not found within ${PROXIMITY} lines of the anchor: ` +
              missing.map((m) => JSON.stringify(m)).join(', '),
          });
        }
      }
    });
  }

  if (failures.length > 0) {
    console.error(`\nCITATION DRIFT — ${failures.length} of ${checked} line-level citations\n`);
    for (const f of failures) {
      console.error(`  ${f.where}`);
      console.error(`    ${f.cite}`);
      console.error(`    -> ${f.why}\n`);
    }
    console.error(
      'A citation that points at the wrong line is worse than a vague one: it reads as\n' +
        'precise and spends the reader’s trust. Re-anchor it, or widen the link text to\n' +
        'stop claiming a literal it no longer points at.\n\n' +
        'For a LABEL failure the fix is never to delete the number from the label: that\n' +
        'trades a visible disagreement for an invisible one. Re-anchor by LANDING \u2014 open\n' +
        'the line, confirm it is what the citation claims \u2014 then set both halves to it.\n',
    );
    process.exit(1);
  }

  console.log(
    `docs citations OK — ${checked} line-level citations across ${docs.length} files ` +
      `(${contentChecked} carried a literal and were content-checked; ` +
      `${labelChecked} carried a line reference in the label and were checked against their anchor).`,
  );
}

main();
