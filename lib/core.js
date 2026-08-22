// dsh-message-edit — core state machine (pure, zero dependencies, zero I/O).
//
// Domain rules for editing / removing a user message in a DSH session:
//   - edit (mark → commit): the user message at `targetSeq` and EVERYTHING
//     after it disappears from the chat view and the model context; the
//     edited text is sent as a brand-new message that lands at the same
//     visual position (everything from targetSeq on is hidden).
//   - undo: the user message at `targetSeq` and everything after it is
//     removed outright — back to "this message was never sent".
//
// Durability model: the session log is append-only and never rewritten.
// Every state transition is described by an audit record (`hook/invoked`
// with source 'message-edit'); the durable state is literally the fold of
// those records, so a fresh boot replays them to rebuild identical state.
//
// Event protocol (wire format — durable decision, do not reshape lightly):
//   { phase: 'mark',   targetSeq, preview? }        edit intent placed
//   { phase: 'cancel', targetSeq }                  edit intent dropped
//   { phase: 'undo',   targetSeq }                  undo intent placed
//   { phase: 'commit', targetSeq, hiddenFrom, hiddenTo }  range sealed
//
// Pending semantics across restarts:
//   - a pending EDIT whose mark record predates the current boot is stale
//     (its textarea lived in the old page) → discarded on replay;
//   - a pending UNDO survives replay → the host seals it at the first
//     reconciliation pass (destruction intent must not resurrect).

/** Audit source marker carried in every record this plugin appends. */
export const SOURCE = 'message-edit'

/** Session event type used for audit records (known-but-unused by the harness build). */
export const AUDIT_TYPE = 'hook/invoked'

/** Node kinds the client offers actions on; both anchor at `user/message` events. */
export const TARGETABLE_NODE_KINDS = ['user', 'steering']

/**
 * Empty durable state for one session.
 * @returns {{ pending: null | { kind: 'edit' | 'undo', targetSeq: number, markSeq: number }, ranges: Array<{ start: number, end: number }> }}
 */
export function emptyState() {
  return { pending: null, ranges: [] }
}

/**
 * True when `seq` falls inside any committed hidden range.
 * @param {Array<{ start: number, end: number }>} ranges
 * @param {number} seq
 */
export function inRanges(ranges, seq) {
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]
    if (seq >= r.start && seq <= r.end) return true
  }
  return false
}

/**
 * Whether a chat node kind may carry edit/undo actions (mirrors the host's
 * `user/message` validation; the client uses this to decide button render).
 * @param {string} kind
 */
export function isTargetableKind(kind) {
  return TARGETABLE_NODE_KINDS.includes(kind)
}

/**
 * Validate a would-be edit/undo target against durable state.
 * @param state durable state for the session
 * @param {number} seq candidate event seq
 * @param {{ type?: string }} event the session event anchored at `seq`
 * @returns {{ ok: true } | { ok: false, code: 'bad-seq' | 'not-user-message' | 'in-hidden-range' }}
 */
export function checkTarget(state, seq, event) {
  if (!Number.isSafeInteger(seq) || seq < 0) return { ok: false, code: 'bad-seq' }
  if (!event || event.type !== 'user/message') return { ok: false, code: 'not-user-message' }
  if (inRanges(state.ranges, seq)) return { ok: false, code: 'in-hidden-range' }
  return { ok: true }
}

/**
 * Plan the audit records for placing an edit intent. Placing a new mark while
 * another pending exists implicitly cancels the old one (cancel first, then
 * mark) so the log never holds two live intents.
 * @param state durable state
 * @param {{ seq: number, preview?: string }} input
 * @returns {{ ok: true, audits: object[] } | { ok: false, code: string }}
 */
export function planMark(state, input) {
  const seq = input.seq
  const check = checkTarget(state, seq, input.event)
  if (!check.ok) return check
  const audits = []
  if (state.pending !== null && state.pending.targetSeq !== seq) {
    audits.push(audit('cancel', { targetSeq: state.pending.targetSeq }))
  } else if (state.pending !== null && state.pending.targetSeq === seq) {
    // Re-marking the same target is a no-op retry; keep the original intent.
    return { ok: true, audits: [] }
  }
  const preview = typeof input.preview === 'string' ? input.preview.slice(0, 120) : ''
  const mark = audit('mark', { targetSeq: seq, preview })
  audits.push(mark)
  return { ok: true, audits }
}

/**
 * Plan the audit record for dropping the current edit intent.
 * @returns {{ ok: true, audits: object[] } | { ok: false, code: 'no-pending' }}
 */
export function planCancel(state) {
  if (state.pending === null || state.pending.kind !== 'edit') return { ok: false, code: 'no-pending' }
  return { ok: true, audits: [audit('cancel', { targetSeq: state.pending.targetSeq })] }
}

/**
 * Plan the audit record for an undo intent. Sealing may be immediate (agent
 * idle) or deferred (agent running → seal on settle); either way the intent
 * is logged first so a crash cannot resurrect the doomed tail.
 * @param state durable state
 * @param {{ seq: number }} input
 */
export function planUndo(state, input) {
  const seq = input.seq
  const check = checkTarget(state, seq, input.event)
  if (!check.ok) return check
  const audits = []
  if (state.pending !== null && state.pending.kind === 'edit') {
    audits.push(audit('cancel', { targetSeq: state.pending.targetSeq }))
  }
  audits.push(audit('undo', { targetSeq: seq }))
  return { ok: true, audits }
}

/**
 * Plan the audit record that seals the hidden range for the current pending.
 * The range always starts at the target message itself (both edit and undo
 * remove the message) and ends at `endSeq` inclusive.
 * @param state durable state
 * @param {{ endSeq: number }} input
 * @returns {{ ok: true, audits: object[] } | { ok: false, code: string }}
 */
export function planCommit(state, input) {
  const pending = state.pending
  if (pending === null) return { ok: false, code: 'no-pending' }
  const endSeq = input.endSeq
  if (!Number.isSafeInteger(endSeq) || endSeq < pending.targetSeq) return { ok: false, code: 'bad-end-seq' }
  return {
    ok: true,
    audits: [audit('commit', {
      targetSeq: pending.targetSeq,
      hiddenFrom: pending.targetSeq,
      hiddenTo: endSeq,
      phaseOfPending: pending.kind,
    })],
  }
}

/**
 * Fold one audit record into durable state. Single mutation path: the host's
 * in-memory state is always the fold of the session's audit records.
 * @param state durable state (treated immutably; a new object is returned on change)
 * @param {{ seq: number, data: object }} record session event previously appended via AUDIT_TYPE
 * @returns next state (same reference when the record is not ours)
 */
export function reduceAudit(state, record) {
  const data = record && record.data
  if (!data || data.source !== SOURCE) return state
  const phase = data.phase
  if (phase === 'mark' && Number.isSafeInteger(data.targetSeq)) {
    if (state.pending !== null && state.pending.kind === 'edit' && state.pending.targetSeq === data.targetSeq) return state
    return { ...state, pending: { kind: 'edit', targetSeq: data.targetSeq, markSeq: record.seq } }
  }
  if (phase === 'undo' && Number.isSafeInteger(data.targetSeq)) {
    if (state.pending !== null && state.pending.kind === 'undo' && state.pending.targetSeq === data.targetSeq) return state
    return { ...state, pending: { kind: 'undo', targetSeq: data.targetSeq, markSeq: record.seq } }
  }
  if (phase === 'cancel') {
    if (state.pending === null) return state
    return { ...state, pending: null }
  }
  if (phase === 'commit' && Number.isSafeInteger(data.hiddenFrom) && Number.isSafeInteger(data.hiddenTo)) {
    if (inRanges(state.ranges, data.hiddenFrom) && inRanges(state.ranges, data.hiddenTo)) return state
    return {
      pending: null,
      ranges: [...state.ranges, { start: data.hiddenFrom, end: data.hiddenTo }],
    }
  }
  return state
}

/**
 * Replay a run of session events into durable state.
 * @param {Array<{ seq: number, type: string, data: object }>} events session events (full log or a suffix)
 * @param state state to fold onto (defaults to empty)
 * @returns next state
 */
export function replay(events, state = emptyState()) {
  let next = state
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (!event || event.type !== AUDIT_TYPE) continue
    next = reduceAudit(next, event)
  }
  return next
}

/**
 * Drop stale pending EDIT intents after a full-log replay: a mark recorded
 * before the current boot (`markSeq < liveFromSeq`) belongs to a page that no
 * longer exists. Pending UNDO intents intentionally survive.
 * @param state state produced by replaying the FULL log
 * @param {number} liveFromSeq first event seq of the current process lifetime
 */
export function dropStalePending(state, liveFromSeq) {
  if (state.pending !== null && state.pending.kind === 'edit' && state.pending.markSeq < liveFromSeq) {
    return { ...state, pending: null }
  }
  return state
}

/**
 * Serializable snapshot for the client `/state` response.
 */
export function snapshot(state) {
  return {
    pending: state.pending === null ? null : {
      kind: state.pending.kind,
      targetSeq: state.pending.targetSeq,
      markSeq: state.pending.markSeq,
    },
    ranges: state.ranges.map((r) => ({ start: r.start, end: r.end })),
  }
}

function audit(phase, data) {
  return { type: AUDIT_TYPE, data: { source: SOURCE, phase, ...data } }
}
