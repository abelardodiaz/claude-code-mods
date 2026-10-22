// Lee el ultimo mensaje del asistente de cada sesion, de su transcript (.jsonl).
// Local: ~/.claude/projects/*/*.jsonl (el nombre sale de la linea "agent-name").
// Servidores: ~/.claude/projects/<dir de la instancia con / -> -> por ssh.

import type { Instancia } from '../types'

export type Ultimo = { texto: string; at: number }

const MAX_TEXTO = 600
const LOCAL_DIAS = 2
const LOCAL_MAX = 15

// base64 propio: el modulo no tiene btoa garantizado.
function b64(s: string): string {
  return b64Bytes(Array.from(new TextEncoder().encode(s)))
}


function b64Bytes(bytes: number[]): string {
  const t = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | (b << 8) | c
    out += t[(n >> 18) & 63]! + t[(n >> 12) & 63]! + (i + 1 < bytes.length ? t[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? t[n & 63]! : '=')
  }
  return out
}

// Una linea del transcript del tipo assistant con bloques de texto -> texto + hora.
function textoDeLinea(linea: string): Ultimo | null {
  try {
    const o = JSON.parse(linea)
    const partes = (o?.message?.content ?? []) as { type?: string; text?: string }[]
    const texto = partes.filter(p => p.type === 'text' && p.text).map(p => p.text).join('\n').trim()
    if (!texto) return null
    return { texto: texto.slice(-MAX_TEXTO), at: Date.parse(o.timestamp ?? '') || 0 }
  } catch {
    return null
  }
}

// Carpeta de proyecto como la nombra Claude Code: todo lo no alfanumerico -> '-'.
export function slug(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, '-')
}

// Una llamada ssh por servidor para todas sus instancias activas.
export async function ultimosRemotos($: any, ssh: string[], host: string, insts: Instancia[]): Promise<Record<string, Ultimo>> {
  const activas = insts.filter(i => i.active && i.host === host)
  if (activas.length === 0) return {}
  const script = activas
    .map(i => {
      const s = slug(i.dir)
      // El transcript actual puede estar vacio (sesion recien reiniciada): el mas reciente con contenido.
      return [
        `f=""; for x in $(ls -t ~/.claude/projects/${s}/*.jsonl 2>/dev/null); do [ -s "$x" ] && f="$x" && break; done`,
        `echo "@@${i.inst} $( [ -n "$f" ] && stat -c %Y "$f" )"`,
        `[ -n "$f" ] && tail -n 400 "$f" | grep '"type":"assistant"' | grep '"type":"text"' | tail -n 1`,
      ].join('; ')
    })
    .join('\n')
  // El script viaja en base64 (sin $ ni comillas): wsl lo pasa por un bash local, y asi
  // nada se expande aqui; Windows lo envuelve en comillas dobles por llevar espacios.
  const r = await $.process.run(
    [...ssh, '-o', 'ConnectTimeout=6', '-o', 'BatchMode=yes', host, `echo ${b64(script)} | base64 -d | bash`],
    { timeoutMs: 45_000 },
  )
  const out: Record<string, Ultimo> = {}
  let actual = ''
  let mtime = 0
  for (const linea of String(r.stdout).split('\n')) {
    if (linea.startsWith('@@')) {
      const [inst = '', seg = '0'] = linea.slice(2).trim().split(/\s+/)
      actual = inst
      mtime = Number(seg) * 1000 || 0
      // Sin texto del asistente: al menos la fecha de la ultima actividad.
      if (actual && mtime) out[`${host}/${actual}`] = { texto: '', at: mtime }
    } else if (actual && linea.startsWith('{')) {
      const u = textoDeLinea(linea)
      if (u) out[`${host}/${actual}`] = { texto: u.texto, at: u.at || mtime }
    }
  }
  return out
}

// Cache: ruta del transcript -> nombre de la sesion (rara vez cambia).
const nombrePorArchivo = new Map<string, string>()

export async function ultimosLocales($: any): Promise<Record<string, Ultimo>> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) return {}
  const raiz = `${home}/.claude/projects`.replace(/\\/g, '/')
  const ahora = await $.clock.now()
  const archivos: { path: string; mtime: number }[] = []
  for (const d of await $.fs.list(raiz)) {
    if (d.kind !== 'dir') continue
    for (const f of await $.fs.list(`${raiz}/${d.name}`).catch(() => [])) {
      if (f.kind === 'file' && f.name.endsWith('.jsonl') && ahora - f.mtimeMs < LOCAL_DIAS * 86_400_000) {
        archivos.push({ path: `${raiz}/${d.name}/${f.name}`, mtime: f.mtimeMs })
      }
    }
  }
  archivos.sort((a, b) => b.mtime - a.mtime)
  const lista = archivos.slice(0, LOCAL_MAX)
  if (lista.length === 0) return {}

  const windows = /^[A-Za-z]:/.test(home)
  let salida = ''
  if (windows) {
    const ps = [
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
      ...lista.map(a => {
        const p = a.path.replace(/'/g, "''")
        const buscaNombre = nombrePorArchivo.has(a.path)
          ? ''
          : `$n=Select-String -LiteralPath '${p}' -Pattern '"type":"agent-name"' -SimpleMatch | Select-Object -Last 1; if($n){$n.Line};`
        return `"@@${p}"; ${buscaNombre} $t=Get-Content -LiteralPath '${p}' -Tail 400 -Encoding UTF8 | Where-Object { $_.Contains('"type":"assistant"') -and $_.Contains('"type":"text"') } | Select-Object -Last 1; if($t){$t}`
      }),
    ].join('\n')
    // El script va por stdin: en la linea de comandos -Command se come las comillas dobles
    // y -EncodedCommand revienta el limite de 32K caracteres de Windows con 25 archivos.
    // Con "-Command -" PowerShell ejecuta linea por linea; cada archivo es una sola linea.
    const r = await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', '-'], {
      stdin: ps + '\n',
      timeoutMs: 90_000,
    })
    salida = String(r.stdout)
  } else {
    const sh = lista
      .map(a => {
        const p = a.path.replace(/'/g, `'\\''`)
        const buscaNombre = nombrePorArchivo.has(a.path) ? '' : `grep -F '"type":"agent-name"' '${p}' | tail -n 1;`
        return `echo '@@${p}'; ${buscaNombre} tail -n 400 '${p}' | grep -F '"type":"assistant"' | grep -F '"type":"text"' | tail -n 1`
      })
      .join('\n')
    const r = await $.process.run(['sh', '-c', sh], { timeoutMs: 60_000 })
    salida = String(r.stdout)
  }

  // Por nombre, el archivo mas reciente gana (la lista ya viene ordenada).
  const out: Record<string, Ultimo> = {}
  let actual = ''
  for (const linea of salida.split('\n')) {
    if (linea.startsWith('@@')) {
      actual = linea.slice(2).trim()
      continue
    }
    if (!actual || !linea.startsWith('{')) continue
    if (linea.includes('"type":"agent-name"')) {
      try {
        const n = JSON.parse(linea)?.agentName
        if (n) nombrePorArchivo.set(actual, String(n))
      } catch {}
      continue
    }
    const nombre = nombrePorArchivo.get(actual)
    const u = textoDeLinea(linea)
    if (nombre && u && !out[nombre]) out[nombre] = u
  }
  return out
}
