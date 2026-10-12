// Wiring smoke test for the dsh-message-edit host half.
// Exercises apply() against fake harness services and a fake Session, then
// drives the HTTP handlers through the full edit / undo lifecycle. Catches
// wiring-level regressions (wrong names, missing routes, broken fold order)
// that pure unit tests cannot see. External behavior only — no internals.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as host from '../lib/index.js'

/** Minimal fake Session mirroring the harness surface this plugin touches. */
class FakeSession {
  constructor(id) {
    this.id = id
    this.events = []
    this.firstLiveSeq = 0
    // 0.2.0 surface: contentGeneration is the deriveMessages cache counter
    // (replaceGeneration only tracks positional replacements).
    this.surface = { nodes: [], replaceGeneration: 1, contentGeneration: 1 }
    this.appendCount = 0
  }

  get seq() {
    return this.events.length
  }

  // 0.2.0: the public log property is gone; readers go through these.
  snapshotEvents() {
    return this.events
  }

  eventAt(seq) {
    return this.events[seq]
  }

  append(type, data) {
    const record = { seq: this.events.length, type, data }
    this.events.push(record)
    this.appendCount += 1
    return record
  }

  addUserMessage(text) {
    const record = this.append('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })
    this.surface.nodes.push(record.seq)
    return record.seq
  }

  addAssistantMessage(text) {
    const record = this.append('assistant/message', { content: [{ type: 'text', text }] })
    this.surface.nodes.push(record.seq)
    return record.seq
  }

  deriveEventMessage(event) {
    if (!event || !Array.isArray(event.data?.content)) return null
    const role = event.type === 'user/message' ? 'user' : 'assistant'
    return { role, content: event.data.content }
  }

  deriveMessages() {
    const out = []
    for (const seq of this.surface.nodes) {
      const message = this.deriveEventMessage(this.events[seq])
      if (message != null) out.push(message)
    }
    return out
  }
}

function makeHarness() {
  const sessionsMap = new Map()
  const agentsMap = new Map()
  const routes = new Map()
  const listeners = new Map()
  const effects = []

  const ctx = {
    webServer: { register(route) { routes.set(route.path, route.handler) } },
    sessions: { get: (sid) => sessionsMap.get(sid) },
    agents: { get: (sid) => agentsMap.get(sid) },
    effect(fn) { effects.push(fn()) },
    on(name, cb) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(cb)
    },
  }

  async function call(routePath, init) {
    const handler = routes.get(routePath)
    if (handler === undefined) throw new Error(`no route: ${routePath}`)
    const chunks = []
    const res = {
      statusCode: 200,
      body: null,
      writeHead(status) { this.statusCode = status },
      end(payload) { this.body = payload ? JSON.parse(payload) : null },
    }
    const req = {
      method: init?.method ?? 'GET',
      url: init?.url ?? routePath,
      on(ev, cb) {
        if (ev === 'data' && init?.body !== undefined) cb(Buffer.from(JSON.stringify(init.body)))
        if (ev === 'end') cb()
      },
    }
    await handler(req, res)
    chunks.push(res.body)
    return { status: res.statusCode, body: res.body }
  }

  function emit(name, payload) {
    for (const cb of listeners.get(name) ?? []) cb(payload, () => {})
  }

  return { ctx, sessionsMap, agentsMap, routes, effects, call, emit }
}

test('host half wires routes and reports empty state for a fresh session', async () => {
  const h = makeHarness()
  assert.equal(typeof host.apply, 'function')
  assert.deepEqual(host.inject, ['webServer', 'sessions', 'agents'])
  h.ctx.apply ??= null
  await host.apply(h.ctx)
  for (const p of ['/api/dsh-message-edit/mark', '/api/dsh-message-edit/undo', '/api/dsh-message-edit/cancel', '/api/dsh-message-edit/state']) {
    assert.ok(h.routes.has(p), `missing route ${p}`)
  }
  const session = new FakeSession('s1')
  h.sessionsMap.set('s1', session)

  const res = await h.call('/api/dsh-message-edit/state', { url: '/api/dsh-message-edit/state?sessionId=s1' })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true, pending: null, ranges: [] })
})

test('undo on an idle session seals immediately and truncates model context', async () => {
  const h = makeHarness()
  await host.apply(h.ctx)
  const session = new FakeSession('s1')
  session.addUserMessage('first')
  session.addAssistantMessage('reply-1')
  session.addUserMessage('second')
  session.addAssistantMessage('reply-2')
  h.sessionsMap.set('s1', session)
  h.agentsMap.set('s1', { id: 's1', status: 'idle', cancel() { throw new Error('should not cancel an idle agent') } })

  const res = await h.call('/api/dsh-message-edit/undo', { method: 'POST', body: { sessionId: 's1', seq: 2 } })
  assert.equal(res.body.ok, true)
  assert.equal(res.body.sealed, true)

  const state = await h.call('/api/dsh-message-edit/state', { url: '/api/dsh-message-edit/state?sessionId=s1' })
  // Sealing covers the current log end, which includes the undo audit record
  // itself (seq 4) — harmless: audit records are never surface nodes, so the
  // model context loses exactly the two conversation messages.
  assert.deepEqual(state.body.ranges, [{ start: 2, end: 4 }])
  assert.equal(state.body.pending, null)

  const visible = session.deriveMessages().map((m) => m.content[0].text)
  assert.deepEqual(visible, ['first', 'reply-1'])

  // The audit log keeps everything: 4 conversation events + undo + commit.
  assert.equal(session.events.length, 6)
})

test('undo while running defers sealing until the agent settles', async () => {
  const h = makeHarness()
  await host.apply(h.ctx)
  const session = new FakeSession('s1')
  session.addUserMessage('q')
  session.addAssistantMessage('partial…')
  h.sessionsMap.set('s1', session)
  let cancelled = 0
  const agent = {
    id: 's1',
    status: 'running',
    // A real cancel resolves asynchronously; the status stays "running" here
    // until the test flips it, simulating the straggler window.
    cancel() { cancelled += 1 },
  }
  h.agentsMap.set('s1', agent)

  const res = await h.call('/api/dsh-message-edit/undo', { method: 'POST', body: { sessionId: 's1', seq: 0 } })
  assert.equal(res.body.sealed, false)
  assert.equal(cancelled, 1)
  // Not sealed yet: straggler window stays open…
  let state = await h.call('/api/dsh-message-edit/state', { url: '/api/dsh-message-edit/state?sessionId=s1' })
  assert.equal(state.body.pending.kind, 'undo')

  // …and closes as soon as the agent reports idle.
  agent.status = 'idle'
  h.emit('agent/status', { agent, status: 'idle' })
  state = await h.call('/api/dsh-message-edit/state', { url: '/api/dsh-message-edit/state?sessionId=s1' })
  assert.equal(state.body.pending, null)
  assert.deepEqual(state.body.ranges, [{ start: 0, end: 2 }])
})

test('edit marks, interrupts, and commits in the pre-step waterfall', async () => {
  const h = makeHarness()
  await host.apply(h.ctx)
  const session = new FakeSession('s1')
  session.addUserMessage('typo versian')
  session.addAssistantMessage('answering the typo')
  session.addUserMessage('follow-up')
  h.sessionsMap.set('s1', session)
  let cancelled = 0
  h.agentsMap.set('s1', { id: 's1', status: 'idle', cancel() { cancelled += 1 } })

  const marked = await h.call('/api/dsh-message-edit/mark', { method: 'POST', body: { sessionId: 's1', seq: 0, preview: 'typo versian' } })
  assert.equal(marked.body.ok, true)
  assert.equal(marked.body.targetSeq, 0)

  // Pending edit survives until an input message is claimed.
  let state = await h.call('/api/dsh-message-edit/state', { url: '/api/dsh-message-edit/state?sessionId=s1' })
  assert.equal(state.body.pending.kind, 'edit')

  // The next turn claims the edited message: pre-step seals BEFORE it appends.
  h.emit('agent/pre-step', { agent: { id: 's1' }, messages: [{ role: 'user' }] }, () => {})
  state = await h.call('/api/dsh-message-edit/state', { url: '/api/dsh-message-edit/state?sessionId=s1' })
  assert.equal(state.body.pending, null)
  assert.deepEqual(state.body.ranges, [{ start: 0, end: 3 }])

  // The edited message lands after the sealed range and stays visible.
  session.addUserMessage('typo version')
  const visible = session.deriveMessages().map((m) => m.content[0].text)
  assert.deepEqual(visible, ['typo version'])
})

test('targets inside hidden ranges and non-user messages are rejected', async () => {
  const h = makeHarness()
  await host.apply(h.ctx)
  const session = new FakeSession('s1')
  session.addUserMessage('keep')
  session.addAssistantMessage('kept reply')
  session.addUserMessage('doomed')
  h.sessionsMap.set('s1', session)
  h.agentsMap.set('s1', { id: 's1', status: 'idle', cancel() {} })

  const undo = await h.call('/api/dsh-message-edit/undo', { method: 'POST', body: { sessionId: 's1', seq: 2 } })
  assert.equal(undo.body.ok, true)

  const buried = await h.call('/api/dsh-message-edit/undo', { method: 'POST', body: { sessionId: 's1', seq: 2 } })
  assert.equal(buried.status, 409)
  const buriedMark = await h.call('/api/dsh-message-edit/mark', { method: 'POST', body: { sessionId: 's1', seq: 2 } })
  assert.equal(buriedMark.status, 409)

  const assistantTarget = await h.call('/api/dsh-message-edit/undo', { method: 'POST', body: { sessionId: 's1', seq: 1 } })
  assert.equal(assistantTarget.status, 400)

  const unknown = await h.call('/api/dsh-message-edit/undo', { method: 'POST', body: { sessionId: 'nope', seq: 0 } })
  assert.equal(unknown.status, 404)
})

test('a pending undo recorded before shutdown re-seals after restart replay', async () => {
  const h = makeHarness()
  await host.apply(h.ctx)
  const session = new FakeSession('s1')
  session.addUserMessage('one')
  session.addAssistantMessage('r1')
  session.addUserMessage('two')
  h.sessionsMap.set('s1', session)
  h.agentsMap.set('s1', { id: 's1', status: 'running', cancel() { this.status = 'idle' } })

  await h.call('/api/dsh-message-edit/undo', { method: 'POST', body: { sessionId: 's1', seq: 2 } })
  // Process "restart": fresh plugin state, same durable log, agent now idle.
  // A real boot sets firstLiveSeq to the log length at startup.
  session.firstLiveSeq = session.events.length
  const h2 = makeHarness()
  await host.apply(h2.ctx)
  h2.sessionsMap.set('s1', session)
  h2.agentsMap.set('s1', { id: 's1', status: 'idle', cancel() {} })

  const state = await h2.call('/api/dsh-message-edit/state', { url: '/api/dsh-message-edit/state?sessionId=s1' })
  assert.equal(state.body.pending, null)
  assert.deepEqual(state.body.ranges, [{ start: 2, end: 3 }])
})

test('a pending edit from a dead page is discarded on restart replay', async () => {
  const h = makeHarness()
  await host.apply(h.ctx)
  const session = new FakeSession('s1')
  session.addUserMessage('hello')
  h.sessionsMap.set('s1', session)
  h.agentsMap.set('s1', { id: 's1', status: 'idle', cancel() {} })

  await h.call('/api/dsh-message-edit/mark', { method: 'POST', body: { sessionId: 's1', seq: 0, preview: 'hello' } })

  // Process "restart": the mark predates the new boot, so its intent is stale.
  session.firstLiveSeq = session.events.length
  const h2 = makeHarness()
  await host.apply(h2.ctx)
  h2.sessionsMap.set('s1', session)
  h2.agentsMap.set('s1', { id: 's1', status: 'idle', cancel() {} })

  const state = await h2.call('/api/dsh-message-edit/state', { url: '/api/dsh-message-edit/state?sessionId=s1' })
  assert.equal(state.body.pending, null)
  assert.deepEqual(state.body.ranges, [])
})

test('unloading the plugin restores the original deriveMessages', async () => {
  const h = makeHarness()
  await host.apply(h.ctx)
  const session = new FakeSession('s1')
  session.addUserMessage('one')
  h.sessionsMap.set('s1', session)
  h.agentsMap.set('s1', { id: 's1', status: 'idle', cancel() {} })

  await h.call('/api/dsh-message-edit/undo', { method: 'POST', body: { sessionId: 's1', seq: 0 } })
  const patched = session.deriveMessages
  assert.notEqual(patched, FakeSession.prototype.deriveMessages)

  for (const disposer of h.effects) {
    if (typeof disposer === 'function') disposer()
  }
  assert.equal(session.deriveMessages, FakeSession.prototype.deriveMessages)
})
