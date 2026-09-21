import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE NOTICE-PLACEMENT GUARD — a STRUCTURAL assertion, deliberately.
 *
 * ===================== WHY THIS IS A SOURCE-TEXT TEST =======================
 *
 * The dropped-write notice (OPEN-15's client half) must render ABOVE
 * `<main key={mountKey}>`. That is not a layout preference — it is the
 * difference between a notice that works and one that is destroyed by the event
 * it reports. The tenant-mismatch recovery re-homes the tab, which CHANGES
 * `mountKey`, so everything inside `main` unmounts. A notice rendered in there
 * would flash and vanish; and after re-homing to a workspace where the caller is
 * not an admin, `MembersAdmin` would not render at all.
 *
 * `workspace-session.spec.ts` proves the notice SURVIVES, but it can only prove
 * that about session state — it cannot see JSX. There is no render test in this
 * app (every spec here is a `lib/` unit test) and adding a DOM renderer is a
 * dependency this slice will not take for one assertion. So the invariant that
 * remains unprovable by behaviour is pinned structurally instead, in the shape
 * `route-inventory.spec.ts` already uses when it reads `ARCHITECTURE.md` §9:
 * read the artefact, assert the fact.
 *
 * It is crude and it is honest about being crude. What it buys is that moving
 * the notice inside the remount boundary REDS A TEST rather than silently
 * shipping a notice nobody ever sees — which is precisely the failure this
 * placement was chosen to avoid, and precisely the kind that no amount of
 * comment would prevent.
 */
const raw = readFileSync(resolve(__dirname, 'app-shell.tsx'), 'utf8');

/**
 * Comments are stripped before anything is measured, and the first draft of this
 * file is why.
 *
 * `AppShell`'s comments legitimately QUOTE the JSX they explain — the block above
 * the notice says, in words, that it must sit above `<main key={mountKey}>`. A
 * naive `indexOf` therefore found the boundary inside that prose, decided the
 * notice came after it, and failed against correct code. The guard has to read
 * CODE, not the documentation of the code, or it measures whichever sentence was
 * written first.
 */
function stripComments(input: string): string {
  return input
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '') // {/* JSX comment */}
    .replace(/\/\*[\s\S]*?\*\//g, '') // /* block */
    .replace(/^\s*\/\/.*$/gm, ''); // // line
}

const source = stripComments(raw);

describe('AppShell — the dropped-write notice renders outside the remount boundary', () => {
  it('read a real file, and stripping left real code behind', () => {
    // Non-vacuity, in both directions. A renamed or moved component would make
    // every assertion below vacuously true; so would a `stripComments` that got
    // greedy and deleted the component along with its prose.
    expect(raw.length).toBeGreaterThan(200);
    expect(source).toContain('export function AppShell');
    expect(source).toContain('<WorkspaceSwitcher />');
    expect(source, 'comments were not stripped').not.toContain('THE WHOLE POINT');
  });

  it('still HAS a remount boundary keyed on mountKey', () => {
    // The whole hazard depends on this existing. If the boundary ever goes away,
    // this guard is measuring nothing and should be revisited rather than
    // quietly continuing to pass.
    expect(source).toContain('key={mountKey}');
  });

  it('renders the notice BEFORE <main key={mountKey}>', () => {
    const noticeAt = source.indexOf('{notice &&');
    const boundaryAt = source.indexOf('key={mountKey}');

    expect(noticeAt, 'AppShell no longer renders the notice at all').toBeGreaterThan(-1);
    expect(boundaryAt).toBeGreaterThan(-1);
    expect(
      noticeAt,
      'the notice moved INSIDE the remount boundary — the recovery that raises it changes mountKey, so it would be unmounted before it could be read',
    ).toBeLessThan(boundaryAt);
  });

  it('reads the notice from session state, not from component state', () => {
    // `useState` for the notice would reintroduce the same bug by a different
    // route: component state does not survive the remount either.
    expect(source).toContain('notice');
    expect(source).toContain('session.clearNotice()');
    expect(
      /useState\s*(<[^>]*>)?\s*\(\s*(null|'')/.test(source),
      'AppShell holds the notice in component state — it must come from the session',
    ).toBe(false);
  });
});
