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
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'

import { TitlebarIcon } from './titlebar-fix.jsx'

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

const WORKSPACE_KEY = `${ID}:screen`
const WORKSPACE_PANE_ID = `plugin-workspace:${WORKSPACE_KEY}`

// One JSON line per event in ~/.hermes/vps-browser.log on the backend, so a click that
// does nothing on the user's screen can be diagnosed from the server.
function breadcrumb(event, detail = {}) {
  try {
    const line = JSON.stringify({ t: new Date().toISOString(), event, ...detail }) + '\n'
    const b64 = btoa(unescape(encodeURIComponent(line)))
    void host.request('shell.exec', { command: `echo ${b64} | base64 -d >> "$HOME/.hermes/vps-browser.log"` }).catch(() => {})
  } catch {
    // diagnostics only
  }
}

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
        {api?.useMac ? (
          <Button onClick={() => api.useMac()} size="xs" title="Switch to the browser on this laptop" variant="ghost">
            <Codicon name="device-desktop" size="0.8125rem" /> Mac
          </Button>
        ) : null}
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

// ------------------------------------------------------------------ browser switcher
// The globe opens a small menu: VPS browser (this plugin's screen) or Mac browser (the
// app's own in-app browser on this laptop, opened through ctx.runAction('view.showBrowser')).
let api = null
let menu = { open: false, top: 0, right: 0 }
const menuSubs = new Set()
const setMenu = next => {
  menu = { ...menu, ...next }
  menuSubs.forEach(fn => fn())
}
const useMenu = () =>
  useSyncExternalStore(
    fn => {
      menuSubs.add(fn)
      return () => menuSubs.delete(fn)
    },
    () => menu
  )

function macBrowserView() {
  for (const el of document.querySelectorAll('webview[partition="persist:hermes-preview"]')) {
    const r = el.getBoundingClientRect()
    const shown = typeof el.checkVisibility === 'function' ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : true
    if (r.width > 0 && r.height > 0 && shown) return el
  }
  return null
}

const MENU_ITEM = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '7px 10px',
  borderRadius: 8,
  cursor: 'pointer',
  textAlign: 'left',
  color: 'var(--ui-text-primary, var(--foreground))'
}

function MenuItem({ icon, title, sub, checked, onPick }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onClick={e => {
        e.stopPropagation()
        e.preventDefault()
        onPick()
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role="menuitem"
      style={{ ...MENU_ITEM, background: hover ? 'var(--ui-row-hover-background, rgb(127 127 127 / 0.12))' : 'transparent' }}
    >
      <Codicon name={icon} size="0.95rem" style={{ flexShrink: 0, opacity: 0.85 }} />
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: 13, lineHeight: '17px' }}>{title}</span>
        {sub ? <span style={{ fontSize: 11.5, lineHeight: '15px', color: 'var(--ui-text-tertiary)' }}>{sub}</span> : null}
      </span>
      {checked ? <Codicon name="check" size="0.85rem" style={{ flexShrink: 0, color: 'var(--ui-accent)' }} /> : null}
    </div>
  )
}

function BrowserMenu() {
  const state = useMenu()
  const ref = useRef(null)
  useEffect(() => {
    if (!state.open) return
    const away = e => {
      if (ref.current?.contains(e.target) || ref.current?.parentElement?.closest('button')?.contains(e.target)) return
      setMenu({ open: false })
    }
    const esc = e => e.key === 'Escape' && setMenu({ open: false })
    const blur = () => setMenu({ open: false })
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', esc, true)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', esc, true)
      window.removeEventListener('blur', blur)
    }
  }, [state.open])
  // If the menu cannot actually be seen or clicked here, fall back to plain toggling.
  useLayoutEffect(() => {
    if (!state.open || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 12)
    if (!r.width || !r.height || !ref.current.contains(hit)) {
      breadcrumb('menu-fallback', { w: r.width, h: r.height, hit: hit?.tagName })
      setMenu({ open: false })
      api?.toggleVps()
    }
  }, [state.open])
  if (!state.open || !api) return null
  const vps = api.vpsOpen()
  const mac = Boolean(macBrowserView())
  const pick = fn => () => {
    setMenu({ open: false })
    fn()
  }
  return (
    <div
      onClick={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      ref={ref}
      role="menu"
      style={{
        position: 'fixed',
        top: state.top,
        right: state.right,
        width: 248,
        padding: 4,
        zIndex: 1000,
        borderRadius: 12,
        border: '1px solid var(--ui-stroke-secondary, var(--border))',
        background: 'var(--ui-bg-elevated, #2b2b2b)',
        boxShadow: '0 10px 30px -8px rgb(0 0 0 / 0.45)',
        WebkitAppRegion: 'no-drag',
        cursor: 'default',
        fontWeight: 400,
        whiteSpace: 'normal'
      }}
    >
      <MenuItem checked={vps} icon="cloud" onPick={pick(api.useVps)} sub="Runs on the VPS, works with the laptop closed" title="VPS browser" />
      <MenuItem checked={mac} icon="device-desktop" onPick={pick(api.useMac)} sub="This laptop, needs Hermes open" title="Mac browser" />
      {vps || mac ? (
        <>
          <div style={{ height: 1, margin: '4px 6px', background: 'var(--ui-stroke-tertiary, var(--border))' }} />
          <MenuItem icon="close" onPick={pick(api.closeAll)} title="Close browser" />
        </>
      ) : null}
    </div>
  )
}

function GlobeIcon() {
  return (
    <TitlebarIcon onReport={reportTitlebar}>
      <Codicon className="leading-none" name="globe" size="13.9px" />
      <BrowserMenu />
    </TitlebarIcon>
  )
}

let titlebarReported = false
function reportTitlebar(info) {
  if (titlebarReported) return
  titlebarReported = true
  breadcrumb('titlebar', info)
}

export default {
  id: ID,
  name: 'VPS Browser',
  description: 'Globe button in the title bar that shows the VPS browser in the right sidebar.',
  register(ctx) {
    // Main-area tile docked to the right of the chat, opened through the same door the
    // built-in Bots → Screen uses (host.openWorkspace). A plain plugin pane never got
    // adopted into the layout on Hermes Desktop 0.22, so the button did nothing.
    let closeTile = null
    const usesWorkspace = typeof host.openWorkspace === 'function'
    const tileId = usesWorkspace ? WORKSPACE_PANE_ID : PANE_ID

    const isVisible = () => {
      try {
        return Boolean(host.paneVisibility?.(tileId)?.get())
      } catch {
        return false
      }
    }

    const open = () => {
      if (usesWorkspace) {
        closeTile = host.openWorkspace(WORKSPACE_KEY, {
          title: 'VPS browser',
          minWidth: '26rem',
          dock: { pane: 'workspace', pos: 'right' },
          render: () => <ScreenPane />,
          onClose: () => {
            closeTile = null
          }
        })
      } else {
        const dispose = ctx.register({
          id: PANE,
          area: PANES_AREA,
          title: 'VPS browser',
          render: () => <ScreenPane />,
          data: { placement: 'right', width: '720px' }
        })
        closeTile = () => {
          dispose()
          closeTile = null
        }
        host.undismissPane?.(PANE_ID)
        setTimeout(() => host.revealPane?.(PANE_ID), 0)
      }
    }

    const toggle = () => {
      try {
        if (closeTile && isVisible()) {
          closeTile()
          closeTile = null
        } else if (closeTile) {
          host.revealPane?.(tileId)
        } else {
          open()
        }
        breadcrumb('toggle', { usesWorkspace, open: Boolean(closeTile), visible: isVisible() })
      } catch (err) {
        breadcrumb('toggle-error', { message: errorText(err) })
        host.notify?.({ kind: 'error', message: `VPS browser: ${errorText(err)}` })
      }
    }

    const runMac = () => {
      const res = typeof ctx.runAction === 'function' ? ctx.runAction('view.showBrowser') : null
      if (!res || res.ok === false) host.notify?.({ kind: 'info', message: 'Press ⌘⇧L to open the Mac browser' })
      return res
    }

    const closeVps = () => {
      if (closeTile) {
        closeTile()
        closeTile = null
      }
    }

    const showVps = () => {
      if (closeTile) host.revealPane?.(tileId)
      else open()
    }

    api = {
      vpsOpen: () => Boolean(closeTile && isVisible()),
      toggleVps: toggle,
      useVps: () => {
        try {
          if (macBrowserView()) runMac()
          showVps()
          breadcrumb('switch', { to: 'vps' })
        } catch (err) {
          host.notify?.({ kind: 'error', message: `VPS browser: ${errorText(err)}` })
        }
      },
      useMac: () => {
        try {
          closeVps()
          if (!macBrowserView()) runMac()
          breadcrumb('switch', { to: 'mac' })
        } catch (err) {
          host.notify?.({ kind: 'error', message: `Mac browser: ${errorText(err)}` })
        }
      },
      closeAll: () => {
        closeVps()
        if (macBrowserView()) runMac()
        breadcrumb('switch', { to: 'none' })
      }
    }

    const openMenu = event => {
      const button = event?.currentTarget || document.querySelector('button[aria-label="Browser"]')
      const r = button?.getBoundingClientRect?.()
      if (!r) return toggle()
      if (menu.open) return setMenu({ open: false })
      setMenu({ open: true, top: Math.round(r.bottom + 6), right: Math.max(8, Math.round(window.innerWidth - r.right)) })
      breadcrumb('menu', { vps: api.vpsOpen(), mac: Boolean(macBrowserView()) })
    }

    ctx.onDispose?.(() => {
      closeTile?.()
      setMenu({ open: false })
      api = null
    })
    breadcrumb('loaded', { usesWorkspace, runAction: typeof ctx.runAction === 'function' })

    ctx.register({
      id: 'titlebar',
      area: 'titleBar.tools.right',
      data: {
        id: 'vps-browser',
        label: 'Browser',
        icon: <GlobeIcon />,
        onSelect: openMenu
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

    ctx.register({
      id: 'palette-mac',
      area: PALETTE_AREA,
      data: {
        id: 'vps-browser.mac',
        label: 'Switch to Mac browser',
        keywords: ['browser', 'mac', 'local', 'laptop'],
        run: () => api?.useMac()
      }
    })

    ctx.register({
      id: 'palette-vps',
      area: PALETTE_AREA,
      data: {
        id: 'vps-browser.vps',
        label: 'Switch to VPS browser',
        keywords: ['browser', 'vps', 'server'],
        run: () => api?.useVps()
      }
    })
  }
}
