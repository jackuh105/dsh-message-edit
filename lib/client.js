// dsh-message-edit — client half (permanent bundle plugin, no build step).
//
// Classic-script bundle contract: executing this file only REGISTERS the
// factory; the web module system materializes it once at mount. Externals
// (react, ui primitives) resolve through the shell's frozen module table.
//
// What the user sees (Gemini-style):
//   - every user / steering message row carries hover actions beside copy:
//     a pencil (edit) and ↺ (undo). Rows with attachments only offer undo.
//   - edit turns the bubble in place into a prefilled textarea with
//     傳送 / Cancel (Esc). The tail stays visible while editing; pressing
//     傳送 marks the target, sends the new text through the conversation
//     service (the composer draft is never touched), and everything from the
//     target onward — the old message included — hides from the chat view and
//     the model. The new message lands at the target's visual position.
//   - undo removes the message itself and everything after it, immediately
//     and without a confirmation dialog; no response is triggered.
//
// Hiding is pure CSS over the chat view's data-chat-flow-key rows, driven by
// the composer-mounted driver component (always present for the active
// session), so cancelling or switching sessions restores the shipped UI.

window.__ModuleLoader__.load({
  id: 'dsh-message-edit',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    // Externals resolve through the shell's frozen module table. The package
    // declares them as `dsh.client.external` edges so their scripts arrive
    // before this factory materializes (rc.1's synchronous require throws on
    // a dependency that has not arrived). A defensive fallback keeps the
    // bundle alive — with degraded visuals — if an external ever drifts, so
    // the whole GUI boot is never blocked by this plugin again.
    var React = require('react')
    var UiPrimitives = null
    var UiAttachment = null
    try { UiPrimitives = require('@deepseek-ai/dsh-client-ui-primitives') } catch (e) {
      console.warn('[message-edit] ui-primitives unavailable, rendering degraded UI:', e && e.message)
    }
    try { UiAttachment = require('@deepseek-ai/dsh-client-ui-attachment') } catch (e) {
      console.warn('[message-edit] ui-attachment unavailable, images render as placeholders:', e && e.message)
    }
    if (UiPrimitives === null) {
      UiPrimitives = {
        MessageText: function (props) { return React.createElement('span', { style: { whiteSpace: 'pre-wrap' } }, props.text) },
        Tooltip: function (props) { return props.children },
        JsonBlock: function () { return null },
        IconCheckOutline16: function () { return null },
        IconCopyOutline16: function () { return null },
        writeClipboard: function (text) {
          if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).then(function () { return true }).catch(function () { return false })
          }
          return Promise.resolve(false)
        },
      }
    }

    var API = '/api/dsh-message-edit'

    // ---------------------------------------------------------------- http --
    function post(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) { return r.json() }).catch(function () { return null })
    }
    function get(path) {
      return fetch(API + path).then(function (r) { return r.json() }).catch(function () { return null })
    }

    // ----------------------------------------------- per-session UI state --
    // { pending: null | { kind, targetSeq, markSeq }, ranges: [{start,end}],
    //   editingSeq: number | null, version }
    // `pending`/`ranges` mirror the host; `editingSeq` is client-only (which
    // row currently has its inline textarea open).
    var states = new Map()
    var listeners = new Set()
    // Shared safe default for pre-fetch renders. useSyncExternalStore requires
    // a stable snapshot reference; one frozen constant satisfies that until
    // the first real write replaces it.
    var EMPTY_STATE = Object.freeze({ pending: null, ranges: [], editingSeq: null, version: 0 })
    function readState(sid) { return states.get(sid) || EMPTY_STATE }
    function writeState(sid, mut) {
      var prev = states.get(sid) || { pending: null, ranges: [], editingSeq: null, version: 0 }
      states.set(sid, {
        pending: mut && 'pending' in mut ? mut.pending : prev.pending,
        ranges: mut && 'ranges' in mut ? mut.ranges : prev.ranges,
        editingSeq: mut && 'editingSeq' in mut ? mut.editingSeq : prev.editingSeq,
        version: prev.version + 1,
      })
      Array.from(listeners).forEach(function (fn) {
        try { fn() } catch (e) { console.error('[message-edit]', e) }
      })
    }
    function subscribe(fn) {
      listeners.add(fn)
      return function () { listeners.delete(fn) }
    }
    function useMessageEdit(sid) {
      return React.useSyncExternalStore(subscribe, function () { return readState(sid) })
    }
    function applyHostState(sid, res) {
      if (!res || res.ok !== true) return
      writeState(sid, {
        pending: res.pending || null,
        ranges: Array.isArray(res.ranges) ? res.ranges : [],
      })
    }

    // -------------------------------------------------------- hide styles --
    var hideTag = null
    var hideSig = ''
    function publishHiddenKeys(keys) {
      var sig = keys.join('|')
      if (sig === hideSig) return
      hideSig = sig
      if (hideTag === null) {
        hideTag = document.createElement('style')
        hideTag.setAttribute('data-dsh-message-edit', 'hide')
        document.head.append(hideTag)
      }
      hideTag.textContent = keys.length === 0 ? '' : keys.map(function (k) {
        return '[data-chat-flow-key="' + String(k).replace(/(["\\])/g, '\\$1') + '"]'
      }).join(',\n') + '{display:none!important}'
    }

    // Anchor seq of the first user/steering node anchored after `boundary`
    // (the mark event's seq) — i.e. the message whose send committed the
    // pending edit. Nodes that existed at mark time anchor before the mark
    // record, so pre-existing later messages are never mistaken for it.
    function firstNewInputAnchor(nodes, order, boundary) {
      for (var i = 0; i < order.length; i++) {
        var n = nodes.get(order[i])
        if (n && (n.kind === 'user' || n.kind === 'steering') && typeof n.anchorSeq === 'number' && n.anchorSeq > boundary) {
          return n.anchorSeq
        }
      }
      return null
    }

    // -------------------------------------------------------------- i18n --
    var zh = (typeof navigator !== 'undefined' ? navigator.language || '' : '').toLowerCase().indexOf('zh') === 0
    var L = zh ? {
      edit: '編輯訊息',
      undo: '移除此訊息及其後內容',
      send: '傳送',
      cancel: '取消',
      cancelEdit: '取消未完成的編輯',
      sendFailed: '送出失敗——可重試或取消。',
      copy: '複製',
      copied: '已複製',
      image: '圖片',
      open: '查看原圖',
      openNamed: function (n) { return '查看 ' + n + ' 原圖' },
      loading: '載入中…',
      loadFailed: '載入失敗，點擊重試',
      dialog: '圖片預覽',
      close: '關閉',
      extra: '附加資料塊',
      truncated: function (total) { return '已截斷（共 ' + total + ' 項）' },
    } : {
      edit: 'Edit message',
      undo: 'Remove this message and everything after',
      send: 'Send',
      cancel: 'Cancel',
      cancelEdit: 'Cancel unfinished edit',
      sendFailed: 'Send failed — retry or cancel.',
      copy: 'Copy',
      copied: 'Copied',
      image: 'image',
      open: 'Open original',
      openNamed: function (n) { return 'Open ' + n },
      loading: 'Loading…',
      loadFailed: 'Load failed — retry',
      dialog: 'Image preview',
      close: 'Close',
      extra: 'Extra content block',
      truncated: function (total) { return 'Truncated (' + total + ' total)' },
    }
    var imageLabels = {
      image: L.image,
      open: L.open,
      openNamed: L.openNamed,
      loading: L.loading,
      loadFailed: L.loadFailed,
      lightbox: { dialog: L.dialog, close: L.close },
    }

    // ------------------------------------------------------------ helpers --
    function contentParts(content) {
      var texts = [], images = [], rest = []
      if (Array.isArray(content)) {
        for (var i = 0; i < content.length; i++) {
          var b = content[i]
          if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
          else if (b && b.type === 'image' && b.attachment !== undefined) images.push({ attachment: b.attachment })
          else rest.push(b)
        }
      }
      return { text: texts.join(''), images: images, rest: rest }
    }
    function pad2(n) { return n < 10 ? '0' + n : String(n) }
    function fmtClock(time) {
      try {
        var d = new Date(time)
        var now = new Date()
        var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes())
        if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm
        return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm
      } catch (e) { return '' }
    }
    function svgIcon(paths) {
      return React.createElement('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, paths)
    }
    var EDIT_ICON = svgIcon([
      React.createElement('path', { key: 'a', d: 'M12 20h9' }),
      React.createElement('path', { key: 'b', d: 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z' }),
    ])
    var UNDO_ICON = svgIcon([
      React.createElement('path', { key: 'arc', d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }),
      React.createElement('path', { key: 'head', d: 'M3 3v5h5' }),
    ])
    var CANCEL_ICON = svgIcon([
      React.createElement('path', { key: 'a', d: 'M18 6 6 18' }),
      React.createElement('path', { key: 'b', d: 'M6 6l12 12' }),
    ])

    // -------------------------------------------- user message node view --
    // Faithful replacement for the shipped user/steering row (bubble + copy +
    // clock), adding the edit and undo actions. Registered with priority -1
    // so this cell shadows the shipped renderer while this plugin is mounted.
    function UserNodeView(props) {
      var node = props.node
      var data = node && node.data ? node.data : { content: [] }
      var parts = contentParts(data.content)
      var sid = props.sessionId
      var st = useMessageEdit(sid) || EMPTY_STATE
      var seq = data.seq
      var editable = parts.images.length === 0 && parts.rest.length === 0
      // A row inside a committed hidden range must not offer actions (the
      // host would reject it anyway); it is invisible regardless.
      var hidden = false
      for (var i = 0; i < st.ranges.length; i++) {
        var r = st.ranges[i]
        if (seq >= r.start && seq <= r.end) { hidden = true; break }
      }
      var editing = st.editingSeq === seq

      var copiedState = React.useState(false)
      var copied = copiedState[0]
      var setCopied = copiedState[1]
      var busyState = React.useState(null) // null | 'mark' | 'undo'
      var busy = busyState[0]
      var setBusy = busyState[1]
      var draftState = React.useState(parts.text)
      var draft = draftState[0]
      var setDraft = draftState[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var areaRef = React.useRef(null)

      React.useEffect(function () {
        if (editing && areaRef.current !== null) {
          var el = areaRef.current
          el.focus()
          try { el.setSelectionRange(el.value.length, el.value.length) } catch (e) { /* older engines */ }
        }
      }, [editing])

      function onCopy() {
        if (copied) return
        UiPrimitives.writeClipboard(parts.text).then(function (ok) {
          if (ok) setCopied(true)
        }).catch(function () { /* clipboard unavailable */ })
      }

      function openEditor() {
        if (!editable) return
        setError('')
        setDraft(parts.text)
        writeState(sid, { editingSeq: seq })
      }
      function closeEditor() {
        writeState(sid, { editingSeq: null })
        setError('')
        setBusy(null)
      }

      function onCancelEdit() {
        // Before a mark exists this is purely local; after a failed send the
        // host may hold the intent, so drop it there too.
        post('/cancel', { sessionId: sid })
        closeEditor()
      }

      function onSend() {
        if (busy !== null) return
        setError('')
        setBusy('mark')
        post('/mark', { sessionId: sid, seq: seq, preview: parts.text.slice(0, 120) }).then(function (res) {
          if (!res || res.ok !== true) {
            setError(res && res.error === 'in-hidden-range' ? L.sendFailed : L.sendFailed)
            setBusy(null)
            return
          }
          writeState(sid, { pending: { kind: 'edit', targetSeq: seq, markSeq: typeof res.markSeq === 'number' ? res.markSeq : seq } })
          setBusy('send')
          var conversation = props.sessions.scope(sid).conversation
          return conversation.send(draft).then(function () {
            closeEditor()
          }).catch(function (sendError) {
            console.error('[message-edit] send failed:', sendError)
            setError(L.sendFailed)
            setBusy(null)
          })
        }).catch(function (markError) {
          console.error('[message-edit] mark failed:', markError)
          setError(L.sendFailed)
          setBusy(null)
        })
      }

      function onUndo() {
        if (busy !== null) return
        setBusy('undo')
        post('/undo', { sessionId: sid, seq: seq }).then(function (res) {
          if (res && res.ok === true) {
            writeState(sid, { pending: { kind: 'undo', targetSeq: seq, markSeq: seq } })
          } else {
            console.error('[message-edit] undo rejected:', res && res.error)
          }
        }).catch(function (e) {
          console.error('[message-edit] undo failed:', e)
        }).then(function () { setBusy(null) })
      }

      function onKeyDown(e) {
        if (e.key === 'Escape') {
          e.stopPropagation()
          if (busy === null) onCancelEdit()
        }
      }

      if (hidden) return null

      // ---- inline edit mode: the bubble becomes a textarea in place ----
      if (editing) {
        return React.createElement('div', { className: 'dme-row', 'data-time-hover-root': true },
          React.createElement('div', { key: 'editor', className: 'dme-editor' },
            React.createElement('textarea', {
              ref: areaRef,
              className: 'dme-editor-area',
              value: draft,
              onChange: function (e) { setDraft(e.target.value) },
              onKeyDown: onKeyDown,
              rows: Math.min(12, Math.max(2, draft.split('\n').length)),
              disabled: busy !== null,
            }),
            error !== ''
              ? React.createElement('div', { className: 'dme-editor-error' }, error)
              : null,
            React.createElement('div', { className: 'dme-editor-actions' },
              React.createElement('button', {
                type: 'button', className: 'dme-editor-send', onClick: onSend, disabled: busy !== null || draft === '',
              }, busy === 'mark' || busy === 'send' ? '…' : L.send),
              React.createElement('button', {
                type: 'button', className: 'dme-editor-cancel', onClick: onCancelEdit, disabled: busy !== null,
              }, L.cancel))))
      }

      // ---- normal mode: native-looking bubble + hover actions ----
      var stackChildren = []
      if (parts.images.length > 0) {
        stackChildren.push(UiAttachment === null
          ? React.createElement('div', { key: 'images', className: 'dme-bubble dme-img-ph' },
              (zh ? '圖片 ' : 'images: ') + parts.images.length)
          : React.createElement(UiAttachment.ImageGallery, {
              key: 'images', images: parts.images, load: props.loadImage, align: 'end', labels: imageLabels,
            }))
      }
      if (parts.text !== '' || parts.rest.length > 0) {
        var bubbleChildren = []
        if (parts.text !== '') {
          bubbleChildren.push(React.createElement(UiPrimitives.MessageText, { key: 'text', text: parts.text }))
        }
        parts.rest.forEach(function (block, i) {
          bubbleChildren.push(React.createElement(UiPrimitives.JsonBlock, {
            key: 'rest-' + i, label: L.extra, payload: block, truncatedLabel: L.truncated,
          }))
        })
        stackChildren.push(React.createElement('div', { key: 'bubble', className: 'dme-bubble' }, bubbleChildren))
      }

      var actionsChildren = []
      if (typeof data.time === 'number') {
        actionsChildren.push(React.createElement('span', { key: 'clock', className: 'dme-clock' }, fmtClock(data.time)))
      }
      actionsChildren.push(React.createElement(UiPrimitives.Tooltip, { key: 'copy', label: copied ? L.copied : L.copy, side: 'bottom' },
        React.createElement('button', {
          type: 'button', className: 'dme-action', 'aria-label': copied ? L.copied : L.copy,
          onClick: onCopy, onMouseLeave: function () { setCopied(false) },
        }, copied
          ? React.createElement(UiPrimitives.IconCheckOutline16, {})
          : React.createElement(UiPrimitives.IconCopyOutline16, {}))))
      if (editable) {
        actionsChildren.push(React.createElement(UiPrimitives.Tooltip, { key: 'edit', label: L.edit, side: 'bottom' },
          React.createElement('button', {
            type: 'button', className: 'dme-action', 'aria-label': L.edit, onClick: openEditor,
          }, EDIT_ICON)))
      }
      actionsChildren.push(React.createElement(UiPrimitives.Tooltip, { key: 'undo', label: L.undo, side: 'bottom' },
        React.createElement('button', {
          type: 'button', className: 'dme-action dme-trigger', 'aria-label': L.undo, onClick: onUndo, disabled: busy !== null,
        }, UNDO_ICON)))

      return React.createElement('div', { className: 'dme-row', 'data-time-hover-root': true },
        React.createElement('div', { key: 'stack', className: 'dme-stack' }, stackChildren),
        React.createElement('div', { key: 'actions', className: 'dme-actions' }, actionsChildren))
    }

    // --------------------------------------------- pending state driver --
    // Mounted in the composer tool row for the active session: owns the host
    // state sync (attach + commit detection + undo seal polling) and
    // publishes the hide rules. Renders nothing unless an edit intent is
    // stranded (its textarea is gone but the host still holds the mark).
    function Driver(props) {
      var sid = props.sessionId
      var st = useMessageEdit(sid) || EMPTY_STATE
      var order = props.useSession(function (s) { return s.chat.order })
      var nodes = props.useSession(function (s) { return s.chat.nodes })
      var pending = st.pending
      var ranges = st.ranges
      var targetSeq = pending ? pending.targetSeq : null
      var boundary = pending && pending.kind === 'edit' ? pending.markSeq : null

      // Attach: rebuild host state (covers page refresh and process restart).
      React.useEffect(function () {
        var live = true
        get('/state?sessionId=' + encodeURIComponent(sid)).then(function (res) {
          if (live) applyHostState(sid, res)
        })
        return function () { live = false }
      }, [sid])

      // Edit commit detection: a user/steering node anchored past the mark
      // boundary means the edited draft was sent and the host sealed the range.
      React.useEffect(function () {
        if (boundary === null) return
        if (firstNewInputAnchor(nodes, order, boundary) === null) return
        get('/state?sessionId=' + encodeURIComponent(sid)).then(function (res) { applyHostState(sid, res) })
      }, [order, boundary, sid])

      // Undo seal polling: the host seals once the interrupted turn settles;
      // poll briefly so the committed range replaces the optimistic pending.
      var undoPollRef = React.useRef(0)
      React.useEffect(function () {
        if (pending === null || pending.kind !== 'undo') return undefined
        var delays = [250, 700, 1500, 3000, 5000]
        var timers = delays.map(function (ms) {
          return setTimeout(function () {
            get('/state?sessionId=' + encodeURIComponent(sid)).then(function (res) { applyHostState(sid, res) })
          }, ms)
        })
        undoPollRef.current += 1
        return function () { timers.forEach(clearTimeout) }
      }, [pending !== null && pending.kind, targetSeq, sid])

      // Any new chat content while a pending exists is also a good moment to
      // resync (covers seal-on-settle appending straggler nodes).
      React.useEffect(function () {
        if (pending === null) return
        get('/state?sessionId=' + encodeURIComponent(sid)).then(function (res) { applyHostState(sid, res) })
      }, [order.length, sid])

      // Publish the hide rules for this session's hidden keys.
      React.useEffect(function () {
        if (pending === null && ranges.length === 0 && st.editingSeq === null) { publishHiddenKeys([]); return }
        var upper = boundary === null ? null : firstNewInputAnchor(nodes, order, boundary)
        var keys = []
        for (var i = 0; i < order.length; i++) {
          var key = order[i]
          var n = nodes.get(key)
          if (!n || typeof n.anchorSeq !== 'number') continue
          var a = n.anchorSeq
          var hide = false
          if (pending !== null && a >= pending.targetSeq && (pending.kind === 'undo' || upper === null || a < upper)) hide = true
          if (!hide) {
            for (var j = 0; j < ranges.length; j++) {
              if (a >= ranges[j].start && a <= ranges[j].end) { hide = true; break }
            }
          }
          if (hide) keys.push(key)
        }
        publishHiddenKeys(keys)
      }, [order, pending, ranges, st.editingSeq, sid])

      // The stranded-edit escape hatch appears only after a grace period, so
      // the normal mark→send→commit window never flashes it (a pending that
      // survives a page refresh shows it right away — its editor is gone).
      var graceState = React.useState(false)
      var graceElapsed = graceState[0]
      var setGraceElapsed = graceState[1]
      React.useEffect(function () {
        setGraceElapsed(false)
        if (pending === null || pending.kind !== 'edit') return undefined
        var timer = setTimeout(function () { setGraceElapsed(true) }, 4000)
        return function () { clearTimeout(timer) }
      }, [pending !== null && pending.kind, targetSeq, boundary, sid])

      function onCancelStranded() {
        post('/cancel', { sessionId: sid }).then(function (res) {
          if (res && res.ok === true) writeState(sid, { pending: null })
        })
      }

      if (pending === null || pending.kind !== 'edit' || st.editingSeq !== null || !graceElapsed) return null
      return React.createElement('button', {
        type: 'button', className: 'dme-stranded', 'aria-label': L.cancelEdit, title: L.cancelEdit, onClick: onCancelStranded,
      }, CANCEL_ICON)
    }

    var BASE_CSS = [
      '.dme-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px;min-width:0}',
      '.dme-stack{display:flex;flex-direction:column;align-items:flex-end;gap:8px;min-width:0;max-width:min(525px,82%)}',
      '.dme-bubble{background:var(--dsw-specific-bubble,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,inherit);border-radius:22px;padding:10px 16px;font-size:16px;line-height:24px;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere}',
      '.dme-bubble p{margin:0}',
      '.dme-img-ph{font-size:13px;color:var(--dsw-alias-label-secondary,inherit)}',
      '.dme-actions{display:flex;align-items:center;gap:2px;height:28px}',
      '.dme-clock{color:var(--dsw-alias-label-tertiary,#98a2b3);white-space:nowrap;padding-right:10px;font-size:14px;line-height:24px;font-variant-numeric:tabular-nums}',
      '.dme-action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary,#98a2b3);cursor:pointer;background:transparent;border:none;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;padding:6px}',
      '.dme-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-secondary,inherit)}',
      '.dme-action:disabled{opacity:.45;cursor:default}',
      '@media(hover:hover){[data-time-hover-root] .dme-clock,[data-time-hover-root] .dme-action{opacity:0;transition:opacity 80ms}[data-time-hover-root]:hover .dme-clock,[data-time-hover-root]:hover .dme-action,[data-time-hover-root]:focus-within .dme-clock,[data-time-hover-root]:focus-within .dme-action{opacity:1}}',
      '@media(hover:hover){[data-time-hover-root] .dme-trigger{opacity:.55}[data-time-hover-root]:hover .dme-trigger{opacity:1}}',
      '.dme-editor{display:flex;flex-direction:column;gap:8px;max-width:min(525px,82%);box-sizing:border-box}',
      '.dme-editor-area{width:100%;box-sizing:border-box;resize:vertical;min-height:52px;background:var(--dsw-specific-bubble,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-active,#7c8cf0);border-radius:16px;padding:10px 16px;font-size:16px;line-height:24px;font-family:inherit;overflow-wrap:anywhere}',
      '.dme-editor-area:focus{outline:none}',
      '.dme-editor-area:disabled{opacity:.6}',
      '.dme-editor-error{color:var(--dsw-alias-state-error-primary,#d44444);font-size:13px;line-height:18px}',
      '.dme-editor-actions{display:flex;justify-content:flex-end;gap:8px}',
      '.dme-editor-send,.dme-editor-cancel{cursor:pointer;border:none;border-radius:14px;padding:6px 14px;font-size:14px;line-height:20px;font-family:inherit}',
      '.dme-editor-send{background:var(--dsw-alias-button-primary-bg,#4f5bd5);color:var(--dsw-alias-button-primary-label,#fff)}',
      '.dme-editor-send:disabled{opacity:.5;cursor:default}',
      '.dme-editor-cancel{background:transparent;color:var(--dsw-alias-label-secondary,inherit)}',
      '.dme-editor-cancel:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}',
      '.dme-editor-cancel:disabled{opacity:.5;cursor:default}',
      '.dme-stranded{width:28px;height:28px;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;background:transparent;border:none;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;padding:6px}',
      '.dme-stranded:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,60,60,.14));color:var(--dsw-alias-state-error-primary,#d44444)}',
    ].join('\n')

    // -------------------------------------------------------------- apply --
    function apply(ctx) {
      var slots = ctx.slots
      var sessions = ctx.sessions
      // Session-scope facade accessor shared with node views (conversation.send).
      var scoped = { sessions: sessions }

      var baseTag = document.createElement('style')
      baseTag.setAttribute('data-dsh-message-edit', 'base')
      baseTag.textContent = BASE_CSS
      document.head.append(baseTag)

      ctx.effect(function () {
        var disposers = [
          slots.inject('conversation.chat.node', function () {
            return [
              slots.register({ name: 'conversation.chat.node', key: 'user', priority: -1 }, function (props) {
                return React.createElement(UserNodeView, Object.assign({}, props, { sessions: scoped }))
              }),
              slots.register({ name: 'conversation.chat.node', key: 'steering', priority: -1 }, function (props) {
                return React.createElement(UserNodeView, Object.assign({}, props, { sessions: scoped }))
              }),
            ]
          }),
          slots.inject('conversation.input.right', function () {
            return slots.register({ name: 'conversation.input.right', id: 'dsh-message-edit-driver', order: 90, label: 'message-edit' }, function (props) {
              return React.createElement(Driver, Object.assign({}, props, { sessions: scoped }))
            })
          }),
        ]
        return function () {
          disposers.forEach(function (d) {
            try { d() } catch (e) { /* stale disposer */ }
          })
        }
      })
      ctx.effect(function () {
        return function () {
          baseTag.remove()
          if (hideTag !== null) hideTag.remove()
        }
      })
    }

    exports.name = 'dsh-message-edit'
    exports.inject = ['slots', 'sessions']
    exports.apply = apply
    return module.exports
  },
})
