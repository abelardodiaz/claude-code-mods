//! flota-widget: widget nativo de Windows (Win32 + GDI, sin WebView) con las sesiones de
//! Claude Code de esta maquina, al estilo Turbo Pascal del mod `flota`.
//!
//! Pantallas: Principal (sesiones de esta maquina e instancias de claude-rc de los servidores)
//! y Salud (CPU, RAM, disco y procesos de cada dispositivo).

#![cfg_attr(not(test), windows_subsystem = "windows")]

#[cfg(not(windows))]
compile_error!("flota-widget es solo para Windows");

mod app;
mod datos;
mod inicio;
mod salud;

fn main() {
    app::run();
}
