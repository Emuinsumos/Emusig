import { Component, Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { escuchar, guardar, borrar, nuevoId, modo } from './db.js'
import './calibres.css'
import { certificadoPDF } from './certificado.js'
import { certificadoRoscaPDF } from './certificadoRosca.js'
import { etiquetasPDF } from './etiquetas.js'
import { listadoMaquinaPDF } from './listado.js'
import { metodoDe, fechaHora, TEMP_REF } from './normas.js'

const TIPO_ROSCA = 'Tapón roscado'
const TIPOS = ['Vernier', 'Micrómetro', 'Alesómetro', 'Tapón P-NP', TIPO_ROSCA, 'Otro']
const esRosca = (i) => !!i && i.tipo === TIPO_ROSCA
const certificadoDe = (c, inst) => (c.tipoControl === 'rosca' ? certificadoRoscaPDF(c, inst) : certificadoPDF(c, inst))
const MODALIDADES = ['Mecánico', 'Digital']
const PUNTOS = 5 // filas disponibles en el formulario
const MIN_PUNTOS = 2 // mínimo de mediciones para poder guardar; el resto es opcional
const AVISO_DIAS = 7
const MOTIVOS = ['Mal funcionamiento', 'Golpe o caída', 'Lectura dudosa', 'Daño o desgaste visible', 'Se pasó la fecha de control', 'Otro']
const fmtHora = (ms) =>
  ms ? new Date(ms).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'

// ---------- fechas ----------
const pad = (n) => String(n).padStart(2, '0')
const aISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hoyISO = () => aISO(new Date())
const parse = (iso) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}
function sumarMeses(iso, meses) {
  if (!iso || !meses) return ''
  const d = parse(iso)
  const dia = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + Number(meses))
  const ultimo = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(dia, ultimo))
  return aISO(d)
}
function diasHasta(iso) {
  if (!iso) return null
  const hoy = parse(hoyISO())
  return Math.round((parse(iso) - hoy) / 86400000)
}
const fmt = (iso) => (iso ? iso.split('-').reverse().join('/') : '—')

const num = (s) => {
  if (s === '' || s == null) return null
  const n = parseFloat(String(s).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

// ---------- tolerancias ----------
// Clave de la tabla: tipo + modalidad (sin acentos ni símbolos, apta para Firebase)
const limpiar = (s) => s.normalize('NFD').replace(/[^a-zA-Z0-9]/g, '')
const tolKey = (tipo, modalidad) => `${limpiar(tipo)}__${limpiar(modalidad)}`
// Tolerancia propia del instrumento (si la tiene) o la de la tabla de Calidad
function tolDe(inst, tols) {
  if (esRosca(inst)) return null
  const propia = num(inst.tolerancia)
  if (propia !== null) return { valor: propia, origen: 'del instrumento' }
  const t = tols[tolKey(inst.tipo, inst.modalidad)]
  const v = t ? num(t.valor) : null
  if (v !== null) return { valor: v, origen: `ajuste de Gerencia de Calidad (${inst.tipo} ${inst.modalidad.toLowerCase()})` }
  return mpeDefault(inst)
}

// Error máximo permitido POR DEFECTO, según el tipo de instrumento y su resolución (no depende de la pieza que mida).
// Referencia: ISO 13385-1 (calibres), ISO 3611 (micrómetros de exteriores) y especificaciones de fabricantes.
// Alesómetros: no hay norma de producto, se usa el valor típico de fabricantes. Tapón P-NP y otros: sin valor por defecto.
const coma = (n) => String(n).replace('.', ',')
function mpeDefault(inst) {
  const res = num(inst.apreciacion)
  const dig = inst.modalidad === 'Digital'
  let v = null
  let origen = ''
  if (inst.tipo === 'Vernier') {
    const r = res ?? (dig ? 0.01 : 0.02)
    v = dig ? (r <= 0.01 ? 0.02 : 0.03) : r <= 0.02 ? 0.03 : r <= 0.05 ? 0.05 : 0.1
    origen = `por defecto, calibre ${dig ? 'digital' : 'mecánico'} de lectura ${coma(r)} mm (ISO 13385-1 y fabricantes)`
  } else if (inst.tipo === 'Micrómetro') {
    const rango = Math.min(num(inst.rango) ?? 25, 300)
    v = rango <= 50 ? 0.004 : Math.round((0.004 + 0.001 * Math.ceil((rango - 50) / 50)) * 1e6) / 1e6
    origen = `por defecto, micrómetro de exteriores hasta ${rango} mm (ISO 3611)`
  } else if (inst.tipo === 'Alesómetro') {
    const r = res ?? 0.01
    v = r >= 0.01 ? 0.01 : 0.003
    origen = `por defecto, alesómetro de lectura ${coma(r)} mm (valor típico de fabricantes; sin norma de producto)`
  }
  if (v === null) return null
  if (inst.tipo !== 'Micrómetro' && res !== null && res > v) { v = res; origen += ', ajustado a la apreciación' }
  return { valor: v, origen }
}

// Lista de máquinas: acepta array de textos/objetos o un objeto indexado; devuelve textos únicos ordenados.
function normMaquinas(m) {
  const arr = Array.isArray(m) ? m : Object.values(m || {})
  const out = arr
    .map((x) => (x && typeof x === 'object' ? (x.name ?? x.nombre ?? x.numero ?? x.id ?? '') : x))
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
  return [...new Set(out)].sort((a, b) => a.localeCompare(b, 'es', { numeric: true }))
}
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
const MESES_C = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

const n5 = (v) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(5))
const hayExt = (i) => !!i && ((num(i.pasaExtMin) !== null && num(i.pasaExtMax) !== null) || (num(i.nopasaExtMin) !== null && num(i.nopasaExtMax) !== null))
const extFicha = (i) => (hayExt(i) ? [['Diám. exterior PASA', limTxt(i.pasaExtMin, i.pasaExtMax)], ['Diám. exterior NO PASA', limTxt(i.nopasaExtMin, i.nopasaExtMax)]] : [])
const limTxt = (a, b) => (num(a) !== null && num(b) !== null ? `${num(a)} a ${num(b)} mm` : 'sin cargar')
// Alambre ideal (toca los flancos en el diámetro medio): d = P / (2 cos(α/2))
function alambreIdealDe(f) {
  const P = num(f.paso)
  const a = num(f.angulo) ?? 60
  if (P === null || P <= 0) return ''
  return String(Math.round((P / (2 * Math.cos((a * Math.PI) / 360))) * 1000) / 1000)
}
// Diámetro medio por tres varillas: E = M − d (1 + 1/sen(α/2)) + (P/2) cot(α/2)
function medioTresVarillas(M, d, P, angulo) {
  const a = ((num(angulo) ?? 60) * Math.PI) / 360
  return M - d * (1 + 1 / Math.sin(a)) + (P / 2) / Math.tan(a)
}

// ---------- estado ----------
function estadoDe(i) {
  if (i.activo === false) return { clase: 'na', texto: 'BAJA', orden: 9 }
  if (i.rechazado) return { clase: 'bad', texto: 'RECHAZADO', orden: 0 }
  const d = diasHasta(i.vencimiento)
  if (d === null) return { clase: 'na', texto: 'SIN FECHA', orden: 5 }
  if (d < 0) return { clase: 'bad', texto: `VENCIDO ${-d}d`, orden: 1 }
  if (d === 0) return { clase: 'warn', texto: 'VENCE HOY', orden: 2 }
  if (d <= AVISO_DIAS) return { clase: 'warn', texto: `VENCE EN ${d}d`, orden: 3 }
  return { clase: 'ok', texto: `VIGENTE ${d}d`, orden: 4 }
}

// ---------- avisos del navegador ----------
function avisarNavegador(items) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const clave = `calibres_aviso_${hoyISO()}`
  let hechos = []
  try { hechos = JSON.parse(localStorage.getItem(clave) || '[]') } catch { /* nada */ }
  const nuevos = items.filter((i) => !hechos.includes(i.id))
  if (!nuevos.length) return
  const cuerpo = nuevos.slice(0, 5).map((i) => `${i.codigo}: ${estadoDe(i).texto}`).join('\n')
  notificar('Calibres: control por vencer', cuerpo)
  try { localStorage.setItem(clave, JSON.stringify(hechos.concat(nuevos.map((i) => i.id)))) } catch { /* nada */ }
}

// Notificación segura: en Android hay que usar el service worker; si no se puede, se ignora sin romper nada.
async function notificar(titulo, cuerpo) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    if (navigator.serviceWorker) {
      const reg = await navigator.serviceWorker.getRegistration()
      if (reg && reg.showNotification) { await reg.showNotification(titulo, { body: cuerpo }); return }
    }
    new Notification(titulo, { body: cuerpo })
  } catch { /* el navegador no lo permite: no pasa nada */ }
}

// ---------- App ----------
// embebido: true cuando va dentro del SIG (oculta el título propio).
// operario: nombre del operario logueado en el SIG (se usa como responsable por defecto del control).
function CalibresApp({ embebido = false, operario = '', maquinas = [] }) {
  const listaMaq = useMemo(() => normMaquinas(maquinas), [maquinas])
  const [instrumentos, setInstrumentos] = useState({})
  const [controles, setControles] = useState({})
  const [tols, setTols] = useState({})
  const [solicitudes, setSolicitudes] = useState({})
  const [tab, setTab] = useState('panel')
  const [editando, setEditando] = useState(null) // null | 'nuevo' | id
  const [controlPara, setControlPara] = useState('')
  const [toast, setToast] = useState('')
  const [permiso, setPermiso] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported')

  useEffect(() => {
    const fn = (e) => { setToast(e.detail); setTimeout(() => setToast(''), 5000) }
    window.addEventListener('calibres-error', fn)
    return () => window.removeEventListener('calibres-error', fn)
  }, [])
  useEffect(() => escuchar('instrumentos', setInstrumentos), [])
  useEffect(() => escuchar('controles', setControles), [])
  useEffect(() => escuchar('tolerancias', setTols), [])
  useEffect(() => escuchar('solicitudes', setSolicitudes), [])

  const lista = useMemo(
    () => Object.entries(instrumentos).map(([id, v]) => ({ ...v, id })),
    [instrumentos]
  )
  const porVencer = useMemo(
    () => lista.filter((i) => ['bad', 'warn'].includes(estadoDe(i).clase)).sort((a, b) => estadoDe(a).orden - estadoDe(b).orden),
    [lista]
  )

  const solPend = useMemo(
    () => Object.entries(solicitudes).map(([id, s]) => ({ ...s, id })).filter((s) => s.estado === 'pendiente').sort((a, b) => (b.creado || 0) - (a.creado || 0)),
    [solicitudes]
  )

  // aviso del navegador al abrir y cada hora (solo funciona con la app abierta)
  useEffect(() => {
    if (!lista.length) return
    avisarNavegador(porVencer)
    const t = setInterval(() => avisarNavegador(porVencer), 3600000)
    return () => clearInterval(t)
  }, [porVencer, lista.length])

  const mostrar = (m) => {
    setToast(m)
    setTimeout(() => setToast(''), 2500)
  }

  const activarAvisos = async () => {
    if (typeof Notification === 'undefined') return mostrar('Este navegador no soporta avisos')
    const p = await Notification.requestPermission()
    setPermiso(p)
    if (p === 'granted') mostrar('Avisos activados')
  }

  const irAControl = (id) => {
    setControlPara(id)
    const inst = lista.find((i) => i.id === id)
    setTab(esRosca(inst) ? 'rosca' : 'control')
  }

  const nVenc = porVencer.length

  return (
    <div className="cal-root"><div className="app">
      {!embebido && (
        <div className="top">
          <h1>CONTROL DE <span>CALIBRES</span></h1>
          <span className={`badge-modo ${modo}`}>{modo === 'firebase' ? 'EN LÍNEA' : 'MODO PRUEBA (local)'}</span>
        </div>
      )}

      <div className="tabs">
        <button className={`tab ${tab === 'panel' ? 'on' : ''}`} onClick={() => setTab('panel')}>
          Vencimientos{nVenc > 0 && <span className="n">{nVenc}</span>}
        </button>
        <button className={`tab ${tab === 'maquinas' ? 'on' : ''}`} onClick={() => setTab('maquinas')}>Por máquina</button>
        <button className={`tab ${tab === 'calendario' ? 'on' : ''}`} onClick={() => setTab('calendario')}>Calendario</button>
        <button className={`tab ${tab === 'solicitudes' ? 'on' : ''}`} onClick={() => setTab('solicitudes')}>
          Solicitudes{solPend.length > 0 && <span className="n">{solPend.length}</span>}
        </button>
        <button className={`tab ${tab === 'escanear' ? 'on' : ''}`} onClick={() => setTab('escanear')}>Escanear</button>
        <button className={`tab ${tab === 'instrumentos' ? 'on' : ''}`} onClick={() => { setTab('instrumentos'); setEditando(null) }}>Instrumentos</button>
        <button className={`tab ${tab === 'rosca' ? 'on' : ''}`} onClick={() => setTab('rosca')}>Tapones de rosca</button>
        <button className={`tab ${tab === 'control' ? 'on' : ''}`} onClick={() => setTab('control')}>Registrar control</button>
        <button className={`tab ${tab === 'historial' ? 'on' : ''}`} onClick={() => setTab('historial')}>Historial</button>
        <button className={`tab ${tab === 'etiquetas' ? 'on' : ''}`} onClick={() => setTab('etiquetas')}>Etiquetas</button>
        <button className={`tab ${tab === 'tolerancias' ? 'on' : ''}`} onClick={() => setTab('tolerancias')}>Tolerancias</button>
      </div>

      {tab === 'panel' && (
        <Panel lista={lista} porVencer={porVencer} permiso={permiso} activarAvisos={activarAvisos} irAControl={irAControl} solPend={solPend} irASolicitudes={() => setTab('solicitudes')} />
      )}
      {tab === 'maquinas' && (
        <PorMaquina
          lista={lista} controles={controles} tols={tols} solicitudes={solicitudes} maquinas={listaMaq}
          irAControl={irAControl} mostrar={mostrar}
          editar={(id) => { setEditando(id); setTab('instrumentos') }}
        />
      )}
      {tab === 'calendario' && <Calendario lista={lista} tols={tols} maquinas={listaMaq} irAControl={irAControl} />}
      {tab === 'instrumentos' && (
        <Instrumentos
          lista={lista}
          controles={controles}
          maquinas={listaMaq}
          tols={tols}
          editando={editando}
          setEditando={setEditando}
          irAControl={irAControl}
          mostrar={mostrar}
        />
      )}
      {tab === 'control' && (
        <RegistrarControl
          lista={lista.filter((i) => i.activo !== false && !esRosca(i))}
          tols={tols}
          solicitudes={solicitudes}
          inicial={controlPara}
          operario={operario}
          mostrar={mostrar}
          alTerminar={() => { setControlPara(''); setTab('panel') }}
        />
      )}
      {tab === 'rosca' && (
        <Roscas
          lista={lista} controles={controles} solicitudes={solicitudes} inicial={controlPara} operario={operario} mostrar={mostrar}
          nuevo={() => { setEditando('nuevo-rosca'); setTab('instrumentos') }}
          editar={(id) => { setEditando(id); setTab('instrumentos') }}
          limpiarInicial={() => setControlPara('')}
        />
      )}
      {tab === 'historial' && <Historial lista={lista} controles={controles} mostrar={mostrar} />}
      {tab === 'solicitudes' && (
        <Solicitudes lista={lista} solicitudes={solicitudes} irAControl={irAControl} mostrar={mostrar} />
      )}
      {tab === 'escanear' && (
        <Escaner lista={lista} controles={controles} tols={tols} irAControl={irAControl} mostrar={mostrar} />
      )}
      {tab === 'etiquetas' && <Etiquetas lista={lista} mostrar={mostrar} />}
      {tab === 'tolerancias' && <Tolerancias tols={tols} mostrar={mostrar} />}

      {toast && <div className="toast">{toast}</div>}
    </div></div>
  )
}

// ---------- Panel ----------
function Panel({ lista, porVencer, permiso, activarAvisos, irAControl, solPend, irASolicitudes }) {
  const activos = lista.filter((i) => i.activo !== false)
  const vencidos = activos.filter((i) => estadoDe(i).clase === 'bad').length
  const proximos = activos.filter((i) => estadoDe(i).clase === 'warn').length
  const vigentes = activos.filter((i) => estadoDe(i).clase === 'ok').length
  return (
    <>
      {solPend.length > 0 && (
        <div className="card alertas">
          <div className="row">
            <div className="sp">
              <b>{solPend.length} solicitud{solPend.length > 1 ? 'es' : ''} de revisión pendiente{solPend.length > 1 ? 's' : ''}</b>
              <div className="nota">
                {solPend.slice(0, 3).map((s) => `${s.codigo} (${s.motivo})`).join(' · ')}{solPend.length > 3 ? '…' : ''}
              </div>
            </div>
            <button className="btn small" onClick={irASolicitudes}>Ver</button>
          </div>
        </div>
      )}
      <div className="resumen">
        <div className="kpi bad"><b>{vencidos}</b><span>Vencidos / rechazados</span></div>
        <div className="kpi warn"><b>{proximos}</b><span>Vencen en ≤ {AVISO_DIAS} días</span></div>
        <div className="kpi ok"><b>{vigentes}</b><span>Vigentes</span></div>
      </div>

      {porVencer.length > 0 ? (
        <div className="card alertas">
          <h2>Requieren control</h2>
          {porVencer.map((i) => {
            const e = estadoDe(i)
            return (
              <div className="alerta" key={i.id}>
                <div>
                  <b className="mono">{i.codigo}</b> · {i.tipo === 'Otro' ? i.tipoOtro || 'Otro' : i.tipo}
                  <div className="nota">A cargo de: {i.aCargo || '—'} · Vence: {fmt(i.vencimiento)}</div>
                </div>
                <div className="row">
                  <span className={`estado ${e.clase}`}>{e.texto}</span>
                  <button className="btn small" onClick={() => irAControl(i.id)}>Controlar</button>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="card vacio">
          {lista.length ? 'Todo al día. No hay instrumentos por vencer.' : 'Todavía no cargaste instrumentos. Andá a la pestaña Instrumentos.'}
        </div>
      )}

      {permiso !== 'granted' && permiso !== 'unsupported' && (
        <div className="card">
          <div className="row">
            <div className="sp">Recibir aviso del navegador cuando falte una semana o menos, o cuando un operario pida una revisión.</div>
            <button className="btn sec" onClick={activarAvisos} disabled={permiso === 'denied'}>
              {permiso === 'denied' ? 'Bloqueado en el navegador' : 'Activar avisos'}
            </button>
          </div>
          <div className="nota">El aviso salta mientras la app esté abierta. Con la app cerrada no llega nada (para eso haría falta un servidor, lo vemos después).</div>
        </div>
      )}
    </>
  )
}

// ---------- Instrumentos ----------
const VACIO = {
  codigo: '', tipo: 'Vernier', tipoOtro: '', modalidad: 'Mecánico', nroFab: '', marca: '',
  frecMeses: 12, aCargo: '', apreciacion: '', tolerancia: '', rango: '', rosca: '', paso: '', angulo: '60', alambre: '', pasaMin: '', pasaMax: '', nopasaMin: '', nopasaMax: '', pasaExtMin: '', pasaExtMax: '', nopasaExtMin: '', nopasaExtMax: '', maquina: '', ultimaRevision: '', vencimiento: '', activo: true, rechazado: false,
}

// Historial de controles de un instrumento, dentro de la misma página (el PDF sigue disponible por control)
function HistorialInstrumento({ inst, controles, lista, mostrar }) {
  const hist = Object.entries(controles || {})
    .map(([id, v]) => ({ ...v, id }))
    .filter((x) => x.instrumentoId === inst.id)
    .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || (b.creado || 0) - (a.creado || 0))

  const pdf = (c) =>
    certificadoDe(c, lista.find((i) => i.id === c.instrumentoId) || inst).catch(() => mostrar('No se pudo generar el PDF'))

  return (
    <div style={{ marginTop: 10, borderTop: '1px dashed var(--line)', paddingTop: 8 }}>
      <b>Historial de mediciones ({hist.length})</b>
      {hist.length === 0 && <div className="nota">Todavía no tiene controles registrados.</div>}
      {hist.map((c) => (
        <div key={c.id} style={{ padding: '8px 0', borderBottom: '1px dashed var(--line)' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              <b>{fmt(c.fecha)}</b> <span className="meta">· {c.responsable || '—'}</span>
            </span>
            <span className={`estado ${c.resultado === 'Aprobado' ? 'ok' : 'bad'}`}>{String(c.resultado || '').toUpperCase()}</span>
          </div>
          <div className="meta">
            Patrón: {c.galga || '—'} · Incert.: {c.incertidumbre ?? '—'}
            {c.errorMax != null && ` · error máx. ${Number(c.errorMax).toFixed(5)} mm`}
            {c.tolerancia != null && ` · tolerancia ${c.tolerancia} mm`}
          </div>
          {(c.puntos || []).length > 0 && (
            <div className="puntos" style={{ marginTop: 6 }}>
              <span />
              <span className="h">Real</span><span className="h">Hallado</span><span className="h" style={{ textAlign: 'right' }}>Dif.</span>
              {c.puntos.map((p, k) => {
                const d = p.hallado - p.real
                return (
                  <Fragment key={k}>
                    <span className="mono" style={{ color: 'var(--muted)' }}>{k + 1}</span>
                    <span className="mono">{n5(p.real)}</span>
                    <span className="mono">{n5(p.hallado)}</span>
                    <span className="dif">{Number.isNaN(d) ? '' : (d > 0 ? '+' : '') + d.toFixed(5)}</span>
                  </Fragment>
                )
              })}
            </div>
          )}
          {c.tipoControl === 'rosca' && c.lados && (
            <div className="meta">
              {c.rosca || 'Rosca'} · E PASA {n5(c.lados.pasa?.E)} mm · E NO PASA {n5(c.lados.nopasa?.E)} mm
              {c.lados.pasa?.D != null && <> · D ext. PASA {n5(c.lados.pasa.D)} mm · D ext. NO PASA {n5(c.lados.nopasa?.D)} mm</>}
            </div>
          )}
          {c.observaciones && <div className="meta">{c.observaciones}</div>}
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn small sec" onClick={() => pdf(c)}>Certificado PDF</button>
          </div>
        </div>
      ))}
    </div>
  )
}

function Instrumentos({ lista, controles = {}, tols, maquinas, editando, setEditando, irAControl, mostrar }) {
  const [q, setQ] = useState('')
  const [fTipo, setFTipo] = useState('')
  const [fMaq, setFMaq] = useState('')
  const [abierto, setAbierto] = useState('')
  const [verHist, setVerHist] = useState('')

  if (editando) {
    const base = editando === 'nuevo' ? VACIO : editando === 'nuevo-rosca' ? { ...VACIO, tipo: TIPO_ROSCA } : lista.find((i) => i.id === editando) || VACIO
    return (
      <FormInstrumento
        key={editando}
        inicial={base}
        id={editando === 'nuevo' || editando === 'nuevo-rosca' ? null : editando}
        lista={lista}
        tols={tols}
        maquinas={maquinas}
        alTerminar={(msg) => { if (msg) mostrar(msg); setEditando(null) }}
      />
    )
  }

  const filtrada = lista
    .filter((i) => {
      const t = `${i.codigo} ${i.marca} ${i.nroFab} ${i.aCargo} ${i.tipoOtro || ''}`.toLowerCase()
      const okMaq = !fMaq || (fMaq === '__sin' ? !i.maquina : i.maquina === fMaq)
      return t.includes(q.toLowerCase()) && (!fTipo || i.tipo === fTipo) && okMaq
    })
    .sort((a, b) => estadoDe(a).orden - estadoDe(b).orden || a.codigo.localeCompare(b.codigo, 'es', { numeric: true }))

  const exportar = () => {
    const cab = ['Código', 'Máquina', 'Tipo', 'Modalidad', 'N° fabricación', 'Marca', 'Frec. control (meses)', 'A cargo de', 'Apreciación', 'Última revisión', 'Vencimiento', 'Estado']
    const filas = lista.map((i) => [
      i.codigo, i.maquina || '', i.tipo === 'Otro' ? i.tipoOtro : i.tipo, i.modalidad, i.nroFab, i.marca, i.frecMeses, i.aCargo,
      i.apreciacion, fmt(i.ultimaRevision), fmt(i.vencimiento), estadoDe(i).texto,
    ])
    const csv = [cab, ...filas].map((f) => f.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `calibres_${hoyISO()}.csv`
    a.click()
  }

  return (
    <>
      <div className="card">
        <div className="row">
          <input style={{ flex: 2, minWidth: 140 }} placeholder="Buscar código, marca, responsable…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select style={{ flex: 1, minWidth: 120 }} value={fTipo} onChange={(e) => setFTipo(e.target.value)}>
            <option value="">Todos los tipos</option>
            {TIPOS.map((t) => <option key={t}>{t}</option>)}
          </select>
          <select style={{ flex: 1, minWidth: 120 }} value={fMaq} onChange={(e) => setFMaq(e.target.value)}>
            <option value="">Todas las máquinas</option>
            <option value="__sin">Sin máquina asignada</option>
            {opcionesMaq(maquinas, lista).map((m) => <option key={m} value={m}>Máquina {m}</option>)}
          </select>
        </div>
        {fMaq && <div className="nota" style={{ marginBottom: 0 }}>{filtrada.length} instrumento{filtrada.length === 1 ? '' : 's'} {fMaq === '__sin' ? 'sin máquina asignada' : `en la máquina ${fMaq}`}.</div>}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => setEditando('nuevo')}>+ Nuevo instrumento</button>
          <button className="btn sec" onClick={exportar} disabled={!lista.length}>Exportar CSV</button>
        </div>
      </div>

      {filtrada.length === 0 && <div className="card vacio">No hay instrumentos para mostrar.</div>}
      {filtrada.map((i) => {
        const e = estadoDe(i)
        return (
          <div className="lista-item" key={i.id}>
            <div>
              <div className="cod">{i.codigo}</div>
              <div className="meta">
                {i.tipo === 'Otro' ? i.tipoOtro || 'Otro' : i.tipo}{esRosca(i) ? ` ${i.rosca || ''}` : ` · ${i.modalidad}`} {i.marca && `· ${i.marca}`} {i.nroFab && `· N° ${i.nroFab}`}
              </div>
              <div className="meta">Máquina: {i.maquina || 'sin asignar'} · A cargo: {i.aCargo || '—'}</div>
              <div className="meta">Última rev.: {fmt(i.ultimaRevision)} · Vence: {fmt(i.vencimiento)}</div>
              {abierto === i.id && <FichaDatos inst={i} tols={tols} />}
              {verHist === i.id && <HistorialInstrumento inst={i} controles={controles} lista={lista} mostrar={mostrar} />}
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn small sec" onClick={() => setAbierto(abierto === i.id ? '' : i.id)}>{abierto === i.id ? 'Ocultar ficha' : 'Ver ficha'}</button>
                <button className="btn small sec" onClick={() => setVerHist(verHist === i.id ? '' : i.id)}>{verHist === i.id ? 'Ocultar historial' : 'Ver historial'}</button>
                <button className="btn small" onClick={() => irAControl(i.id)}>Registrar control</button>
                <button className="btn small sec" onClick={() => setEditando(i.id)}>Editar</button>
                <button className="btn small sec" onClick={() => etiquetasPDF([i]).catch(() => mostrar('No se pudo generar la etiqueta'))}>Etiqueta</button>
              </div>
            </div>
            <span className={`estado ${e.clase}`}>{e.texto}</span>
          </div>
        )
      })}
    </>
  )
}

function FormInstrumento({ inicial, id, lista, tols, maquinas, alTerminar }) {
  const [f, setF] = useState({ ...VACIO, ...inicial })
  const [err, setErr] = useState('')
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }))

  const cambiaRevisionOFrec = (k, v) => {
    setF((p) => {
      const n = { ...p, [k]: v }
      const venc = sumarMeses(n.ultimaRevision, n.frecMeses)
      if (venc) n.vencimiento = venc
      return n
    })
  }

  const deTabla = tols[tolKey(f.tipo, f.modalidad)]
  const roscado = f.tipo === TIPO_ROSCA
  const tolAuto = !roscado ? tolDe({ ...f, tolerancia: '' }, tols) : null
  const alambreIdeal = alambreIdealDe(f)

  const guardarInst = async () => {
    const codigo = f.codigo.trim()
    if (!codigo) return setErr('Falta el código del instrumento.')
    if (lista.some((i) => i.id !== id && i.codigo.toLowerCase() === codigo.toLowerCase())) return setErr('Ya existe un instrumento con ese código.')
    if (f.tipo === 'Otro' && !f.tipoOtro.trim()) return setErr('Indicá qué tipo de instrumento es.')
    if (roscado) {
      const p = num(f.paso)
      if (p === null || p <= 0) return setErr('Indicá el paso de la rosca (mm).')
      for (const [a, b, n] of [['pasaMin', 'pasaMax', 'PASA'], ['nopasaMin', 'nopasaMax', 'NO PASA'], ['pasaExtMin', 'pasaExtMax', 'PASA (diámetro exterior)'], ['nopasaExtMin', 'nopasaExtMax', 'NO PASA (diámetro exterior)']]) {
        const lo = num(f[a]), hi = num(f[b])
        if ((lo === null) !== (hi === null)) return setErr(`Completá el mínimo y el máximo del lado ${n}, o dejá los dos vacíos.`)
        if (lo !== null && lo >= hi) return setErr(`En ${n}, el mínimo tiene que ser menor que el máximo.`)
      }
    }
    const { id: _omit, ...datos } = f
    await guardar('instrumentos', id || nuevoId(), { ...datos, codigo, frecMeses: Number(f.frecMeses) || 0 })
    alTerminar(id ? 'Instrumento actualizado' : 'Instrumento cargado')
  }

  const darDeBaja = async () => {
    const { id: _omit, ...datos } = f
    await guardar('instrumentos', id, { ...datos, activo: f.activo === false })
    alTerminar(f.activo === false ? 'Instrumento reactivado' : 'Instrumento dado de baja')
  }

  const eliminar = async () => {
    if (!window.confirm(`¿Eliminar ${f.codigo} definitivamente? Sus controles quedan en el historial.`)) return
    await borrar('instrumentos', id)
    alTerminar('Instrumento eliminado')
  }

  return (
    <div className="card">
      <h2>{id ? 'Editar instrumento' : 'Nuevo instrumento'}</h2>
      <div className="grid">
        <div><label>Código</label><input className="mono" value={f.codigo} onChange={(e) => set('codigo', e.target.value)} autoFocus /></div>
        <div>
          <label>Tipo</label>
          <select value={f.tipo} onChange={(e) => set('tipo', e.target.value)}>
            {TIPOS.map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
        {f.tipo === 'Otro' && (
          <div><label>¿Cuál?</label><input value={f.tipoOtro} onChange={(e) => set('tipoOtro', e.target.value)} placeholder="Ej: reloj comparador" /></div>
        )}
        {!roscado && (
          <div>
            <label>Modalidad</label>
            <select value={f.modalidad} onChange={(e) => set('modalidad', e.target.value)}>
              {MODALIDADES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
        )}
        <div><label>N° de fabricación</label><input value={f.nroFab} onChange={(e) => set('nroFab', e.target.value)} /></div>
        <div><label>Marca</label><input value={f.marca} onChange={(e) => set('marca', e.target.value)} /></div>
        <div>
          <label>Máquina</label>
          {maquinas.length > 0 || f.maquina ? (
            <select value={f.maquina || ''} onChange={(e) => set('maquina', e.target.value)}>
              <option value="">Sin asignar</option>
              {opcionesMaq(maquinas, [f]).map((m) => <option key={m} value={m}>Máquina {m}</option>)}
            </select>
          ) : (
            <input value={f.maquina || ''} onChange={(e) => set('maquina', e.target.value)} placeholder="Ej: 12 (opcional)" />
          )}
        </div>
        <div><label>A cargo de</label><input value={f.aCargo} onChange={(e) => set('aCargo', e.target.value)} /></div>
        {!roscado && (
          <>
            <div><label>Apreciación (mm)</label><input inputMode="decimal" value={f.apreciacion} onChange={(e) => set('apreciacion', e.target.value)} placeholder="0,01" /></div>
            {f.tipo === 'Micrómetro' && (
              <div><label>Rango máximo (mm) — opcional</label><input inputMode="decimal" value={f.rango} onChange={(e) => set('rango', e.target.value)} placeholder="25, 50, 75, 100…" /></div>
            )}
            <div>
              <label>Tolerancia propia (mm) — opcional</label>
              <input inputMode="decimal" value={f.tolerancia} onChange={(e) => set('tolerancia', e.target.value)} placeholder={tolAuto ? `automática: ${tolAuto.valor}` : 'sin valor por defecto'} />
            </div>
          </>
        )}
        {roscado && (
          <>
            <div><label>Rosca (designación)</label><input value={f.rosca} onChange={(e) => set('rosca', e.target.value)} placeholder="Ej: M10x1,5 6H" /></div>
            <div><label>Paso P (mm)</label><input inputMode="decimal" value={f.paso} onChange={(e) => set('paso', e.target.value)} placeholder="1,5" /></div>
            <div>
              <label>Ángulo del flanco</label>
              <select value={f.angulo || '60'} onChange={(e) => set('angulo', e.target.value)}>
                <option value="60">60° (métrica ISO / UN)</option>
                <option value="55">55° (Whitworth / gas)</option>
                <option value="30">30° (trapezoidal)</option>
                <option value="29">29° (Acme)</option>
              </select>
            </div>
            <div><label>Diámetro del alambre habitual (mm)</label><input inputMode="decimal" value={f.alambre} onChange={(e) => set('alambre', e.target.value)} placeholder={alambreIdeal ? `ideal: ${alambreIdeal}` : ''} /></div>
            <div><label>PASA: diámetro medio mínimo (mm)</label><input inputMode="decimal" value={f.pasaMin} onChange={(e) => set('pasaMin', e.target.value)} /></div>
            <div><label>PASA: diámetro medio máximo (mm)</label><input inputMode="decimal" value={f.pasaMax} onChange={(e) => set('pasaMax', e.target.value)} /></div>
            <div><label>NO PASA: diámetro medio mínimo (mm)</label><input inputMode="decimal" value={f.nopasaMin} onChange={(e) => set('nopasaMin', e.target.value)} /></div>
            <div><label>NO PASA: diámetro medio máximo (mm)</label><input inputMode="decimal" value={f.nopasaMax} onChange={(e) => set('nopasaMax', e.target.value)} /></div>
            <div><label>PASA: diámetro exterior mínimo (mm)</label><input inputMode="decimal" value={f.pasaExtMin} onChange={(e) => set('pasaExtMin', e.target.value)} placeholder="opcional" /></div>
            <div><label>PASA: diámetro exterior máximo (mm)</label><input inputMode="decimal" value={f.pasaExtMax} onChange={(e) => set('pasaExtMax', e.target.value)} placeholder="opcional" /></div>
            <div><label>NO PASA: diámetro exterior mínimo (mm)</label><input inputMode="decimal" value={f.nopasaExtMin} onChange={(e) => set('nopasaExtMin', e.target.value)} placeholder="opcional" /></div>
            <div><label>NO PASA: diámetro exterior máximo (mm)</label><input inputMode="decimal" value={f.nopasaExtMax} onChange={(e) => set('nopasaExtMax', e.target.value)} placeholder="opcional" /></div>
          </>
        )}
        <div><label>Frecuencia de control (meses)</label><input type="number" min="1" value={f.frecMeses} onChange={(e) => cambiaRevisionOFrec('frecMeses', e.target.value)} /></div>
        <div><label>Última revisión</label><input type="date" value={f.ultimaRevision} onChange={(e) => cambiaRevisionOFrec('ultimaRevision', e.target.value)} /></div>
        <div><label>Fecha de vencimiento</label><input type="date" value={f.vencimiento} onChange={(e) => set('vencimiento', e.target.value)} /></div>
      </div>
      <div className="nota">El vencimiento se calcula solo (última revisión + frecuencia), pero lo podés corregir a mano.</div>
      {!roscado && (
        <div className="nota">
          <b>Tolerancia automática:</b>{' '}
          {tolAuto
            ? <>el sistema usa <b>{tolAuto.valor} mm</b> ({tolAuto.origen}). No hace falta cargar nada: solo completá la tolerancia propia si este instrumento necesita otro valor.</>
            : <>para este tipo no hay un valor por defecto (depende de la pieza o del ajuste). Cargá la tolerancia propia, o el control se decidirá a mano.</>}
        </div>
      )}
      {roscado && (
        <div className="nota">
          Los límites de diámetro medio PASA y NO PASA salen del plano o del certificado del tapón (norma de calibres de rosca). El control se hace con el método de las tres varillas en la pestaña <b>Tapones de rosca</b>. El <b>diámetro exterior</b> (medido sobre el filete, con micrómetro) es opcional: si cargás sus límites, el control lo pide y hace falta que cumpla, además del diámetro medio, para aprobar el tapón.
        </div>
      )}
      {err && <div style={{ color: 'var(--bad)', marginTop: 8 }}>{err}</div>}
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn" onClick={guardarInst}>Guardar</button>
        <button className="btn sec" onClick={() => alTerminar()}>Cancelar</button>
        <span className="sp" />
        {id && <button className="btn sec small" onClick={darDeBaja}>{f.activo === false ? 'Reactivar' : 'Dar de baja'}</button>}
        {id && <button className="btn bad small" onClick={eliminar}>Eliminar</button>}
      </div>
    </div>
  )
}

// ---------- Registrar control ----------
function RegistrarControl({ lista, tols, solicitudes, inicial, operario, mostrar, alTerminar }) {
  const [instId, setInstId] = useState(inicial || '')
  const [fecha, setFecha] = useState(hoyISO())
  const [galga, setGalga] = useState('')
  const [incert, setIncert] = useState('')
  const [reales, setReales] = useState(Array(PUNTOS).fill(''))
  const [hallados, setHallados] = useState(Array(PUNTOS).fill(''))
  const [manual, setManual] = useState('Aprobado')
  const [resp, setResp] = useState(operario || '')
  const [temp, setTemp] = useState('')
  const [obs, setObs] = useState('')
  const [err, setErr] = useState('')

  const inst = lista.find((i) => i.id === instId)
  const orden = [...lista].sort((a, b) => a.codigo.localeCompare(b.codigo, 'es', { numeric: true }))

  const setAt = (arr, setArr, i, v) => setArr(arr.map((x, k) => (k === i ? v : x)))
  const difs = reales.map((r, i) => {
    const a = num(r), b = num(hallados[i])
    return a === null || b === null ? null : b - a
  })
  const cargados = difs.filter((d) => d !== null).length
  const completo = cargados >= MIN_PUNTOS
  const maxErr = difs.reduce((m, d) => (d === null ? m : Math.max(m, Math.abs(d))), 0)
  const inc = num(incert) ?? 0
  const total = maxErr + inc

  const tolInfo = inst ? tolDe(inst, tols) : null
  // Criterio: error máximo + incertidumbre del patrón <= tolerancia
  const auto = tolInfo && completo ? (total <= tolInfo.valor + 1e-9 ? 'Aprobado' : 'Rechazado') : null
  const resultado = auto || manual

  const guardarControl = async () => {
    if (!inst) return setErr('Elegí el instrumento.')
    const puntos = reales
      .map((r, i) => ({ real: num(r), hallado: num(hallados[i]) }))
      .filter((p) => p.real !== null || p.hallado !== null)
    if (puntos.some((p) => p.real === null || p.hallado === null)) return setErr('Cada punto necesita valor real y valor hallado.')
    if (!completo) return setErr(`Cargá al menos ${MIN_PUNTOS} mediciones (valor real y valor hallado). Las otras ${PUNTOS - MIN_PUNTOS} son opcionales.`)
    const vence = resultado === 'Aprobado' ? sumarMeses(fecha, inst.frecMeses) || inst.vencimiento || '' : ''
    const id = nuevoId()
    await guardar('controles', id, {
      instrumentoId: inst.id, codigo: inst.codigo, fecha, galga: galga.trim(), incertidumbre: num(incert),
      puntos, resultado, resultadoAuto: !!auto, errorMax: puntos.length ? maxErr : null,
      tolerancia: tolInfo ? tolInfo.valor : null, toleranciaOrigen: tolInfo ? tolInfo.origen : '',
      metodo: metodoDe(inst, { tipoControl: 'normal', tolInfo, auto: !!auto, temperatura: num(temp) ?? '' }),
      responsable: resp.trim() || inst.aCargo || '', observaciones: obs.trim(), creado: Date.now(),
      proximoVencimiento: vence,
      // datos del instrumento al momento del control (para el certificado)
      tipoTexto: inst.tipo === 'Otro' ? inst.tipoOtro : inst.tipo, modalidad: inst.modalidad, marca: inst.marca || '',
      nroFab: inst.nroFab || '', apreciacion: inst.apreciacion || '', aCargo: inst.aCargo || '',
    })
    const { id: _omit, ...datos } = inst
    if (resultado === 'Aprobado') {
      await guardar('instrumentos', inst.id, { ...datos, rechazado: false, ultimaRevision: fecha, vencimiento: vence })
    } else {
      await guardar('instrumentos', inst.id, { ...datos, rechazado: true, ultimaRevision: fecha })
    }
    const abiertas = Object.entries(solicitudes || {}).filter(([, s]) => s.instrumentoId === inst.id && s.estado === 'pendiente')
    for (const [sid, s] of abiertas) {
      await guardar('solicitudes', sid, { ...s, estado: 'atendida', atendidaEn: Date.now(), atendidaPor: 'control', controlId: id })
    }
    mostrar(resultado === 'Aprobado' ? 'Control aprobado. Vencimiento actualizado.' : 'Control rechazado registrado.')
    alTerminar()
  }

  return (
    <div className="card">
      <h2>Registrar control</h2>
      <div className="grid">
        <div>
          <label>Instrumento</label>
          <select value={instId} onChange={(e) => setInstId(e.target.value)}>
            <option value="">— elegir —</option>
            {orden.map((i) => <option key={i.id} value={i.id}>{i.codigo} · {i.tipo === 'Otro' ? i.tipoOtro : i.tipo}</option>)}
          </select>
        </div>
        <div><label>Fecha de control</label><input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} /></div>
        <div><label>Galga / patrón usado</label><input value={galga} onChange={(e) => setGalga(e.target.value)} /></div>
        <div><label>Incertidumbre del patrón (mm)</label><input inputMode="decimal" value={incert} onChange={(e) => setIncert(e.target.value)} placeholder="0,00000" /></div>
        <div><label>Responsable del control</label><input value={resp} onChange={(e) => setResp(e.target.value)} placeholder={inst?.aCargo || ''} /></div>
        <div><label>Temperatura ambiente (°C) — opcional</label><input inputMode="decimal" value={temp} onChange={(e) => setTemp(e.target.value)} placeholder={`referencia ${TEMP_REF}`} /></div>
      </div>

      {inst && (
        <div className="nota">
          {inst.tipo === 'Otro' ? inst.tipoOtro : inst.tipo} · {inst.modalidad} · {inst.marca} · apreciación {inst.apreciacion || '—'} · frecuencia {inst.frecMeses} meses
        </div>
      )}

      <h2 style={{ marginTop: 16 }}>Mediciones (mínimo {MIN_PUNTOS}, hasta {PUNTOS})</h2>
      <div className="nota" style={{ marginTop: 0, marginBottom: 8 }}>Las mediciones {MIN_PUNTOS + 1} a {PUNTOS} son opcionales. Dejá vacías las que no uses.</div>
      <div className="puntos">
        <span />
        <span className="h">Valor real (galga)</span><span className="h">Valor hallado</span><span className="h" style={{ textAlign: 'right' }}>Dif.</span>
        {reales.map((_, i) => (
          <PuntoFila key={i} i={i} real={reales[i]} hallado={hallados[i]} dif={difs[i]}
            onReal={(v) => setAt(reales, setReales, i, v)} onHallado={(v) => setAt(hallados, setHallados, i, v)} />
        ))}
      </div>

      {inst && <PanelMetodo inst={inst} tolInfo={tolInfo} auto={!!auto} temp={temp} />}

      {inst && (
        <div className="card" style={{ marginTop: 14, background: 'var(--panel2)' }}>
          {tolInfo ? (
            <>
              <div className="nota" style={{ marginTop: 0 }}>
                Tolerancia: <b className="mono">{tolInfo.valor}</b> mm ({tolInfo.origen}). Criterio: error máximo + incertidumbre ≤ tolerancia.
              </div>
              {cargados > 0 && (
                <div className="mono" style={{ marginTop: 6, fontSize: 13 }}>
                  {maxErr.toFixed(5)} + {inc.toFixed(5)} = {total.toFixed(5)} {total <= tolInfo.valor + 1e-9 ? '≤' : '>'} {tolInfo.valor}
                </div>
              )}
              <div style={{ marginTop: 8 }}>
                Resultado:{' '}
                {completo
                  ? <span className={`estado ${auto === 'Aprobado' ? 'ok' : 'bad'}`}>{auto.toUpperCase()}</span>
                  : <span className="nota">se calcula al cargar al menos {MIN_PUNTOS} mediciones ({cargados}/{PUNTOS})</span>}
              </div>
            </>
          ) : (
            <>
              <div style={{ color: 'var(--warn)', fontSize: 14 }}>
                Este tipo de instrumento no tiene tolerancia por defecto ni propia: el resultado hay que elegirlo a mano. Cargá la tolerancia propia en su ficha para que sea automático.
              </div>
              {cargados > 0 && <div className="nota">Error máximo: <b className="mono">{maxErr.toFixed(5)}</b> mm.</div>}
              <div style={{ marginTop: 8 }}>
                <label>Resultado</label>
                <select value={manual} onChange={(e) => setManual(e.target.value)}>
                  <option>Aprobado</option>
                  <option>Rechazado</option>
                </select>
              </div>
            </>
          )}
        </div>
      )}

      <div className="grid" style={{ marginTop: 14 }}>
        <div><label>Observaciones</label><input value={obs} onChange={(e) => setObs(e.target.value)} /></div>
      </div>

      {err && <div style={{ color: 'var(--bad)', marginTop: 8 }}>{err}</div>}
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn" onClick={guardarControl}>Guardar control</button>
        <button className="btn sec" onClick={alTerminar}>Cancelar</button>
      </div>
      <div className="nota">Si el resultado es Aprobado, la última revisión y el vencimiento del instrumento se actualizan solos.</div>
    </div>
  )
}

function PanelMetodo({ inst, tolInfo, auto, temp, tipoControl = 'normal', usaIncert = true }) {
  const m = metodoDe(inst, { tipoControl, tolInfo, auto, usaIncert, temperatura: num(temp) ?? '' })
  return (
    <div className="card" style={{ marginTop: 14, background: 'var(--panel2)' }}>
      <h2 style={{ marginTop: 0 }}>Método y criterio</h2>
      <div className="nota" style={{ marginTop: 0 }}>
        <b>Cuándo:</b> {fechaHora(Date.now())} hs (queda guardado al registrar).<br />
        <b>Norma:</b> {m.norma}.<br />
        <b>Patrón:</b> {m.patronRef}.<br />
        <b>Marco:</b> {m.marco}.<br />
        <b>Criterio:</b> {m.regla}
      </div>
    </div>
  )
}

function PuntoFila({ i, real, hallado, dif, onReal, onHallado }) {
  return (
    <>
      <span className="mono" style={{ color: 'var(--muted)' }}>{i + 1}</span>
      <input className="mono" inputMode="decimal" value={real} onChange={(e) => onReal(e.target.value)} placeholder="0,00000" />
      <input className="mono" inputMode="decimal" value={hallado} onChange={(e) => onHallado(e.target.value)} placeholder="0,00000" />
      <span className="dif">{dif === null ? '' : (dif > 0 ? '+' : '') + dif.toFixed(5)}</span>
    </>
  )
}

// ---------- Historial ----------
function Historial({ lista, controles, mostrar }) {
  const [codigo, setCodigo] = useState('')
  const filas = Object.entries(controles)
    .map(([id, c]) => ({ ...c, id }))
    .filter((c) => !codigo || c.codigo === codigo)
    .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || (b.creado || 0) - (a.creado || 0))
  const codigos = [...new Set([...lista.map((i) => i.codigo), ...Object.values(controles).map((c) => c.codigo)])].sort((a, b) =>
    a.localeCompare(b, 'es', { numeric: true })
  )

  const eliminar = async (c) => {
    if (!window.confirm(`¿Borrar el control de ${c.codigo} del ${fmt(c.fecha)}?`)) return
    await borrar('controles', c.id)
    mostrar('Control borrado')
  }

  const certificado = async (c) => {
    try {
      await certificadoDe(c, lista.find((i) => i.id === c.instrumentoId))
    } catch (e) {
      console.error(e)
      mostrar('No se pudo generar el PDF')
    }
  }

  return (
    <>
      <div className="card">
        <label>Filtrar por instrumento</label>
        <select value={codigo} onChange={(e) => setCodigo(e.target.value)}>
          <option value="">Todos</option>
          {codigos.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>
      {filas.length === 0 && <div className="card vacio">Todavía no hay controles registrados.</div>}
      {filas.map((c) => {
        const maxE = c.errorMax ?? (c.puntos || []).reduce((m, p) => Math.max(m, Math.abs(p.hallado - p.real)), 0)
        return (
          <div className="lista-item" key={c.id}>
            <div>
              <div className="cod">{c.codigo} <span className="meta">· {fmt(c.fecha)}{c.creado ? ` · ${fechaHora(c.creado).slice(11)} hs` : ''}</span></div>
              {c.metodo && <div className="meta">Norma: {c.metodo.norma.split(':')[0]}</div>}
              <div className="meta">Patrón: {c.galga || '—'} · Incert.: {c.incertidumbre ?? '—'} · Resp.: {c.responsable || '—'}</div>
              {c.tipoControl === 'rosca' && c.lados && (
                <div className="meta">
                  {c.rosca || 'Rosca'} · E PASA {n5(c.lados.pasa?.E)} mm · E NO PASA {n5(c.lados.nopasa?.E)} mm{c.lados.pasa?.D != null && <> · D ext. PASA {n5(c.lados.pasa.D)} mm · D ext. NO PASA {n5(c.lados.nopasa?.D)} mm</>}
                </div>
              )}
              {(c.puntos || []).length > 0 && (
                <div className="meta">
                  {c.puntos.length} puntos · error máx. {maxE.toFixed(5)} mm{c.tolerancia != null ? ` · tolerancia ${c.tolerancia} mm` : ''}
                </div>
              )}
              {c.observaciones && <div className="meta">{c.observaciones}</div>}
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn small" onClick={() => certificado(c)}>Certificado PDF</button>
                <button className="btn small bad" onClick={() => eliminar(c)}>Borrar</button>
              </div>
            </div>
            <span className={`estado ${c.resultado === 'Aprobado' ? 'ok' : 'bad'}`}>{c.resultado.toUpperCase()}</span>
          </div>
        )
      })}
    </>
  )
}

// ---------- Tolerancias (las carga Gerencia de Calidad) ----------
function Tolerancias({ tols, mostrar }) {
  const [err, setErr] = useState('')
  const [valores, setValores] = useState({})

  const filas = TIPOS.filter((t) => t !== TIPO_ROSCA).flatMap((t) => MODALIDADES.map((m) => ({ tipo: t, modalidad: m, key: tolKey(t, m) })))

  useEffect(() => {
    const v = {}
    filas.forEach((f) => { v[f.key] = tols[f.key] ? String(tols[f.key].valor) : '' })
    setValores(v)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tols])

  const guardarTodo = async () => {
    for (const f of filas) {
      const v = num(valores[f.key])
      if (valores[f.key] !== '' && (v === null || v < 0)) return setErr(`Valor inválido en ${f.tipo} ${f.modalidad}.`)
    }
    setErr('')
    for (const f of filas) {
      const v = num(valores[f.key])
      if (v === null) { if (tols[f.key]) await borrar('tolerancias', f.key) }
      else if (!tols[f.key] || tols[f.key].valor !== v) {
        await guardar('tolerancias', f.key, { tipo: f.tipo, modalidad: f.modalidad, valor: v, actualizado: Date.now() })
      }
    }
    mostrar('Tolerancias guardadas')
  }

  return (
    <div className="card">
      <h2>Tolerancias</h2>
      <h3 style={{ margin: '10px 0 6px', fontSize: 16 }}>Ajustes opcionales por tipo y modalidad</h3>
      <div className="nota" style={{ marginTop: 0, marginBottom: 10 }}>
        Error máximo permitido en mm. El control se aprueba si
        <b> error máximo + incertidumbre del patrón ≤ tolerancia</b>. Orden de prioridad: 1) tolerancia propia del instrumento, 2) un ajuste de esta tabla, 3) el valor por defecto de arriba. Los tapones roscados tienen su propio control.
      </div>
      {filas.map((f) => (
        <div className="row" key={f.key} style={{ marginBottom: 8 }}>
          <span className="sp">{f.tipo} · {f.modalidad}</span>
          <input
            className="mono" style={{ width: 130 }} inputMode="decimal" placeholder="mm"
            value={valores[f.key] ?? ''} onChange={(e) => setValores({ ...valores, [f.key]: e.target.value })}
          />
        </div>
      ))}
      {err && <div style={{ color: 'var(--bad)', marginTop: 8 }}>{err}</div>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={guardarTodo}>Guardar tolerancias</button>
      </div>
    </div>
  )
}

// ---------- Escáner (cámara + código escrito o lector USB/Bluetooth) ----------
function Escaner({ lista, controles, tols, irAControl, mostrar, modo = 'calidad', solicitudes = {}, operario = '', maquina = '' }) {
  const [encId, setEncId] = useState(null)
  const [manual, setManual] = useState('')
  const [camara, setCamara] = useState(false)
  const [err, setErr] = useState('')
  const [solicitando, setSolicitando] = useState(false)
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const timerRef = useRef(null)
  const buscarRef = useRef(null)
  const soporta = typeof window !== 'undefined' && 'BarcodeDetector' in window

  const parar = () => {
    clearInterval(timerRef.current)
    timerRef.current = null
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setCamara(false)
  }
  useEffect(() => parar, [])

  const buscar = (texto) => {
    const t = String(texto || '').trim().toLowerCase()
    if (!t) return false
    const inst = lista.find((i) => i.codigo.trim().toLowerCase() === t)
    if (!inst) {
      setErr(`No hay ningún instrumento con el código "${String(texto).trim()}".`)
      return false
    }
    setErr('')
    setEncId(inst.id)
    setSolicitando(false)
    setManual('')
    try { navigator.vibrate && navigator.vibrate(120) } catch { /* nada */ }
    return true
  }
  buscarRef.current = buscar

  const iniciar = async () => {
    setErr('')
    setEncId(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      streamRef.current = stream
      setCamara(true)
      await new Promise((r) => setTimeout(r, 80)) // esperar a que exista el <video>
      const v = videoRef.current
      v.srcObject = stream
      await v.play()
      const soportados = await window.BarcodeDetector.getSupportedFormats()
      const formats = ['code_128', 'qr_code', 'code_39', 'ean_13'].filter((f) => soportados.includes(f))
      const det = new window.BarcodeDetector({ formats })
      timerRef.current = setInterval(async () => {
        try {
          const r = await det.detect(v)
          if (r.length && buscarRef.current(r[0].rawValue)) parar()
        } catch { /* frame todavía no listo */ }
      }, 300)
    } catch (e) {
      console.error(e)
      parar()
      setErr('No se pudo abrir la cámara. Revisá el permiso de cámara del navegador para este sitio.')
    }
  }

  const inst = encId ? lista.find((i) => i.id === encId) : null
  const ultimo = inst
    ? Object.entries(controles)
        .map(([id, c]) => ({ ...c, id }))
        .filter((c) => c.instrumentoId === inst.id)
        .sort((x, y) => (y.fecha || '').localeCompare(x.fecha || '') || (y.creado || 0) - (x.creado || 0))[0]
    : null

  return (
    <>
      <div className="card">
        <h2>Escanear etiqueta</h2>
        {!camara && (
          <div className="row">
            <button className="btn" onClick={iniciar} disabled={!soporta}>Abrir cámara</button>
          </div>
        )}
        {!soporta && (
          <div className="nota">
            Este navegador no lee códigos con la cámara. Usá Chrome en Android, o escribí el código (o usá un lector) en el campo de abajo.
          </div>
        )}
        {camara && (
          <>
            <video ref={videoRef} playsInline muted style={{ width: '100%', borderRadius: 8, background: '#000' }} />
            <div className="nota">Apuntá al código de barras de la etiqueta.</div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sec" onClick={parar}>Cerrar cámara</button>
            </div>
          </>
        )}
        <div style={{ marginTop: 14 }}>
          <label>O escribí / escaneá con lector el código</label>
          <div className="row">
            <input
              className="mono" style={{ flex: 1, minWidth: 140 }} value={manual} placeholder="Código del instrumento"
              onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && buscar(manual)}
            />
            <button className="btn" onClick={() => buscar(manual)}>Buscar</button>
          </div>
        </div>
        {err && <div style={{ color: 'var(--bad)', marginTop: 8 }}>{err}</div>}
      </div>

      {inst && (() => {
        const e = estadoDe(inst)
        const t = tolDe(inst, tols)
        const datos = [
          ['Tipo', `${inst.tipo === 'Otro' ? inst.tipoOtro || 'Otro' : inst.tipo} · ${inst.modalidad}`],
          ['Máquina', inst.maquina || 'sin asignar'],
          ['Marca', inst.marca || '—'],
          ['N° de fabricación', inst.nroFab || '—'],
          ['A cargo de', inst.aCargo || '—'],
          ...(esRosca(inst)
            ? [['Rosca', `${inst.rosca || '—'} · paso ${inst.paso || '—'} mm`], ['Límites PASA', limTxt(inst.pasaMin, inst.pasaMax)], ['Límites NO PASA', limTxt(inst.nopasaMin, inst.nopasaMax)], ...extFicha(inst)]
            : [['Apreciación', inst.apreciacion ? `${inst.apreciacion} mm` : '—']]),
          ['Frecuencia de control', inst.frecMeses ? `${inst.frecMeses} meses` : '—'],
          ['Última revisión', fmt(inst.ultimaRevision)],
          ['Vencimiento', fmt(inst.vencimiento)],
          ...(esRosca(inst) ? [] : [['Tolerancia', t ? `${t.valor} mm (${t.origen})` : 'sin definir']]),
        ].filter(([k]) => modo !== 'operador' || k !== 'Tolerancia')
        const pendInst = Object.values(solicitudes).filter((s) => s.instrumentoId === inst.id && s.estado === 'pendiente')
        return (
          <div className="card">
            <div className="row">
              <div className="mono" style={{ fontSize: 24, fontWeight: 700 }}>{inst.codigo}</div>
              <span className="sp" />
              <span className={`estado ${e.clase}`}>{e.texto}</span>
            </div>
            <div style={{ marginTop: 8 }}>
              {datos.map(([k, v]) => (
                <div className="alerta" key={k}><span style={{ color: 'var(--muted)' }}>{k}</span><b>{v}</b></div>
              ))}
            </div>
            <div className="nota">
              {ultimo
                ? `Último control: ${fmt(ultimo.fecha)} · ${ultimo.resultado}${ultimo.errorMax != null ? ` · error máx. ${Number(ultimo.errorMax).toFixed(5)} mm` : ''}`
                : 'Todavía no tiene controles registrados.'}
            </div>
            {pendInst.length > 0 && (
              <div className="nota" style={{ color: 'var(--warn)' }}>
                Ya hay {pendInst.length} solicitud{pendInst.length > 1 ? 'es' : ''} de revisión pendiente{pendInst.length > 1 ? 's' : ''} para este instrumento.
              </div>
            )}
            {modo === 'operador' && solicitando && (
              <FormSolicitud
                inst={inst} operario={operario} maquina={maquina}
                onCancel={() => setSolicitando(false)}
                onEnviada={() => { setSolicitando(false); mostrar('Solicitud enviada a Calidad') }}
              />
            )}
            <div className="row" style={{ marginTop: 12 }}>
              {modo === 'operador'
                ? <button className="btn" onClick={() => setSolicitando(true)} disabled={solicitando}>Solicitar revisión</button>
                : <button className="btn" onClick={() => irAControl(inst.id)}>Registrar control</button>}
              {ultimo && modo !== 'operador' && (
                <button className="btn sec" onClick={() => certificadoDe(ultimo, inst).catch(() => mostrar('No se pudo generar el PDF'))}>
                  Último certificado
                </button>
              )}
              <button className="btn sec" onClick={() => { setEncId(null); setSolicitando(false); iniciar() }} disabled={!soporta}>Escanear otro</button>
            </div>
          </div>
        )
      })()}
    </>
  )
}

// ---------- Etiquetas con código de barras ----------
function Etiquetas({ lista, mostrar }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState({})
  const activos = lista.filter((i) => i.activo !== false)
  const filtrada = activos
    .filter((i) => `${i.codigo} ${i.tipo} ${i.tipoOtro || ''} ${i.marca}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.codigo.localeCompare(b.codigo, 'es', { numeric: true }))
  const elegidos = activos.filter((i) => sel[i.id])

  const marcar = (v) => {
    const n = { ...sel }
    filtrada.forEach((i) => { n[i.id] = v })
    setSel(n)
  }
  const generar = async () => {
    try {
      await etiquetasPDF(elegidos.sort((a, b) => a.codigo.localeCompare(b.codigo, 'es', { numeric: true })))
    } catch (e) {
      console.error(e)
      mostrar('No se pudo generar el PDF')
    }
  }

  return (
    <div className="card">
      <h2>Etiquetas con código de barras</h2>
      <div className="nota" style={{ marginTop: 0, marginBottom: 10 }}>
        Elegí los instrumentos y generá un PDF con etiquetas de 63 × 33 mm (24 por hoja A4). El código de barras es el código del instrumento.
      </div>
      <input placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="row" style={{ margin: '10px 0' }}>
        <button className="btn sec small" onClick={() => marcar(true)}>Marcar todos</button>
        <button className="btn sec small" onClick={() => marcar(false)}>Desmarcar</button>
        <span className="sp" />
        <span className="nota">{elegidos.length} elegidos</span>
      </div>
      {filtrada.length === 0 && <div className="vacio">No hay instrumentos para mostrar.</div>}
      {filtrada.map((i) => (
        <label key={i.id} className="lista-item" style={{ gridTemplateColumns: 'auto 1fr', alignItems: 'center', cursor: 'pointer', textTransform: 'none', letterSpacing: 0, fontSize: 14, color: 'var(--text)', marginBottom: 6 }}>
          <input type="checkbox" style={{ width: 20, height: 20 }} checked={!!sel[i.id]} onChange={(e) => setSel({ ...sel, [i.id]: e.target.checked })} />
          <span><b className="mono">{i.codigo}</b> <span className="meta">· {i.tipo === 'Otro' ? i.tipoOtro || 'Otro' : i.tipo} · {i.modalidad}</span></span>
        </label>
      ))}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={generar} disabled={!elegidos.length}>Generar PDF de etiquetas</button>
      </div>
    </div>
  )
}

// ---------- Solicitud de revisión (la hace el operador) ----------
function FormSolicitud({ inst, operario, maquina, onCancel, onEnviada }) {
  const [motivo, setMotivo] = useState(MOTIVOS[0])
  const [comentario, setComentario] = useState('')
  const [nombre, setNombre] = useState(() => {
    if (operario) return operario
    try { return localStorage.getItem('calibres_nombre') || '' } catch { return '' }
  })
  const [maq, setMaq] = useState(maquina || '')
  const [err, setErr] = useState('')
  const [enviando, setEnviando] = useState(false)

  const enviar = async () => {
    if (!nombre.trim()) return setErr('Poné tu nombre.')
    if (motivo === 'Otro' && !comentario.trim()) return setErr('Contanos el motivo en el comentario.')
    setErr('')
    setEnviando(true)
    try {
      await guardar('solicitudes', nuevoId(), {
        instrumentoId: inst.id, codigo: inst.codigo,
        tipoTexto: inst.tipo === 'Otro' ? inst.tipoOtro || 'Otro' : inst.tipo, modalidad: inst.modalidad || '',
        motivo, comentario: comentario.trim(), solicitante: nombre.trim(), maquina: String(maq).trim(),
        fecha: hoyISO(), creado: Date.now(), estado: 'pendiente',
      })
      try { if (!operario) localStorage.setItem('calibres_nombre', nombre.trim()) } catch { /* nada */ }
      onEnviada()
    } catch (e) {
      console.error(e)
      setErr('No se pudo enviar. Revisá la conexión e intentá de nuevo.')
      setEnviando(false)
    }
  }

  return (
    <div className="card" style={{ background: '#fff', marginTop: 12, marginBottom: 0 }}>
      <h2>Solicitar revisión de {inst.codigo}</h2>
      <div className="grid">
        <div>
          <label>Motivo</label>
          <select value={motivo} onChange={(e) => setMotivo(e.target.value)}>
            {MOTIVOS.map((m) => <option key={m}>{m}</option>)}
          </select>
        </div>
        {!operario && (
          <div><label>Tu nombre</label><input value={nombre} onChange={(e) => setNombre(e.target.value)} /></div>
        )}
        <div><label>Máquina (opcional)</label><input value={maq} onChange={(e) => setMaq(e.target.value)} placeholder="Ej: 12" /></div>
      </div>
      <div style={{ marginTop: 10 }}>
        <label>Comentario {motivo === 'Otro' ? '' : '(opcional)'}</label>
        <textarea rows={3} value={comentario} onChange={(e) => setComentario(e.target.value)} placeholder="Qué le pasa al instrumento" />
      </div>
      {err && <div style={{ color: 'var(--bad)', marginTop: 8 }}>{err}</div>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={enviar} disabled={enviando}>{enviando ? 'Enviando…' : 'Enviar a Calidad'}</button>
        <button className="btn sec" onClick={onCancel} disabled={enviando}>Cancelar</button>
      </div>
    </div>
  )
}

// ---------- Bandeja de solicitudes (lado Calidad) ----------
function Solicitudes({ lista, solicitudes, irAControl, mostrar }) {
  const todas = Object.entries(solicitudes).map(([id, s]) => ({ ...s, id })).sort((a, b) => (b.creado || 0) - (a.creado || 0))
  const pend = todas.filter((s) => s.estado === 'pendiente')
  const hechas = todas.filter((s) => s.estado !== 'pendiente').slice(0, 15)

  const atender = async (s) => {
    const { id, ...resto } = s
    await guardar('solicitudes', id, { ...resto, estado: 'atendida', atendidaEn: Date.now(), atendidaPor: 'manual' })
    mostrar('Marcada como atendida')
  }

  const fila = (s, esPend) => {
    const inst = lista.find((i) => i.id === s.instrumentoId)
    return (
      <div className="lista-item" key={s.id}>
        <div>
          <div className="cod">{s.codigo} <span className="meta">· {s.tipoTexto}{s.modalidad ? ` · ${s.modalidad}` : ''}</span></div>
          <div style={{ fontWeight: 700, marginTop: 4 }}>{s.motivo}</div>
          {s.comentario && <div className="meta">{s.comentario}</div>}
          <div className="meta">
            Pidió: {s.solicitante || '—'}{s.maquina ? ` · Máq. ${s.maquina}` : ''} · {fmtHora(s.creado)}
            {!esPend && s.atendidaEn ? ` · atendida ${fmtHora(s.atendidaEn)}${s.atendidaPor === 'control' ? ' (control registrado)' : ''}` : ''}
          </div>
          {esPend && (
            <div className="row" style={{ marginTop: 8 }}>
              {inst && inst.activo !== false && <button className="btn small" onClick={() => irAControl(inst.id)}>Registrar control</button>}
              <button className="btn small sec" onClick={() => atender(s)}>Marcar atendida</button>
            </div>
          )}
        </div>
        <span className={`estado ${esPend ? 'warn' : 'ok'}`}>{esPend ? 'PENDIENTE' : 'ATENDIDA'}</span>
      </div>
    )
  }

  return (
    <>
      <div className="card">
        <h2>Solicitudes de revisión</h2>
        <div className="nota" style={{ marginTop: 0 }}>
          Las envían los operarios desde su panel al escanear un instrumento. Se cierran solas al registrar un control del instrumento.
        </div>
      </div>
      {pend.length === 0 && <div className="card vacio">No hay solicitudes pendientes.</div>}
      {pend.map((s) => fila(s, true))}
      {hechas.length > 0 && (
        <>
          <div className="nota" style={{ margin: '14px 0 6px' }}>Últimas atendidas</div>
          {hechas.map((s) => fila(s, false))}
        </>
      )}
    </>
  )
}

// ---------- Panel del operador: escanear un instrumento y pedir revisión ----------
function InstrumentosOperadorBase({ operario = '', maquina = '' }) {
  const [instrumentos, setInstrumentos] = useState({})
  const [controles, setControles] = useState({})
  const [tols, setTols] = useState({})
  const [solicitudes, setSolicitudes] = useState({})
  const [toast, setToast] = useState('')

  useEffect(() => {
    const fn = (e) => { setToast(e.detail); setTimeout(() => setToast(''), 5000) }
    window.addEventListener('calibres-error', fn)
    return () => window.removeEventListener('calibres-error', fn)
  }, [])
  useEffect(() => escuchar('instrumentos', setInstrumentos), [])
  useEffect(() => escuchar('controles', setControles), [])
  useEffect(() => escuchar('tolerancias', setTols), [])
  useEffect(() => escuchar('solicitudes', setSolicitudes), [])

  const lista = useMemo(
    () => Object.entries(instrumentos).map(([id, v]) => ({ ...v, id })).filter((i) => i.activo !== false),
    [instrumentos]
  )
  const mostrar = (m) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  return (
    <div className="cal-root">
      <div className="app">
        <Escaner
          modo="operador" lista={lista} controles={controles} tols={tols} solicitudes={solicitudes}
          irAControl={() => {}} mostrar={mostrar} operario={operario} maquina={maquina}
        />
        {toast && <div className="toast">{toast}</div>}
      </div>
    </div>
  )
}

// ---------- Cantidad de solicitudes pendientes (para mostrar un número en una pestaña del SIG) ----------
export function useSolicitudesPendientes() {
  const [sol, setSol] = useState({})
  useEffect(() => escuchar('solicitudes', setSol), [])
  return Object.values(sol).filter((s) => s.estado === 'pendiente').length
}

function pitido() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    const ctx = new AC()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.connect(g)
    g.connect(ctx.destination)
    o.frequency.value = 880
    g.gain.value = 0.15
    o.start()
    o.stop(ctx.currentTime + 0.25)
    setTimeout(() => ctx.close(), 500)
  } catch { /* el navegador puede bloquear el sonido */ }
}

// ---------- Aviso a Calidad: cartel + sonido + notificación del navegador cuando llega una solicitud ----------
// Funciona mientras esta pantalla esté abierta. onVer (opcional) lleva a la pestaña de solicitudes.
export function AvisoSolicitudes({ onVer }) {
  const [sol, setSol] = useState({})
  const [nuevo, setNuevo] = useState(null)
  const conocidas = useRef(null)
  useEffect(() => escuchar('solicitudes', setSol), [])

  useEffect(() => {
    const pend = Object.entries(sol).filter(([, s]) => s.estado === 'pendiente')
    const ids = new Set(pend.map(([id]) => id))
    if (conocidas.current === null) { conocidas.current = ids; return } // primera carga: no avisar
    // solo las recién llegadas (evita falsas alarmas si la base manda los datos en dos tandas)
    const recientes = pend.filter(([id, s]) => !conocidas.current.has(id) && Date.now() - (s.creado || 0) < 120000)
    conocidas.current = ids
    if (!recientes.length) return
    const s = { ...recientes[recientes.length - 1][1] }
    setNuevo(s)
    pitido()
    try { navigator.vibrate && navigator.vibrate([150, 80, 150]) } catch { /* nada */ }
    notificar('Solicitud de revisión', `${s.codigo} - ${s.motivo}${s.maquina ? ` (máq. ${s.maquina})` : ''}\nPidió: ${s.solicitante || '—'}`)
  }, [sol])

  if (!nuevo) return null
  return (
    <div className="cal-root">
      <div className="cal-aviso">
        <div>
          <b>Solicitud de revisión</b>
          <div style={{ fontSize: 14 }}>
            <span className="mono">{nuevo.codigo}</span> · {nuevo.motivo}{nuevo.maquina ? ` · Máq. ${nuevo.maquina}` : ''} · {nuevo.solicitante || '—'}
          </div>
        </div>
        <div className="row">
          {onVer && <button className="btn small" onClick={() => { onVer(); setNuevo(null) }}>Ver</button>}
          <button className="btn small sec" onClick={() => setNuevo(null)}>Cerrar</button>
        </div>
      </div>
    </div>
  )
}

// ---------- Si algo falla, mostrar el error en vez de dejar la pantalla en blanco ----------
class Contencion extends Component {
  constructor(p) { super(p); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(e) { console.error('Calibres:', e) }
  render() {
    if (!this.state.error) return this.props.children
    const e = this.state.error
    return (
      <div className="cal-root"><div className="app"><div className="card">
        <h2>Algo falló en Instrumentos</h2>
        <div className="nota" style={{ wordBreak: 'break-word' }}>{String((e && e.message) || e)}</div>
        <div className="nota" style={{ wordBreak: 'break-word', fontSize: 11 }}>{String((e && e.stack) || '').split('\n').slice(0, 4).join(' | ')}</div>
        <button className="btn" onClick={() => this.setState({ error: null })}>Reintentar</button>
      </div></div></div>
    )
  }
}

export default function Calibres(props) {
  return <Contencion><CalibresApp {...props} /></Contencion>
}

export function InstrumentosOperador(props) {
  return <Contencion><InstrumentosOperadorBase {...props} /></Contencion>
}

// Máquinas disponibles + las que ya usan los instrumentos (por si alguna ya no está en la lista de producción)
function opcionesMaq(maquinas, lista) {
  const usadas = lista.map((i) => String(i.maquina || '').trim()).filter(Boolean)
  return [...new Set([...maquinas, ...usadas])].sort((a, b) => a.localeCompare(b, 'es', { numeric: true }))
}

// ---------- Ficha completa de un instrumento ----------
function FichaDatos({ inst, tols }) {
  const t = tolDe(inst, tols)
  const datos = [
    ['Tipo', `${inst.tipo === 'Otro' ? inst.tipoOtro || 'Otro' : inst.tipo} · ${inst.modalidad}`],
    ['Máquina', inst.maquina || 'sin asignar'],
    ['Marca', inst.marca || '—'],
    ['N° de fabricación', inst.nroFab || '—'],
    ['A cargo de', inst.aCargo || '—'],
    ...(esRosca(inst)
      ? [['Rosca', `${inst.rosca || '—'} · paso ${inst.paso || '—'} mm · ${inst.angulo || 60}°`], ['Límites PASA', limTxt(inst.pasaMin, inst.pasaMax)], ['Límites NO PASA', limTxt(inst.nopasaMin, inst.nopasaMax)], ...extFicha(inst)]
      : [['Apreciación', inst.apreciacion ? `${inst.apreciacion} mm` : '—']]),
    ['Frecuencia de control', inst.frecMeses ? `${inst.frecMeses} meses` : '—'],
    ['Última revisión', fmt(inst.ultimaRevision)],
    ['Vencimiento', fmt(inst.vencimiento)],
    ...(esRosca(inst) ? [] : [['Tolerancia', t ? `${t.valor} mm (${t.origen})` : 'sin definir']]),
  ]
  return (
    <div style={{ margin: '8px 0', padding: '4px 10px', background: 'var(--panel)', borderRadius: 8 }}>
      {datos.map(([k, v]) => (
        <div className="alerta" key={k}><span style={{ color: 'var(--muted)' }}>{k}</span><b>{v}</b></div>
      ))}
    </div>
  )
}

// ---------- Calendario mes a mes: qué vence en cada mes ----------
function Calendario({ lista, tols, maquinas, irAControl }) {
  const hoy = hoyISO()
  const [anio, setAnio] = useState(Number(hoy.slice(0, 4)))
  const [mes, setMes] = useState(Number(hoy.slice(5, 7)))
  const [fMaq, setFMaq] = useState('')
  const [abierto, setAbierto] = useState('')

  const activos = lista.filter((i) => i.activo !== false && i.vencimiento && (!fMaq || (fMaq === '__sin' ? !i.maquina : i.maquina === fMaq)))
  const porMes = Array.from({ length: 12 }, (_, k) => {
    const pref = `${anio}-${pad(k + 1)}`
    return activos.filter((i) => i.vencimiento.startsWith(pref))
  })
  const delMes = porMes[mes - 1].slice().sort((a, b) => a.vencimiento.localeCompare(b.vencimiento) || a.codigo.localeCompare(b.codigo, 'es', { numeric: true }))
  const esActual = anio === Number(hoy.slice(0, 4)) && mes === Number(hoy.slice(5, 7))
  const atrasados = esActual ? activos.filter((i) => i.vencimiento < `${anio}-${pad(mes)}-01`) : []
  const sinFecha = lista.filter((i) => i.activo !== false && !i.vencimiento).length

  const ir = (d) => {
    let m = mes + d
    let a = anio
    if (m < 1) { m = 12; a -= 1 }
    if (m > 12) { m = 1; a += 1 }
    setMes(m); setAnio(a); setAbierto('')
  }

  const fila = (i) => {
    const e = estadoDe(i)
    return (
      <div className="lista-item" key={i.id}>
        <div>
          <div className="cod">{i.codigo} <span className="meta">· {i.tipo === 'Otro' ? i.tipoOtro || 'Otro' : i.tipo} · {i.modalidad}</span></div>
          <div className="meta">Vence: <b>{fmt(i.vencimiento)}</b> · Máquina: {i.maquina || 'sin asignar'} · A cargo: {i.aCargo || '—'}</div>
          {abierto === i.id && <FichaDatos inst={i} tols={tols} />}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn small sec" onClick={() => setAbierto(abierto === i.id ? '' : i.id)}>{abierto === i.id ? 'Ocultar ficha' : 'Ver ficha'}</button>
            <button className="btn small" onClick={() => irAControl(i.id)}>Registrar control</button>
          </div>
        </div>
        <span className={`estado ${e.clase}`}>{e.texto}</span>
      </div>
    )
  }

  return (
    <>
      <div className="card">
        <div className="row">
          <button className="btn small sec" onClick={() => ir(-1)}>◀</button>
          <h2 style={{ margin: 0, flex: 1, textAlign: 'center' }}>{MESES[mes - 1]} {anio}</h2>
          <button className="btn small sec" onClick={() => ir(1)}>▶</button>
        </div>
        <div className="meses">
          {MESES_C.map((nm, k) => {
            const n = porMes[k].length
            const pasado = `${anio}-${pad(k + 1)}` < hoy.slice(0, 7)
            return (
              <button key={nm} className={`mes ${mes === k + 1 ? 'on' : ''} ${n && pasado ? 'pasado' : ''}`} onClick={() => { setMes(k + 1); setAbierto('') }}>
                <span>{nm}</span>
                <b>{n || '·'}</b>
              </button>
            )
          })}
        </div>
        <select style={{ marginTop: 10 }} value={fMaq} onChange={(e) => setFMaq(e.target.value)}>
          <option value="">Todas las máquinas</option>
          <option value="__sin">Sin máquina asignada</option>
          {opcionesMaq(maquinas, lista).map((m) => <option key={m} value={m}>Máquina {m}</option>)}
        </select>
        <div className="nota" style={{ marginBottom: 0 }}>
          Cada casillero muestra cuántos instrumentos vencen ese mes. Tocá un mes para ver la lista.
          {sinFecha > 0 && ` Hay ${sinFecha} instrumento${sinFecha > 1 ? 's' : ''} sin fecha de vencimiento.`}
        </div>
      </div>

      <div className="card" style={{ paddingBottom: 4 }}>
        <h2 style={{ marginBottom: 4 }}>Vencen en {MESES[mes - 1].toLowerCase()}: {delMes.length}</h2>
      </div>
      {delMes.length === 0 && <div className="card vacio">No vence ningún instrumento en {MESES[mes - 1].toLowerCase()} {anio}.</div>}
      {delMes.map(fila)}

      {atrasados.length > 0 && (
        <>
          <div className="nota" style={{ margin: '14px 0 6px', color: 'var(--bad)' }}>
            Ya vencidos de meses anteriores y sin renovar: {atrasados.length}
          </div>
          {atrasados.sort((a, b) => a.vencimiento.localeCompare(b.vencimiento)).map(fila)}
        </>
      )}
    </>
  )
}

// ---------- Por máquina: elegir una máquina, ver sus instrumentos y abrir la ficha completa ----------
function PorMaquina({ lista, controles, tols, solicitudes, maquinas, irAControl, editar, mostrar }) {
  const [maq, setMaq] = useState(null)   // null = pantalla de máquinas; '__sin' = sin asignar
  const [sel, setSel] = useState('')     // id del instrumento abierto

  const activos = lista.filter((i) => i.activo !== false)
  const nombres = opcionesMaq(maquinas, lista)
  const deMaq = (m) => activos.filter((i) => (m === '__sin' ? !i.maquina : i.maquina === m))
  const peor = (items) => items.reduce((p, i) => Math.min(p, estadoDe(i).orden), 9)
  const claseDe = (items) => (!items.length ? 'na' : peor(items) <= 1 ? 'bad' : peor(items) <= 3 ? 'warn' : 'ok')

  // ---- pantalla 1: tarjetas de máquinas ----
  if (maq === null) {
    const sin = deMaq('__sin')
    const tarjeta = (clave, titulo, items) => (
      <button key={clave} className={`maq-card ${claseDe(items)}`} onClick={() => { setMaq(clave); setSel('') }}>
        <span className="maq-nombre">{titulo}</span>
        <b>{items.length}</b>
        <span className="maq-sub">
          {items.length === 0 ? 'sin instrumentos' : `${items.filter((i) => estadoDe(i).orden <= 3).length} para atender`}
        </span>
      </button>
    )
    return (
      <>
        <div className="card">
          <h2>Instrumentos por máquina</h2>
          <div className="nota" style={{ marginTop: 0 }}>
            Tocá una máquina para ver sus instrumentos. El color indica el peor estado: rojo (vencido o rechazado), amarillo (vence en 7 días o menos), verde (todo vigente).
          </div>
        </div>
        <div className="maq-grid">
          {nombres.map((m) => tarjeta(m, m, deMaq(m)))}
          {sin.length > 0 && tarjeta('__sin', 'Sin máquina', sin)}
        </div>
        {nombres.length === 0 && sin.length === 0 && <div className="card vacio">Todavía no hay instrumentos cargados.</div>}
      </>
    )
  }

  const items = deMaq(maq).sort((a, b) => estadoDe(a).orden - estadoDe(b).orden || a.codigo.localeCompare(b.codigo, 'es', { numeric: true }))
  const titulo = maq === '__sin' ? 'Sin máquina asignada' : `Máquina ${maq}`
  const inst = sel ? lista.find((i) => i.id === sel) : null

  const descargarPDF = () => {
    const filas = items.map((i) => {
      const e = estadoDe(i)
      return {
        codigo: i.codigo, tipo: i.tipo === 'Otro' ? i.tipoOtro || 'Otro' : i.tipo, modalidad: i.modalidad,
        nroFab: i.nroFab, aCargo: i.aCargo, vencimiento: i.vencimiento,
        estado: e.texto.startsWith('VIGENTE') ? 'VIGENTE' : e.texto.startsWith('VENCE EN') || e.texto === 'VENCE HOY' ? `VIGENTE (${e.texto.toLowerCase()})` : e.texto,
        clase: e.clase, vigente: e.orden >= 2 && e.orden <= 4, porVencer: e.orden === 2 || e.orden === 3,
      }
    })
    const hoy = hoyISO().split('-').reverse().join('/')
    listadoMaquinaPDF(titulo, filas, hoy).catch(() => mostrar('No se pudo generar el PDF'))
  }

  // ---- pantalla 3: ficha completa ----
  if (inst) {
    const e = estadoDe(inst)
    const hist = Object.entries(controles).map(([id, v]) => ({ ...v, id })).filter((x) => x.instrumentoId === inst.id).sort((a, b) => (b.creado || 0) - (a.creado || 0))
    const pend = Object.values(solicitudes).filter((s) => s.instrumentoId === inst.id && s.estado === 'pendiente')
    const ultimo = hist[0]
    return (
      <>
        <button className="btn small sec" onClick={() => setSel('')} style={{ marginBottom: 10 }}>◀ {titulo}</button>
        <div className="card">
          <div className="row">
            <div className="mono" style={{ fontSize: 24, fontWeight: 700 }}>{inst.codigo}</div>
            <span className="sp" />
            <span className={`estado ${e.clase}`}>{e.texto}</span>
          </div>
          <FichaDatos inst={inst} tols={tols} />
          {pend.length > 0 && (
            <div className="nota" style={{ color: 'var(--warn)' }}>
              {pend.length} solicitud{pend.length > 1 ? 'es' : ''} de revisión pendiente{pend.length > 1 ? 's' : ''}: {pend.map((s) => `${s.motivo} (${s.solicitante || '—'})`).join(', ')}
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => irAControl(inst.id)}>Registrar control</button>
            {ultimo && <button className="btn sec" onClick={() => certificadoDe(ultimo, inst).catch(() => mostrar('No se pudo generar el PDF'))}>Último certificado</button>}
            <button className="btn sec" onClick={() => etiquetasPDF([inst]).catch(() => mostrar('No se pudo generar la etiqueta'))}>Etiqueta</button>
            <button className="btn sec" onClick={() => editar(inst.id)}>Editar</button>
          </div>
        </div>
        <div className="card">
          <h2>Historial de controles ({hist.length})</h2>
          {hist.length === 0 && <div className="nota" style={{ marginTop: 0 }}>Todavía no tiene controles registrados.</div>}
          {hist.slice(0, 10).map((h) => (
            <div className="alerta" key={h.id}>
              <span>
                {fmt(h.fecha)} · {h.responsable || '—'}
                {h.errorMax != null && <span style={{ color: 'var(--muted)' }}> · error máx. {Number(h.errorMax).toFixed(5)} mm</span>}
              </span>
              <span className={`estado ${h.resultado === 'Aprobado' ? 'ok' : 'bad'}`}>{String(h.resultado || '').toUpperCase()}</span>
            </div>
          ))}
          {hist.length > 10 && <div className="nota">Se muestran los últimos 10. El historial completo está en la pestaña Historial.</div>}
        </div>
      </>
    )
  }

  // ---- pantalla 2: instrumentos de la máquina ----
  return (
    <>
      <button className="btn small sec" onClick={() => setMaq(null)} style={{ marginBottom: 10 }}>◀ Todas las máquinas</button>
      <div className="card" style={{ paddingBottom: 4 }}>
        <h2 style={{ marginBottom: 4 }}>{titulo}: {items.length} instrumento{items.length === 1 ? '' : 's'}</h2>
      </div>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="btn" onClick={descargarPDF}>Descargar PDF</button>
      </div>
      {items.length === 0 && <div className="card vacio">Esta máquina no tiene instrumentos asignados.</div>}
      {items.map((i) => {
        const e = estadoDe(i)
        return (
          <div className="lista-item clic" key={i.id} onClick={() => setSel(i.id)}>
            <div>
              <div className="cod">{i.codigo} <span className="meta">· {i.tipo === 'Otro' ? i.tipoOtro || 'Otro' : i.tipo} · {i.modalidad}</span></div>
              <div className="meta">Vence: {fmt(i.vencimiento)} · A cargo: {i.aCargo || '—'}</div>
              <div className="meta" style={{ color: 'var(--accent-dark)' }}>Ver ficha completa ▸</div>
            </div>
            <span className={`estado ${e.clase}`}>{e.texto}</span>
          </div>
        )
      })}
    </>
  )
}

// ---------- Tapones roscados: lista, control por tres varillas e historial (aparte de los demás instrumentos) ----------
function Roscas({ lista, controles, solicitudes, inicial, operario, mostrar, nuevo, editar, limpiarInicial }) {
  const [vista, setVista] = useState(inicial ? 'control' : 'lista')
  const [instId, setInstId] = useState(inicial || '')
  const roscados = lista.filter((i) => esRosca(i) && i.activo !== false).sort((a, b) => a.codigo.localeCompare(b.codigo, 'es', { numeric: true }))

  const abrirControl = (id) => { setInstId(id); setVista('control') }

  if (vista === 'control') {
    return (
      <ControlRosca
        lista={roscados} solicitudes={solicitudes} inicial={instId} operario={operario} mostrar={mostrar}
        alTerminar={() => { limpiarInicial(); setInstId(''); setVista('lista') }}
      />
    )
  }

  const hist = Object.entries(controles).map(([id, v]) => ({ ...v, id })).filter((x) => x.tipoControl === 'rosca').sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || (b.creado || 0) - (a.creado || 0))

  if (vista === 'historial') {
    return (
      <>
        <button className="btn small sec" onClick={() => setVista('lista')} style={{ marginBottom: 10 }}>◀ Tapones de rosca</button>
        <div className="card" style={{ paddingBottom: 4 }}><h2 style={{ marginBottom: 4 }}>Historial de controles de rosca ({hist.length})</h2></div>
        {hist.length === 0 && <div className="card vacio">Todavía no hay controles de rosca.</div>}
        {hist.map((h) => {
          const inst = lista.find((i) => i.id === h.instrumentoId)
          return (
            <div className="lista-item" key={h.id}>
              <div>
                <div className="cod">{h.codigo} <span className="meta">· {fmt(h.fecha)} · {h.rosca || ''}</span></div>
                <div className="meta">E PASA {n5(h.lados?.pasa?.E)} mm ({h.lados?.pasa?.ok === false ? 'no cumple' : 'cumple'}) · E NO PASA {n5(h.lados?.nopasa?.E)} mm ({h.lados?.nopasa?.ok === false ? 'no cumple' : 'cumple'})</div>
                <div className="meta">Resp.: {h.responsable || '—'}{h.observaciones ? ` · ${h.observaciones}` : ''}</div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn small" onClick={() => certificadoRoscaPDF(h, inst).catch(() => mostrar('No se pudo generar el PDF'))}>Certificado PDF</button>
                  <button className="btn small bad" onClick={async () => { if (window.confirm('¿Borrar este control?')) { await borrar('controles', h.id); mostrar('Control borrado') } }}>Borrar</button>
                </div>
              </div>
              <span className={`estado ${h.resultado === 'Aprobado' ? 'ok' : 'bad'}`}>{String(h.resultado || '').toUpperCase()}</span>
            </div>
          )
        })}
      </>
    )
  }

  return (
    <>
      <div className="card">
        <h2>Tapones de rosca</h2>
        <div className="nota" style={{ marginTop: 0 }}>
          Se controlan por el <b>diámetro medio</b> con el método de las tres varillas, en los lados PASA y NO PASA. Este control está separado del de los demás instrumentos.
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={nuevo}>+ Nuevo tapón de rosca</button>
          <button className="btn sec" onClick={() => setVista('historial')}>Historial</button>
        </div>
      </div>
      {roscados.length === 0 && <div className="card vacio">Todavía no hay tapones de rosca cargados.</div>}
      {roscados.map((i) => {
        const e = estadoDe(i)
        return (
          <div className="lista-item" key={i.id}>
            <div>
              <div className="cod">{i.codigo} <span className="meta">· {i.rosca || 'sin designación'}</span></div>
              <div className="meta">Paso {i.paso || '—'} mm · {i.angulo || 60}° · Máquina: {i.maquina || 'sin asignar'} · A cargo: {i.aCargo || '—'}</div>
              <div className="meta">PASA {limTxt(i.pasaMin, i.pasaMax)} · NO PASA {limTxt(i.nopasaMin, i.nopasaMax)}</div>
              {hayExt(i) && <div className="meta">Diám. exterior: PASA {limTxt(i.pasaExtMin, i.pasaExtMax)} · NO PASA {limTxt(i.nopasaExtMin, i.nopasaExtMax)}</div>}
              <div className="meta">Última rev.: {fmt(i.ultimaRevision)} · Vence: {fmt(i.vencimiento)}</div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn small" onClick={() => abrirControl(i.id)}>Registrar control</button>
                <button className="btn small sec" onClick={() => editar(i.id)}>Editar</button>
              </div>
            </div>
            <span className={`estado ${e.clase}`}>{e.texto}</span>
          </div>
        )
      })}
    </>
  )
}

function ControlRosca({ lista, solicitudes, inicial, operario, mostrar, alTerminar }) {
  const [instId, setInstId] = useState(inicial || '')
  const [fecha, setFecha] = useState(hoyISO())
  const [incert, setIncert] = useState('')
  const [incertExt, setIncertExt] = useState('')
  const [usaIncert, setUsaIncert] = useState(false) // el control de roscas no usa incertidumbre salvo que se tilde
  const [lados, setLados] = useState({ pasa: { d: '', M: '', D: '' }, nopasa: { d: '', M: '', D: '' } })
  const [manual, setManual] = useState('Aprobado')
  const [resp, setResp] = useState(operario || '')
  const [temp, setTemp] = useState('')
  const [obs, setObs] = useState('')
  const [err, setErr] = useState('')
  const inst = lista.find((i) => i.id === instId)

  // al elegir el tapón, proponer el alambre habitual (o el ideal)
  useEffect(() => {
    if (!inst) return
    const d = inst.alambre || alambreIdealDe(inst)
    setLados((p) => ({ pasa: { ...p.pasa, d: p.pasa.d || d }, nopasa: { ...p.nopasa, d: p.nopasa.d || d } }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instId])

  const setLado = (k, campo, v) => setLados((p) => ({ ...p, [k]: { ...p[k], [campo]: v } }))
  const P = inst ? num(inst.paso) : null
  const U = usaIncert ? (num(incert) ?? 0) : 0
  const Ue = usaIncert ? (num(incertExt) ?? U) : 0
  const evaluar = (k, min, max, extMin, extMax) => {
    const d = num(lados[k].d), M = num(lados[k].M)
    if (!inst || P === null || d === null || M === null) return null
    const E = medioTresVarillas(M, d, P, inst.angulo)
    const lo = num(min), hi = num(max)
    const okE = lo === null || hi === null ? null : E - U >= lo - 1e-9 && E + U <= hi + 1e-9
    // Diámetro exterior (medido sobre el filete): opcional; si el tapón tiene límites cargados, hay que medirlo y cumplirlo.
    const elo = num(extMin), ehi = num(extMax), D = num(lados[k].D)
    const pideExt = elo !== null && ehi !== null
    if (pideExt && D === null) return null
    const okX = pideExt ? D - Ue >= elo - 1e-9 && D + Ue <= ehi + 1e-9 : null
    const ok = okX === false ? false : okE
    return { alambre: d, cota: M, E, min: lo, max: hi, okE, D, extMin: pideExt ? elo : null, extMax: pideExt ? ehi : null, okX, ok }
  }
  const rP = inst ? evaluar('pasa', inst.pasaMin, inst.pasaMax, inst.pasaExtMin, inst.pasaExtMax) : null
  const rN = inst ? evaluar('nopasa', inst.nopasaMin, inst.nopasaMax, inst.nopasaExtMin, inst.nopasaExtMax) : null
  const completo = !!rP && !!rN
  const auto = completo && rP.ok !== null && rN.ok !== null ? (rP.ok && rN.ok ? 'Aprobado' : 'Rechazado') : null
  const resultado = auto || manual

  const guardarControl = async () => {
    if (!inst) return setErr('Elegí el tapón.')
    if (!completo) return setErr(hayExt(inst) ? 'Cargá el alambre, la cota medida y el diámetro exterior de los dos lados (PASA y NO PASA).' : 'Cargá el alambre y la cota medida de los dos lados (PASA y NO PASA).')
    const vence = resultado === 'Aprobado' ? sumarMeses(fecha, inst.frecMeses) || inst.vencimiento || '' : ''
    const id = nuevoId()
    const lado = (r) => ({ alambre: r.alambre, cota: r.cota, E: r.E, min: r.min, max: r.max, ok: r.ok, okE: r.okE, D: r.D, extMin: r.extMin, extMax: r.extMax, okX: r.okX })
    await guardar('controles', id, {
      tipoControl: 'rosca', instrumentoId: inst.id, codigo: inst.codigo, fecha, usaIncertidumbre: usaIncert, incertidumbre: usaIncert ? num(incert) : null, incertidumbreExt: usaIncert ? num(incertExt) : null,
      rosca: inst.rosca || '', paso: num(inst.paso), angulo: num(inst.angulo) ?? 60,
      lados: { pasa: lado(rP), nopasa: lado(rN) }, puntos: [], errorMax: null, tolerancia: null,
      resultado, resultadoAuto: !!auto, responsable: resp.trim() || inst.aCargo || '', observaciones: obs.trim(), creado: Date.now(),
      metodo: metodoDe(inst, { tipoControl: 'rosca', usaIncert, auto: !!auto, temperatura: num(temp) ?? '' }),
      proximoVencimiento: vence, tipoTexto: TIPO_ROSCA, modalidad: inst.modalidad || '', marca: inst.marca || '', nroFab: inst.nroFab || '', aCargo: inst.aCargo || '',
    })
    const { id: _omit, ...datos } = inst
    if (resultado === 'Aprobado') await guardar('instrumentos', inst.id, { ...datos, rechazado: false, ultimaRevision: fecha, vencimiento: vence })
    else await guardar('instrumentos', inst.id, { ...datos, rechazado: true, ultimaRevision: fecha })
    for (const [sid, s] of Object.entries(solicitudes || {}).filter(([, s]) => s.instrumentoId === inst.id && s.estado === 'pendiente')) {
      await guardar('solicitudes', sid, { ...s, estado: 'atendida', atendidaEn: Date.now(), atendidaPor: 'control', controlId: id })
    }
    mostrar(resultado === 'Aprobado' ? 'Control aprobado. Vencimiento actualizado.' : 'Control rechazado registrado.')
    alTerminar()
  }

  const bloque = (k, titulo, r, min, max, extMin, extMax) => (
    <div className="card" style={{ background: 'var(--panel)' }}>
      <h2>{titulo}</h2>
      <div className="grid">
        <div><label>Diámetro del alambre d (mm)</label><input inputMode="decimal" value={lados[k].d} onChange={(e) => setLado(k, 'd', e.target.value)} /></div>
        <div><label>Cota medida sobre alambres M (mm)</label><input inputMode="decimal" value={lados[k].M} onChange={(e) => setLado(k, 'M', e.target.value)} /></div>
        {num(extMin) !== null && num(extMax) !== null && (
          <div><label>Diámetro exterior D, sobre el filete (mm)</label><input inputMode="decimal" value={lados[k].D} onChange={(e) => setLado(k, 'D', e.target.value)} /></div>
        )}
      </div>
      <div className="nota">
        Límites del diámetro medio: <b>{limTxt(min, max)}</b>
        {r && <> · Diámetro medio calculado E = <b className="mono">{r.E.toFixed(5)} mm</b> {r.okE === null ? '(sin límites cargados)' : r.okE ? '· CUMPLE' : '· NO CUMPLE'}</>}
        {num(extMin) !== null && num(extMax) !== null && (
          <><br />Límites del diámetro exterior: <b>{limTxt(extMin, extMax)}</b>{r && <> · medido D = <b className="mono">{r.D.toFixed(5)} mm</b> {r.okX ? '· CUMPLE' : '· NO CUMPLE'}</>}</>
        )}
      </div>
    </div>
  )

  return (
    <div className="card">
      <h2>Registrar control de tapón roscado</h2>
      <div className="grid">
        <div>
          <label>Tapón de rosca</label>
          <select value={instId} onChange={(e) => setInstId(e.target.value)}>
            <option value="">— elegir —</option>
            {lista.map((i) => <option key={i.id} value={i.id}>{i.codigo} · {i.rosca || 'sin designación'}</option>)}
          </select>
        </div>
        <div><label>Fecha de control</label><input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} /></div>
        <div><label>Incertidumbre (opcional)</label><label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto' }} checked={usaIncert} onChange={(e) => setUsaIncert(e.target.checked)} /> Considerar incertidumbre en la decisión</label></div>
        {usaIncert && <div><label>Incertidumbre de la medición (mm)</label><input inputMode="decimal" value={incert} onChange={(e) => setIncert(e.target.value)} placeholder="0,00000" /></div>}
        {usaIncert && hayExt(inst) && <div><label>Incertidumbre del micrómetro, diám. exterior (mm)</label><input inputMode="decimal" value={incertExt} onChange={(e) => setIncertExt(e.target.value)} placeholder="si va vacío, usa la de arriba" /></div>}
        <div><label>Responsable</label><input value={resp} onChange={(e) => setResp(e.target.value)} placeholder={inst?.aCargo || ''} /></div>
        <div><label>Temperatura ambiente (°C) — opcional</label><input inputMode="decimal" value={temp} onChange={(e) => setTemp(e.target.value)} placeholder={`referencia ${TEMP_REF}`} /></div>
      </div>
      {inst && (
        <>
          <PanelMetodo inst={inst} tolInfo={null} auto={!!auto} temp={temp} tipoControl="rosca" usaIncert={usaIncert} />
          <div className="nota">{inst.rosca || 'Rosca'} · paso {inst.paso} mm · flanco {inst.angulo || 60}°{alambreIdealDe(inst) ? ` · alambre ideal ${alambreIdealDe(inst)} mm` : ''}</div>
          {bloque('pasa', 'Lado PASA', rP, inst.pasaMin, inst.pasaMax, inst.pasaExtMin, inst.pasaExtMax)}
          {bloque('nopasa', 'Lado NO PASA', rN, inst.nopasaMin, inst.nopasaMax, inst.nopasaExtMin, inst.nopasaExtMax)}
          <div className="nota">
            {usaIncert
              ? <>Criterio: en cada lado, <b>E − incertidumbre ≥ mínimo</b> y <b>E + incertidumbre ≤ máximo</b>. Si el tapón tiene límites de diámetro exterior, además <b>D − incertidumbre ≥ mínimo</b> y <b>D + incertidumbre ≤ máximo</b>. Si los dos lados cumplen todo, el tapón queda aprobado.</>
              : <>Criterio: en cada lado, <b>mínimo ≤ E ≤ máximo</b>. Si el tapón tiene límites de diámetro exterior, además <b>mínimo ≤ D ≤ máximo</b>. Si los dos lados cumplen todo, el tapón queda aprobado.</>}
          </div>
          {auto ? (
            <div style={{ margin: '10px 0' }}><span className={`estado ${auto === 'Aprobado' ? 'ok' : 'bad'}`}>{auto.toUpperCase()}</span> <span className="meta">decidido automáticamente</span></div>
          ) : completo ? (
            <div style={{ margin: '10px 0' }}>
              <label>Faltan los límites del tapón: elegí el resultado a mano</label>
              <select value={manual} onChange={(e) => setManual(e.target.value)}><option>Aprobado</option><option>Rechazado</option></select>
            </div>
          ) : null}
        </>
      )}
      <div style={{ marginTop: 8 }}><label>Observaciones</label><textarea rows={2} value={obs} onChange={(e) => setObs(e.target.value)} /></div>
      {err && <div style={{ color: 'var(--bad)', marginTop: 8 }}>{err}</div>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={guardarControl}>Guardar control</button>
        <button className="btn sec" onClick={alTerminar}>Cancelar</button>
      </div>
    </div>
  )
}
