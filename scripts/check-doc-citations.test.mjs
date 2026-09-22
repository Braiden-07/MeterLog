#!/usr/bin/env node
/**
 * THE CHECKER'S OWN ACCEPTANCE GATE — `npm run docs:check:self`.
 *
 * ================== WHY `docs:check` CANNOT PROVE THE CHECKER ===============
 *
 * `docs:check` reporting green says nothing about a change to the checker,
 * because that verdict is the thing under test. "Green on the live corpus" is
 * exactly as true of a guard that has quietly stopped guarding — which is not a
 * hypothetical here: the register recorded three blind mechanisms for four
 * slices while CI stayed green through every one of them, and two real drifts
 * landed on `main` underneath that green.
 *
 * So acceptance comes from OUTSIDE the tool. This runs it against a corpus of
 * trees whose answers are known in advance:
 *
 *   * `bad-*`   MUST fail. Each reconstructs drift this project has actually
 *               landed, so the corpus is a record of real defects and not of
 *               imagined ones.
 *   * `good-*`  MUST pass. Each is a citation shape that is legitimately correct,
 *               including the prose-into-block case the proximity window exists
 *               for — because a guard is only worth having if it can tell the
 *               two apart.
 *
 * ===================== AND THE MUTATION PASS ===============================
 *
 * Two fixtures passing is not proof that two checks are doing the work; one
 * check could be catching everything while the other is decoration. So the
 * mutation pass DISABLES each new rule in turn, in a scratch copy of the
 * checker, and asserts that a DIFFERENT, NAMED fixture goes green — proving
 * which mechanism each rule actually closes, and that neither is redundant.
 *
 * A rule whose removal changes nothing would be caught here, not by review.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, 'check-doc-citations.mjs');
const FIXTURES = join(HERE, 'fixtures', 'docs-check');

/** Runs a checker against a fixture root. Returns {ok, output}. */
function run(checkerPath, fixtureRoot) {
  try {
    const output = execFileSync(process.execPath, [checkerPath], {
      env: { ...process.env, DOCS_CHECK_ROOT: fixtureRoot },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/**
 * The two rules the OPEN-19 fix added, each with the edit that disables it and
 * the fixture that must go green when it is gone.
 *
 * The `reds` fixture is the DISCRIMINATOR: it is chosen to be caught by this
 * rule and by nothing else, which is what makes the mutation informative. A
 * fixture caught by both rules would go red either way and prove nothing about
 * which one matters.
 */
const MUTATIONS = [
  {
    rule: 'the blank-anchor rule (2b)',
    // Neutralise the blank test without removing the block, so the mutation is
    // minimal and cannot accidentally disable anything else.
    find: "if (anchorLine.trim() === '') {",
    replace: 'if (false) {',
    reds: 'bad-blank-anchor-no-checks',
    because:
      'a citation with neither a literal nor a label, on a blank line — no other rule looks at it',
  },
  {
    rule: 'the record-id exactness rule (3a)',
    // Send record-id links back down the proximity path they used to take.
    find: 'const headingOnly = /^[A-Z]{2,6}-?\\d{2,4}$/.test(linkText.trim());',
    replace: 'const headingOnly = false;',
    reds: 'bad-window-absorbs-record-shift',
    because:
      'a record-id anchor two lines above its heading, on a NON-blank line — the blank rule cannot see it and the old window absorbed it',
  },
];

function main() {
  const cases = readdirSync(FIXTURES).sort();
  const bad = cases.filter((c) => c.startsWith('bad-'));
  const good = cases.filter((c) => c.startsWith('good-'));

  if (bad.length === 0 || good.length === 0) {
    console.error('the corpus must contain both bad-* and good-* fixtures');
    process.exit(1);
  }

  const failures = [];

  // ---- known-bad must FAIL --------------------------------------------------
  for (const name of bad) {
    const { ok, output } = run(CHECKER, join(FIXTURES, name));
    if (ok) {
      failures.push(`${name}: expected the checker to REJECT this, and it passed\n${output}`);
    }
  }

  // ---- known-good must PASS ------------------------------------------------
  for (const name of good) {
    const { ok, output } = run(CHECKER, join(FIXTURES, name));
    if (!ok) {
      failures.push(
        `${name}: expected the checker to ACCEPT this, and it failed — a false positive ` +
          `is how a guard gets suppressed\n${output}`,
      );
    }
  }

  // ---- the mutation pass ---------------------------------------------------
  const source = readFileSync(CHECKER, 'utf8');
  const scratch = mkdtempSync(join(tmpdir(), 'docs-check-mutation-'));
  const mutationNotes = [];

  try {
    for (const mutation of MUTATIONS) {
      if (!source.includes(mutation.find)) {
        failures.push(
          `mutation "${mutation.rule}": its anchor text is no longer in the checker, so this ` +
            `mutation silently tests nothing. Update the mutation alongside the rule.`,
        );
        continue;
      }

      const mutated = join(scratch, 'mutated.mjs');
      writeFileSync(mutated, source.replace(mutation.find, mutation.replace), 'utf8');

      // With the rule gone, its discriminating fixture must PASS — that is what
      // proves the rule, and only that rule, was catching it.
      const withoutRule = run(mutated, join(FIXTURES, mutation.reds));
      if (!withoutRule.ok) {
        failures.push(
          `mutation "${mutation.rule}": ${mutation.reds} still fails with the rule disabled, so ` +
            `something ELSE is catching it and this rule is not proven by this fixture`,
        );
        continue;
      }

      // And every good fixture must still pass, or the mutation broke something
      // unrelated and the result above means nothing.
      const collateral = good.filter((name) => !run(mutated, join(FIXTURES, name)).ok);
      if (collateral.length > 0) {
        failures.push(
          `mutation "${mutation.rule}": disabling it also broke ${collateral.join(', ')} — ` +
            `the mutation is not surgical, so its result is not informative`,
        );
        continue;
      }

      mutationNotes.push(`  ${mutation.rule}\n    -> proven by ${mutation.reds}: ${mutation.because}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\nCHECKER SELF-TEST FAILED — ${failures.length} problem(s)\n`);
    for (const f of failures) console.error(`  ${f}\n`);
    console.error(
      'This suite is the only thing that proves the citation guard still guards.\n' +
        '`docs:check` going green does not: its verdict is the thing under test.\n',
    );
    process.exit(1);
  }

  console.log(
    `checker self-test OK — ${bad.length} known-bad trees rejected, ` +
      `${good.length} known-good trees accepted, ${MUTATIONS.length} rules proven non-decorative:`,
  );
  for (const note of mutationNotes) console.log(note);
}

main();
