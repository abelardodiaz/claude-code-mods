# Claude Code mods

Small mods (function-hook plugins) that add live panes and buttons to Claude Code.

*Versión en español abajo.*

## flota

A Turbo Pascal style pane, inside Claude Code, for your fleet of Claude Code sessions and the machines they run on. Three screens, switched from the menu bar at the top:

- **Principal**: every session you have (this one, other local sessions and Remote Control sessions) with its state (working, waiting, closing, offline), where it runs, and how long ago it last wrote. If your servers run sessions with `claude-rc` (systemd + tmux), it shows the server and instance of each one, flags instances that are up with no session, and lists stopped instances you can start. Pick a row with Enter or a click and its icons appear: **↻** restart, **X** close (frees its RAM), **⎘** copy its claude.ai/code link. Restart and close ask for a second press.
- **Salud** (health): CPU, RAM, disk, uptime and Claude processes of every device you list (laptop, servers, even a phone with Termux), with yellow/red warnings, a flag for devices without Claude Code, and the processes using the most memory on the one you pick.
- **Ayuda** (help): keys, shortcuts, states and commands.

A **Tips** button in the menu turns on a bar with the shortcuts of the current screen.

### Keyboard

Focus the pane with `Ctrl+X Tab`; `Esc` goes back to the prompt. Tab and the arrows move between rows and buttons, Enter presses. With the pane focused, letters work as shortcuts: `p s y` screens, `t` tips, `r e c` restart / close / copy url on the chosen row, `o a u` show offline, show stopped, refresh. The mouse works too.

Careful: the left arrow on an **empty prompt** (not in the pane) sends the session to the background and opens Claude Code's agent view.

### Commands

```
/flota                       open the pane
/flota parar                 stop all reads and close the pane
/flota reiniciar             forget what was read and read everything again
/flota nueva <server> <instance> <dir> [--name X]
/flota apagar <server> <instance>
```

### Install

At the prompt of a terminal session:

```
/plugin install flota --marketplace abelardodiaz/claude-code-mods
```

From a shell:

```
claude plugin install flota --marketplace abelardodiaz/claude-code-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `abelardodiaz/claude-code-mods`, then Add plugin.

Answer `y` to add the marketplace and pick a scope. The options screen asks for:

- **Servers**: comma-separated SSH hosts that run `claude-rc`, for example `vps1,vps2`. Empty means sessions only.
- **SSH command**: `ssh` by default. On Windows with your keys inside WSL use `wsl ssh`.
- **Health devices**: comma-separated devices for the health screen: `laptop` (this machine) and SSH hosts, for example `laptop,vps1,phone`.
- **TypeSafe key file**: reserved for an upcoming feature (Jev reading each session's last message); leave empty.

Then type `/flota`.

### Requirements and limits

- Session list: a Claude Code build with mods and the `ListAgents` tool.
- Servers: passwordless SSH (`BatchMode=yes`) and the `claude-rc` tool on each host (`ls`, `up`, `restart`, `down`, `new`, `url`). Sessions are matched to instances by the project number at the start of the session name (`080-agent` -> a directory containing `-080-`).
- Health: any Linux or Termux host over SSH (`/proc`, `df`, `ps`), and the local machine (PowerShell on Windows, `sh` elsewhere).
- Only simple names and paths (`A-Z a-z 0-9 _ . / -`) are passed to SSH, and only to the hosts you listed.
- Local sessions have no `claude-rc` behind them, so they get no restart, close or url actions.

## flota-widget (Windows)

The same Principal and Salud screens as a native Windows widget in `widget/` (Win32 + GDI, no WebView, one ~400 KB `.exe`), for when no Claude Code session is open. Always on top, tray icon (click shows or hides, right click opens the menu with **Start with Windows**), drag it from anywhere, `Esc` hides it.

- Local sessions come from `claude agents --json`; servers from `claude-rc ls` over SSH, like the mod.
- It reads the mod's options (`pluginConfigs["flota@claude-code-mods"]` in `~/.claude/settings.json`), so install and configure the mod first.

```powershell
cd widget
cargo build --release
# target\release\flota-widget.exe
```

---

## Español

Un panel estilo Turbo Pascal dentro de Claude Code para tu flota de sesiones y las máquinas donde corren. Tres pantallas, desde la barra de arriba:

- **Principal**: todas tus sesiones (esta, las locales y las de Remote Control) con su estado, dónde corren y hace cuánto escribieron. Con `claude-rc` en tus servidores muestra servidor e instancia, avisa de instancias activas sin sesión y lista las apagadas para levantarlas. Eliges una fila con Enter o clic y aparecen sus iconos: **↻** reiniciar, **X** cerrar (libera su RAM), **⎘** copiar su enlace. Reiniciar y cerrar piden una segunda pulsación.
- **Salud**: CPU, RAM, disco, tiempo encendido y procesos de Claude de cada dispositivo (laptop, servidores, hasta un celular con Termux), con avisos en amarillo y rojo, marca de los que no tienen Claude Code y los procesos que más memoria usan.
- **Ayuda**: teclas, atajos, estados y comandos.

El botón **Tips** del menú prende una barra con los atajos de la pantalla actual.

Instalación: igual que arriba (`/plugin install flota --marketplace abelardodiaz/claude-code-mods`). En las opciones pon tus servidores y dispositivos separados por comas y, en Windows con las llaves en WSL, `wsl ssh` como comando de SSH. Luego escribe `/flota`.

### flota-widget (Windows)

Las mismas pantallas Principal y Salud como widget nativo de Windows en `widget/` (Win32 + GDI, sin WebView, un solo `.exe` de unos 400 KB), para cuando no tienes ninguna sesión de Claude Code abierta. Siempre encima, icono en la bandeja (clic muestra u oculta, clic derecho abre el menú con **Iniciar con Windows**), se arrastra desde cualquier punto y `Esc` lo oculta. Lee las opciones del mod, así que primero instala y configura el mod. Se compila con `cargo build --release` dentro de `widget/`.

## License

MIT
