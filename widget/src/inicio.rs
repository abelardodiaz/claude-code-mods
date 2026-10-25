//! "Iniciar con Windows" y la posicion de la ventana.
//!
//! - El arranque vive en HKCU\Software\Microsoft\Windows\CurrentVersion\Run, valor FlotaWidget.
//!   Se maneja con reg.exe para no sumar dependencias del registro.
//! - La posicion se guarda en %APPDATA%\flota-widget\estado.json al soltar la ventana.

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CLAVE: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const VALOR: &str = "FlotaWidget";

fn reg(args: &[&str]) -> bool {
    Command::new("reg")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .is_ok_and(|o| o.status.success())
}

pub fn arranca_con_windows() -> bool {
    reg(&["query", CLAVE, "/v", VALOR])
}

/// Prende o apaga el arranque con Windows. Devuelve como quedo.
pub fn alternar_arranque() -> bool {
    if arranca_con_windows() {
        reg(&["delete", CLAVE, "/v", VALOR, "/f"]);
    } else if let Ok(exe) = std::env::current_exe() {
        let ruta = format!("\"{}\"", exe.display());
        reg(&["add", CLAVE, "/v", VALOR, "/t", "REG_SZ", "/d", &ruta, "/f"]);
    }
    arranca_con_windows()
}

fn archivo_estado() -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var_os("APPDATA")?).join("flota-widget");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("estado.json"))
}

pub fn leer_posicion() -> Option<(i32, i32)> {
    let texto = std::fs::read_to_string(archivo_estado()?).ok()?;
    let v: serde_json::Value = serde_json::from_str(&texto).ok()?;
    Some((v["x"].as_i64()? as i32, v["y"].as_i64()? as i32))
}

pub fn guardar_posicion(x: i32, y: i32) {
    if let Some(ruta) = archivo_estado() {
        let _ = std::fs::write(ruta, serde_json::json!({ "x": x, "y": y }).to_string());
    }
}
