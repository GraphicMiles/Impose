# Delete and recovery: product plan

Scope-locked plan for the one gap this pass closes. Written against the
product-planner skill (traceability, invariants, failure states, scope lock),
the flow brief (CRUD completeness, destructive actions, empty states, deep
links), the copy brief (consequence-bearing buttons, no blame, personality in
microcopy), and the system-design skill (client is untrusted, idempotency,
soft delete over hard delete).

## 1. Why this, and why now

The three prior passes made the community surface look and behave correctly for
**creating and reading**. Auditing the shipped app against the flow brief's CRUD
matrix (§8) shows the create and read columns are complete and the **delete
column is entirely absent**:

| Entity | Create | Read | Update | Delete |
|---|---|---|---|---|
| Generation | yes | yes | n/a by design | **missing** |
| Comment | yes | yes | n/a by design | **missing** |

This is not a cosmetic gap. Three pieces of shipped code already assume deletion
exists:

1. `community.js:511` renders the string `"a deleted generation"` when a
   challenge's parent cannot be resolved. The read path handles a tombstone that
   nothing in the product can currently produce.
2. `route()` falls through to the feed when `#/g/<id>` does not resolve, so a
   dead link silently becomes the home feed with no explanation.
3. `gen.counts.comment` only ever increments.

Update is deliberately **not** in scope and is recorded as a non-goal below, so
absence of an edit affordance is a decision rather than an oversight.

## 2. Traceability

Every requirement below traces to an origin, per planner Rule 12.

| ID | Requirement | Origin |
|---|---|---|
| D1 | A user can delete their own generation | flow §8 CRUD Delete |
| D2 | A user can delete their own comment | flow §8 CRUD Delete |
| D3 | Deletion is reversible for a grace period | flow §23 "is there an undo period" |
| D4 | Confirmation states the consequence, not "are you sure" | flow §23, copy §9 |
| D5 | Replies to a deleted parent survive as a tombstone | flow §23 "dependent data" |
| D6 | A deep link to a deleted generation explains itself | flow §15 deep links |
| D7 | Counts stay truthful after deletion | engineering: no drifting denormalized count (system-design §4.2) |
| D8 | Deleting is never available on another user's content | planner Rule 9, client is untrusted |

## 3. Product invariants

Rules that hold regardless of UI.

- **Only an author deletes their own content.** Ownership is the sole permission
  input. The UI hides the control; the data layer re-checks it. The client is
  never the authority (planner Rule 9).
- **Delete is soft.** A deleted record keeps its id and its position in the
  reply graph. Nothing is removed from storage during the undo window.
- **A tombstone is not content.** A deleted generation exposes no prompt, no
  response, and no author identity, but its replies keep their parent link.
- **Counts describe what is visible.** A deleted comment stops being counted.
- **Undo restores exactly the prior state**, not an approximation.

## 4. Chosen semantics, and the rejected alternatives

| Question | Decision | Why |
|---|---|---|
| Soft or hard? | Soft, with a `deleted` flag and `deletedAt` | Hard delete makes D3 and D5 impossible |
| Undo period | 6 seconds, via the existing toast action slot | The app already has a toast with an action button; a modal undo would be new furniture for no gain |
| Confirm dialog? | **No dialog for comments, no dialog for posts** | See below |
| Purge? | Out of scope, recorded as future | Needs a server; this build is local-first |

On the confirm dialog: the flow brief says never ask "are you sure" without
explaining the consequence. The stronger reading is that a **reversible** action
should not ask at all. A confirm dialog plus an undo toast is two interruptions
for one decision. So the product deletes immediately, states the consequence in
the toast, and offers Undo for 6 seconds. This matches the brief's preference
for fewer steps and clearer state.

Non-obvious consequence: if the toast is dismissed the delete becomes permanent
for this build. The toast copy therefore has to carry that fact.

## 5. Copy

Per the copy brief: say what happened, what it affected, and what to do next.
No blame, no "are you sure", no AI-company verbs.

| Surface | Copy |
|---|---|
| Menu item, own post | `Delete post` |
| Menu item, own comment | `Delete comment` |
| Toast, post with replies | `Post deleted. N replies kept, shown under a removed post.` + `Undo` |
| Toast, post with no replies | `Post deleted.` + `Undo` |
| Toast, comment | `Comment deleted.` + `Undo` |
| Tombstone body | `This post was deleted by its author.` |
| Deleted comment in a thread | `Comment deleted.` |
| Deep link to a deleted post | `This post was deleted` / `The author removed it. The replies it started are gone with it.` + `Back to the feed` |
| Undo confirmation | `Post restored.` / `Comment restored.` |

## 6. State machine

```
        delete
live ───────────────> pending-delete ──(6s elapsed)──> deleted
  ^                         │
  └─────── undo ────────────┘
```

`pending-delete` and `deleted` render identically. The distinction exists only
so Undo knows whether it may still act. Reload during `pending-delete` lands in
`deleted`: the flag is persisted at the moment of deletion, not at expiry, so a
crash can never resurrect content the author asked to remove. This is the safe
direction to fail (system-design §11: fail toward the user's stated intent).

## 7. Failure and edge matrix

| Case | Behaviour |
|---|---|
| Delete a post that is mid-stream | Blocked. The control is absent while streaming, and the handler re-checks |
| Delete a post with replies | Post becomes a tombstone, replies stay, thread geometry unchanged |
| Delete a comment with replies | Same: tombstone row, children keep their indent |
| Delete a comment with no replies | Row is removed outright, no tombstone litter |
| Undo after the window | Not possible; the toast is gone, so there is no affordance to mislead |
| Undo twice | Idempotent, second call is a no-op |
| Deep link to a deleted post | Dedicated missing state with a route out (D6) |
| Deleted post in the feed | Filtered out of the feed entirely |
| Deleted post that is a challenge parent | Existing `"a deleted generation"` path now actually fires |
| Another user's post | No control rendered, and the handler rejects it (D8) |
| Counts after deleting a comment | Decremented, floored at zero |

## 8. Non-goals

- **Editing.** A post that can be silently rewritten after being remixed or
  challenged breaks the meaning of the replies pointing at it. Out of scope
  deliberately, not by omission.
- **Hard purge / "delete for everyone".** Needs a server and a moderation model.
- **Reporting and moderation.** Separate product surface.
- **Bulk delete.** No evidence of need at this scale.

## 9. Acceptance criteria

1. An own post shows a delete control; another user's post does not.
2. Deleting removes it from the feed within one render.
3. The toast states the reply consequence and offers Undo.
4. Undo restores the post, its replies, and its counts exactly.
5. Replies to a deleted post survive under a tombstone.
6. A deleted comment with children renders a tombstone; one without is removed.
7. `#/g/<deleted id>` renders the missing state, not the feed.
8. Comment counts never go negative and match visible comments.
9. A streaming post cannot be deleted.
10. Deletion survives reload; undo state does not.
11. The handler rejects a forged id for content the user does not own.
12. Full regression gate stays green.

## 10. Scope lock

Locked to D1 through D8. Anything else discovered during implementation is
recorded here as a future item rather than built.
