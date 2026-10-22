# Claude Code mods

Small mods (function-hook plugins) that add live panes and buttons to Claude Code.

*Versión en español abajo.*

## flota

A live pane listing every Claude Code session you have: this one, other local sessions and Remote Control sessions, grouped as working, waiting or offline. If your servers run sessions with `claude-rc` (systemd + tmux), it also shows which server and instance each session lives on, flags instances that are up but have no session, and gives you buttons:

- **restart** an instance and **url** (copies its claude.ai/code link), on each row
- **start** a stopped instance (toggle with `a`)
- show or hide offline sessions (`o`), refresh now (`r`)

Restart and start ask for a second press within 6 seconds. Typed commands run directly:

```
/flota
/flota nueva <server> <instance> <dir> [--name X]
/flota apagar <server> <instance>
```

Without servers configured it still lists your sessions.

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

Then type `/flota`.

### Requirements and limits

- Session list: any Claude Code build with mods and the `ListAgents` tool.
- Servers: passwordless SSH (`BatchMode=yes`) and the `claude-rc` tool on each host (`claude-rc ls`, `up`, `restart`, `down`, `new`, `url`). Sessions are matched to instances by the project number at the start of the session name (`080-agent` -> a directory containing `-080-`).
- Only simple names and paths (`A-Z a-z 0-9 _ . / -`) are passed to SSH, and only to the hosts you listed.

---

## Español

Un panel en vivo con todas tus sesiones de Claude Code: esta, las otras locales y las de Remote Control, agrupadas en trabajando, en espera y sin conexión. Si tus servidores corren sesiones con `claude-rc` (systemd + tmux), también dice en qué servidor e instancia vive cada una, marca las instancias activas que no tienen sesión y trae botones para **reiniciar**, copiar la **url** y **levantar** instancias apagadas. Reiniciar y levantar piden una segunda pulsación en menos de 6 segundos.

Instalación: igual que arriba (`/plugin install flota --marketplace abelardodiaz/claude-code-mods`). En las opciones pon tus servidores separados por comas y, en Windows con las llaves en WSL, `wsl ssh` como comando de SSH. Luego escribe `/flota`.

## License

MIT
