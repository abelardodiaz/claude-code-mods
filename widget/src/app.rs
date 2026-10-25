//! Ventana Win32 + GDI estilo Turbo Pascal, como el mod `flota`.
//!
//! - Ventana emergente sin bordes, fuera de la barra de tareas (WS_EX_TOOLWINDOW), siempre encima,
//!   con icono en la bandeja (clic: mostrar/ocultar; clic derecho: menu). El menu y las filas
//!   reciben clics; el resto arrastra la ventana. Esc la oculta; Salir esta en el menu.
//! - Se dibuja sobre una cuadricula de caracteres con letra de ancho fijo, como una pantalla de
//!   texto. Doble bufer (bitmap en memoria + BitBlt): sin parpadeo. La posicion se recuerda.
//! - Hilos aparte leen las sesiones (15 s), los servidores (60 s) y la salud (60 s, solo con su
//!   pantalla a la vista) y avisan con WM_DATOS; la ventana solo dibuja lo ultimo leido.
//! - Teclado (con la ventana activa; la barra de estado dice si lo esta): flechas mueven el
//!   cursor, Enter o clic eligen; R reiniciar, E cerrar, L levantar, C copiar url (reiniciar,
//!   cerrar y levantar piden la tecla dos veces); P S Y pantallas, U actualizar, I arranque.

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU8, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{
    COLORREF, ERROR_ALREADY_EXISTS, GetLastError, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, CreateCompatibleBitmap,
    CreateCompatibleDC, CreateFontW, CreateSolidBrush, DEFAULT_CHARSET, DeleteDC, DeleteObject,
    EndPaint, FF_DONTCARE, FW_NORMAL, FillRect, GetDC, GetTextExtentPoint32W, HDC, HFONT, HGDIOBJ,
    InvalidateRect, OUT_DEFAULT_PRECIS, PAINTSTRUCT, ReleaseDC, SRCCOPY, ScreenToClient,
    SelectObject, SetBkMode, SetTextColor, TRANSPARENT, TextOutW,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::SystemInformation::GetLocalTime;
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForWindow, SetProcessDpiAwarenessContext,
};
use windows::Win32::UI::Shell::{
    NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW, Shell_NotifyIconW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, DestroyWindow,
    DispatchMessageW, GetClientRect, GetCursorPos, GetMessageW, GetSystemMetrics, GetWindowRect,
    HICON, HTCAPTION, HTCLIENT, IDC_ARROW, IDI_APPLICATION, IsWindowVisible, LoadCursorW,
    LoadIconW, MF_CHECKED, MF_SEPARATOR, MF_STRING, MSG, PostMessageW, PostQuitMessage,
    RegisterClassExW, RegisterWindowMessageW, SM_CXSCREEN, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOMOVE, SWP_NOZORDER,
    SetForegroundWindow, SetTimer, SetWindowPos, ShowWindow, TPM_BOTTOMALIGN, TPM_RETURNCMD,
    TPM_RIGHTBUTTON, TrackPopupMenu, TranslateMessage, WM_ACTIVATE, WM_APP, WM_DESTROY,
    WM_DPICHANGED, WM_ERASEBKGND, WM_EXITSIZEMOVE, WM_KEYDOWN, WM_LBUTTONUP, WM_NCHITTEST,
    WM_NCRBUTTONUP, WM_PAINT, WM_RBUTTONUP, WM_TIMER, WNDCLASSEXW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_POPUP,
};
use windows::core::{PCWSTR, w};

use crate::datos::{self, Config, Instancia, Sesion};
use crate::inicio;
use crate::salud::{self, Salud, dias, gb};

const CLASS_NAME: PCWSTR = w!("FlotaWidget");
const MUTEX_NAME: PCWSTR = w!("Local\\io.github.abelardodiaz.flota-widget");
/// Hilos -> ventana: hay datos nuevos.
const WM_DATOS: u32 = WM_APP + 1;
/// Mensajes del icono de la bandeja.
const WM_TRAY: u32 = WM_APP + 2;
const TRAY_ID: u32 = 1;
const TIMER_RELOJ: usize = 1;
const CADA_LOCAL: Duration = Duration::from_secs(15);
const CADA_SERVIDORES: Duration = Duration::from_secs(60);
const CADA_SALUD: Duration = Duration::from_secs(60);
/// Tiempo para la segunda pulsacion de reiniciar, cerrar y levantar.
const CONFIRMAR: Duration = Duration::from_secs(6);
// Opciones del menu de la bandeja.
const ID_MOSTRAR: usize = 1;
const ID_ACTUALIZAR: usize = 2;
const ID_ARRANQUE: usize = 3;
const ID_SALIR: usize = 4;

// Teclas (codigos virtuales de Windows).
const VK_RETURN: usize = 0x0D;
const VK_ESCAPE: usize = 0x1B;
const VK_PRIOR: usize = 0x21;
const VK_NEXT: usize = 0x22;
const VK_END: usize = 0x23;
const VK_HOME: usize = 0x24;
const VK_UP: usize = 0x26;
const VK_RIGHT: usize = 0x27;
const VK_DOWN: usize = 0x28;

// Paleta VGA de Turbo Pascal (0xRRGGBB), la misma del mod.
const NEGRO: u32 = 0x000000;
const AZUL: u32 = 0x0000AA;
const CIAN: u32 = 0x00AAAA;
const GRIS: u32 = 0xAAAAAA;
const BLANCO: u32 = 0xFFFFFF;
const AMARILLO: u32 = 0xFFFF55;
const VERDE: u32 = 0x55FF55;
const MAGENTA: u32 = 0xFF55FF;
const FONDO: u32 = 0x0C0C0C;
const CIAN_CLARO: u32 = 0x55FFFF;
const ROJO_CLARO: u32 = 0xFF5555;
const GRIS_OSCURO: u32 = 0x777777;

/// Ancho de la pantalla en caracteres.
const COLS: usize = 72;
// Columnas de la tabla principal (en caracteres), despues de la marca de 2.
const C_ESTADO: usize = 12;
const C_NOMBRE: usize = 18;
const C_DONDE: usize = 9;
const C_HACE: usize = 6;
/// Alto de letra en px logicos (a 96 dpi).
const LETRA: i32 = 15;
// Columnas del menu: " ≡ FLOTA   Principal   Salud   Ayuda".
const MENU_PRINCIPAL: (i32, i32) = (11, 20);
const MENU_SALUD: (i32, i32) = (23, 28);
const MENU_AYUDA: (i32, i32) = (31, 36);

/// Lo ultimo leido por los hilos. `None` = todavia no hay lectura.
struct Datos {
    sesiones: Option<Result<Vec<Sesion>, String>>,
    servidores: Option<(Vec<Instancia>, Vec<String>)>,
    con_servidores: bool,
    dispositivos: Vec<String>,
    salud: Vec<Salud>,
}

static DATOS: Mutex<Datos> = Mutex::new(Datos {
    sesiones: None,
    servidores: None,
    con_servidores: false,
    dispositivos: Vec::new(),
    salud: Vec::new(),
});
static CONFIG: OnceLock<Config> = OnceLock::new();
static VENTANA: AtomicUsize = AtomicUsize::new(0);
/// Mensaje que Windows manda cuando el Explorador se reinicia: hay que volver a poner el icono.
static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);

/// Pantalla a la vista: 0 Principal, 1 Salud, 2 Ayuda.
static PESTANA: AtomicU8 = AtomicU8::new(0);
static PEDIR_SALUD: AtomicBool = AtomicBool::new(false);
static PEDIR_SERVIDORES: AtomicBool = AtomicBool::new(false);
static PEDIR_LOCAL: AtomicBool = AtomicBool::new(false);
/// La ventana tiene el teclado.
static ACTIVA: AtomicBool = AtomicBool::new(false);
/// Tamano de celda del ultimo pintado (px), para saber que se cliqueo.
static CW: AtomicI32 = AtomicI32::new(8);
static CH: AtomicI32 = AtomicI32::new(16);

/// Estado de la interfaz.
struct Ui {
    /// Fila bajo el cursor de teclado, por pantalla (principal, salud).
    cursor: [usize; 2],
    /// Clave de la fila elegida (Enter o clic) y dispositivo elegido.
    elegida: String,
    disp: String,
    /// Accion esperando la segunda pulsacion: (accion, clave, desde).
    pendiente: Option<(&'static str, String, Instant)>,
    /// Ultimo resultado de una accion.
    aviso: String,
    arranque: bool,
    /// Para cada renglon dibujado: indice de fila de tabla, o None.
    renglones: Vec<Option<usize>>,
}

static UI: Mutex<Ui> = Mutex::new(Ui {
    cursor: [0, 0],
    elegida: String::new(),
    disp: String::new(),
    pendiente: None,
    aviso: String::new(),
    arranque: false,
    renglones: Vec::new(),
});

fn cref(rgb: u32) -> COLORREF {
    COLORREF(((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff))
}

fn px(v: i32, dpi: u32) -> i32 {
    ((v as i64 * dpi as i64 + 48) / 96) as i32
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn wide_z(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Recorta o rellena a `n` caracteres (la cuadricula manda).
fn col(t: &str, n: usize) -> String {
    let mut s: String = t.chars().take(n).collect();
    let largo = s.chars().count();
    if largo < n {
        s.push_str(&" ".repeat(n - largo));
    }
    s
}

/// "hace cuanto" corto: 5m, 3h, 6d.
fn hace(epoch: u64) -> String {
    if epoch == 0 {
        return "-".into();
    }
    let m = datos::ahora().saturating_sub(epoch) / 60;
    if m < 60 {
        format!("{m}m")
    } else if m < 48 * 60 {
        format!("{}h", m / 60)
    } else {
        format!("{}d", m / 1440)
    }
}

fn fuente(dpi: u32) -> HFONT {
    unsafe {
        CreateFontW(
            -px(LETRA, dpi),
            0,
            0,
            0,
            FW_NORMAL.0 as i32,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            CLEARTYPE_QUALITY,
            FF_DONTCARE.0 as u32,
            w!("Consolas"),
        )
    }
}

/// Tamano de una celda de caracter con la fuente puesta en `hdc`.
fn celda(hdc: HDC) -> (i32, i32) {
    let m = wide("M");
    let mut s = SIZE::default();
    unsafe {
        let _ = GetTextExtentPoint32W(hdc, &m, &mut s);
    }
    (s.cx.max(1), s.cy.max(1))
}

/// Un renglon de la pantalla: pedazos de texto con su color de letra y de fondo.
struct Pedazo {
    t: String,
    fg: u32,
    bg: u32,
}

fn p(t: &str, fg: u32, bg: u32) -> Pedazo {
    Pedazo {
        t: t.to_string(),
        fg,
        bg,
    }
}

fn hora() -> String {
    let t = unsafe { GetLocalTime() };
    format!(
        "{:02}/{:02} {:02}:{:02}",
        t.wDay, t.wMonth, t.wHour, t.wMinute
    )
}

/// Lo que se va dibujando: renglones y, por renglon, a que fila de tabla apunta.
struct Lienzo {
    r: Vec<Vec<Pedazo>>,
    map: Vec<Option<usize>>,
}

impl Lienzo {
    fn push(&mut self, renglon: Vec<Pedazo>, fila: Option<usize>) {
        self.r.push(renglon);
        self.map.push(fila);
    }
    fn linea(&mut self, t: &str, fg: u32) {
        self.push(vec![p(&col(&format!("  {t}"), COLS), fg, FONDO)], None);
    }
    fn franja(&mut self, t: &str, fg: u32, bg: u32) {
        self.push(vec![p(&col(t, COLS), fg, bg)], None);
    }
    /// Ventana azul de borde sencillo con titulo, como las de Turbo Pascal. Cada linea son
    /// pedazos (texto, color) sobre el azul; lo que no cabe se recorta.
    fn ventana(&mut self, titulo: &str, lineas: &[Vec<(String, u32)>]) {
        let ancho = COLS - 2;
        let tit = format!(" {titulo} ");
        let arriba = format!(
            "┌─{}{}┐",
            col(&tit, tit.chars().count().min(ancho - 2)),
            "─".repeat(ancho.saturating_sub(1 + tit.chars().count()))
        );
        self.push(vec![p(&col(&arriba, COLS), BLANCO, AZUL)], None);
        for l in lineas {
            let mut v = vec![p("│ ", BLANCO, AZUL)];
            let mut quedan = ancho - 1;
            for (t, c) in l {
                let t = col(t, t.chars().count().min(quedan));
                quedan -= t.chars().count();
                v.push(p(&t, *c, AZUL));
            }
            v.push(p(&" ".repeat(quedan), BLANCO, AZUL));
            v.push(p("│", BLANCO, AZUL));
            self.push(v, None);
        }
        self.push(
            vec![p(&format!("└{}┘", "─".repeat(ancho)), BLANCO, AZUL)],
            None,
        );
    }
}

/// Dos datos por linea: titulo en amarillo, valor en blanco.
fn par(a: &str, va: &str, b: &str, vb: &str) -> Vec<(String, u32)> {
    // Sin segundo dato, el valor usa todo el ancho (rutas largas).
    if b.is_empty() {
        return vec![(col(a, 11), AMARILLO), (va.to_string(), BLANCO)];
    }
    vec![
        (col(a, 11), AMARILLO),
        (col(va, 26), BLANCO),
        (col(b, 12), AMARILLO),
        (vb.to_string(), BLANCO),
    ]
}

/// Una fila de la tabla principal.
struct Fila {
    clave: String,
    estado: &'static str,
    color: u32,
    nombre: String,
    host: String,
    donde: String,
    carpeta: String,
    ruta: String,
    hace: u64,
    /// Solo las instancias de servidor tienen acciones.
    inst: Option<Instancia>,
}

fn filas_principal(d: &Datos) -> Vec<Fila> {
    let mut v = Vec::new();
    if let Some(Ok(ses)) = &d.sesiones {
        for s in ses {
            let (estado, color) = if s.status == "busy" {
                ("trabajando", VERDE)
            } else {
                ("esperando", AMARILLO)
            };
            v.push(Fila {
                clave: format!("L:{}", s.name),
                estado,
                color,
                nombre: s.name.clone(),
                host: "laptop".into(),
                donde: "laptop".into(),
                carpeta: s.carpeta().into(),
                ruta: s.cwd.clone(),
                hace: s.hace,
                inst: None,
            });
        }
    }
    if let Some((insts, _)) = &d.servidores {
        for i in insts {
            let (estado, color) = if i.activa {
                ("activa", CIAN_CLARO)
            } else {
                ("apagada", GRIS_OSCURO)
            };
            v.push(Fila {
                clave: format!("I:{}/{}", i.host, i.inst),
                estado,
                color,
                nombre: i.inst.clone(),
                host: i.host.clone(),
                donde: i.host_corto(),
                carpeta: i.carpeta().into(),
                ruta: i.dir.clone(),
                hace: i.hace,
                inst: Some(i.clone()),
            });
        }
    }
    v
}

/// Lo que se dibuja (renglones de COLS caracteres) y, por renglon, a que fila de tabla apunta.
fn pantalla() -> Lienzo {
    let d = DATOS.lock().unwrap();
    let mut ui = UI.lock().unwrap();
    // Una confirmacion que no se repitio a tiempo se cancela.
    if ui
        .pendiente
        .as_ref()
        .is_some_and(|(_, _, t)| t.elapsed() > CONFIRMAR)
    {
        ui.pendiente = None;
    }
    let mut l = Lienzo {
        r: Vec::new(),
        map: Vec::new(),
    };

    // Menu arriba (gris), la pantalla actual en cian y la hora a la derecha.
    let pest = PESTANA.load(Ordering::Relaxed);
    let fondo = |n: u8| if pest == n { CIAN } else { GRIS };
    let reloj = format!(" {} ", hora());
    let usado = 11 + 9 + 3 + 5 + 3 + 5 + reloj.chars().count();
    l.push(
        vec![
            p(" ≡ FLOTA   ", NEGRO, GRIS),
            p("Principal", NEGRO, fondo(0)),
            p("   ", NEGRO, GRIS),
            p("Salud", NEGRO, fondo(1)),
            p("   ", NEGRO, GRIS),
            p("Ayuda", NEGRO, fondo(2)),
            p(&" ".repeat(COLS - usado), NEGRO, GRIS),
            p(&reloj, NEGRO, GRIS),
        ],
        None,
    );
    l.linea("", BLANCO);

    match pest {
        1 => pantalla_salud(&d, &mut ui, &mut l),
        2 => pantalla_ayuda(&ui, &mut l),
        _ => pantalla_principal(&d, &mut ui, &mut l),
    }
    l
}

/// Final comun: la barra de estado (cian, con el indicador de teclado) y la de ayuda (gris).
fn pie(l: &mut Lienzo, estado: &str, ayuda: &str) {
    l.linea("", BLANCO);
    let teclado = if ACTIVA.load(Ordering::Relaxed) {
        "teclado: AQUI"
    } else {
        "clic = teclado"
    };
    let largo = COLS.saturating_sub(teclado.chars().count() + 1);
    l.franja(&format!("{}{teclado} ", col(estado, largo)), NEGRO, CIAN);
    l.franja(ayuda, NEGRO, GRIS);
}

fn pantalla_principal(d: &Datos, ui: &mut Ui, l: &mut Lienzo) {
    let filas = filas_principal(d);
    if !filas.is_empty() {
        ui.cursor[0] = ui.cursor[0].min(filas.len() - 1);
    }

    // Informacion de lo elegido.
    match filas.iter().find(|f| f.clave == ui.elegida) {
        None => l.ventana(
            "Sesion",
            &[
                par("", "Elige una fila: flechas y Enter, o clic.", "", ""),
                vec![],
                vec![],
                vec![],
            ],
        ),
        Some(f) => {
            let estado = match f.estado {
                "activa" => "activa (RC)",
                "apagada" => "apagada",
                e => e,
            };
            let inst = f.inst.as_ref().map_or("-".to_string(), |i| i.inst.clone());
            l.ventana(
                &f.nombre,
                &[
                    par("Sesion", &f.nombre, "Estado", estado),
                    par("Servidor", &f.host, "Instancia", &inst),
                    par("Carpeta", &f.ruta, "", ""),
                    par(
                        "Actividad",
                        &if f.hace > 0 {
                            format!("hace {}", hace(f.hace))
                        } else {
                            "sin dato".into()
                        },
                        "",
                        "",
                    ),
                ],
            );
        }
    }
    if let Some((accion, clave, _)) = &ui.pendiente {
        let nombre = clave.rsplit('/').next().unwrap_or(clave);
        let tecla = match *accion {
            "reiniciar" => "R",
            "cerrar" => "E",
            _ => "L",
        };
        l.linea(
            &format!("¿{accion} {nombre}?  pulsa {tecla} otra vez"),
            ROJO_CLARO,
        );
    }
    if !ui.aviso.is_empty() {
        let color = if ui.aviso.starts_with("FALLO") {
            ROJO_CLARO
        } else {
            CIAN_CLARO
        };
        let aviso = ui.aviso.clone();
        l.linea(&aviso, color);
    }
    l.linea("", BLANCO);

    let enc = format!(
        "  {}{}{}{}{}",
        col("ESTADO", C_ESTADO),
        col("SESION", C_NOMBRE),
        col("DONDE", C_DONDE),
        col("HACE", C_HACE),
        "CARPETA"
    );
    l.franja(&enc, AZUL, GRIS);
    match &d.sesiones {
        None => l.linea("leyendo sesiones de esta maquina...", GRIS),
        Some(Err(e)) => l.linea(e, ROJO_CLARO),
        Some(Ok(v)) if v.is_empty() => l.linea("sin sesiones de Claude Code en esta maquina", GRIS),
        _ => {}
    }
    let resto = COLS - 2 - C_ESTADO - C_NOMBRE - C_DONDE - C_HACE;
    for (i, f) in filas.iter().enumerate() {
        let marca = if f.clave == ui.elegida { "► " } else { "  " };
        if i == ui.cursor[0] {
            // Cursor: barra cian de lado a lado (la seleccion en Turbo Pascal).
            let t = format!(
                "{marca}{}{}{}{}{}",
                col(f.estado, C_ESTADO),
                col(&f.nombre, C_NOMBRE),
                col(&f.donde, C_DONDE),
                col(&hace(f.hace), C_HACE),
                col(&f.carpeta, resto)
            );
            l.push(vec![p(&t, NEGRO, CIAN)], Some(i));
        } else {
            l.push(
                vec![
                    p(marca, AMARILLO, FONDO),
                    p(&col(f.estado, C_ESTADO), f.color, FONDO),
                    p(&col(&f.nombre, C_NOMBRE), BLANCO, FONDO),
                    p(&col(&f.donde, C_DONDE), GRIS, FONDO),
                    p(&col(&hace(f.hace), C_HACE), GRIS, FONDO),
                    p(&col(&f.carpeta, resto), GRIS, FONDO),
                ],
                Some(i),
            );
        }
    }
    if let Some((_, errores)) = &d.servidores {
        for e in errores {
            l.linea(e, ROJO_CLARO);
        }
    } else if d.con_servidores {
        l.linea("leyendo servidores...", GRIS);
    }

    let trab = filas.iter().filter(|f| f.estado == "trabajando").count();
    let esp = filas.iter().filter(|f| f.estado == "esperando").count();
    let mut estado = format!(" LAPTOP {trab} TRAB {esp} ESP");
    if d.con_servidores {
        let act = filas.iter().filter(|f| f.estado == "activa").count();
        let apag = filas.iter().filter(|f| f.estado == "apagada").count();
        estado.push_str(&format!(" | SERVIDORES {act} ACTIVAS {apag} APAGADAS"));
    }
    pie(
        l,
        &estado,
        " ↑↓ Enter elegir  R E L C acciones  P S Y pantallas  U actualizar  Esc",
    );
}

/// Pantalla de salud: el dispositivo elegido arriba y una fila por dispositivo.
fn pantalla_salud(d: &Datos, ui: &mut Ui, l: &mut Lienzo) {
    let color = |v: f64, amarillo: f64, rojo: f64| {
        if v >= rojo {
            ROJO_CLARO
        } else if v >= amarillo {
            AMARILLO
        } else {
            VERDE
        }
    };
    if !d.dispositivos.is_empty() {
        ui.cursor[1] = ui.cursor[1].min(d.dispositivos.len() - 1);
    }
    if ui.disp.is_empty() {
        ui.disp = d.dispositivos.first().cloned().unwrap_or_default();
    }

    // Informacion del dispositivo elegido.
    let corto = ui.disp.replacen("server", "s", 1);
    match d.salud.iter().find(|s| s.disp == ui.disp) {
        None => l.ventana(
            &corto,
            &[
                par("Disp", &corto, "Estado", "leyendo..."),
                vec![],
                vec![],
                vec![],
                vec![],
            ],
        ),
        Some(s) if !s.error.is_empty() => l.ventana(
            &corto,
            &[
                par("Disp", &corto, "Estado", "sin respuesta"),
                par("Error", &s.error, "", ""),
                vec![],
                vec![],
                vec![],
            ],
        ),
        Some(s) => {
            let memoria: Vec<String> = s
                .top
                .iter()
                .take(4)
                .map(|(kb, n)| format!("{n} {}", gb(*kb)))
                .collect();
            l.ventana(
                &corto,
                &[
                    par("Disp", &corto, "Encendido", &dias(s.up)),
                    par(
                        "CPU",
                        &s.cpu_txt(),
                        "Claude",
                        &if s.tiene_claude {
                            format!("{} procesos", s.claude)
                        } else {
                            "NO instalado".into()
                        },
                    ),
                    par(
                        "RAM",
                        &format!("{}% de {}", s.ram_pct(), gb(s.mem_total)),
                        "claude-rc",
                        &if s.rc >= 0 {
                            format!("{} activas", s.rc)
                        } else {
                            "-".into()
                        },
                    ),
                    par(
                        "Disco",
                        &format!("{}% de {} en {}", s.disco_pct(), gb(s.disk_total), s.mount),
                        "",
                        "",
                    ),
                    par("Memoria", &memoria.join("  "), "", ""),
                ],
            );
        }
    }
    l.linea("", BLANCO);

    let enc = format!(
        "  {}{}{}{}{}{}{}",
        col("DISP", 10),
        col("CPU", 10),
        col("RAM", 13),
        col("DISCO", 13),
        col("ENCEND", 9),
        col("CLAUDE", 8),
        "RC"
    );
    l.franja(&enc, AZUL, GRIS);
    let (mut alertas, mut sin_claude, mut sin_resp) = (0, 0, 0);
    for (i, disp) in d.dispositivos.iter().enumerate() {
        let corto = disp.replacen("server", "s", 1);
        let marca = if *disp == ui.disp { "► " } else { "  " };
        let celdas: Vec<Pedazo> = match d.salud.iter().find(|s| &s.disp == disp) {
            None => vec![
                p(&col(&corto, 10), BLANCO, FONDO),
                p(&col("leyendo...", COLS - 12), GRIS, FONDO),
            ],
            Some(s) if !s.error.is_empty() => {
                sin_resp += 1;
                vec![
                    p(&col(&corto, 10), BLANCO, FONDO),
                    p(&col(&s.error, COLS - 12), ROJO_CLARO, FONDO),
                ]
            }
            Some(s) => {
                let (carga, ram, disco) = (s.carga_pct(), s.ram_pct() as f64, s.disco_pct() as f64);
                if carga >= 100.0 || ram >= 85.0 || disco >= 90.0 {
                    alertas += 1;
                }
                if !s.tiene_claude {
                    sin_claude += 1;
                }
                vec![
                    p(&col(&corto, 10), BLANCO, FONDO),
                    p(&col(&s.cpu_txt(), 10), color(carga, 70.0, 100.0), FONDO),
                    p(
                        &col(&format!("{}% {}", s.ram_pct(), gb(s.mem_total)), 13),
                        color(ram, 70.0, 85.0),
                        FONDO,
                    ),
                    p(
                        &col(&format!("{}% {}", s.disco_pct(), gb(s.disk_total)), 13),
                        color(disco, 80.0, 90.0),
                        FONDO,
                    ),
                    p(&col(&dias(s.up), 9), BLANCO, FONDO),
                    if s.tiene_claude {
                        p(&col(&s.claude.to_string(), 8), BLANCO, FONDO)
                    } else {
                        p(&col("sin", 8), MAGENTA, FONDO)
                    },
                    p(
                        &col(
                            &if s.rc >= 0 {
                                s.rc.to_string()
                            } else {
                                "-".into()
                            },
                            COLS - 2 - 10 - 10 - 13 - 13 - 9 - 8,
                        ),
                        BLANCO,
                        FONDO,
                    ),
                ]
            }
        };
        if i == ui.cursor[1] {
            let t: String = celdas.iter().map(|c| c.t.as_str()).collect();
            l.push(
                vec![p(&col(&format!("{marca}{t}"), COLS), NEGRO, CIAN)],
                Some(i),
            );
        } else {
            let mut v = vec![p(marca, AMARILLO, FONDO)];
            v.extend(celdas);
            l.push(v, Some(i));
        }
    }
    let estado = format!(
        " SALUD {} disp | {} alerta | {} sin resp | {} sin Claude",
        d.dispositivos.len(),
        alertas,
        sin_resp,
        sin_claude
    );
    pie(
        l,
        &estado,
        " ↑↓ Enter elegir dispositivo  P S Y pantallas  U actualizar  Esc ocultar",
    );
}

/// Pantalla de ayuda: teclas, pantallas y significado de colores.
fn pantalla_ayuda(ui: &Ui, l: &mut Lienzo) {
    let fila = |a: &str, b: &str| vec![(col(a, 18), AMARILLO), (b.to_string(), BLANCO)];
    l.ventana(
        "Teclado (con la ventana activa: la barra cian dice 'teclado: AQUI')",
        &[
            fila("clic", "da el teclado a la ventana; en una fila, la elige"),
            fila("↑ ↓ AvPag Inicio", "mover el cursor (barra cian)"),
            fila("Enter o →", "elegir la fila (marca ►)"),
            fila("R  E  L", "reiniciar, cerrar, levantar (pulsar dos veces)"),
            fila("C", "copiar la url de claude.ai de la instancia"),
            fila("P  S  Y", "pantallas Principal, Salud y aYuda"),
            fila("U", "actualizar todo ya"),
            fila("I", "iniciar con Windows (prende / apaga)"),
            fila("Esc", "ocultar; vuelve desde el icono de la bandeja"),
        ],
    );
    l.linea("", BLANCO);
    l.ventana(
        "Colores y estados",
        &[
            fila("trabajando", "sesion de esta maquina procesando un turno"),
            fila(
                "esperando",
                "sesion de esta maquina esperando instrucciones",
            ),
            fila("activa", "instancia de claude-rc corriendo en un servidor"),
            fila("apagada", "instancia detenida; se levanta con L"),
            fila("HACE", "ultima actividad de su conversacion"),
            fila("sin (Salud)", "el dispositivo no tiene Claude Code"),
            fila("verde/amar/rojo", "salud: bien / vigilar / atencion"),
        ],
    );
    let arranque = if ui.arranque { "SI" } else { "NO" };
    pie(
        l,
        " AYUDA",
        &format!(" P S Y pantallas  I iniciar con Windows: {arranque}  Esc ocultar"),
    );
}

fn medidas(hwnd: HWND, dpi: u32) -> (i32, i32) {
    let filas = pantalla().r.len();
    unsafe {
        let hdc = GetDC(Some(hwnd));
        let f = fuente(dpi);
        let viejo = SelectObject(hdc, HGDIOBJ(f.0));
        let (cw, ch) = celda(hdc);
        SelectObject(hdc, viejo);
        let _ = DeleteObject(HGDIOBJ(f.0));
        ReleaseDC(Some(hwnd), hdc);
        (cw * COLS as i32, ch * filas as i32)
    }
}

fn redibujar(hwnd: HWND) {
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    let (w, h) = medidas(hwnd, dpi);
    unsafe {
        let _ = SetWindowPos(hwnd, None, 0, 0, w, h, SWP_NOMOVE | SWP_NOZORDER);
        let _ = InvalidateRect(Some(hwnd), None, false);
    }
}

fn pintar(hwnd: HWND) {
    unsafe {
        let mut ps = PAINTSTRUCT::default();
        let hdc = BeginPaint(hwnd, &mut ps);
        let mut rc = RECT::default();
        let _ = GetClientRect(hwnd, &mut rc);
        let (w, h) = (rc.right - rc.left, rc.bottom - rc.top);

        // Doble bufer.
        let mem = CreateCompatibleDC(Some(hdc));
        let bmp = CreateCompatibleBitmap(hdc, w, h);
        let viejo_bmp = SelectObject(mem, HGDIOBJ(bmp.0));
        let f = fuente(GetDpiForWindow(hwnd));
        let viejo_f = SelectObject(mem, HGDIOBJ(f.0));
        SetBkMode(mem, TRANSPARENT);
        let (cw, ch) = celda(mem);
        CW.store(cw, Ordering::Relaxed);
        CH.store(ch, Ordering::Relaxed);

        let fondo = CreateSolidBrush(cref(FONDO));
        FillRect(mem, &rc, fondo);
        let _ = DeleteObject(HGDIOBJ(fondo.0));

        let lienzo = pantalla();
        UI.lock().unwrap().renglones = lienzo.map;
        for (fila, renglon) in lienzo.r.iter().enumerate() {
            let mut x = 0;
            let y = fila as i32 * ch;
            for pz in renglon {
                let n = pz.t.chars().count() as i32;
                let caja = RECT {
                    left: x,
                    top: y,
                    right: x + n * cw,
                    bottom: y + ch,
                };
                let b = CreateSolidBrush(cref(pz.bg));
                FillRect(mem, &caja, b);
                let _ = DeleteObject(HGDIOBJ(b.0));
                SetTextColor(mem, cref(pz.fg));
                // Caracter por caracter en su celda: la cuadricula queda exacta aunque un
                // simbolo (como los de borde) no mida lo mismo que una letra.
                for (i, c) in pz.t.chars().enumerate() {
                    let mut buf = [0u16; 2];
                    let s = c.encode_utf16(&mut buf);
                    let _ = TextOutW(mem, x + i as i32 * cw, y, s);
                }
                x += n * cw;
            }
        }

        let _ = BitBlt(hdc, 0, 0, w, h, Some(mem), 0, 0, SRCCOPY);
        SelectObject(mem, viejo_f);
        let _ = DeleteObject(HGDIOBJ(f.0));
        SelectObject(mem, viejo_bmp);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(mem);
        let _ = EndPaint(hwnd, &ps);
    }
}

fn avisar_ventana() {
    let h = VENTANA.load(Ordering::Relaxed);
    if h != 0 {
        unsafe {
            let _ = PostMessageW(
                Some(HWND(h as *mut core::ffi::c_void)),
                WM_DATOS,
                WPARAM(0),
                LPARAM(0),
            );
        }
    }
}

fn cambiar_pestana(n: u8) {
    PESTANA.store(n, Ordering::Relaxed);
    if n == 1 {
        PEDIR_SALUD.store(true, Ordering::Relaxed);
    }
}

/// Elige la fila bajo el cursor (Enter o clic).
fn elegir() {
    let pest = PESTANA.load(Ordering::Relaxed);
    let d = DATOS.lock().unwrap();
    let mut ui = UI.lock().unwrap();
    if pest == 0 {
        if let Some(f) = filas_principal(&d).get(ui.cursor[0]) {
            ui.elegida = f.clave.clone();
            ui.pendiente = None;
        }
    } else if pest == 1
        && let Some(dv) = d.dispositivos.get(ui.cursor[1])
    {
        ui.disp = dv.clone();
    }
}

fn mover(delta: i64) {
    let pest = PESTANA.load(Ordering::Relaxed) as usize;
    if pest > 1 {
        return;
    }
    let n = {
        let d = DATOS.lock().unwrap();
        if pest == 0 {
            filas_principal(&d).len()
        } else {
            d.dispositivos.len()
        }
    };
    if n == 0 {
        return;
    }
    let mut ui = UI.lock().unwrap();
    ui.cursor[pest] = (ui.cursor[pest] as i64 + delta).clamp(0, n as i64 - 1) as usize;
}

/// Reiniciar, cerrar o levantar la instancia elegida: la primera pulsacion arma, la segunda
/// (antes de CONFIRMAR) ejecuta en un hilo aparte. Copiar url no pide confirmacion.
fn accion(nombre: &'static str) {
    if PESTANA.load(Ordering::Relaxed) != 0 {
        return;
    }
    let inst = {
        let d = DATOS.lock().unwrap();
        let ui = UI.lock().unwrap();
        filas_principal(&d)
            .into_iter()
            .find(|f| f.clave == ui.elegida)
            .and_then(|f| f.inst)
    };
    let Some(inst) = inst else { return };
    // Cada accion solo tiene sentido en su estado: levantar las apagadas, lo demas las activas.
    if (nombre == "levantar") == inst.activa {
        return;
    }
    let clave = format!("{}/{}", inst.host, inst.inst);
    if nombre != "url" {
        let mut ui = UI.lock().unwrap();
        let armada = ui
            .pendiente
            .as_ref()
            .is_some_and(|(a, c, t)| *a == nombre && *c == clave && t.elapsed() <= CONFIRMAR);
        if !armada {
            ui.pendiente = Some((nombre, clave, Instant::now()));
            return;
        }
        ui.pendiente = None;
        ui.aviso = format!("{nombre} {}...", inst.inst);
    }
    let Some(cfg) = CONFIG.get() else { return };
    let cfg = cfg.clone();
    thread::spawn(move || {
        let orden = match nombre {
            "reiniciar" => "restart",
            "cerrar" => "down",
            "levantar" => "up",
            _ => "url",
        };
        let r = datos::claude_rc(&cfg, &inst.host, &[orden, &inst.inst]);
        let texto = match (nombre, r) {
            ("url", Ok(salida)) => {
                match salida.split_whitespace().find(|t| t.starts_with("http")) {
                    Some(url) => match datos::copiar(url) {
                        Ok(()) => format!("URL de {} copiada", inst.inst),
                        Err(e) => format!("FALLO al copiar: {e}"),
                    },
                    None => format!("FALLO: {} no devolvio url", inst.inst),
                }
            }
            (_, Ok(salida)) => format!(
                "OK {nombre} {}: {}",
                inst.inst,
                salida.chars().take(50).collect::<String>()
            ),
            (_, Err(e)) => format!("FALLO {nombre} {}: {e}", inst.inst),
        };
        UI.lock().unwrap().aviso = texto;
        PEDIR_SERVIDORES.store(true, Ordering::Relaxed);
        avisar_ventana();
    });
}

fn actualizar_todo() {
    PEDIR_LOCAL.store(true, Ordering::Relaxed);
    PEDIR_SERVIDORES.store(true, Ordering::Relaxed);
    PEDIR_SALUD.store(true, Ordering::Relaxed);
}

// ---------------------------------------------------------------------------------------
// Bandeja.

fn icono_bandeja(hwnd: HWND, poner: bool) {
    let mut nid = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: hwnd,
        uID: TRAY_ID,
        uFlags: NIF_ICON | NIF_MESSAGE | NIF_TIP,
        uCallbackMessage: WM_TRAY,
        hIcon: unsafe { LoadIconW(None, IDI_APPLICATION).unwrap_or(HICON::default()) },
        ..Default::default()
    };
    for (i, c) in "flota: sesiones y salud"
        .encode_utf16()
        .take(nid.szTip.len() - 1)
        .enumerate()
    {
        nid.szTip[i] = c;
    }
    unsafe {
        let _ = Shell_NotifyIconW(if poner { NIM_ADD } else { NIM_DELETE }, &nid);
    }
}

fn mostrar_ocultar(hwnd: HWND) {
    unsafe {
        if IsWindowVisible(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_HIDE);
        } else {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = SetForegroundWindow(hwnd);
            redibujar(hwnd);
        }
    }
}

/// Menu de la bandeja (tambien con clic derecho sobre la ventana).
fn menu(hwnd: HWND) {
    unsafe {
        let Ok(m) = CreatePopupMenu() else { return };
        let visible = IsWindowVisible(hwnd).as_bool();
        let arranque = UI.lock().unwrap().arranque;
        let txt = |s: &str| wide_z(s);
        let mostrar = txt(if visible { "Ocultar" } else { "Mostrar" });
        let actualizar = txt("Actualizar");
        let inicio_w = txt("Iniciar con Windows");
        let salir = txt("Salir");
        let _ = AppendMenuW(m, MF_STRING, ID_MOSTRAR, PCWSTR(mostrar.as_ptr()));
        let _ = AppendMenuW(m, MF_STRING, ID_ACTUALIZAR, PCWSTR(actualizar.as_ptr()));
        let _ = AppendMenuW(
            m,
            if arranque {
                MF_STRING | MF_CHECKED
            } else {
                MF_STRING
            },
            ID_ARRANQUE,
            PCWSTR(inicio_w.as_ptr()),
        );
        let _ = AppendMenuW(m, MF_SEPARATOR, 0, PCWSTR::null());
        let _ = AppendMenuW(m, MF_STRING, ID_SALIR, PCWSTR(salir.as_ptr()));
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        // Sin esto el menu no se cierra al hacer clic fuera.
        let _ = SetForegroundWindow(hwnd);
        let elegido = TrackPopupMenu(
            m,
            TPM_RIGHTBUTTON | TPM_BOTTOMALIGN | TPM_RETURNCMD,
            pt.x,
            pt.y,
            Some(0),
            hwnd,
            None,
        );
        let _ = DestroyMenu(m);
        match elegido.0 as usize {
            ID_MOSTRAR => mostrar_ocultar(hwnd),
            ID_ACTUALIZAR => actualizar_todo(),
            ID_ARRANQUE => {
                let quedo = inicio::alternar_arranque();
                UI.lock().unwrap().arranque = quedo;
                redibujar(hwnd);
            }
            ID_SALIR => {
                let _ = DestroyWindow(hwnd);
            }
            _ => {}
        }
    }
}

extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let taskbar = TASKBAR_CREATED.load(Ordering::Relaxed);
    if taskbar != 0 && msg == taskbar {
        // El Explorador se reinicio: el icono de la bandeja se perdio.
        icono_bandeja(hwnd, true);
        return LRESULT(0);
    }
    match msg {
        // El menu y las filas reciben clics; el resto arrastra la ventana.
        WM_NCHITTEST => {
            let (x, y) = (
                (lparam.0 & 0xffff) as i16 as i32,
                ((lparam.0 >> 16) & 0xffff) as i16 as i32,
            );
            let mut pt = POINT { x, y };
            unsafe {
                let _ = ScreenToClient(hwnd, &mut pt);
            }
            let fila = (pt.y / CH.load(Ordering::Relaxed).max(1)) as usize;
            let es_fila = UI
                .lock()
                .unwrap()
                .renglones
                .get(fila)
                .is_some_and(|f| f.is_some());
            if fila == 0 || es_fila {
                LRESULT(HTCLIENT as isize)
            } else {
                LRESULT(HTCAPTION as isize)
            }
        }
        WM_LBUTTONUP => {
            let x = (lparam.0 & 0xffff) as i16 as i32;
            let y = ((lparam.0 >> 16) & 0xffff) as i16 as i32;
            let columna = x / CW.load(Ordering::Relaxed).max(1);
            let renglon = (y / CH.load(Ordering::Relaxed).max(1)) as usize;
            if renglon == 0 {
                if (MENU_PRINCIPAL.0..MENU_PRINCIPAL.1).contains(&columna) {
                    cambiar_pestana(0);
                } else if (MENU_SALUD.0..MENU_SALUD.1).contains(&columna) {
                    cambiar_pestana(1);
                } else if (MENU_AYUDA.0..MENU_AYUDA.1).contains(&columna) {
                    cambiar_pestana(2);
                }
            } else {
                let fila = UI.lock().unwrap().renglones.get(renglon).copied().flatten();
                if let Some(i) = fila {
                    let pest = PESTANA.load(Ordering::Relaxed) as usize;
                    if pest <= 1 {
                        UI.lock().unwrap().cursor[pest] = i;
                        elegir();
                    }
                }
            }
            redibujar(hwnd);
            LRESULT(0)
        }
        WM_KEYDOWN => {
            match wparam.0 {
                VK_ESCAPE => unsafe {
                    let _ = ShowWindow(hwnd, SW_HIDE);
                    return LRESULT(0);
                },
                VK_UP => mover(-1),
                VK_DOWN => mover(1),
                VK_PRIOR => mover(-10),
                VK_NEXT => mover(10),
                VK_HOME => mover(-1000),
                VK_END => mover(1000),
                VK_RETURN | VK_RIGHT => elegir(),
                0x50 => cambiar_pestana(0),  // P
                0x53 => cambiar_pestana(1),  // S
                0x59 => cambiar_pestana(2),  // Y
                0x52 => accion("reiniciar"), // R
                0x45 => accion("cerrar"),    // E
                0x4C => accion("levantar"),  // L
                0x43 => accion("url"),       // C
                0x55 => actualizar_todo(),   // U
                0x49 => {
                    // I: iniciar con Windows
                    let quedo = inicio::alternar_arranque();
                    UI.lock().unwrap().arranque = quedo;
                }
                _ => return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
            }
            redibujar(hwnd);
            LRESULT(0)
        }
        // La barra de estado dice si la ventana tiene el teclado.
        WM_ACTIVATE => {
            ACTIVA.store((wparam.0 & 0xffff) != 0, Ordering::Relaxed);
            unsafe {
                let _ = InvalidateRect(Some(hwnd), None, false);
            }
            LRESULT(0)
        }
        WM_TRAY => {
            match (lparam.0 & 0xffff) as u32 {
                WM_LBUTTONUP => mostrar_ocultar(hwnd),
                WM_RBUTTONUP => menu(hwnd),
                _ => {}
            }
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_PAINT => {
            pintar(hwnd);
            LRESULT(0)
        }
        WM_DATOS | WM_TIMER | WM_DPICHANGED => {
            redibujar(hwnd);
            LRESULT(0)
        }
        // Al soltar la ventana se guarda su posicion.
        WM_EXITSIZEMOVE => {
            let mut rc = RECT::default();
            unsafe {
                let _ = GetWindowRect(hwnd, &mut rc);
            }
            inicio::guardar_posicion(rc.left, rc.top);
            LRESULT(0)
        }
        // Clic derecho sobre una zona de arrastre: el mismo menu de la bandeja.
        WM_NCRBUTTONUP => {
            menu(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            icono_bandeja(hwnd, false);
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// Posicion guardada si sigue dentro del escritorio; si no, arriba a la derecha.
fn posicion_inicial() -> (i32, i32) {
    unsafe {
        let (vx, vy) = (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
        );
        let (vw, vh) = (
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        );
        match inicio::leer_posicion() {
            Some((x, y)) if x >= vx && y >= vy && x < vx + vw - 100 && y < vy + vh - 100 => (x, y),
            _ => (GetSystemMetrics(SM_CXSCREEN) - 760, 60),
        }
    }
}

/// Hilo que repite `leer` cada `cada`, o antes si se pide con `pedir`; `activo` decide si toca.
fn ciclo(
    cada: Duration,
    pedir: &'static AtomicBool,
    activo: fn() -> bool,
    leer: impl Fn() + Send + 'static,
) {
    thread::spawn(move || {
        let mut ultima: Option<Instant> = None;
        loop {
            let pedido = pedir.swap(false, Ordering::Relaxed);
            if activo() && (pedido || ultima.is_none_or(|t| t.elapsed() >= cada)) {
                ultima = Some(Instant::now());
                leer();
                avisar_ventana();
            }
            thread::sleep(Duration::from_millis(500));
        }
    });
}

pub fn run() {
    unsafe {
        // Una sola instancia.
        let _mutex = CreateMutexW(None, true, MUTEX_NAME);
        if GetLastError() == ERROR_ALREADY_EXISTS {
            return;
        }
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        TASKBAR_CREATED.store(
            RegisterWindowMessageW(w!("TaskbarCreated")),
            Ordering::Relaxed,
        );
        let hinst = GetModuleHandleW(None).unwrap_or_default();
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(wndproc),
            hInstance: hinst.into(),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            lpszClassName: CLASS_NAME,
            ..Default::default()
        };
        RegisterClassExW(&wc);

        let cfg = datos::leer_config();
        {
            let mut d = DATOS.lock().unwrap();
            d.con_servidores = !cfg.hosts.is_empty();
            d.dispositivos = cfg.dispositivos.clone();
        }
        UI.lock().unwrap().arranque = inicio::arranca_con_windows();
        let _ = CONFIG.set(cfg);

        let (x, y) = posicion_inicial();
        let hwnd = match CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
            CLASS_NAME,
            w!("flota"),
            WS_POPUP,
            x,
            y,
            700,
            200,
            None,
            None,
            Some(hinst.into()),
            None,
        ) {
            Ok(h) => h,
            Err(_) => return,
        };
        VENTANA.store(hwnd.0 as usize, Ordering::Relaxed);
        icono_bandeja(hwnd, true);
        redibujar(hwnd);
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        SetTimer(Some(hwnd), TIMER_RELOJ, 20_000, None);

        // Sesiones de esta maquina, cada 15 s.
        ciclo(
            CADA_LOCAL,
            &PEDIR_LOCAL,
            || true,
            || {
                let v = datos::leer_sesiones();
                DATOS.lock().unwrap().sesiones = Some(v);
            },
        );
        // Servidores (instancias y su actividad), cada 60 s o al pedirlo tras una accion.
        ciclo(
            CADA_SERVIDORES,
            &PEDIR_SERVIDORES,
            || CONFIG.get().is_some_and(|c| !c.hosts.is_empty()),
            || {
                if let Some(cfg) = CONFIG.get() {
                    let v = datos::leer_servidores(cfg);
                    DATOS.lock().unwrap().servidores = Some(v);
                }
            },
        );
        // Salud, cada 60 s y solo con su pantalla a la vista; los dispositivos en paralelo.
        ciclo(
            CADA_SALUD,
            &PEDIR_SALUD,
            || PESTANA.load(Ordering::Relaxed) == 1,
            || {
                let Some(cfg) = CONFIG.get() else { return };
                let hilos: Vec<_> = cfg
                    .dispositivos
                    .iter()
                    .map(|dv| {
                        let (ssh, dv) = (cfg.ssh.clone(), dv.clone());
                        thread::spawn(move || salud::leer_salud(&ssh, &dv))
                    })
                    .collect();
                let v: Vec<Salud> = hilos.into_iter().filter_map(|h| h.join().ok()).collect();
                DATOS.lock().unwrap().salud = v;
            },
        );

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).into() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
