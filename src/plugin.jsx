/**
 * VPS Browser: a globe button in the title bar that opens the backend's own screen
 * (Hermes Bot Screen: Xfce + Chromium on the gateway host) in the right sidebar.
 *
 * Hermes browses on that screen with its browser tools (browser.headed: true), so the
 * pane shows it live. Take over gives you the mouse and keyboard; Hand back returns it.
 * The stream is the gateway's own display bridge (display.* RPCs + /api/display/ws),
 * the same one the built-in Bots → Screen pane uses, so leases and takeovers agree.
 *
 * Built from src/plugin.jsx with esbuild; noVNC is bundled in.
 */
import RFB from '@novnc/novnc'
import { Button, Codicon, GlyphSpinner, host, PALETTE_AREA, PANES_AREA, resolveSiblingWsUrl } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useRef, useState } from 'react'

const ID = 'vps-browser'
const PANE = 'screen'
const PANE_ID = `${ID}:${PANE}`
const CLOSE_CONTROL_TAKEN = 4000
const MAX_PASTE = 256 * 1024

const profileName = () => {
  try {
    return host.state?.profile?.get?.() || 'default'
  } catch {
    return 'default'
  }
}

const request = (method, params = {}) => host.request(method, { ...params, profile: profileName() })

async function viewerHash(id) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
}

async function screenWsUrl(ticket) {
  const connectionId = typeof host.activeConnectionId === 'function' ? host.activeConnectionId() : null
  const url = new URL(
    await resolveSiblingWsUrl({ connectionId, profile: profileName() }, '/api/display/ws', {
      stripGatewayCredential: true
    })
  )
  url.searchParams.set('display_ticket', ticket)
  return url.toString()
}

const errorText = err => (err instanceof Error ? err.message : String(err?.message ?? err))

function ScreenPane() {
  const [status, setStatus] = useState(null)
  const [lease, setLease] = useState(null)
  const [viewer, setViewer] = useState(null)
  const [conn, setConn] = useState('idle')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const canvasHost = useRef(null)
  const rfb = useRef(null)
  const socket = useRef(null)
  const generation = useRef(0)
  const viewerRef = useRef(null)
  const profileKey = useRef(null)
  const startTried = useRef(false)

  const iHold = Boolean(lease && viewer && lease.holder === 'human' && lease.viewer_hash === viewer.hash)
  const humanElsewhere = Boolean(lease && lease.holder === 'human' && !iHold)

  const applyStatus = useCallback(next => {
    if (!next) return
    setStatus(next)
    profileKey.current = next.profile_key ?? profileKey.current
    if (next.lease) setLease(next.lease)
  }, [])

  const refresh = useCallback(async () => {
    try {
      applyStatus(await request('display.status'))
      setError(null)
    } catch (err) {
      setError(errorText(err))
    }
  }, [applyStatus])

  const detach = useCallback((handBack = false) => {
    generation.current += 1
    if (handBack) socket.current?.close(1000)
    rfb.current?.disconnect()
    rfb.current = null
    socket.current?.close()
    socket.current = null
  }, [])

  const attach = useCallback(async () => {
    if (!canvasHost.current) return
    detach()
    const gen = generation.current
    setConn('attaching')
    setError(null)
    try {
      const prior = viewerRef.current?.id
      const observe = await request('display.observe', prior ? { viewer_id: prior } : {})
      const minted = { id: observe.viewer_id, hash: await viewerHash(observe.viewer_id) }
      applyStatus(observe)
      const url = await screenWsUrl(observe.ticket)
      if (gen !== generation.current || !canvasHost.current) return
      viewerRef.current = minted
      setViewer(minted)
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      socket.current = ws
      let closeCode = 0
      ws.addEventListener('close', event => {
        closeCode = event.code
      })
      const client = new RFB(canvasHost.current, ws, { shared: true })
      client.scaleViewport = true
      client.resizeSession = false
      client.focusOnClick = true
      client.background = 'transparent'
      client.qualityLevel = 7
      const held = observe.lease
      client.viewOnly = !(held && held.holder === 'human' && held.viewer_hash === minted.hash)
      client.addEventListener('connect', () => {
        if (gen === generation.current) setConn('live')
      })
      client.addEventListener('disconnect', event => {
        if (rfb.current === client) rfb.current = null
        if (gen !== generation.current) return
        const reason = event.detail?.reason ?? ''
        if (closeCode === CLOSE_CONTROL_TAKEN || reason.includes('control-taken')) setConn('idle')
        else if (event.detail?.clean) setConn('idle')
        else {
          setConn('error')
          setError(reason || 'The connection to the VPS screen dropped.')
        }
        void refresh()
      })
      rfb.current = client
      const target = canvasHost.current
      const onPaste = event => {
        if (client.viewOnly) return
        const text = event.clipboardData?.getData('text')
        if (text && text.length <= MAX_PASTE) {
          event.preventDefault()
          client.clipboardPasteFrom(text)
        }
      }
      target.addEventListener('paste', onPaste)
      client.addEventListener('disconnect', () => target.removeEventListener('paste', onPaste))
    } catch (err) {
      if (gen === generation.current) {
        setConn('error')
        setError(errorText(err))
      }
    }
  }, [applyStatus, detach, refresh])

  const start = useCallback(async () => {
    setBusy(true)
    try {
      applyStatus(await request('display.start'))
      setConn('idle')
      setError(null)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [applyStatus])

  useEffect(() => {
    void refresh()
    const forMe = event => {
      const key = event?.payload?.profile_key
      return !key || !profileKey.current || key === profileKey.current
    }
    const offLease = host.onEvent('display.lease', event => {
      if (forMe(event) && event.payload?.lease) setLease(event.payload.lease)
    })
    const offStatus = host.onEvent('display.status', event => {
      if (forMe(event) && event.payload) applyStatus(event.payload)
    })
    return () => {
      offLease?.()
      offStatus?.()
    }
  }, [applyStatus, refresh])

  useEffect(() => () => detach(true), [detach])

  // Opening the pane is the ask: bring the screen up if it is installed but stopped.
  useEffect(() => {
    if (status && status.installed && !status.running && !startTried.current) {
      startTried.current = true
      void start()
    }
  }, [start, status])

  useEffect(() => {
    if (status?.running && conn === 'idle') void attach()
  }, [attach, conn, status?.running])

  useEffect(() => {
    if (rfb.current) {
      rfb.current.viewOnly = !iHold
      if (iHold) rfb.current.focus()
    }
  }, [iHold])

  const takeOver = useCallback(async () => {
    if (!viewerRef.current) return
    setBusy(true)
    try {
      const result = await request('display.lease.acquire', { viewer_id: viewerRef.current.id })
      setLease(result.lease)
      if (conn !== 'live') void attach()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [attach, conn])

  const handBack = useCallback(async (force = false) => {
    setBusy(true)
    try {
      const result = await request('display.lease.release', force ? { force: true } : { viewer_id: viewerRef.current?.id })
      setLease(result.lease)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [])

  let note = 'Connecting…'
  if (status && !status.supported) note = 'This backend has no screen (it only runs on a Linux server).'
  else if (status && !status.installed) note = `The screen is not installed on the VPS. Missing: ${(status.missing || []).join(', ')}`
  else if (status && !status.running) note = busy ? 'Starting the VPS screen…' : 'The VPS screen is off.'
  else if (conn === 'live') note = iHold ? 'You are in control' : humanElsewhere ? 'Someone else is in control' : 'Hermes is in control'
  else if (conn === 'error') note = error || 'Not connected'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.375rem 0.625rem',
          borderBottom: '1px solid var(--ui-stroke-tertiary)',
          fontSize: '0.75rem',
          color: 'var(--ui-text-secondary)',
          flexShrink: 0
        }}
      >
        {conn === 'attaching' || busy ? <GlyphSpinner /> : <Codicon name={iHold ? 'person' : 'globe'} size="0.875rem" />}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: iHold ? 'var(--ui-red)' : undefined }}>
          {note}
        </span>
        {status?.running && conn === 'live' && !iHold && (
          <Button disabled={busy || !viewer} onClick={() => void takeOver()} size="xs" variant="outline">
            Take over
          </Button>
        )}
        {iHold && (
          <Button disabled={busy} onClick={() => void handBack()} size="xs" variant="outline">
            Hand back
          </Button>
        )}
        {humanElsewhere && (
          <Button disabled={busy} onClick={() => void handBack(true)} size="xs" variant="ghost">
            Hand back (force)
          </Button>
        )}
        {status && status.installed && !status.running && !busy && (
          <Button onClick={() => void start()} size="xs" variant="outline">
            Start
          </Button>
        )}
        {conn === 'error' && status?.running && (
          <Button onClick={() => void attach()} size="xs" variant="ghost">
            Reconnect
          </Button>
        )}
      </div>
      <div
        ref={canvasHost}
        style={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          overflow: 'hidden',
          outline: iHold ? '2px solid var(--ui-red)' : 'none',
          outlineOffset: '-2px'
        }}
      />
    </div>
  )
}

export default {
  id: ID,
  name: 'VPS Browser',
  description: 'Globe button in the title bar that shows the VPS browser in the right sidebar.',
  register(ctx) {
    let disposePane = null

    const openPane = () => {
      if (!disposePane) {
        disposePane = ctx.register({
          id: PANE,
          area: PANES_AREA,
          title: 'VPS browser',
          render: () => <ScreenPane />,
          data: { placement: 'right', width: '720px' }
        })
      }
      host.undismissPane?.(PANE_ID)
      setTimeout(() => host.revealPane?.(PANE_ID), 0)
    }

    const closePane = () => {
      disposePane?.()
      disposePane = null
    }

    const toggle = () => {
      let visible = false
      try {
        visible = Boolean(disposePane && host.paneVisibility?.(PANE_ID)?.get())
      } catch {
        visible = false
      }
      if (visible) closePane()
      else openPane()
    }

    ctx.register({
      id: 'titlebar',
      area: 'titleBar.tools.right',
      data: {
        id: 'vps-browser',
        label: 'VPS browser',
        icon: <Codicon className="leading-none" name="globe" size="13.9px" />,
        onSelect: toggle
      }
    })

    ctx.register({
      id: 'palette',
      area: PALETTE_AREA,
      data: {
        id: 'vps-browser.toggle',
        label: 'Toggle VPS browser',
        keywords: ['browser', 'vps', 'screen', 'web', 'internet'],
        run: toggle
      }
    })
  }
}
