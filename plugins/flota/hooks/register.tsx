import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Foto, Instancia, Pendiente, Servidores, Sesion } from '../types'

const PANE = 'flota'
const CADA_MS = 30_000
const SERVIDORES_CADA_MS = 5 * 60_000
const CONFIRMAR_MS = 6_000
// Opciones del plugin (userConfig). Sin servidores, el panel solo lista sesiones.
let HOSTS: string[] = []
let SSH: string[] = ['ssh']
const SIN_PENDIENTE: Pendiente = { accion: '', host: '', inst: '', hasta: 0 }

const foto = atom({ plugin: 'flota', key: 'foto' } as const, { sesiones: [], at: 0, error: '' })
const servidores = atom({ plugin: 'flota', key: 'servidores' } as const, { instancias: [], at: 0, error: '' })
const verFuera = atom({ plugin: 'flota', key: 'verFuera' } as const, false)
const verApagadas = atom({ plugin: 'flota', key: 'verApagadas' } as const, false)
const pendiente = atom({ plugin: 'flota', key: 'pendiente' } as const, SIN_PENDIENTE)
const aviso = atom({ plugin: 'flota', key: 'aviso' } as const, '')

// Solo nombres y rutas simples llegan al ssh: nada de comillas ni espacios.
const SEGURO = /^[A-Za-z0-9_./-]+$/

// El comando de ssh es configurable: en Windows suele ser "wsl ssh" (las llaves viven en WSL).
async function claudeRc($: any, host: string, args: string[], timeoutMs = 30_000) {
  if (!HOSTS.includes(host)) throw new Error(`servidor desconocido: ${host}`)
  for (const a of args) if (!SEGURO.test(a)) throw new Error(`argumento no permitido: ${a}`)
  const r = await $.process.run(
    [...SSH, '-o', 'ConnectTimeout=6', '-o', 'BatchMode=yes', host, 'claude-rc', ...args],
    { timeoutMs },
  )
  return { ok: r.exitCode === 0, out: String(r.stdout).trim(), err: String(r.stderr).trim() }
}

async function claudeRcLs($: any, host: string): Promise<Instancia[]> {
  const r = await claudeRc($, host, ['ls'])
  if (!r.ok) throw new Error(`${host}: ${r.err.slice(0, 120)}`)
  const out: Instancia[] = []
  for (const linea of r.out.split('\n').slice(1)) {
    const c = linea.trim().split(/\s+/)
    if (c.length >= 6) out.push({ host, inst: c[0] ?? '', active: c[1] === 'active', dir: c[c.length - 1] ?? '' })
  }
  return out
}

// "120-shop" -> instancia cuyo dir trae "-120-"; si hay varias, la que comparte
// alguna palabra del nombre (120-shop-api vs 120-shop-web).
function instanciaDe(s: Sesion, insts: Instancia[]): Instancia | null {
  if (!s.kind.toLowerCase().includes('remote')) return null
  const num = s.name.match(/^(\d{3,5})/)?.[1]
  if (!num) return null
  const cand = insts.filter(i => i.dir.includes(`-${num}-`))
  const palabras = s.name.toLowerCase().split(/[-_ ]/).slice(1).filter(p => p.length > 2)
  return (
    cand.find(i => i.active && palabras.some(p => (i.inst + i.dir).toLowerCase().includes(p))) ??
    cand.find(i => i.active) ??
    cand[0] ??
    null
  )
}

// La salida de ListAgents trae filas con status libre ("idle", "busy", "offline"...).
function grupo(status: string): 'activa' | 'espera' | 'fuera' {
  const s = status.toLowerCase()
  if (s.includes('offline')) return 'fuera'
  if (s.includes('idle')) return 'espera'
  return 'activa'
}

// Una misma sesion puede aparecer varias veces (instancias viejas offline).
// Se queda la mejor: activa > espera > fuera.
function dedup(lista: Sesion[]): Sesion[] {
  const peso = { activa: 0, espera: 1, fuera: 2 }
  const por = new Map<string, Sesion>()
  for (const s of lista) {
    const prev = por.get(s.name)
    if (!prev || peso[grupo(s.status)] < peso[grupo(prev.status)]) por.set(s.name, s)
  }
  return [...por.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// Los llena session.start; los botones y /flota los usan.
let actualizarTodo: (() => Promise<void>) | null = null
let actualizarServidores: (() => Promise<void>) | null = null

async function avisar($: any, texto: string) {
  await update($, aviso, () => texto)
  $.ui.toast(texto)
}

// Ejecuta una orden de claude-rc y deja el resultado en el panel.
async function ejecutar($: any, accion: string, host: string, args: string[]) {
  await avisar($, `${accion} ${host}/${args[1] ?? args[0]}...`)
  try {
    const r = await claudeRc($, host, args, 120_000)
    const det = (r.ok ? r.out : r.err).split('\n').filter(Boolean).slice(-1)[0] ?? ''
    await avisar($, `${r.ok ? 'OK' : 'FALLO'} ${accion} ${host}/${args[1] ?? ''}: ${det.slice(0, 140)}`)
  } catch (err) {
    await avisar($, `FALLO ${accion}: ${String(err)}`)
  }
  if (actualizarServidores) await actualizarServidores()
}

// Primera pulsacion: arma la accion. Segunda (antes de CONFIRMAR_MS): la ejecuta.
async function pulsar($: any, accion: string, host: string, inst: string) {
  const ahora = await $.clock.now()
  const p: Pendiente = await read($, pendiente)
  if (p.accion === accion && p.host === host && p.inst === inst && ahora < p.hasta) {
    await update($, pendiente, () => SIN_PENDIENTE)
    await ejecutar($, accion, host, [accion === 'levantar' ? 'up' : 'restart', inst])
    return
  }
  await update($, pendiente, () => ({ accion, host, inst, hasta: ahora + CONFIRMAR_MS }))
  $.clock.after(CONFIRMAR_MS, () => {
    void update($, pendiente, q => (q.inst === inst && q.accion === accion ? SIN_PENDIENTE : q))
  })
}

async function copiarUrl($: any, host: string, inst: string, surface: any) {
  try {
    const r = await claudeRc($, host, ['url', inst])
    const url = r.out.match(/https?:\/\/\S+/)?.[0]
    if (!url) return avisar($, `Sin URL para ${host}/${inst}: ${(r.err || r.out).slice(0, 120)}`)
    await $.ui.copy({ text: url, surface })
    await avisar($, `URL de ${inst} copiada`)
  } catch (err) {
    await avisar($, `FALLO url ${inst}: ${String(err)}`)
  }
}

const AYUDA =
  '/flota | /flota nueva <servidor> <inst> <dir> [--name X] | /flota apagar <servidor> <inst>'

export const register: Register = (on, options) => {
  const o = options as { hosts?: string; sshCommand?: string }
  HOSTS = (o.hosts ?? '').split(',').map(h => h.trim()).filter(h => SEGURO.test(h))
  SSH = (o.sshCommand ?? 'ssh').split(/\s+/).filter(Boolean)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'flota', description: 'Panel de sesiones de la flota. ' + AYUDA })

    const refrescar = async () => {
      try {
        const r = await $.tool.call({ tool: 'ListAgents' })
        if ('deny' in r && r.deny) throw new Error('ListAgents rechazado: ' + r.deny)
        type Fila = { name?: string; ref?: string; id?: string; type?: string; status?: string }
        const res = (r.result ?? {}) as { listing?: string; sections?: { kind: string; rows: Fila[] }[] }
        const filas: Sesion[] = []
        for (const sec of res.sections ?? []) {
          for (const row of sec.rows) {
            filas.push({
              name: row.name ?? row.id ?? '?',
              ref: row.ref ?? '',
              kind: row.type ?? sec.kind,
              status: row.status ?? '',
            })
          }
        }
        // ListAgents no se lista a si misma; su nombre viene en la primera linea del texto.
        const yo = (res.listing ?? '').match(/This session is (.+?) \[([0-9a-f]+)\]/)
        if (yo) filas.push({ name: yo[1] ?? '?', ref: yo[2] ?? '', kind: 'interactive', status: 'aqui' })
        // Respaldo: el texto trae filas "nombre [ref]  ·  tipo  ·  estado".
        if (filas.length <= 1) {
          for (const linea of (res.listing ?? '').split('\n')) {
            const m = linea.match(/^\s+(.+?) \[([0-9a-f]+)\]\s+·\s+(.+?)\s+·\s+(\S+)/)
            if (m) filas.push({ name: m[1] ?? '?', ref: m[2] ?? '', kind: m[3] ?? '', status: m[4] ?? '' })
          }
        }
        const at = await $.clock.now()
        await update($, foto, () => ({ sesiones: dedup(filas), at, error: '' }))
      } catch (err) {
        const at = await $.clock.now()
        await update($, foto, f => ({ ...f, at, error: String(err) }))
      }
    }

    actualizarServidores = async () => {
      const instancias: Instancia[] = []
      const errores: string[] = []
      for (const host of HOSTS) {
        try {
          instancias.push(...(await claudeRcLs($, host)))
        } catch (err) {
          errores.push(String(err))
        }
      }
      const at = await $.clock.now()
      await update($, servidores, () => ({ instancias, at, error: errores.join(' | ') }))
    }

    actualizarTodo = async () => {
      await Promise.all([refrescar(), actualizarServidores ? actualizarServidores() : Promise.resolve()])
    }
    void actualizarTodo()
    $.clock.every(CADA_MS, () => void refrescar())
    $.clock.every(SERVIDORES_CADA_MS, () => {
      if (actualizarServidores) void actualizarServidores()
    })

    return next(e)
  })

  on('command.run', { command: 'flota' }, async ($, e) => {
    const p = e.args.trim().split(/\s+/).filter(Boolean)
    // Ordenes escritas por la persona: se ejecutan sin segunda confirmacion.
    if (p[0] === 'nueva') {
      const [, host, inst, dir, ...resto] = p
      if (!host || !inst || !dir) return { text: AYUDA }
      void ejecutar($, 'nueva', host, ['new', inst, dir, ...resto])
      await $.ui.open({ id: PANE, title: 'Flota' })
      return { text: `Creando ${inst} en ${host}; el resultado sale en el panel.` }
    }
    if (p[0] === 'apagar') {
      const [, host, inst] = p
      if (!host || !inst) return { text: AYUDA }
      void ejecutar($, 'apagar', host, ['down', inst])
      await $.ui.open({ id: PANE, title: 'Flota' })
      return { text: `Apagando ${inst} en ${host}; el resultado sale en el panel.` }
    }
    if (p.length > 0) return { text: AYUDA }
    await $.ui.open({ id: PANE, title: 'Flota' })
    if (actualizarTodo) void actualizarTodo()
    return { text: 'Panel de la flota abierto; actualizando sesiones y servidores.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const f: Foto = await read($, foto)
    const sv: Servidores = await read($, servidores)
    const mostrarFuera: boolean = await read($, verFuera)
    const mostrarApagadas: boolean = await read($, verApagadas)
    const p: Pendiente = await read($, pendiente)
    const ultimo: string = await read($, aviso)
    const activas = f.sesiones.filter(s => grupo(s.status) === 'activa')
    const espera = f.sesiones.filter(s => grupo(s.status) === 'espera')
    const fuera = f.sesiones.filter(s => grupo(s.status) === 'fuera')
    const hora = f.at ? new Date(f.at).toTimeString().slice(0, 8) : '--'

    const filas = [...activas, ...espera, ...(mostrarFuera ? fuera : [])]
      .map(s => {
        const g = grupo(s.status)
        const aqui = s.status === 'aqui'
        const remota = s.kind.toLowerCase().includes('remote')
        // Una sesion sin conexion no corre en ningun lado: no se le busca servidor.
        const inst = g === 'fuera' ? null : instanciaDe(s, sv.instancias)
        return {
          estado: aqui ? 'aqui' : g === 'activa' ? 'trabaja' : g === 'espera' ? 'espera' : 'fuera',
          color: aqui ? 'cyan' : g === 'activa' ? 'green' : g === 'espera' ? 'yellow' : 'gray',
          nombre: s.name,
          servidor: inst ? inst.host : g === 'fuera' ? '-' : remota ? 'laptop (?)' : 'laptop',
          inst,
        }
      })
      .sort((a, b) => {
        const orden: Record<string, number> = { aqui: 0, trabaja: 1, espera: 2, fuera: 3 }
        return (orden[a.estado] ?? 3) - (orden[b.estado] ?? 3) || a.servidor.localeCompare(b.servidor) || a.nombre.localeCompare(b.nombre)
      })
    const ancho = Math.min(28, Math.max(6, ...filas.map(r => r.nombre.length))) + 2
    const col = (t: string, n: number) => (t.length > n - 1 ? t.slice(0, n - 2) + '~ ' : t.padEnd(n))

    // Instancias que el servidor dice activas pero que no aparecen como sesion.
    const nombres = f.sesiones.filter(s => grupo(s.status) !== 'fuera').map(s => s.name)
    const huerfanas = sv.instancias.filter(i => {
      if (!i.active) return false
      const num = i.dir.match(/-(\d{3,5})-/)?.[1] ?? ''
      return num !== '' && !nombres.some(n => n.startsWith(num))
    })
    const apagadas = sv.instancias.filter(i => !i.active)

    // Boton con confirmacion: la primera pulsacion cambia la etiqueta.
    const boton = (accion: string, i: Instancia) => {
      const armado = p.accion === accion && p.host === i.host && p.inst === i.inst
      return (
        <Button key={`${accion}:${i.host}:${i.inst}`} onPress={() => void pulsar($, accion, i.host, i.inst)}>
          {armado ? <Text color="red">{`confirmar ${accion} ${i.inst}`}</Text> : accion}
        </Button>
      )
    }
    const botonUrl = (i: Instancia) => (
      <Button key={`url:${i.host}:${i.inst}`} onPress={press => void copiarUrl($, i.host, i.inst, press.surface)}>
        url
      </Button>
    )

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {activas.length} trabajando, {espera.length} en espera, {fuera.length} sin conexion. Actualizado {hora}
        </Text>
        {f.error !== '' && <Text color="red">Error: {f.error}</Text>}
        <Text> </Text>
        <Text bold>{col('ESTADO', 9) + col('SESION', ancho) + col('SERVIDOR', 12) + col('INSTANCIA', 14) + 'ACCIONES'}</Text>
        <Text dimColor>{'-'.repeat(9 + ancho + 12 + 14 + 22)}</Text>
        {filas.map(r => (
          <Box flexDirection="row">
            <Text dimColor={r.estado === 'fuera'}>
              <Text color={r.color}>{col(r.estado, 9)}</Text>
              {col(r.nombre, ancho)}
              <Text dimColor={r.servidor.startsWith('laptop')}>{col(r.servidor, 12)}</Text>
              <Text dimColor>{col(r.inst?.inst ?? '-', 14)}</Text>
            </Text>
            {r.inst && r.inst.active && boton('reiniciar', r.inst)}
            {r.inst && r.inst.active && <Text> </Text>}
            {r.inst && r.inst.active && botonUrl(r.inst)}
          </Box>
        ))}

        {huerfanas.length > 0 && <Text> </Text>}
        {huerfanas.length > 0 && <Text color="red">Activas en servidor pero sin sesion:</Text>}
        {huerfanas.map(i => (
          <Box flexDirection="row">
            <Text color="red">{'  ' + col(i.host, 12) + col(i.inst, 18)}</Text>
            {boton('reiniciar', i)}
          </Box>
        ))}

        {mostrarApagadas && apagadas.length > 0 && <Text> </Text>}
        {mostrarApagadas && apagadas.length > 0 && <Text bold>Instancias apagadas</Text>}
        {mostrarApagadas &&
          apagadas.map(i => (
            <Box flexDirection="row">
              <Text dimColor>{'  ' + col(i.host, 12) + col(i.inst, 18) + col(i.dir.split('/').pop() ?? '', 30)}</Text>
              {boton('levantar', i)}
            </Box>
          ))}

        <Text> </Text>
        <Box flexDirection="row">
          <Button key="ver-fuera" hotkey="o" onPress={() => void update($, verFuera, v => !v)}>
            {(mostrarFuera ? 'ocultar' : 'mostrar') + ` sin conexion (${fuera.length})`}
          </Button>
          <Text> </Text>
          <Button key="ver-apagadas" hotkey="a" onPress={() => void update($, verApagadas, v => !v)}>
            {(mostrarApagadas ? 'ocultar' : 'mostrar') + ` apagadas (${apagadas.length})`}
          </Button>
          <Text> </Text>
          <Button key="actualizar" hotkey="r" onPress={() => { if (actualizarTodo) void actualizarTodo() }}>
            actualizar
          </Button>
        </Box>
        {ultimo !== '' && <Text color={ultimo.startsWith('FALLO') ? 'red' : 'cyan'}>{ultimo}</Text>}
        {sv.error !== '' && <Text color="red">Servidores: {sv.error}</Text>}
        <Text dimColor>{AYUDA}</Text>
      </Box>
    )
  })
}
