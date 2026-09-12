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
 * THE THREE CHECKS, AND WHY THE THIRD IS THE ONE THAT MATTERS.
 *
 *   1. The target path resolves.
 *   2. Every line number is within the target file's length.
 *   3. CONTENT. Where the link TEXT contains a quoted string or an
 *      identifier-shaped token, that literal must appear in the target file
 *      within PROXIMITY lines of the anchor.
 *
 * Checks 1 and 2 catch deletions and truncations only. A citation that slides
 * twenty lines because somebody added an import passes both of them, every time
 * — the file still exists and the line still exists, it just says something else
 * now. Check 3 is the one that catches the slide, and it is affordable precisely
 * because the docs ALREADY cite tests by their `it(...)` name in the link text.
 * It asserts, mechanically, the thing the author was already asserting by hand.
 *
 * Run: `npm run docs:check`. Wired into CI as its OWN step, so a failure reads
 * as "citation drift" rather than as a buried test failure.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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

        // ---- 3. the content check -----------------------------------------
        const literals = literalsFrom(linkText)
          .map((l) => normalise(l, rawTarget))
          .filter(Boolean);
        if (literals.length === 0) continue;

        const haystack = haystackFor(lines, from, highest);
        const missing = literals.filter((literal) => !haystack.includes(literal));
        contentChecked += 1;

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
        'stop claiming a literal it no longer points at.\n',
    );
    process.exit(1);
  }

  console.log(
    `docs citations OK — ${checked} line-level citations across ${docs.length} files ` +
      `(${contentChecked} carried a literal and were content-checked).`,
  );
}

main();
