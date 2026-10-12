// dsh-message-edit — host half (permanent bundle plugin, zero dependencies).
//
// Gemini-style message edit & undo for DSH conversations:
//   - edit: client places a mark (POST /mark) right before re-sending the
//     edited text; when the session next claims an input message the hidden
//     range [targetSeq, log end] is sealed in the agent/pre-step waterfall,
//     so the model sees only the history before the target plus the new
//     message. The edited message lands at the target's visual position.
//   - undo: POST /undo logs the intent immediately, interrupts a running
//     turn, and seals [targetSeq, log end] as soon as the agent settles —
//     back to "this message was never sent", no response is triggered.
//
// The session log stays append-only: every transition appends a `hook/invoked`
// audit record (source 'message-edit'), and this plugin's view of each session
// is always the fold of those records (lib/core.js). Committed ranges survive
// page refreshes and process restarts via replay; a pending edit from a dead
// page is discarded, while a pending undo is sealed at the first reconcile.
//
// Model-side truncation shadows the live Session's deriveMessages() with a
// range-filtered derivation — request building, replay invariants, and image
// checks all read through that one entry point, so one patch keeps every
// reader consistent.

import {
  AUDIT_TYPE,
  checkTarget,
  dropStalePending,
  emptyState,
  inRanges,
  planCancel,
  planCommit,
  planMark,
  planUndo,
  reduceAudit,
  replay,
  snapshot,
} from './core.js'

export const name = 'message-edit'
export const inject = ['webServer', 'sessions', 'agents']

const API = '/api/dsh-message-edit'
const MAX_BODY_BYTES = 64 * 1024

export function apply(ctx) {
  const { sessions, agents, webServer } = ctx

  /** sid -> { state, scannedSeq, patched } */
  const states = new Map()

  function stateFor(sid) {
    let st = states.get(sid)
    if (st === undefined) {
      st = { state: emptyState(), scannedSeq: -1, patched: false }
      states.set(sid, st)
    }
    return st
  }

  // ---- durable state maintenance ------------------------------------------

  /** Incrementally fold new audit records into the session's durable state. */
  function rebuild(session, st) {
    // 0.2.0: `Session.events` was removed (the log went private); the sanctioned
    // synchronous readers are snapshotEvents()/eventAt() (deprecated but kept).
    const events = session.snapshotEvents()
    if (st.scannedSeq >= events.length - 1) return
    const start = st.scannedSeq + 1
    const fresh = []
    for (let i = start; i < events.length; i++) {
      const event = events[i]
      if (event !== undefined && event.type === AUDIT_TYPE) fresh.push(event)
    }
    st.scannedSeq = events.length - 1
    if (fresh.length === 0) return
    let next = st.state
    for (const record of fresh) next = reduceAudit(next, record)
    st.state = next
  }

  /**
   * Full-log replay (boot path): rebuilds state from scratch and applies the
   * stale-pending rule (pre-boot edit intents die, undo intents survive).
   */
  function rebuildFromLog(session, st) {
    const events = session.snapshotEvents()
    st.state = dropStalePending(replay(events), session.firstLiveSeq)
    st.scannedSeq = events.length - 1
  }

  /** Append audit records planned by core, folding each into memory as it lands. */
  function commitAudits(session, st, plan) {
    for (const planned of plan.audits) {
      const record = session.append(planned.type, planned.data)
      st.state = reduceAudit(st.state, record)
      st.scannedSeq = Math.max(st.scannedSeq, record.seq)
    }
  }

  // ---- model-side truncation ----------------------------------------------

  // Shadow deriveMessages with a range-filtered, memoized derivation.
  function ensurePatched(session, st) {
    if (st.patched) return
    const original = session.deriveMessages
    if (typeof original !== 'function') return
    const rangesRef = () => st.state.ranges
    let cacheSig = ''
    let cacheOut = []
    Object.defineProperty(session, 'deriveMessages', {
      configurable: true,
      writable: true,
      value: function deriveMessagesWithMessageEdit() {
        const ranges = rangesRef()
        if (ranges.length === 0) return original.call(this)
        const surface = this.surface
        const nodes = surface.nodes
        // 0.2.0: the shipped deriveMessages invalidates its cache on
        // contentGeneration (positional replacements AND message projections);
        // mirror that counter so a projection change never serves a stale fold.
        const sig = `${nodes.length}:${ranges.length}:${surface.contentGeneration}`
        if (sig === cacheSig) return cacheOut.slice()
        const out = []
        for (let i = 0; i < nodes.length; i++) {
          const seq = nodes[i]
          if (inRanges(ranges, seq)) continue
          const message = this.deriveEventMessage(this.eventAt(seq))
          if (message != null) out.push(message)
        }
        cacheSig = sig
        cacheOut = out
        return out.slice()
      },
    })
    st.patched = true
  }

  // ---- sealing -------------------------------------------------------------

  /** Seal the current pending range at `session.seq - 1` (current log end). */
  function sealPending(session, st) {
    if (st.state.pending === null) return false
    const plan = planCommit(st.state, { endSeq: session.seq - 1 })
    if (!plan.ok) return false
    commitAudits(session, st, plan)
    ensurePatched(session, st)
    return true
  }

  /**
   * Bring one session's derived state up to date and act on what the fold
   * reveals: pending undos seal as soon as no agent is running.
   */
  function reconcile(sid) {
    const session = sessions.get(sid)
    if (session === undefined) return undefined
    const st = stateFor(String(session.id))
    if (st.scannedSeq < 0) rebuildFromLog(session, st)
    else rebuild(session, st)
    ensurePatched(session, st)
    if (st.state.pending !== null && st.state.pending.kind === 'undo') {
      let running = false
      try {
        const agent = agents.get(String(session.id))
        running = agent !== undefined && agent.status === 'running'
      } catch {
        running = false
      }
      if (!running) sealPending(session, st)
    }
    return { session, st }
  }

  /** Interrupt the session's running turn; its remaining output belongs to the abandoned tail. */
  function interruptRunning(sid) {
    try {
      const agent = agents.get(sid)
      if (agent !== undefined && agent.status === 'running') {
        agent.cancel({ kind: 'user' }, { keepInbox: true })
        return true
      }
    } catch (error) {
      console.error('[message-edit] interrupt failed:', error)
    }
    return false
  }

  // ---- HTTP API -------------------------------------------------------------

  function readJsonBody(req) {
    return new Promise((resolve) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          req.destroy()
          resolve(undefined)
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          resolve(undefined)
        }
      })
      req.on('error', () => resolve(undefined))
    })
  }

  function writeJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }

  /** Map core validation failures onto HTTP statuses. */
  function reject(res, code) {
    const status = code === 'in-hidden-range' ? 409 : code === 'unknown-session' ? 404 : 400
    writeJson(res, status, { ok: false, error: code })
  }

  function resolveTarget(req, res, body) {
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'POST only' })
      return undefined
    }
    const sid = body && typeof body.sessionId === 'string' ? body.sessionId : ''
    const session = sid.length > 0 ? sessions.get(sid) : undefined
    if (session === undefined) {
      writeJson(res, 404, { ok: false, error: 'unknown-session' })
      return undefined
    }
    const seq = body && typeof body.seq === 'number' ? body.seq : Number.NaN
    const event = session.eventAt(seq)
    const check = checkTarget(stateFor(String(session.id)).state, seq, event)
    if (!check.ok) {
      reject(res, check.code)
      return undefined
    }
    return { session, seq, event }
  }

  async function onMark(req, res) {
    const body = await readJsonBody(req)
    const target = resolveTarget(req, res, body)
    if (target === undefined) return
    const { session, seq } = target
    const st = stateFor(String(session.id))
    rebuild(session, st)
    const preview = body && typeof body.preview === 'string' ? body.preview : ''
    const plan = planMark(st.state, { seq, event: session.eventAt(seq), preview })
    if (!plan.ok) return reject(res, plan.code)
    commitAudits(session, st, plan)
    const markSeq = st.state.pending !== null ? st.state.pending.markSeq : seq
    interruptRunning(String(session.id))
    writeJson(res, 200, { ok: true, targetSeq: seq, markSeq })
  }

  async function onUndo(req, res) {
    const body = await readJsonBody(req)
    const target = resolveTarget(req, res, body)
    if (target === undefined) return
    const { session, seq } = target
    const st = stateFor(String(session.id))
    rebuild(session, st)
    const plan = planUndo(st.state, { seq, event: session.eventAt(seq) })
    if (!plan.ok) return reject(res, plan.code)
    commitAudits(session, st, plan)
    const interrupted = interruptRunning(String(session.id))
    if (!interrupted) sealPending(session, st)
    writeJson(res, 200, { ok: true, targetSeq: seq, sealed: !interrupted })
  }

  async function onCancel(req, res) {
    const body = await readJsonBody(req)
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' })
    const sid = body && typeof body.sessionId === 'string' ? body.sessionId : ''
    const session = sid.length > 0 ? sessions.get(sid) : undefined
    if (session === undefined) return writeJson(res, 404, { ok: false, error: 'unknown-session' })
    const st = stateFor(String(session.id))
    rebuild(session, st)
    const plan = planCancel(st.state)
    if (!plan.ok) return writeJson(res, 200, { ok: true, cancelled: false })
    commitAudits(session, st, plan)
    writeJson(res, 200, { ok: true, cancelled: true })
  }

  function onState(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sid = url.searchParams.get('sessionId') ?? ''
    const found = sid.length > 0 ? reconcile(sid) : undefined
    if (found === undefined) return writeJson(res, 404, { ok: false, error: 'unknown-session' })
    writeJson(res, 200, { ok: true, ...snapshot(found.st.state) })
  }

  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/mark', handler: onMark }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/undo', handler: onUndo }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/cancel', handler: onCancel }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/state', handler: onState }))

  // ---- lifecycle hooks ------------------------------------------------------

  // A newly claimed input message seals any pending range (edit's normal path;
  // undo's fallback when the user types before the agent fully settles).
  ctx.on('agent/pre-step', (payload, next) => {
    try {
      const agent = payload && payload.agent
      if (agent && agent.id !== undefined) {
        const sid = String(agent.id)
        const st = states.get(sid)
        if (st !== undefined && st.state.pending !== null && Array.isArray(payload.messages) && payload.messages.length > 0) {
          const session = sessions.get(sid)
          if (session !== undefined) {
            rebuild(session, st)
            sealPending(session, st)
          }
        }
      }
    } catch (error) {
      console.error('[message-edit] pre-step commit failed:', error)
    }
    return next()
  })

  // When an interrupted turn finishes settling, pending undos seal immediately.
  ctx.on('agent/status', (payload) => {
    try {
      const agent = payload && payload.agent
      if (agent && agent.id !== undefined && payload.status === 'idle') {
        reconcile(String(agent.id))
      }
    } catch (error) {
      console.error('[message-edit] status reconcile failed:', error)
    }
  })

  ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload && payload.agent
      if (agent && agent.id !== undefined) states.delete(String(agent.id))
    } catch {
      /* best-effort cleanup */
    }
  })

  // Unwind every deriveMessages patch with the plugin fiber.
  ctx.effect(() => () => {
    for (const [sid, st] of states) {
      if (!st.patched) continue
      const session = sessions.get(sid)
      if (session !== undefined) {
        try {
          delete session.deriveMessages
        } catch (error) {
          console.error(`[message-edit] failed to unpatch session ${sid}:`, error)
        }
      }
    }
    states.clear()
  })
}
