// Unit tests for the dsh-message-edit core state machine.
// Run: node --test test/
// Only external behavior is tested: planning decisions, audit folds, replay
// reconstruction, and range predicates — never implementation internals.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AUDIT_TYPE,
  SOURCE,
  checkTarget,
  dropStalePending,
  emptyState,
  inRanges,
  isTargetableKind,
  planCancel,
  planCommit,
  planMark,
  planUndo,
  reduceAudit,
  replay,
  snapshot,
} from '../lib/core.js'

/** Build a fake audit session event as the host would append it. */
function record(seq, phase, data) {
  return { seq, type: AUDIT_TYPE, data: { source: SOURCE, phase, ...data } }
}

const USER_EVENT = { type: 'user/message' }
const ASSISTANT_EVENT = { type: 'assistant/message' }

test('checkTarget validates seq, event kind, and hidden ranges', () => {
  const state = { pending: null, ranges: [{ start: 5, end: 9 }] }
  assert.deepEqual(checkTarget(state, 3, USER_EVENT), { ok: true })
  assert.equal(checkTarget(state, -1, USER_EVENT).code, 'bad-seq')
  assert.equal(checkTarget(state, 1.5, USER_EVENT).code, 'bad-seq')
  assert.equal(checkTarget(state, 4, ASSISTANT_EVENT).code, 'not-user-message')
  assert.equal(checkTarget(state, 4, undefined).code, 'not-user-message')
  assert.equal(checkTarget(state, 5, USER_EVENT).code, 'in-hidden-range')
  assert.equal(checkTarget(state, 9, USER_EVENT).code, 'in-hidden-range')
  assert.equal(checkTarget(state, 10, USER_EVENT).ok, true)
})

test('planMark places an edit intent and carries a truncated preview', () => {
  const plan = planMark(emptyState(), { seq: 4, event: USER_EVENT, preview: 'x'.repeat(200) })
  assert.equal(plan.ok, true)
  assert.equal(plan.audits.length, 1)
  assert.equal(plan.audits[0].data.phase, 'mark')
  assert.equal(plan.audits[0].data.targetSeq, 4)
  assert.equal(plan.audits[0].data.preview.length, 120)
})

test('planMark rejects invalid targets with the same codes as checkTarget', () => {
  assert.equal(planMark(emptyState(), { seq: 2, event: ASSISTANT_EVENT }).code, 'not-user-message')
  const sealed = { pending: null, ranges: [{ start: 2, end: 6 }] }
  assert.equal(planMark(sealed, { seq: 3, event: USER_EVENT }).code, 'in-hidden-range')
})

test('planMark cancels a different pending edit before re-marking', () => {
  let state = replay([record(20, 'mark', { targetSeq: 4 })])
  const plan = planMark(state, { seq: 8, event: USER_EVENT })
  assert.equal(plan.ok, true)
  assert.equal(plan.audits.length, 2)
  assert.equal(plan.audits[0].data.phase, 'cancel')
  assert.equal(plan.audits[0].data.targetSeq, 4)
  assert.equal(plan.audits[1].data.phase, 'mark')
  assert.equal(plan.audits[1].data.targetSeq, 8)
})

test('planMark on the same target is a no-op retry (no duplicate intent)', () => {
  let state = replay([record(20, 'mark', { targetSeq: 4 })])
  const plan = planMark(state, { seq: 4, event: USER_EVENT })
  assert.equal(plan.ok, true)
  assert.equal(plan.audits.length, 0)
})

test('reduceAudit folds mark into a pending edit stamped with the record seq', () => {
  const state = reduceAudit(emptyState(), record(21, 'mark', { targetSeq: 4 }))
  assert.deepEqual(state.pending, { kind: 'edit', targetSeq: 4, markSeq: 21 })
  assert.deepEqual(state.ranges, [])
})

test('reduceAudit folds undo into a pending undo', () => {
  const state = reduceAudit(emptyState(), record(31, 'undo', { targetSeq: 7 }))
  assert.deepEqual(state.pending, { kind: 'undo', targetSeq: 7, markSeq: 31 })
})

test('reduceAudit folds cancel to clear any pending', () => {
  let state = reduceAudit(emptyState(), record(21, 'mark', { targetSeq: 4 }))
  state = reduceAudit(state, record(22, 'cancel', { targetSeq: 4 }))
  assert.equal(state.pending, null)
  // Cancel without pending keeps state unchanged (same reference).
  const before = state
  assert.equal(reduceAudit(state, record(23, 'cancel', { targetSeq: 4 })), before)
})

test('reduceAudit folds commit into a sealed range and clears pending', () => {
  let state = reduceAudit(emptyState(), record(21, 'mark', { targetSeq: 4 }))
  state = reduceAudit(state, record(40, 'commit', { targetSeq: 4, hiddenFrom: 4, hiddenTo: 39 }))
  assert.equal(state.pending, null)
  assert.deepEqual(state.ranges, [{ start: 4, end: 39 }])
})

test('reduceAudit ignores foreign sources and unknown phases', () => {
  const before = emptyState()
  const foreign = { seq: 1, type: AUDIT_TYPE, data: { source: 'someone-else', phase: 'commit', hiddenFrom: 0, hiddenTo: 99 } }
  assert.equal(reduceAudit(before, foreign), before)
  const weird = record(2, 'teleport', { targetSeq: 3 })
  assert.equal(reduceAudit(before, weird), before)
})

test('planCommit seals [targetSeq, endSeq] for both pending kinds and validates endSeq', () => {
  for (const phase of ['mark', 'undo']) {
    let state = replay([record(10, phase, { targetSeq: 4 })])
    const plan = planCommit(state, { endSeq: 30 })
    assert.equal(plan.ok, true)
    assert.deepEqual(plan.audits[0].data, {
      source: SOURCE,
      phase: 'commit',
      targetSeq: 4,
      hiddenFrom: 4,
      hiddenTo: 30,
      phaseOfPending: phase === 'mark' ? 'edit' : 'undo',
    })
  }
  assert.equal(planCommit(emptyState(), { endSeq: 30 }).code, 'no-pending')
  let state = replay([record(10, 'undo', { targetSeq: 4 })])
  assert.equal(planCommit(state, { endSeq: 3 }).code, 'bad-end-seq')
  assert.equal(planCommit(state, { endSeq: Number.NaN }).code, 'bad-end-seq')
})

test('planCancel only drops edit intents', () => {
  let state = replay([record(20, 'mark', { targetSeq: 4 })])
  assert.equal(planCancel(state).ok, true)
  state = replay([record(20, 'undo', { targetSeq: 4 })])
  assert.equal(planCancel(state).code, 'no-pending')
  assert.equal(planCancel(emptyState()).code, 'no-pending')
})

test('planUndo logs an undo intent and cancels a live edit intent first', () => {
  const plain = planUndo(emptyState(), { seq: 6, event: USER_EVENT })
  assert.equal(plain.ok, true)
  assert.equal(plain.audits.length, 1)
  assert.equal(plain.audits[0].data.phase, 'undo')

  let state = replay([record(20, 'mark', { targetSeq: 2 })])
  const mixed = planUndo(state, { seq: 6, event: USER_EVENT })
  assert.equal(mixed.audits.length, 2)
  assert.equal(mixed.audits[0].data.phase, 'cancel')
  assert.equal(mixed.audits[1].data.phase, 'undo')

  assert.equal(planUndo(emptyState(), { seq: 6, event: ASSISTANT_EVENT }).code, 'not-user-message')
})

test('replay reconstructs identical state from an arbitrary audit history', () => {
  const history = [
    record(20, 'mark', { targetSeq: 4 }),
    record(40, 'commit', { targetSeq: 4, hiddenFrom: 4, hiddenTo: 39 }),
    record(50, 'undo', { targetSeq: 45 }),
    record(60, 'commit', { targetSeq: 45, hiddenFrom: 45, hiddenTo: 59 }),
    record(70, 'mark', { targetSeq: 70 }),
  ]
  const state = replay(history)
  assert.deepEqual(state.ranges, [{ start: 4, end: 39 }, { start: 45, end: 59 }])
  assert.deepEqual(state.pending, { kind: 'edit', targetSeq: 70, markSeq: 70 })

  // Incremental folding over suffixes matches the full-log fold.
  let incremental = replay(history.slice(0, 2))
  incremental = replay(history.slice(2), incremental)
  assert.deepEqual(incremental, state)
})

test('dropStalePending discards pre-boot edit intents but keeps undo intents', () => {
  let state = replay([
    record(20, 'mark', { targetSeq: 4 }),
  ])
  state = dropStalePending(state, 100)
  assert.equal(state.pending, null)

  state = replay([record(120, 'mark', { targetSeq: 104 })])
  state = dropStalePending(state, 100)
  assert.deepEqual(state.pending, { kind: 'edit', targetSeq: 104, markSeq: 120 })

  state = replay([record(20, 'undo', { targetSeq: 4 })])
  state = dropStalePending(state, 100)
  assert.deepEqual(state.pending, { kind: 'undo', targetSeq: 4, markSeq: 20 })
})

test('snapshot exposes a JSON-safe view for the client', () => {
  assert.deepEqual(snapshot(emptyState()), { pending: null, ranges: [] })
  const state = replay([
    record(20, 'undo', { targetSeq: 7 }),
    record(40, 'commit', { targetSeq: 7, hiddenFrom: 7, hiddenTo: 39 }),
  ])
  assert.deepEqual(snapshot(state), {
    pending: null,
    ranges: [{ start: 7, end: 39 }],
  })
})

test('inRanges and isTargetableKind cover boundary semantics', () => {
  const ranges = [{ start: 5, end: 9 }, { start: 20, end: 20 }]
  assert.equal(inRanges(ranges, 4), false)
  assert.equal(inRanges(ranges, 5), true)
  assert.equal(inRanges(ranges, 9), true)
  assert.equal(inRanges(ranges, 10), false)
  assert.equal(inRanges(ranges, 20), true)
  assert.equal(isTargetableKind('user'), true)
  assert.equal(isTargetableKind('steering'), true)
  assert.equal(isTargetableKind('assistant'), false)
})
