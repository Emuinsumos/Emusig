// Capa de datos con Firebase Realtime Database.
// TODO lo de esta app vive bajo el nodo "calibres/" (calibres/instrumentos, calibres/controles,
// calibres/tolerancias). Nunca se lee ni se escribe fuera de ese nodo, así que no se mezcla
// con los datos de otros proyectos que usen la misma base.
//
// Config: por defecto usa la base de abajo. Se puede cambiar con VITE_FIREBASE_DATABASE_URL.
// Opcional: VITE_FIREBASE_API_KEY para usar auth anónima (si las reglas de la base la piden).
// VITE_MODO_LOCAL=1 guarda en el navegador (solo pruebas).

const env = import.meta.env
const DB_URL = env.VITE_FIREBASE_DATABASE_URL || 'https://poly-51d86-default-rtdb.firebaseio.com'
const ROOT = 'calibres'
const local = env.VITE_MODO_LOCAL === '1'

export const modo = local ? 'local' : 'firebase'

const avisar = (msg) => window.dispatchEvent(new CustomEvent('calibres-error', { detail: msg }))
const traducir = (e) =>
  /permission/i.test(String(e?.message || e))
    ? 'Firebase rechazó el acceso (reglas de la base). Hay que revisar las reglas.'
    : `Error de conexión con la base: ${e?.message || e}`

let fb = null
async function getFb() {
  if (fb) return fb
  const { initializeApp } = await import('firebase/app')
  const dbm = await import('firebase/database')
  const cfg = { databaseURL: DB_URL }
  if (env.VITE_FIREBASE_API_KEY) {
    cfg.apiKey = env.VITE_FIREBASE_API_KEY
    if (env.VITE_FIREBASE_AUTH_DOMAIN) cfg.authDomain = env.VITE_FIREBASE_AUTH_DOMAIN
    if (env.VITE_FIREBASE_PROJECT_ID) cfg.projectId = env.VITE_FIREBASE_PROJECT_ID
    if (env.VITE_FIREBASE_APP_ID) cfg.appId = env.VITE_FIREBASE_APP_ID
  }
  const app = initializeApp(cfg, 'calibres')
  if (cfg.apiKey) {
    try {
      const { getAuth, signInAnonymously } = await import('firebase/auth')
      await signInAnonymously(getAuth(app))
    } catch (e) {
      console.warn('auth anónima falló', e)
    }
  }
  fb = { db: dbm.getDatabase(app), ...dbm }
  return fb
}

// ---- modo local (solo pruebas) ----
const listeners = {}
const lsKey = (c) => `${ROOT}/${c}`
function lsRead(c) {
  try { return JSON.parse(localStorage.getItem(lsKey(c)) || '{}') } catch { return {} }
}
const lsNotify = (c) => (listeners[c] || []).forEach((f) => f())

// Escucha una colección; devuelve función para desuscribirse. cb recibe { id: registro }
export function escuchar(coleccion, cb) {
  if (local) {
    cb(lsRead(coleccion))
    const fn = () => cb(lsRead(coleccion))
    listeners[coleccion] = (listeners[coleccion] || []).concat(fn)
    return () => { listeners[coleccion] = (listeners[coleccion] || []).filter((f) => f !== fn) }
  }
  let off = () => {}
  let cancelado = false
  getFb()
    .then((f) => {
      if (cancelado) return
      off = f.onValue(
        f.ref(f.db, `${ROOT}/${coleccion}`),
        (snap) => cb(snap.val() || {}),
        (e) => avisar(traducir(e))
      )
    })
    .catch((e) => avisar(traducir(e)))
  return () => { cancelado = true; off() }
}

export async function guardar(coleccion, id, valor) {
  if (local) {
    const data = lsRead(coleccion)
    data[id] = valor
    localStorage.setItem(lsKey(coleccion), JSON.stringify(data))
    lsNotify(coleccion)
    return
  }
  try {
    const f = await getFb()
    await f.set(f.ref(f.db, `${ROOT}/${coleccion}/${id}`), valor)
  } catch (e) {
    avisar(traducir(e))
    throw e
  }
}

export async function borrar(coleccion, id) {
  if (local) {
    const data = lsRead(coleccion)
    delete data[id]
    localStorage.setItem(lsKey(coleccion), JSON.stringify(data))
    lsNotify(coleccion)
    return
  }
  try {
    const f = await getFb()
    await f.remove(f.ref(f.db, `${ROOT}/${coleccion}/${id}`))
  } catch (e) {
    avisar(traducir(e))
    throw e
  }
}

export const nuevoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
