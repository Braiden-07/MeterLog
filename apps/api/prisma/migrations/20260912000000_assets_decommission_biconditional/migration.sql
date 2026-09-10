-- Step 6, Phase 3b — the decommission biconditional, as a DATABASE constraint.
--
-- DECISION 9 made `DELETE /assets/:id` the decommission transition: it sets
-- `status = 'decommissioned'`, sets `deleted_at`, and emits a `decommissioned`
-- event, atomically. The two columns therefore always move together:
--
--     status = 'decommissioned'  <=>  deleted_at IS NOT NULL
--
-- THIS LANDS BEFORE 3c BUILDS THE PATH IT GUARDS, DELIBERATELY. The endpoint that
-- can violate it does not exist yet, which is exactly when the floor should go in:
-- a constraint added after the code it constrains has to be reconciled against
-- whatever that code already wrote.
--
-- WHY A CONSTRAINT RATHER THAN A SERVICE INVARIANT. This project has twice found
-- an app-layer rule to be one endpoint away from wrong — the `FOR ALL` WITH CHECK
-- default (ADR-006 §0.1) and the citext operator resolution (ADR-004's operator
-- amendment). Both were "handled in code" until they were not. A CHECK makes the
-- inconsistent state UNREPRESENTABLE, so every path is covered without being
-- enumerated: the 3c `DELETE` and `POST /events` handlers, a future bulk import,
-- an `UPDATE` typed into psql at 2am, and any definer function added later. This
-- is Decision B's standard — the database is the hard floor, the application is
-- defence in depth on top of it.
--
-- WHY A CHECK IS AVAILABLE HERE AND WAS NOT FOR ADR-007. ADR-007 needed a child
-- row's tenant to agree with its PARENT's, and `CHECK` cannot reference another
-- table — hence the composite FK. This invariant is entirely within ONE ROW, which
-- is precisely the shape `CHECK` exists for. No subquery, no second table, no
-- mutable-predicate problem: the constraint is evaluated per row on write and
-- there is no policy interaction at all (unlike the OPEN-5 `deleted_at`-in-policy
-- deadlock, which was about a POLICY predicate, not a constraint).
--
-- NOT NULL-SAFE BY CONSTRUCTION: `(a) = (b)` where both sides are boolean and
-- neither can be NULL — `status` is `NOT NULL`, and `deleted_at IS NOT NULL` is a
-- predicate that always yields true or false, never NULL. So the CHECK never
-- evaluates to NULL and can never be satisfied vacuously, which is the usual way
-- a CHECK silently stops enforcing anything.
--
-- Phase 3b creates only LIVE, `installed` assets (`deleted_at` null), so every row
-- it writes satisfies this trivially. The constraint is here for 3c.

ALTER TABLE public.assets
  ADD CONSTRAINT assets_decommissioned_iff_deleted
  CHECK ((status = 'decommissioned') = (deleted_at IS NOT NULL));

-- Note what this deliberately does NOT do: it does not stop an asset being
-- decommissioned, and it does not express WHICH transitions are legal. The legal
-- (from -> to) graph is application logic and lands in 3c (ARCHITECTURE §9.2);
-- putting a transition graph in a constraint would be the procedural-logic-in-the-
-- database mistake ADR-007 rejected. This constraint only forbids the two columns
-- from disagreeing about whether the asset is decommissioned.
