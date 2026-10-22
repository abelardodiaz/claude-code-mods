import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Foto, Instancia, Pendiente, Registro, Servidores, Sesion } from '../types'
import { ultimosRemotos } from './actividad'
import type { Ultimo } from './actividad'
import { juzgar } from './jev'
type FilaTabla = { k: string; estado: string; color: string; nombre: string; donde: string; hace: string; host: string; inst: string; activa: boolean; rc: boolean }
const ESTADO_LARGO: Record<string, string> = { aqui: 'esta sesion', trab: 'trabajando', esp: 'esperando', cerr: 'cerrando', off: 'sin conexion' }
// Paleta VGA (Turbo Pascal). Azul = ventanas y tablas; cian = estado, tips y seleccion;
// gris = menu, barra de abajo y modales; amarillo = titulos dentro de las ventanas.
const AZUL = '#0000AA'
const CIAN = '#00AAAA'
const GRIS = '#AAAAAA'
const AMARILLO = '#FFFF55'
// Un pedazo de linea con su color (para los titulos amarillos de las ventanas).
type Seg = { t: string; c?: string }
type Celda = { t: string; c?: string }
type FilaLista = { k: string; celdas: Celda[] }
import { leerSalud } from './salud'
import type { Salud } from './salud'

const PANE = 'flota'
const CADA_MS = 15_000
const SERVIDORES_CADA_MS = 5 * 60_000
const ACTIVIDAD_CADA_MS = 2 * 60_000
const SALUD_CADA_MS = 60_000
const CONFIRMAR_MS = 6_000
// Jev solo juzga mensajes recientes y por encima de este umbral los marca.
const JUZGAR_DIAS = 3
const JEV_ACTIVO = false
const UMBRAL = 0.7
// Opciones del plugin (userConfig). Sin servidores, el panel solo lista sesiones;
// sin archivo de key de TypeSafe, no hay juicio de Jev.
let HOSTS: string[] = []
let SSH: string[] = ['ssh']
let KEY_JEV = ''
// Dispositivos de la pantalla de salud: 'laptop' y alias de ssh.
let DISPOSITIVOS: string[] = ['laptop']
// Simbolos de un solo caracter de ancho (los emojis de color ocupan dos y desalinean la tabla).
const ICONO: Record<string, string> = { reiniciar: '↻', cerrar: 'X', levantar: '▶' }
const SIN_PENDIENTE: Pendiente = { accion: '', host: '', inst: '', hasta: 0 }

const foto = atom({ plugin: 'flota', key: 'foto' } as const, { sesiones: [], at: 0, error: '' })
const servidores = atom({ plugin: 'flota', key: 'servidores' } as const, { instancias: [], at: 0, error: '' })
const verFuera = atom({ plugin: 'flota', key: 'verFuera' } as const, false)
const verApagadas = atom({ plugin: 'flota', key: 'verApagadas' } as const, false)
const pendiente = atom({ plugin: 'flota', key: 'pendiente' } as const, SIN_PENDIENTE)
const aviso = atom({ plugin: 'flota', key: 'aviso' } as const, '')
const verMensajes = atom({ plugin: 'flota', key: 'verMensajes' } as const, true)
const actividad = atom({ plugin: 'flota', key: 'actividad' } as const, {} as Record<string, Registro>)
const errorActividad = atom({ plugin: 'flota', key: 'errorActividad' } as const, '')
const pantalla = atom({ plugin: 'flota', key: 'pantalla' } as const, 'sesiones' as 'sesiones' | 'salud' | 'ayuda')
const salud = atom({ plugin: 'flota', key: 'salud' } as const, {} as Record<string, Salud>)
const dispSel = atom({ plugin: 'flota', key: 'dispSel' } as const, '')
const filaSel = atom({ plugin: 'flota', key: 'filaSel' } as const, '')
const verTips = atom({ plugin: 'flota', key: 'verTips' } as const, false)

// "1.2G" a partir de KB.
function gb(kb: number): string {
  return kb >= 1048576 ? `${(kb / 1048576).toFixed(1)}G` : `${Math.round(kb / 1024)}M`
}
function dias(seg: number): string {
  if (!seg) return '-'
  if (seg < 3600) return `${Math.round(seg / 60)}m`
  if (seg < 172800) return `${Math.round(seg / 3600)}h`
  return `${(seg / 86400).toFixed(1)}d`
}
const corto = (d: string) => d.replace(/^server/, 's')

// "hace cuanto" corto para la columna ULTIMO.
function hace(ms: number, ahora: number): string {
  if (!ms) return '-'
  const m = Math.max(0, Math.round((ahora - ms) / 60_000))
  if (m < 60) return `${m}m`
  if (m < 48 * 60) return `${Math.round(m / 60)}h`
  return `${Math.round(m / 1440)}d`
}

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
let actualizarActividad: (() => Promise<void>) | null = null
let actualizarSesiones: (() => Promise<void>) | null = null
let actualizarSalud: (() => Promise<void>) | null = null
let leyendoActividad = false
// Foco: el ultimo elemento enfocado y los extremos visibles de la pantalla actual. Los botones
// fantasma (atajos ocultos) entran al recorrido de Tab: cuando el foco cae en uno se salta.
let ultimoFoco = ''
const PRIMER_VISIBLE = 'ir:sesiones'
let ultimoVisible = 'tips'
let relojes: { cancel: () => void }[] = []
let arrancar: (() => void) | null = null

function detener() {
  for (const r of relojes) r.cancel()
  relojes = []
}

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
  // Remote Control tarda en marcar una sesion apagada: se vuelve a mirar en 5 y 15 s.
  if (actualizarSesiones) {
    void actualizarSesiones()
    for (const ms of [5_000, 15_000]) $.clock.after(ms, () => { if (actualizarSesiones) void actualizarSesiones() })
  }
}

// Primera pulsacion: arma la accion. Segunda (antes de CONFIRMAR_MS): la ejecuta.
async function pulsar($: any, accion: string, host: string, inst: string) {
  const ahora = await $.clock.now()
  const p: Pendiente = await read($, pendiente)
  if (p.accion === accion && p.host === host && p.inst === inst && ahora < p.hasta) {
    await update($, pendiente, () => SIN_PENDIENTE)
    const orden: Record<string, string> = { levantar: 'up', reiniciar: 'restart', cerrar: 'down' }
    await ejecutar($, accion, host, [orden[accion] ?? 'restart', inst])
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
  'Panel: p s y t (pantallas y tips), r e c (reiniciar, cerrar, url), o a u. Comandos: /flota | /flota parar | /flota reiniciar | /flota nueva <servidor> <inst> <dir> [--name X] | /flota apagar <servidor> <inst>'

export const register: Register = (on, options) => {
  const o = options as { hosts?: string; sshCommand?: string; typesafeKeyFile?: string; devices?: string }
  HOSTS = (o.hosts ?? '').split(',').map(h => h.trim()).filter(h => SEGURO.test(h))
  SSH = (o.sshCommand ?? 'ssh').split(/\s+/).filter(Boolean)
  KEY_JEV = (o.typesafeKeyFile ?? '').trim()
  DISPOSITIVOS = (o.devices ?? 'laptop').split(',').map(d => d.trim()).filter(d => SEGURO.test(d))
  if (DISPOSITIVOS.length === 0) DISPOSITIVOS = ['laptop']

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

    actualizarSesiones = refrescar

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

    // Ultimo mensaje de cada sesion (local y servidores) y, si cambio, juicio de Jev.
    actualizarActividad = async () => {
      if (leyendoActividad) return
      leyendoActividad = true
      try {
        const sv: Servidores = await read($, servidores)
        const errores: string[] = []
        // Mezcla lo leido conservando el juicio de Jev si el texto no cambio.
        const mezclar = async (nuevos: Record<string, Ultimo>) => {
          await update($, actividad, previo => {
            const sig = { ...previo }
            for (const [clave, u] of Object.entries(nuevos)) {
              const p = previo[clave]
              sig[clave] = p && p.juzgado === u.texto
                ? { ...p, texto: u.texto, at: u.at }
                : { texto: u.texto, at: u.at, necesita: -1, atorada: -1, error: '', juzgado: '' }
            }
            return sig
          })
        }
        // Solo servidores: la lectura local (PowerShell sobre transcripts de varios MB) tardaba
        // mas de 90 s y gastaba CPU y RAM en la laptop. Queda en actividad.ts por si se retoma.
        await Promise.all(
          HOSTS.map(host =>
            ultimosRemotos($, SSH, host, sv.instancias).then(mezclar, err => void errores.push(`${host}: ${String(err)}`)),
          ),
        )
        await update($, errorActividad, () => errores.join(' | ').slice(0, 300))
        const ahora = await $.clock.now()
        const siguiente: Record<string, Registro> = await read($, actividad)
        // Jev apagado por ahora (JEV_ACTIVO); el juicio sigue en jev.ts.
        if (!JEV_ACTIVO || KEY_JEV === '') return
        for (const [clave, r] of Object.entries(siguiente)) {
          if (!r.texto || r.juzgado === r.texto || ahora - r.at > JUZGAR_DIAS * 86_400_000) continue
          const j = await juzgar($, KEY_JEV, clave, r.texto)
          await update($, actividad, a => ({ ...a, [clave]: { ...r, ...j, juzgado: j.error ? '' : r.texto } }))
        }
      } finally {
        leyendoActividad = false
      }
    }

    actualizarTodo = async () => {
      await Promise.all([refrescar(), actualizarServidores ? actualizarServidores() : Promise.resolve()])
      if (actualizarActividad) await actualizarActividad()
    }
    actualizarSalud = async () => {
      await Promise.all(
        DISPOSITIVOS.map(async d => {
          const r = await leerSalud($, SSH, d)
          await update($, salud, m => ({ ...m, [d]: r }))
        }),
      )
    }

    // Los relojes se guardan para que /flota parar los detenga.
    arrancar = () => {
      detener()
      if (actualizarTodo) void actualizarTodo()
      relojes = [
        $.clock.every(CADA_MS, () => void refrescar()),
        $.clock.every(SERVIDORES_CADA_MS, () => {
          if (actualizarServidores) void actualizarServidores()
        }),
        $.clock.every(ACTIVIDAD_CADA_MS, () => {
          if (actualizarActividad) void actualizarActividad()
        }),
        $.clock.every(SALUD_CADA_MS, () => {
          void read($, pantalla).then(p => { if (p === 'salud' && actualizarSalud) void actualizarSalud() })
        }),
      ]
    }
    // Preferencias guardadas: al reactivar el mod el panel queda como estaba.
    const vf = await $.store.get('verFuera')
    const va = await $.store.get('verApagadas')
    const vt = await $.store.get('verTips')
    if (typeof vt === 'boolean') await update($, verTips, () => vt)
    if (typeof vf === 'boolean') await update($, verFuera, () => vf)
    if (typeof va === 'boolean') await update($, verApagadas, () => va)
    arrancar()

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
    if (p[0] === 'parar') {
      detener()
      await $.ui.close({ id: PANE })
      return { text: 'Flota parada: sin lecturas ni llamadas a Jev. /flota la vuelve a arrancar.' }
    }
    if (p[0] === 'reiniciar') {
      // Borra lo leido y lo juzgado, y vuelve a empezar.
      await update($, actividad, () => ({}))
      await update($, errorActividad, () => '')
      await update($, aviso, () => '')
      if (arrancar) arrancar()
      await $.ui.open({ id: PANE, title: 'Flota' })
      return { text: 'Flota reiniciada: releyendo sesiones, servidores y mensajes.' }
    }
    if (p.length > 0) return { text: AYUDA }
    await $.ui.open({ id: PANE, title: 'Flota' })
    // Cada apertura empieza sin sesion elegida.
    await update($, filaSel, () => '')
    // Parada o no, abrir el panel la (re)arranca.
    if (relojes.length === 0 && arrancar) arrancar()
    else if (actualizarTodo) void actualizarTodo()
    return { text: 'Panel de la flota abierto; actualizando sesiones y servidores.' }
  })

  // Tab no pasa a las paradas del motor (la X de cerrar del panel): por ahi se salia el foco.
  // Sin next el foco se queda donde estaba. Esc sigue devolviendo el teclado al chat.
  on('ui.focus', async ($, e, next) => {
    const quien = (e.origin as { kind?: string } | undefined)?.kind
    if (e.requestId === PANE && !e.element && quien === 'person') return {}
    // Fantasma: si veniamos del primer visible estamos retrocediendo -> al ultimo visible;
    // si no, avanzando -> da la vuelta al primero del menu.
    if (e.requestId === PANE && e.element?.startsWith('hk:') && quien === 'person') {
      const destino = ultimoFoco === PRIMER_VISIBLE ? ultimoVisible : PRIMER_VISIBLE
      ultimoFoco = destino
      return next({ ...e, element: destino })
    }
    if (e.requestId === PANE && e.element) ultimoFoco = e.element
    return next(e)
  })

  on('ui.message', async ($, e, next) => {
    // Atajos reenviados por la tabla o la lista cuando ellas tienen el teclado.
    const atajo = ((e.data ?? {}) as { atajo?: string }).atajo
    if ((e.element === 'tabla' || e.element === 'lista-salud') && atajo) {
      if (atajo === 'sesiones' || atajo === 'salud' || atajo === 'ayuda') {
        await update($, pantalla, () => atajo)
        if (atajo === 'salud' && actualizarSalud) void actualizarSalud()
      } else if (atajo === 'actualizar' && actualizarTodo) void actualizarTodo()
      else if (atajo === 'actualizarSalud' && actualizarSalud) void actualizarSalud()
      else if (atajo === 'sinConexion') await update($, verFuera, v => (void $.store.set('verFuera', !v), !v))
      else if (atajo === 'apagadas') await update($, verApagadas, v => (void $.store.set('verApagadas', !v), !v))
      return {}
    }
    // Lista de salud: elegir dispositivo o volver a la principal.
    if (e.element === 'lista-salud') {
      const d = (e.data ?? {}) as { elegir?: string; ir?: string }
      if (d.elegir) await update($, dispSel, () => d.elegir as string)
      if (d.ir === 'sesiones') await update($, pantalla, () => 'sesiones')
      return {}
    }
    if (e.element !== 'tabla') return next(e)
    const d = (e.data ?? {}) as { accion?: string; host?: string; inst?: string }
    if (!d.accion || !d.host || !d.inst) return {}
    if (d.accion === 'url') void copiarUrl($, d.host, d.inst, e.surface)
    else if (d.accion === 'reiniciar' || d.accion === 'cerrar') void pulsar($, d.accion, d.host, d.inst)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const f: Foto = await read($, foto)
    const sv: Servidores = await read($, servidores)
    const mostrarFuera: boolean = await read($, verFuera)
    const mostrarApagadas: boolean = await read($, verApagadas)
    const p: Pendiente = await read($, pendiente)
    const ultimo: string = await read($, aviso)
    const mostrarMensajes: boolean = await read($, verMensajes)
    const act: Record<string, Registro> = await read($, actividad)
    const errAct: string = await read($, errorActividad)
    const pant = await read($, pantalla)
    // Lo comun a las tres pantallas: barra verde de ubicacion arriba y menu abajo.
    const props = ((e as any).props ?? {}) as { isFocused?: boolean; bodyColumns?: number; scroll?: { bodyRows?: number } }
    const foco = props.isFocused === true
    const NOMBRE: Record<string, string> = { sesiones: 'PRINCIPAL', salud: 'SALUD', ayuda: 'AYUDA' }
    const TECLAS: Record<string, string> = {
      sesiones: 'flechas/Tab moverse  Enter pulsar  la fila enfocada queda elegida',
      salud: 'flechas/Tab moverse  Enter pulsar  el dispositivo enfocado queda elegido',
      ayuda: '',
    }
    // Estilo Turbo Pascal (Borland). Cada color significa una sola cosa:
    // gris = barras del sistema (menu arriba, estado abajo), verde = seleccion/foco,
    // azul con borde doble = ventanas de contenido, cian = resumen, gris con borde simple = modal.
    const W = Math.max(40, (props.bodyColumns ?? 80) - 1)
    const llenar = (t: string, n = W) => (t.length >= n ? t.slice(0, n) : t.padEnd(n))
    const franja = (t: string, fg: string, bg: string) => (
      <Text color={fg} backgroundColor={bg} bold>{llenar(t)}</Text>
    )
    const tips: boolean = await read($, verTips)
    const estado = (t: string) => franja(` ${t}  | teclado: ${foco ? 'PANEL' : 'CHAT (ctrl+x tab)'}`, 'black', CIAN)
    // Barra verde de tips: aparece solo con el boton Tips del menu.
    // Una idea por linea: iconos, atajos y movimiento.
    const TIPS: Record<string, string[]> = {
      sesiones: [
        'Iconos de la fila elegida:  ↻ reiniciar    X cerrar    ⎘ copiar url',
        'Atajos:  R reiniciar   E cerrar   C copiar url   O ver off   A apagadas   U actualizar',
        'Moverse: Tab o flechas    Elegir: Enter o clic    Menu: P S Y T    Esc: al chat',
      ],
      salud: [
        'Moverse: Tab o flechas    Elegir dispositivo: Enter o clic',
        'Atajos:  U actualizar    Menu: P S Y T    Esc: al chat',
      ],
      ayuda: ['Tips: prende y apaga esta barra con T o con el boton Tips del menu'],
    }
    const barra = tips ? (
      <Box flexDirection="column">{(TIPS[pant] ?? []).map(t => franja(` ${t}`, 'black', CIAN))}</Box>
    ) : null
    // Ventana: titulo en el borde de arriba, como las de Turbo Pascal.
    const ventana = (titulo: string, lineas: (string | Seg[])[], fg = 'white', bg = AZUL, doble = false) => {
      const ancho = W - 2
      // (no llamar "h" a nada: es la funcion global con la que se dibuja el JSX)
      const [hz, v, a1, a2, b1, b2] = doble ? ['═', '║', '╔', '╗', '╚', '╝'] : ['─', '│', '┌', '┐', '└', '┘']
      const tit = ` ${titulo} `.slice(0, Math.max(0, ancho - 4))
      const arriba = a1 + hz + tit + hz.repeat(Math.max(0, ancho - 1 - tit.length)) + a2
      return [
        <Text color={fg} backgroundColor={bg} bold>{arriba}</Text>,
        ...lineas.map(l => {
          if (typeof l === 'string') return <Text color={fg} backgroundColor={bg}>{v + llenar(` ${l}`, ancho) + v}</Text>
          // Recorta los pedazos para que la linea nunca pase el ancho (si pasa, se parte y descuadra).
          let quedan = ancho - 1
          const segs = l.map(x => {
            const t = x.t.slice(0, Math.max(0, quedan))
            quedan -= t.length
            return { ...x, t }
          })
          const largo = 1 + segs.reduce((n, x) => n + x.t.length, 0)
          return (
            <Text color={fg} backgroundColor={bg}>
              {v + ' '}
              {segs.map(x => (x.c ? <Text color={x.c} bold>{x.t}</Text> : x.t))}
              {' '.repeat(Math.max(0, ancho - largo)) + v}
            </Text>
          )
        }),
        <Text color={fg} backgroundColor={bg} bold>{b1 + hz.repeat(ancho) + b2}</Text>,
      ]
    }
    // Boton estilo Turbo Pascal: plano (sin corchetes) y SIN hotkey, porque un plano con
    // hotkey antepone "p:" en el color de acento del motor. La letra roja en mayuscula es solo
    // guia visual; se pulsa con Tab/flechas + Enter o con el mouse.
    type Item = { key: string; hk: string; etiqueta: string; onPress: (e: any) => void; verde?: boolean }
    const largoItem = (it: Item) => it.etiqueta.length + 2
    const tecla = (it: Item) => {
      const fondo = it.verde ? CIAN : GRIS
      const i = it.etiqueta.toLowerCase().indexOf(it.hk)
      return (
        <Button key={it.key} plain onPress={it.onPress}>
          <Text backgroundColor={fondo} color="black">
            {' '}
            {i >= 0 ? it.etiqueta.slice(0, i) : it.etiqueta}
            {i >= 0 && <Text color="red" bold>{it.etiqueta[i]!.toUpperCase()}</Text>}
            {i >= 0 ? it.etiqueta.slice(i + 1) : ''}
            {' '}
          </Text>
        </Button>
      )
    }
    // Barra gris de lado a lado con los botones seguidos, sin divisiones.
    const barraBotones = (items: Item[], prefijo = '', derecha = '') => {
      const usado = prefijo.length + items.reduce((n, it) => n + largoItem(it), 0) + derecha.length
      return (
        <Box flexDirection="row">
          {prefijo !== '' && <Text backgroundColor={GRIS} color="black" bold>{prefijo}</Text>}
          {items.map(tecla)}
          <Text backgroundColor={GRIS}>{' '.repeat(Math.max(0, W - usado))}</Text>
          {derecha !== '' && <Text backgroundColor={GRIS} color="black" bold>{derecha}</Text>}
        </Box>
      )
    }
    // PRUEBA: botones "fantasma" en un contenedor oculto, solo para que las letras funcionen
    // como atajo sin dibujar "p:" ni corchetes. Si el motor desactiva los atajos de lo oculto,
    // esto no hace nada y se quita.
    const fantasmas = (items: Item[]) => (
      <Box display="none">
        {items.map(it => (
          <Button key={`hk:${it.key}`} plain hotkey={it.hk} onPress={it.onPress}>
            {it.etiqueta}
          </Button>
        ))}
      </Box>
    )
    // Fecha y hora de la maquina que corre Claude Code, corta y en 24 h.
    const reloj = (() => {
      const d = new Date()
      const dos = (n: number) => String(n).padStart(2, '0')
      return ` ${dos(d.getDate())}/${dos(d.getMonth() + 1)} ${dos(d.getHours())}:${dos(d.getMinutes())} `
    })()
    const irA = (q: 'sesiones' | 'salud' | 'ayuda') => {
      void update($, pantalla, () => q)
      if (q === 'salud' && actualizarSalud) void actualizarSalud()
    }
    const OPCIONES: readonly (readonly ['sesiones' | 'salud' | 'ayuda', string, string])[] = [
      ['sesiones', 'p', 'principal'],
      ['salud', 's', 'salud'],
      ['ayuda', 'y', 'ayuda'],
    ]
    // Menu arriba, en la barra gris, como el de Turbo Pascal.
    const itemsMenu: Item[] = OPCIONES.map(([q, hk, etiqueta]) => ({
        key: `ir:${q}`,
        hk,
        etiqueta: etiqueta[0]!.toUpperCase() + etiqueta.slice(1),
        onPress: () => irA(q),
        verde: pant === q,
      })).concat([
        {
          key: 'tips',
          hk: 't',
          etiqueta: 'Tips',
          onPress: () => void update($, verTips, v => (void $.store.set('verTips', !v), !v)),
          verde: tips,
        },
      ])
    const menu = (
      <Box flexDirection="column">
        {barraBotones(itemsMenu, ' ≡ FLOTA  ', reloj)}
      </Box>
    )

    if (pant === 'ayuda') {
      ultimoVisible = 'tips'
      // Dos columnas: tecla o termino en amarillo, explicacion en blanco.
      const fila = (a: string, b: string): Seg[] => [{ t: a.padEnd(18), c: AMARILLO }, { t: b }]
      const aviso = (t: string): Seg[] => [{ t: '¡CUIDADO!'.padEnd(18), c: 'red' }, { t }]
      return (
        <Box flexDirection="column">
          {menu}
          {barra}
          <Text> </Text>
          {ventana('Teclado', [
            fila('ctrl+x tab', 'el teclado pasa al panel (la linea de abajo dice PANEL)'),
            fila('Esc', 'el teclado regresa al chat'),
            fila('Tab, flechas', 'moverse entre filas y botones'),
            fila('Enter o clic', 'pulsar el boton o elegir la fila (marca ►)'),
            fila('flecha izq/der', 'en el panel: control anterior / siguiente (como Shift+Tab / Tab)'),
            aviso('flecha izq en el CHAT (prompt vacio): sesion a 2o plano'),
            fila('ctrl+x x', 'cierra el panel'),
            fila('ctrl+x izq / der', 'agranda / achica el panel'),
            fila('AvPag RePag', 'desplaza el panel (tambien Inicio y Fin)'),
          ])}
          <Text> </Text>
          {ventana('Atajos (con el panel enfocado)', [
            fila('P  S  Y', 'pantallas Principal, Salud y aYuda'),
            fila('T', 'prende o apaga la barra de tips'),
            fila('O  A  U', 'ver off, ver apagadas, actualizar (Principal)'),
            fila('R  E  C', 'reiniciar, cerrar, copiar url de la sesion elegida'),
            fila('dos veces', 'reiniciar y cerrar se confirman pulsando otra vez'),
          ])}
          <Text> </Text>
          {ventana('Estados de una sesion', [
            fila('esta sesion', 'la sesion donde corre este panel'),
            fila('trabajando', 'Claude esta procesando un turno'),
            fila('esperando', 'sesion viva, esperando instrucciones'),
            fila('cerrando', 'el servidor ya la detuvo; Remote Control aun no se entera'),
            fila('sin conexion', 'entrada vieja de Remote Control; se borra desde la app'),
            fila('apagadas', 'instancias de servidor detenidas; se levantan con su boton ▶'),
            fila('● (columna RC)', 'tiene Remote Control conocido'),
            fila('sin (Salud)', 'el dispositivo no tiene Claude Code instalado'),
          ])}
          <Text> </Text>
          {ventana('Comandos', [
            fila('/flota', 'abre el panel'),
            fila('/flota parar', 'detiene lecturas y cierra el panel'),
            fila('/flota reiniciar', 'borra lo leido y vuelve a leer todo'),
            fila('/flota nueva', '<servidor> <inst> <dir> [--name X]  crea una instancia'),
            fila('/flota apagar', '<servidor> <inst>  apaga una instancia'),
          ])}
          {estado('AYUDA')}
          {fantasmas(itemsMenu)}
        </Box>
      )
    }

    if (pant === 'salud') {
      const sl: Record<string, Salud> = await read($, salud)
      const sel0: string = await read($, dispSel)
      const elegido = DISPOSITIVOS.includes(sel0) ? sel0 : DISPOSITIVOS[0] ?? 'laptop'
      const c = (t: string, n: number) => (t.length > n - 1 ? t.slice(0, n - 2) + '~ ' : t.padEnd(n))
      const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0)
      const color = (v: number, amarillo: number, rojo: number) => (v >= rojo ? 'red' : v >= amarillo ? 'yellow' : 'green')
      const det = sl[elegido]
      const sinClaude = DISPOSITIVOS.filter(d => sl[d] && !sl[d]!.error && !sl[d]!.tieneClaude)
      const sinRespuesta = DISPOSITIVOS.filter(d => sl[d]?.error).length
      // Con alerta: RAM >= 85%, disco >= 90% o carga por encima de los nucleos.
      const alertas = DISPOSITIVOS.filter(d => {
        const x = sl[d]
        if (!x || x.error) return false
        const carga = x.cpupct >= 0 ? x.cpupct : (x.load / Math.max(1, x.cpus)) * 100
        return 100 - pct(x.memAvail, x.memTotal) >= 85 || pct(x.diskUsed, x.diskTotal) >= 90 || carga >= 100
      }).length
      // Informacion del dispositivo elegido: 5 lineas en dos columnas alineadas.
      const par = (a: string, va: string, b = '', vb = ''): Seg[] =>
        b
          ? [{ t: a.padEnd(11), c: AMARILLO }, { t: va.padEnd(Math.max(24, Math.floor((W - 30) / 2))) }, { t: b.padEnd(12), c: AMARILLO }, { t: vb }]
          : [{ t: a.padEnd(11), c: AMARILLO }, { t: va }]
      const lineasDisp: (string | Seg[])[] = !det
        ? [`${corto(elegido)}: leyendo...`, '', '', '', '']
        : det.error
          ? [par('Disp', corto(elegido), 'Estado', 'sin respuesta'), par('Error', det.error), '', '', '']
          : [
              par('Disp', corto(elegido), 'Encendido', dias(det.up)),
              par('CPU', det.cpupct >= 0 ? `${det.cpupct}%` : `carga ${det.load.toFixed(2)} en ${det.cpus} nucleos`, 'Claude', det.tieneClaude ? `${det.claude} procesos` : 'NO instalado'),
              par('RAM', `${100 - pct(det.memAvail, det.memTotal)}% de ${gb(det.memTotal)}`, 'claude-rc', det.rc >= 0 ? `${det.rc} activas` : '-'),
              par('Disco', `${pct(det.diskUsed, det.diskTotal)}% de ${gb(det.diskTotal)} en ${det.mount || '?'}`),
              par('Memoria', det.top.slice(0, 4).map(t => `${t.nombre} ${gb(t.kb)}`).join('   ')),
            ]
      // Una fila por dispositivo, en celdas con color, para la lista con barra (lista.tsx).
      const filasSalud: FilaLista[] = DISPOSITIVOS.map(d => {
        const x = sl[d]
        if (!x) return { k: d, celdas: [{ t: c(corto(d), 10) }, { t: 'leyendo...', c: 'gray' }] }
        if (x.error) return { k: d, celdas: [{ t: c(corto(d), 10) }, { t: x.error, c: 'red' }] }
        const carga = x.cpupct >= 0 ? x.cpupct : Math.round((x.load / Math.max(1, x.cpus)) * 100)
        const cpuTxt = x.cpupct >= 0 ? `${x.cpupct}%` : `${x.load.toFixed(2)}/${x.cpus}`
        const ram = 100 - pct(x.memAvail, x.memTotal)
        const disco = pct(x.diskUsed, x.diskTotal)
        return {
          k: d,
          celdas: [
            { t: c(corto(d), 10) },
            { t: c(cpuTxt, 10), c: color(carga, 70, 100) },
            { t: c(`${ram}% ${gb(x.memTotal)}`, 13), c: color(ram, 70, 85) },
            { t: c(`${disco}% ${gb(x.diskTotal)}`, 13), c: color(disco, 80, 90) },
            { t: c(dias(x.up), 7) },
            x.tieneClaude ? { t: c(String(x.claude), 8) } : { t: c('sin', 8), c: 'magenta' },
            { t: x.rc >= 0 ? String(x.rc) : '-' },
          ],
        }
      })
      ultimoVisible = 'actualizar-salud'
      const itemsSalud: Item[] = [{ key: 'actualizar-salud', hk: 'u', etiqueta: 'Actualizar', onPress: () => { if (actualizarSalud) void actualizarSalud() } }]
      return (
        <Box flexDirection="column">
          {menu}
          {barra}
          <Text> </Text>
          {ventana(corto(elegido), lineasDisp)}
          <Text> </Text>
          <Text backgroundColor={AZUL} color={AMARILLO} bold>{llenar(c('', 2) + c('DISP', 10) + c('CPU', 10) + c('RAM', 13) + c('DISCO', 13) + c('ENC', 7) + c('CLAUDE', 8) + 'RC')}</Text>
          {filasSalud.map(fl => {
            const largo = 2 + fl.celdas.reduce((n, x) => n + x.t.length, 0)
            return (
              <Button key={`disp:${fl.k}`} plain onPress={() => void update($, dispSel, () => fl.k)}>
                <Text backgroundColor={AZUL} color="white" bold={fl.k === elegido}>
                  {fl.k === elegido ? '► ' : '  '}
                  {fl.celdas.map(x => (x.c ? <Text color={x.c}>{x.t}</Text> : x.t))}
                  {' '.repeat(Math.max(0, W - largo))}
                </Text>
              </Button>
            )
          })}
          <Text> </Text>
          {barraBotones(itemsSalud)}
          {estado(
            `SALUD  ${DISPOSITIVOS.length} dispositivos | ${alertas} con alerta | ${sinRespuesta} sin respuesta | ` +
              `${sinClaude.length} sin Claude | cada 60 s`,
          )}
          {fantasmas([...itemsMenu, ...itemsSalud])}
        </Box>
      )
    }

    const ahora = await $.clock.now()
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
        const reg = act[inst ? `${inst.host}/${inst.inst}` : s.name]
        return {
          estado: aqui ? 'aqui' : inst && !inst.active ? 'cerr' : g === 'activa' ? 'trab' : g === 'espera' ? 'esp' : 'off',
          color: aqui ? 'cyan' : inst && !inst.active ? 'gray' : g === 'activa' ? 'green' : g === 'espera' ? 'yellow' : 'gray',
          nombre: s.name,
          servidor: inst ? inst.host : g === 'fuera' ? '-' : remota ? 'laptop (?)' : 'laptop',
          inst,
          reg,
          // Remote Control conocido: sesion Remote Control o instancia de servidor.
          rc: remota || Boolean(inst),
        }
      })
      .sort((a, b) => {
        const orden: Record<string, number> = { aqui: 0, trab: 1, esp: 2, cerr: 3, off: 4 }
        return (orden[a.estado] ?? 3) - (orden[b.estado] ?? 3) || a.servidor.localeCompare(b.servidor) || a.nombre.localeCompare(b.nombre)
      })
    // Lo que no es nombre: marca 2 + estado 13 + RC 3 + donde 13 + hace 5 + iconos 21.
    const tope = Math.max(10, Math.min(28, (props.bodyColumns ?? 80) - 58))
    const ancho = Math.min(tope, Math.max(6, ...filas.map(r => r.nombre.length))) + 1
    // Servidor e instancia en una columna: "s003/t109", "laptop".
    const donde = (r: { servidor: string; inst: Instancia | null }) =>
      r.inst ? `${r.inst.host.replace('server', 's')}/${r.inst.inst}` : r.servidor
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
          {armado ? <Text color="red">{`¿${accion} ${i.inst}?`}</Text> : (ICONO[accion] ?? accion)}
        </Button>
      )
    }
    // Datos para la tabla navegable (tabla.tsx): solo texto plano, sin funciones.
    const filasTabla: FilaTabla[] = filas.map(r => ({
      k: r.nombre, // unico: dos sesiones pueden compartir instancia (120-shop y 120-shop-web)
      estado: r.estado,
      color: r.color,
      nombre: r.nombre,
      donde: donde(r),
      hace: hace(r.reg?.at ?? 0, ahora),
      host: r.inst?.host ?? '',
      inst: r.inst?.inst ?? '',
      activa: Boolean(r.inst?.active),
      rc: r.rc,
    }))
    const selGuardada: string = await read($, filaSel)
    // Sin seleccion por defecto: se elige con Enter o clic.
    const selK = filasTabla.some(r => r.k === selGuardada) ? selGuardada : ''
    const fs = filasTabla.find(r => r.k === selK)
    const armadoEn = (accion: string) => Boolean(fs && p.accion === accion && p.host === fs.host && p.inst === fs.inst)

    // Informacion de la sesion elegida: 5 lineas en dos columnas alineadas.
    const par = (a: string, va: string, b = '', vb = ''): Seg[] =>
      b
        ? [{ t: a.padEnd(11), c: AMARILLO }, { t: va.padEnd(Math.max(24, Math.floor((W - 30) / 2))) }, { t: b.padEnd(12), c: AMARILLO }, { t: vb }]
        : [{ t: a.padEnd(11), c: AMARILLO }, { t: va }]
    const rs = filas.find(r => r.nombre === selK)
    const lineasSel: (string | Seg[])[] = !fs || !rs
      ? ['Elige una sesion con flechas o Tab y pulsa Enter (o clic).', '', '', '']
      : [
          par('Sesion', fs.nombre, 'Estado', ESTADO_LARGO[fs.estado] ?? fs.estado),
          par('Servidor', rs.inst ? rs.inst.host : fs.estado === 'off' ? '-' : 'laptop', 'Instancia', rs.inst ? rs.inst.inst : '-'),
          par(
            'Carpeta',
            rs.inst
              ? rs.inst.dir
              : fs.estado === 'off'
                ? 'entrada vieja de Remote Control (no corre; se borra en la app)'
                : 'sesion local en esta laptop (se maneja desde su ventana)',
          ),
          par('Actividad', fs.hace !== '-' ? `hace ${fs.hace}` : 'sin dato'),
        ]

    ultimoVisible = 'actualizar'
    const itemsPrincipal: Item[] = [
      { key: 'ver-fuera', hk: 'o', etiqueta: `${mostrarFuera ? 'Ocultar' : 'Ver'} off (${fuera.length})`, onPress: () => void update($, verFuera, v => (void $.store.set('verFuera', !v), !v)) },
      { key: 'ver-apagadas', hk: 'a', etiqueta: `${mostrarApagadas ? 'Ocultar' : 'Ver'} apagadas (${apagadas.length})`, onPress: () => void update($, verApagadas, v => (void $.store.set('verApagadas', !v), !v)) },
      { key: 'actualizar', hk: 'u', etiqueta: 'Actualizar', onPress: () => { if (actualizarTodo) void actualizarTodo() } },
    ]
    return (
      <Box flexDirection="column">
        {menu}
        {barra}
        <Text> </Text>
        {ventana(fs ? fs.nombre : 'Sesion', lineasSel)}
        {(armadoEn('reiniciar') || armadoEn('cerrar')) &&
          ventana(
            'Confirmar',
            [armadoEn('cerrar') ? `Cerrar ${fs?.inst} y liberar su RAM?  Pulsa X (o E) otra vez.` : `Reiniciar ${fs?.inst}?  Pulsa ↻ (o R) otra vez.`],
            'black',
            GRIS,
            false,
          )}
        <Text> </Text>
        {f.error !== '' && <Text color="red">Error: {f.error}</Text>}
        {errAct !== '' && <Text color="red">Servidores (actividad): {errAct}</Text>}
        <Text backgroundColor={AZUL} color={AMARILLO} bold>{llenar('  ' + col('ESTADO', 13) + col('SESION', ancho) + col('RC', 3) + col('DONDE', 13) + 'HACE')}</Text>
        {filasTabla.map(r => {
          const elegida = r.k === selK
          const iconos = elegida && r.activa
          // Con iconos la fila deja 21 columnas para [ ↻ ] [ X ] [ ⎘ ].
          const resto = Math.max(0, W - 2 - 13 - ancho - 3 - (iconos ? 21 : 0))
          return (
            <Box flexDirection="row">
              <Button key={`fila:${r.k}`} plain onPress={() => void update($, filaSel, () => r.k)}>
                <Text backgroundColor={AZUL} color="white" bold={elegida}>
                  {elegida ? '► ' : '  '}
                  <Text color={r.color === 'gray' ? 'white' : r.color}>{col(ESTADO_LARGO[r.estado] ?? r.estado, 13)}</Text>
                  {col(r.nombre, ancho)}
                  <Text color="green">{col(r.rc ? '●' : '', 3)}</Text>
                  {llenar(col(r.donde, 13) + col(r.hace, 5), resto)}
                </Text>
              </Button>
              {iconos && (
                <Box flexDirection="row">
                  <Button key="icono-r" hotkey="r" onPress={() => void pulsar($, 'reiniciar', r.host, r.inst)}>
                    {armadoEn('reiniciar') ? <Text color="red">¿↻?</Text> : '↻'}
                  </Button>
                  <Button key="icono-e" hotkey="e" onPress={() => void pulsar($, 'cerrar', r.host, r.inst)}>
                    {armadoEn('cerrar') ? <Text color="red">¿X?</Text> : 'X'}
                  </Button>
                  <Button key="icono-c" hotkey="c" onPress={press => void copiarUrl($, r.host, r.inst, press.surface)}>
                    ⎘
                  </Button>
                </Box>
              )}
            </Box>
          )
        })}

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
        {barraBotones(itemsPrincipal)}
        {estado(
          `${activas.length} TRABAJANDO | ${espera.length} ESPERANDO | ${fuera.length} SIN CONEXION | ` +
            `${apagadas.length} APAGADAS | act ${hora}`,
        )}
        {ultimo !== '' && <Text color={ultimo.startsWith('FALLO') ? 'red' : 'cyan'}>{ultimo}</Text>}
        {sv.error !== '' && <Text color="red">Servidores: {sv.error}</Text>}
        {fantasmas([...itemsMenu, ...itemsPrincipal])}
      </Box>
    )
  })
}
