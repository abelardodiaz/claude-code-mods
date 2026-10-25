//! Salud de un dispositivo: CPU, RAM, disco, tiempo encendido, procesos de Claude y los que mas
//! memoria usan. Mismo metodo que el mod `flota`: script POSIX por ssh para servidores y celular
//! (Termux), PowerShell por stdin para esta maquina.

use std::io::Write;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Default)]
pub struct Salud {
    pub disp: String,
    pub error: String,
    pub up: u64,
    pub load: f64,
    pub cpupct: f64,
    pub cpus: u32,
    pub mem_total: u64,
    pub mem_avail: u64,
    pub disk_total: u64,
    pub disk_used: u64,
    pub mount: String,
    pub claude: u32,
    pub rc: i32,
    pub tiene_claude: bool,
    pub top: Vec<(u64, String)>,
}

impl Salud {
    pub fn ram_pct(&self) -> u64 {
        // Si un dispositivo reporta mas disponible que total, 0% en vez de desbordar.
        (self.mem_avail * 100)
            .checked_div(self.mem_total)
            .map_or(0, |libre| 100u64.saturating_sub(libre))
    }
    pub fn disco_pct(&self) -> u64 {
        (self.disk_used * 100)
            .checked_div(self.disk_total)
            .unwrap_or(0)
    }
    /// Carga relativa a los nucleos, en %: >= 100 es saturado.
    pub fn carga_pct(&self) -> f64 {
        if self.cpupct >= 0.0 {
            self.cpupct
        } else {
            self.load / self.cpus.max(1) as f64 * 100.0
        }
    }
    pub fn cpu_txt(&self) -> String {
        if self.cpupct >= 0.0 {
            format!("{:.0}%", self.cpupct)
        } else {
            format!("{:.2}/{}", self.load, self.cpus)
        }
    }
}

/// "1.2G" a partir de KB.
pub fn gb(kb: u64) -> String {
    if kb >= 1_048_576 {
        format!("{:.1}G", kb as f64 / 1_048_576.0)
    } else {
        format!("{}M", kb / 1024)
    }
}

/// Tiempo encendido con un solo formato: " 2d 14h".
pub fn dias(seg: u64) -> String {
    if seg == 0 {
        return "     -".into();
    }
    format!("{:>2}d {:02}h", seg / 86_400, (seg % 86_400) / 3_600)
}

// Android (Termux) niega /proc/uptime y /proc/loadavg: respaldo con el comando uptime.
const SCRIPT_POSIX: &str = r#"u=$(cut -d. -f1 /proc/uptime 2>/dev/null); [ -z "$u" ] && u=$(( $(date +%s) - $(date -d "$(uptime -s)" +%s 2>/dev/null || date +%s) ))
echo "up=$u"
l=$(cut -d" " -f1 /proc/loadavg 2>/dev/null); [ -z "$l" ] && l=$(uptime | sed "s/.*average: *//" | cut -d, -f1)
echo "load=$l"
echo "cpus=$(nproc 2>/dev/null || echo 1)"
awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{print "mem="t" "a}' /proc/meminfo
df -Pk "$HOME" | awk 'NR==2{print "disk="$2" "$3" "$6}'
echo "claude=$(pgrep -f claude 2>/dev/null | wc -l)"
if command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]; then echo "tieneclaude=1"; else echo "tieneclaude=0"; fi
if command -v claude-rc >/dev/null 2>&1; then echo "rc=$(claude-rc ls 2>/dev/null | awk 'NR>1 && $2=="active"' | wc -l)"; else echo "rc=-1"; fi
ps -eo rss,args 2>/dev/null | awk 'NR>1' | sort -rn | head -5 | awk '{n=$2; sub(/.*\//,"",n); print "top="$1" "n}'
"#;

const SCRIPT_WINDOWS: &str = r#"$os=Get-CimInstance Win32_OperatingSystem
$cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
"up=" + [int]((Get-Date)-$os.LastBootUpTime).TotalSeconds
"cpupct=$cpu"
"cpus=$env:NUMBER_OF_PROCESSORS"
"mem=$($os.TotalVisibleMemorySize) $($os.FreePhysicalMemory)"
"disk=$([int64]($d.Size/1KB)) $([int64](($d.Size-$d.FreeSpace)/1KB)) C:"
"claude=" + @(Get-Process -Name claude -ErrorAction SilentlyContinue).Count
"tieneclaude=" + [int][bool](Get-Command claude -ErrorAction SilentlyContinue)
Get-Process | Sort-Object WS -Descending | Select-Object -First 5 | ForEach-Object { "top=$([int64]($_.WS/1KB)) $($_.ProcessName)" }
"#;

pub(crate) fn b64(datos: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in datos.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if c.len() > 1 {
            T[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn parsear(disp: &str, salida: &str) -> Salud {
    let mut s = Salud {
        disp: disp.into(),
        cpupct: -1.0,
        cpus: 1,
        rc: -1,
        ..Default::default()
    };
    for linea in salida.lines() {
        let linea = linea.trim();
        let Some((k, v)) = linea.split_once('=') else {
            continue;
        };
        let v = v.trim();
        let p: Vec<&str> = v.split_whitespace().collect();
        let num = |i: usize| p.get(i).and_then(|x| x.parse::<u64>().ok()).unwrap_or(0);
        match k {
            "up" => s.up = v.parse().unwrap_or(0),
            "load" => s.load = v.parse().unwrap_or(0.0),
            "cpupct" => s.cpupct = v.parse().unwrap_or(-1.0),
            "cpus" => s.cpus = v.parse().unwrap_or(1),
            "mem" => (s.mem_total, s.mem_avail) = (num(0), num(1)),
            "disk" => {
                (s.disk_total, s.disk_used) = (num(0), num(1));
                s.mount = p.get(2).unwrap_or(&"").to_string();
            }
            "claude" => s.claude = v.parse().unwrap_or(0),
            "rc" => s.rc = v.parse().unwrap_or(-1),
            "tieneclaude" => s.tiene_claude = v == "1",
            "top" => {
                // `top=` vacio llega si el script no encontro procesos: se ignora.
                if p.is_empty() {
                    continue;
                }
                let n = p[1..].join(" ");
                let es_version = n.split('.').count() == 3
                    && n.split('.').all(|x| x.chars().all(|c| c.is_ascii_digit()));
                s.top
                    .push((num(0), if es_version { format!("claude {n}") } else { n }));
            }
            _ => {}
        }
    }
    if s.mem_total == 0 {
        s.error = "sin datos".into();
    }
    s
}

/// `disp`: "laptop" (esta maquina) o un alias de ssh.
pub fn leer_salud(ssh: &[String], disp: &str) -> Salud {
    let salida = if disp == "laptop" {
        // PowerShell por stdin: en la linea de comandos -Command se come las comillas dobles.
        let hijo = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        match hijo {
            Err(e) => {
                return Salud {
                    disp: disp.into(),
                    error: format!("powershell: {}", e.kind()),
                    ..Default::default()
                };
            }
            Ok(mut h) => {
                if let Some(mut entrada) = h.stdin.take() {
                    let _ = entrada.write_all(SCRIPT_WINDOWS.as_bytes());
                    let _ = entrada.write_all(b"\n");
                }
                h.wait_with_output()
            }
        }
    } else {
        let Some((prog, resto)) = ssh.split_first() else {
            return Salud {
                disp: disp.into(),
                error: "sin comando de ssh".into(),
                ..Default::default()
            };
        };
        // Base64 en un solo argumento: wsl lo pasa por un bash local y asi nada se expande aqui.
        let remoto = format!(
            "echo {} | base64 -d | sh",
            b64(SCRIPT_POSIX.replace('\r', "").as_bytes())
        );
        Command::new(prog)
            .args(resto)
            .args([
                "-o",
                "ConnectTimeout=8",
                "-o",
                "BatchMode=yes",
                disp,
                &remoto,
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    };
    match salida {
        Err(e) => Salud {
            disp: disp.into(),
            error: format!("no se pudo ejecutar ({})", e.kind()),
            ..Default::default()
        },
        Ok(o) => {
            let texto = String::from_utf8_lossy(&o.stdout);
            if !texto.contains("mem=") {
                let err = String::from_utf8_lossy(&o.stderr);
                let ultima = err
                    .trim()
                    .lines()
                    .last()
                    .unwrap_or("sin respuesta")
                    .to_string();
                return Salud {
                    disp: disp.into(),
                    error: ultima,
                    ..Default::default()
                };
            }
            parsear(disp, &texto)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcentajes_de_ram_y_disco() {
        let s = Salud {
            mem_total: 16,
            mem_avail: 4,
            disk_total: 200,
            disk_used: 50,
            ..Default::default()
        };
        assert_eq!(s.ram_pct(), 75);
        assert_eq!(s.disco_pct(), 25);
    }

    #[test]
    fn totales_en_cero_o_disponible_de_mas_no_desbordan() {
        assert_eq!(Salud::default().ram_pct(), 0);
        assert_eq!(Salud::default().disco_pct(), 0);
        let raro = Salud {
            mem_total: 4,
            mem_avail: 8,
            ..Default::default()
        };
        assert_eq!(raro.ram_pct(), 0);
    }

    #[test]
    fn parsea_la_salida_del_script() {
        let s = parsear(
            "vps1",
            "up=90061\nload=0.5\ncpus=4\nmem=8000 2000\ndisk=100 40 /\nclaude=3\nrc=2\n\
             tieneclaude=1\ntop=512 node\ntop=256 2.1.30\n",
        );
        assert_eq!(s.error, "");
        assert_eq!(s.ram_pct(), 75);
        assert_eq!(s.disco_pct(), 40);
        assert_eq!(s.mount, "/");
        assert_eq!((s.claude, s.rc, s.tiene_claude), (3, 2, true));
        assert_eq!(
            s.top,
            vec![
                (512, "node".to_string()),
                (256, "claude 2.1.30".to_string())
            ]
        );
    }

    #[test]
    fn linea_top_vacia_no_tumba_el_widget() {
        let s = parsear("vps1", "mem=8000 2000\ntop=\ntop=   \n");
        assert_eq!(s.ram_pct(), 75);
    }

    #[test]
    fn sin_memoria_es_sin_datos() {
        assert_eq!(parsear("vps1", "basura\n").error, "sin datos");
    }
}
