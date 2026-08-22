// Factory-contract smoke test for the dsh-message-edit client half.
// The web bundle is a classic script registering a factory on
// window.__ModuleLoader__; this test executes it in Node with stubbed
// externals and verifies the registration contract and the apply() wiring:
//   - factory registers under the package id
//   - exports expose name / inject / apply
//   - apply() contributes the chat-node shadow renderers and the composer
//     driver through the slots service, and cleans up on dispose
// Component rendering itself stays covered by manual acceptance (needs a
// real browser + harness UI).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runInContext as runInVmContext, createContext as createVmContext } from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))

function loadClientBundle() {
  const source = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')
  const registered = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) { registered.push(definition) },
      },
    },
    document: {
      head: { append() {} },
      createElement() {
        return { setAttribute() {}, append() {}, remove() {}, textContent: '' }
      },
    },
    navigator: { language: 'zh-TW' },
    fetch() { return Promise.resolve({ json: () => Promise.resolve({ ok: true }) }) },
    setTimeout,
    clearTimeout,
    console,
  }
  sandbox.globalThis = sandbox
  const context = createVmContext(sandbox)
  runInVmContext(source, context, { filename: 'lib/client.js' })
  return { registered, sandbox }
}

/** Minimal externals table mirroring the shell's frozen module names. */
function makeRequire() {
  const element = (type, props) => ({ type, props })
  const react = Object.assign(() => { throw new Error('react callable not expected') }, {
    createElement: element,
    useSyncExternalStore: () => undefined,
    useState: (v) => [v, () => {}],
    useEffect: () => undefined,
    useRef: () => ({ current: null }),
  })
  const primitives = new Proxy({}, {
    get(_target, key) {
      if (key === 'writeClipboard') return () => Promise.resolve(true)
      return element
    },
  })
  const attachment = new Proxy({}, { get: () => element })
  return (name) => {
    if (name === 'react') return react
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    if (name === '@deepseek-ai/dsh-client-ui-attachment') return attachment
    throw new Error(`unexpected external: ${name}`)
  }
}

test('client bundle registers its factory under the package id', () => {
  const { registered } = loadClientBundle()
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'dsh-message-edit')
  assert.equal(typeof registered[0].factory, 'function')
})

test('factory exports name, inject list, and an apply function', () => {
  const { registered } = loadClientBundle()
  const exports = registered[0].factory(makeRequire())
  assert.equal(exports.name, 'dsh-message-edit')
  assert.deepEqual([...exports.inject], ['slots', 'sessions'])
  assert.equal(typeof exports.apply, 'function')
})

test('factory survives a missing optional external with a degraded shim', () => {
  const { registered } = loadClientBundle()
  const brokenRequire = makeRequire()
  const exports = registered[0].factory((name) => {
    if (name === '@deepseek-ai/dsh-client-ui-attachment') {
      throw new Error('client-modules: require missed the module table (simulated drift)')
    }
    return brokenRequire(name)
  })
  assert.equal(exports.name, 'dsh-message-edit')
  assert.equal(typeof exports.apply, 'function')
})

test('apply() shadows user/steering nodes and mounts the composer driver', () => {
  const { registered } = loadClientBundle()
  const exports = registered[0].factory(makeRequire())

  const injected = []
  const registeredSlots = []
  const disposers = []
  const ctx = {
    sessions: { scope: () => { throw new Error('not called during apply') } },
    slots: {
      inject(name, contribute) {
        injected.push(name)
        const disposer = contribute()
        if (typeof disposer === 'function') disposers.push(disposer)
      },
      register(spec, renderer) {
        registeredSlots.push({ spec, renderer })
        return { spec, renderer }
      },
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
  }

  exports.apply(ctx)

  assert.ok(injected.includes('conversation.chat.node'), 'chat node slot not injected')
  assert.ok(injected.includes('conversation.input.right'), 'composer driver slot not injected')
  const keys = registeredSlots.map((s) => s.spec.key ?? s.spec.id)
  assert.deepEqual(
    keys.filter((k) => k === 'user' || k === 'steering').sort(),
    ['steering', 'user'],
  )
  assert.ok(registeredSlots.some((s) => s.spec.priority === -1), 'shadow priority missing')
  assert.ok(registeredSlots.some((s) => s.spec.id === 'dsh-message-edit-driver'), 'driver not registered')

  // Disposers run clean (slot unregistration + style tag removal).
  for (const disposer of disposers) disposer()
})
