export type Sesion = {
  name: string
  ref: string
  kind: string
  status: string
}

export type Foto = {
  sesiones: Sesion[]
  at: number
  error: string
}

// Una instancia de claude-rc en un servidor (salida de `claude-rc ls`).
export type Instancia = {
  host: string
  inst: string
  active: boolean
  dir: string
}

export type Servidores = {
  instancias: Instancia[]
  at: number
  error: string
}

// Accion que espera la segunda pulsacion para ejecutarse.
export type Pendiente = {
  accion: string
  host: string
  inst: string
  hasta: number
}

// Ultimo mensaje del asistente de una sesion y lo que Jev dijo de el.
// Clave: el nombre de la sesion (local) o "<host>/<instancia>" (servidor).
// necesita/atorada: probabilidad 0-1 de Jev; -1 = sin juicio (sin key, sin texto o fallo).
export type Registro = {
  texto: string
  at: number
  necesita: number
  atorada: number
  error: string
  juzgado: string
}

// Salud de un dispositivo (pantalla de salud). KB y segundos; -1 = no aplica.
export type Salud = {
  disp: string
  error: string
  at: number
  up: number
  load: number
  cpupct: number
  cpus: number
  memTotal: number
  memAvail: number
  diskTotal: number
  diskUsed: number
  mount: string
  claude: number
  rc: number
  tieneClaude: boolean
  top: { kb: number; nombre: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    flota: {
      foto: Foto
      servidores: Servidores
      verFuera: boolean
      verApagadas: boolean
      verMensajes: boolean
      pendiente: Pendiente
      aviso: string
      actividad: Record<string, Registro>
      errorActividad: string
      pantalla: 'sesiones' | 'salud' | 'ayuda'
      salud: Record<string, Salud>
      dispSel: string
      filaSel: string
      verTips: boolean
    }
  }
}
