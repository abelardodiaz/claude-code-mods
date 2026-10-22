// Salud de un dispositivo: CPU, RAM, disco, tiempo encendido, procesos de Claude y los
// procesos que mas memoria usan. Servidores y celular (Termux) por ssh con un script POSIX;
// la laptop Windows con PowerShell (por stdin: -Command se come las comillas).

import type { Salud } from '../types'
export type { Salud }

// Disco de $HOME: en el celular "/" es el sistema de Android y siempre sale al 100%.
// Android (Termux) niega /proc/uptime y /proc/loadavg: respaldo con el comando uptime.
const SCRIPT_POSIX = [
  'u=$(cut -d. -f1 /proc/uptime 2>/dev/null); [ -z "$u" ] && u=$(( $(date +%s) - $(date -d "$(uptime -s)" +%s 2>/dev/null || date +%s) ))',
  'echo "up=$u"',
  'l=$(cut -d" " -f1 /proc/loadavg 2>/dev/null); [ -z "$l" ] && l=$(uptime | sed "s/.*average: *//" | cut -d, -f1)',
  'echo "load=$l"',
  'echo "cpus=$(nproc 2>/dev/null || echo 1)"',
  `awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{print "mem="t" "a}' /proc/meminfo`,
  `df -Pk "$HOME" | awk 'NR==2{print "disk="$2" "$3" "$6}'`,
  'echo "claude=$(pgrep -f claude 2>/dev/null | wc -l)"',
  // ssh no interactivo no siempre trae ~/.local/bin en el PATH: se mira tambien ahi.
  'if command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]; then echo "tieneclaude=1"; else echo "tieneclaude=0"; fi',
  `if command -v claude-rc >/dev/null 2>&1; then echo "rc=$(claude-rc ls 2>/dev/null | awk 'NR>1 && $2=="active"' | wc -l)"; else echo "rc=-1"; fi`,
  // Nombre del ejecutable (no comm, que Android corta); Claude aparece como su version.
  `ps -eo rss,args 2>/dev/null | awk 'NR>1' | sort -rn | head -5 | awk '{n=$2; sub(/.*\\//,"",n); print "top="$1" "n}'`,
].join('\n')

const SCRIPT_WINDOWS = [
  '$os=Get-CimInstance Win32_OperatingSystem',
  '$cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average',
  '$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'C:\'"',
  '"up=" + [int]((Get-Date)-$os.LastBootUpTime).TotalSeconds',
  '"cpupct=$cpu"',
  '"cpus=$env:NUMBER_OF_PROCESSORS"',
  '"mem=$($os.TotalVisibleMemorySize) $($os.FreePhysicalMemory)"',
  '"disk=$([int64]($d.Size/1KB)) $([int64](($d.Size-$d.FreeSpace)/1KB)) C:"',
  '"claude=" + @(Get-Process -Name claude -ErrorAction SilentlyContinue).Count',
  '"tieneclaude=" + [int][bool](Get-Command claude -ErrorAction SilentlyContinue)',
  'Get-Process | Sort-Object WS -Descending | Select-Object -First 5 | ForEach-Object { "top=$([int64]($_.WS/1KB)) $($_.ProcessName)" }',
].join('\n')

function b64(s: string): string {
  const bytes = Array.from(new TextEncoder().encode(s))
  const t = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | (b << 8) | c
    out += t[(n >> 18) & 63]! + t[(n >> 12) & 63]! + (i + 1 < bytes.length ? t[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? t[n & 63]! : '=')
  }
  return out
}

function parsear(disp: string, salida: string, at: number): Salud {
  const s: Salud = {
    disp, error: '', at, up: 0, load: -1, cpupct: -1, cpus: 1, memTotal: 0, memAvail: 0,
    diskTotal: 0, diskUsed: 0, mount: '', claude: 0, rc: -1, tieneClaude: false, top: [],
  }
  for (const cruda of salida.split('\n')) {
    const linea = cruda.trim()
    const i = linea.indexOf('=')
    if (i < 1) continue
    const k = linea.slice(0, i)
    const v = linea.slice(i + 1).trim()
    const p = v.split(/\s+/)
    if (k === 'up') s.up = Number(v) || 0
    else if (k === 'load') s.load = Number(v)
    else if (k === 'cpupct') s.cpupct = Number(v)
    else if (k === 'cpus') s.cpus = Number(v) || 1
    else if (k === 'mem') { s.memTotal = Number(p[0]) || 0; s.memAvail = Number(p[1]) || 0 }
    else if (k === 'disk') { s.diskTotal = Number(p[0]) || 0; s.diskUsed = Number(p[1]) || 0; s.mount = p[2] ?? '' }
    else if (k === 'claude') s.claude = Number(v) || 0
    else if (k === 'rc') s.rc = Number(v)
    else if (k === 'tieneclaude') s.tieneClaude = v === '1'
    else if (k === 'top') {
      const n = p.slice(1).join(' ')
      s.top.push({ kb: Number(p[0]) || 0, nombre: /^\d+\.\d+\.\d+$/.test(n) ? `claude ${n}` : n })
    }
  }
  if (!s.memTotal) s.error = 'sin datos'
  return s
}

// disp: "laptop" (esta maquina) o un alias de ssh.
export async function leerSalud($: any, ssh: string[], disp: string): Promise<Salud> {
  const at = await $.clock.now()
  try {
    if (disp === 'laptop') {
      const home = (await $.env.get('USERPROFILE')) ?? ''
      const r = /^[A-Za-z]:/.test(home)
        ? await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', '-'], { stdin: SCRIPT_WINDOWS + '\n', timeoutMs: 30_000 })
        : await $.process.run(['sh', '-c', SCRIPT_POSIX], { timeoutMs: 20_000 })
      return parsear(disp, String(r.stdout), at)
    }
    // Mismo truco que ultimosRemotos: base64 en un solo argumento.
    const r = await $.process.run(
      [...ssh, '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', disp, `echo ${b64(SCRIPT_POSIX)} | base64 -d | sh`],
      { timeoutMs: 30_000 },
    )
    if (r.exitCode !== 0 && !String(r.stdout).includes('mem=')) {
      return { ...parsear(disp, '', at), error: String(r.stderr).trim().split('\n').pop()?.slice(0, 100) || `salida ${r.exitCode}` }
    }
    return parsear(disp, String(r.stdout), at)
  } catch (err) {
    return { ...parsear(disp, '', at), error: String(err).slice(0, 100) }
  }
}
