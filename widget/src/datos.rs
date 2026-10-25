//! Fuentes de datos del widget.
//!
//! - Sesiones de esta maquina: `claude agents --json`, la propia linea de comandos de Claude
//!   Code (lista las interactivas y en segundo plano aunque ninguna tenga el mod abierto).
//! - Servidores: `claude-rc ls` por ssh, como el mod. Las opciones (servidores y comando de ssh)
//!   son las mismas del mod: `pluginConfigs["flota@claude-code-mods"]` de ~/.claude/settings.json.

use std::os::windows::process::CommandExt;
use std::process::Command;

use serde::Deserialize;

/// Sin ventana de consola al lanzar procesos desde un programa con interfaz.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Solo nombres simples llegan al ssh (igual que en el mod).
fn seguro(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_./-".contains(c))
}

// ---------------------------------------------------------------------------------------
// Opciones compartidas con el mod.

#[derive(Clone)]
pub struct Config {
    pub hosts: Vec<String>,
    pub ssh: Vec<String>,
    /// Dispositivos de la pantalla de salud: "laptop" y alias de ssh.
    pub dispositivos: Vec<String>,
}

pub fn leer_config() -> Config {
    let mut cfg = Config {
        hosts: vec![],
        ssh: vec!["ssh".into()],
        dispositivos: vec!["laptop".into()],
    };
    let Some(home) = std::env::var_os("USERPROFILE") else {
        return cfg;
    };
    let ruta = std::path::Path::new(&home)
        .join(".claude")
        .join("settings.json");
    let Ok(texto) = std::fs::read_to_string(ruta) else {
        return cfg;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&texto) else {
        return cfg;
    };
    let o = &v["pluginConfigs"]["flota@claude-code-mods"]["options"];
    if let Some(h) = o["hosts"].as_str() {
        cfg.hosts = h
            .split(',')
            .map(|x| x.trim().to_string())
            .filter(|x| seguro(x))
            .collect();
    }
    if let Some(dv) = o["devices"].as_str() {
        let v: Vec<String> = dv
            .split(',')
            .map(|x| x.trim().to_string())
            .filter(|x| seguro(x))
            .collect();
        if !v.is_empty() {
            cfg.dispositivos = v;
        }
    }
    if let Some(s) = o["sshCommand"].as_str() {
        let partes: Vec<String> = s.split_whitespace().map(String::from).collect();
        if !partes.is_empty() {
            cfg.ssh = partes;
        }
    }
    cfg
}

// ---------------------------------------------------------------------------------------
// Sesiones de esta maquina.

#[derive(Debug, Clone, Deserialize)]
pub struct Sesion {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub cwd: String,
    /// Ultima actividad (segundos epoch) de la conversacion mas reciente de su carpeta; 0 = sin dato.
    #[serde(skip)]
    pub hace: u64,
}

/// Carpeta de proyecto como la nombra Claude Code: todo lo no alfanumerico -> '-'.
pub fn slug(dir: &str) -> String {
    dir.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Segundos epoch de ahora.
pub fn ahora() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Ultima actividad de una sesion local: fecha del .jsonl no vacio mas reciente de su carpeta
/// en ~/.claude/projects. Solo mira fechas, no abre los archivos.
fn actividad_local(cwd: &str) -> u64 {
    let Some(home) = std::env::var_os("USERPROFILE") else {
        return 0;
    };
    let dir = std::path::Path::new(&home)
        .join(".claude")
        .join("projects")
        .join(slug(cwd));
    let Ok(entradas) = std::fs::read_dir(dir) else {
        return 0;
    };
    entradas
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.len() > 0)
        .filter_map(|m| m.modified().ok())
        .filter_map(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .max()
        .unwrap_or(0)
}

impl Sesion {
    /// Ultima carpeta de la ruta, para que quepa en la tabla.
    pub fn carpeta(&self) -> &str {
        self.cwd.rsplit(['\\', '/']).next().unwrap_or(&self.cwd)
    }
}

/// Ruta de claude.exe: el instalador nativo lo deja en ~/.local/bin, que no siempre esta en
/// el PATH de un programa lanzado desde el escritorio.
fn claude_exe() -> String {
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let p = std::path::Path::new(&home)
            .join(".local")
            .join("bin")
            .join("claude.exe");
        if p.exists() {
            return p.to_string_lossy().into_owned();
        }
    }
    "claude".to_string()
}

pub fn leer_sesiones() -> Result<Vec<Sesion>, String> {
    let o = Command::new(claude_exe())
        .args(["agents", "--json"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("no se pudo ejecutar claude: {}", e.kind()))?;
    if !o.status.success() {
        return Err(String::from_utf8_lossy(&o.stderr)
            .lines()
            .last()
            .unwrap_or("claude agents fallo")
            .to_string());
    }
    let mut v: Vec<Sesion> =
        serde_json::from_slice(&o.stdout).map_err(|e| format!("respuesta no valida: {e}"))?;
    for s in &mut v {
        s.hace = actividad_local(&s.cwd);
    }
    // Primero las que trabajan, luego por nombre.
    v.sort_by(|a, b| {
        (a.status != "busy")
            .cmp(&(b.status != "busy"))
            .then(a.name.cmp(&b.name))
    });
    Ok(v)
}

// ---------------------------------------------------------------------------------------
// Instancias de claude-rc en los servidores.

#[derive(Debug, Clone)]
pub struct Instancia {
    pub host: String,
    pub inst: String,
    pub activa: bool,
    pub dir: String,
    /// Ultima actividad (segundos epoch); 0 = sin dato.
    pub hace: u64,
}

/// Ultima actividad de las instancias activas de un servidor: la fecha del .jsonl no vacio mas
/// reciente de cada carpeta de proyecto (el actual puede estar vacio si la sesion se reinicio).
/// Un solo ssh por servidor; el script va en base64 para que wsl no lo expanda en la laptop.
fn actividad_remota(cfg: &Config, host: &str, insts: &mut [Instancia]) {
    let lineas: Vec<String> = insts
        .iter()
        .filter(|i| i.activa && seguro(&i.inst))
        .map(|i| {
            let s = slug(&i.dir);
            format!(
                "f=\"\"; for x in $(ls -t ~/.claude/projects/{s}/*.jsonl 2>/dev/null); do [ -s \"$x\" ] && f=\"$x\" && break; done; echo \"@@{} $( [ -n \"$f\" ] && stat -c %Y \"$f\" )\"",
                i.inst
            )
        })
        .collect();
    if lineas.is_empty() {
        return;
    }
    let Some((prog, resto)) = cfg.ssh.split_first() else {
        return;
    };
    let remoto = format!(
        "echo {} | base64 -d | sh",
        crate::salud::b64(lineas.join("\n").as_bytes())
    );
    let Ok(o) = Command::new(prog)
        .args(resto)
        .args([
            "-o",
            "ConnectTimeout=6",
            "-o",
            "BatchMode=yes",
            host,
            &remoto,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return;
    };
    for l in String::from_utf8_lossy(&o.stdout).lines() {
        let Some(resto) = l.strip_prefix("@@") else {
            continue;
        };
        let mut partes = resto.split_whitespace();
        let (Some(inst), Some(t)) = (partes.next(), partes.next()) else {
            continue;
        };
        if let (Some(i), Ok(t)) = (insts.iter_mut().find(|i| i.inst == inst), t.parse::<u64>()) {
            i.hace = t;
        }
    }
}

impl Instancia {
    /// "server003" -> "s003".
    pub fn host_corto(&self) -> String {
        self.host.replacen("server", "s", 1)
    }
    pub fn carpeta(&self) -> &str {
        self.dir.rsplit('/').next().unwrap_or(&self.dir)
    }
}

/// `claude-rc ls` en un servidor. Desde Windows, `wsl ssh ...`: wsl pasa la linea por un bash
/// local, por eso solo van argumentos simples (sin $, comillas ni tuberias).
pub fn leer_servidor(cfg: &Config, host: &str) -> Result<Vec<Instancia>, String> {
    let (prog, resto) = cfg.ssh.split_first().ok_or("sin comando de ssh")?;
    let o = Command::new(prog)
        .args(resto)
        .args([
            "-o",
            "ConnectTimeout=6",
            "-o",
            "BatchMode=yes",
            host,
            "claude-rc",
            "ls",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("{host}: no se pudo ejecutar ssh ({})", e.kind()))?;
    if !o.status.success() {
        let err = String::from_utf8_lossy(&o.stderr);
        return Err(format!(
            "{host}: {}",
            err.trim().lines().last().unwrap_or("ssh fallo")
        ));
    }
    let texto = String::from_utf8_lossy(&o.stdout);
    Ok(texto
        .lines()
        .skip(1)
        .filter_map(|l| {
            let c: Vec<&str> = l.split_whitespace().collect();
            (c.len() >= 6).then(|| Instancia {
                host: host.to_string(),
                inst: c[0].to_string(),
                activa: c[1] == "active",
                dir: c[c.len() - 1].to_string(),
                hace: 0,
            })
        })
        .collect())
}

/// Una orden de claude-rc en un servidor (`restart`, `down`, `up`, `url`). Solo a servidores de
/// las opciones y solo con argumentos simples. Devuelve la ultima linea util de la salida.
pub fn claude_rc(cfg: &Config, host: &str, args: &[&str]) -> Result<String, String> {
    if !cfg.hosts.iter().any(|h| h == host) {
        return Err(format!("servidor desconocido: {host}"));
    }
    if let Some(a) = args.iter().find(|a| !seguro(a)) {
        return Err(format!("argumento no permitido: {a}"));
    }
    let (prog, resto) = cfg.ssh.split_first().ok_or("sin comando de ssh")?;
    let o = Command::new(prog)
        .args(resto)
        .args([
            "-o",
            "ConnectTimeout=6",
            "-o",
            "BatchMode=yes",
            host,
            "claude-rc",
        ])
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("no se pudo ejecutar ssh ({})", e.kind()))?;
    let out = String::from_utf8_lossy(&o.stdout).to_string();
    let err = String::from_utf8_lossy(&o.stderr).to_string();
    let ultima = |t: &str| {
        t.lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    if o.status.success() {
        Ok(ultima(&out))
    } else {
        Err(ultima(&err).chars().take(120).collect())
    }
}

/// Copia texto al portapapeles de Windows con clip.exe (las URL son ASCII).
pub fn copiar(texto: &str) -> Result<(), String> {
    use std::io::Write;
    let mut h = Command::new("clip")
        .stdin(std::process::Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("clip: {}", e.kind()))?;
    if let Some(mut entrada) = h.stdin.take() {
        entrada
            .write_all(texto.as_bytes())
            .map_err(|e| format!("clip: {}", e.kind()))?;
    }
    h.wait().map_err(|e| format!("clip: {}", e.kind()))?;
    Ok(())
}

/// Todos los servidores: las instancias que respondieron y un error por cada uno que no.
pub fn leer_servidores(cfg: &Config) -> (Vec<Instancia>, Vec<String>) {
    let mut insts = Vec::new();
    let mut errores = Vec::new();
    for h in &cfg.hosts {
        match leer_servidor(cfg, h) {
            Ok(mut v) => {
                actividad_remota(cfg, h, &mut v);
                insts.append(&mut v);
            }
            Err(e) => errores.push(e),
        }
    }
    // Activas primero, luego por servidor e instancia.
    insts.sort_by(|a, b| {
        (!a.activa)
            .cmp(&!b.activa)
            .then(a.host.cmp(&b.host))
            .then(a.inst.cmp(&b.inst))
    });
    (insts, errores)
}
