// Jev (TypeSafe) lee el ultimo mensaje de una sesion y dice si te necesita o si esta atorada.
// Una llamada por mensaje nuevo; el resultado se guarda y no se repite mientras no cambie.

export type Juicio = { necesita: number; atorada: number; error: string }

const MODELO = 'jev-1.14.0' // version fija: la calibracion cambia entre versiones
const URL = 'https://api.typesafe.ai/v1/systemone'

let key: string | null = null

async function leerKey($: any, archivo: string): Promise<string> {
  if (key !== null) return key
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const ruta = archivo.replace(/^~/, home)
  key = String(await $.fs.read(ruta)).trim()
  return key
}

export async function juzgar($: any, archivoKey: string, sesion: string, mensaje: string): Promise<Juicio> {
  try {
    const k = await leerKey($, archivoKey)
    const body = {
      model: MODELO,
      state: { sesion, mensaje },
      questions: {
        necesita: {
          type: 'noul',
          instructions:
            'In `mensaje`, the last message an AI coding assistant wrote in its session, is the assistant waiting for the human user to answer a question, make a decision, approve something or do a manual step before it can continue?',
        },
        atorada: {
          type: 'noul',
          instructions:
            'Does `mensaje` report an error, failure or blocker that the assistant could not resolve by itself?',
        },
      },
    }
    const r = await $.http.fetch(URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    // Un fallo de API no es una decision del modelo: se reporta aparte.
    if (!r.ok) return { necesita: -1, atorada: -1, error: `HTTP ${r.status}` }
    const a = JSON.parse(r.text)?.answers ?? {}
    return { necesita: Number(a.necesita?.noul ?? -1), atorada: Number(a.atorada?.noul ?? -1), error: '' }
  } catch (err) {
    return { necesita: -1, atorada: -1, error: String(err).slice(0, 80) }
  }
}
