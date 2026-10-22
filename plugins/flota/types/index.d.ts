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

declare module 'claude-code' {
  interface PluginState {
    flota: {
      foto: Foto
      servidores: Servidores
      verFuera: boolean
      verApagadas: boolean
      pendiente: Pendiente
      aviso: string
    }
  }
}
