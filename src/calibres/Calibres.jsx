import { Component, useEffect, useMemo, useRef, useState } from 'react'
import { escuchar, guardar, borrar, nuevoId, modo } from './db.js'
import './calibres.css'
import { certificadoPDF } from './certificado.js'
import { etiquetasPDF } from './etiquetas.js'

const TIPOS = ['Vernier', 'Micrómetro', 'Alesómetro', 'Tapón P-NP', 'Otro']
const MODALIDADES = ['Mecánico', 'Digital']
const PUNTOS = 5
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
  const propia = num(inst.tolerancia)
  if (propia !== null) return { valor: propia, origen: 'del instrumento' }
  const t = tols[tolKey(inst.tipo, inst.modalidad)]
  const v = t ? num(t.valor) : null
  return v !== null ? { valor: v, origen: `tabla (${inst.tipo} ${inst.modalidad.toLowerCase()})` } : null
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
  new Notification('Calibres: control por vencer', { body: cuerpo })
  try { localStorage.setItem(clave, JSON.stringify(hechos.concat(nuevos.map((i) => i.id)))) } catch { /* nada */ }
}

// ---------- App ----------
// embebido: true cuando va dentro del SIG (oculta el título propio).
// operario: nombre del operario logueado en el SIG (se usa como responsable por defecto del control).
function CalibresApp({ embebido = false, operario = '' }) {
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
    setTab('control')
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
        <button className={`tab ${tab === 'solicitudes' ? 'on' : ''}`} onClick={() => setTab('solicitudes')}>
          Solicitudes{solPend.length > 0 && <span className="n">{solPend.length}</span>}
        </button>
        <button className={`tab ${tab === 'escanear' ? 'on' : ''}`} onClick={() => setTab('escanear')}>Escanear</button>
        <button className={`tab ${tab === 'instrumentos' ? 'on' : ''}`} onClick={() => { setTab('instrumentos'); setEditando(null) }}>Instrumentos</button>
        <button className={`tab ${tab === 'control' ? 'on' : ''}`} onClick={() => setTab('control')}>Registrar control</button>
        <button className={`tab ${tab === 'historial' ? 'on' : ''}`} onClick={() => setTab('historial')}>Historial</button>
        <button className={`tab ${tab === 'etiquetas' ? 'on' : ''}`} onClick={() => setTab('etiquetas')}>Etiquetas</button>
        <button className={`tab ${tab === 'tolerancias' ? 'on' : ''}`} onClick={() => setTab('tolerancias')}>Tolerancias</button>
      </div>

      {tab === 'panel' && (
        <Panel lista={lista} porVencer={porVencer} permiso={permiso} activarAvisos={activarAvisos} irAControl={irAControl} solPend={solPend} irASolicitudes={() => setTab('solicitudes')} />
      )}
      {tab === 'instrumentos' && (
        <Instrumentos
          lista={lista}
          tols={tols}
          editando={editando}
          setEditando={setEditando}
          irAControl={irAControl}
          mostrar={mostrar}
        />
      )}
      {tab === 'control' && (
        <RegistrarControl
          lista={lista.filter((i) => i.activo !== false)}
          tols={tols}
          solicitudes={solicitudes}
          inicial={controlPara}
          operario={operario}
          mostrar={mostrar}
          alTerminar={() => { setControlPara(''); setTab('panel') }}
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
  frecMeses: 12, aCargo: '', apreciacion: '', tolerancia: '', ultimaRevision: '', vencimiento: '', activo: true, rechazado: false,
}

function Instrumentos({ lista, tols, editando, setEditando, irAControl, mostrar }) {
  const [q, setQ] = useState('')
  const [fTipo, setFTipo] = useState('')

  if (editando) {
    const base = editando === 'nuevo' ? VACIO : lista.find((i) => i.id === editando) || VACIO
    return (
      <FormInstrumento
        key={editando}
        inicial={base}
        id={editando === 'nuevo' ? null : editando}
        lista={lista}
        tols={tols}
        alTerminar={(msg) => { if (msg) mostrar(msg); setEditando(null) }}
      />
    )
  }

  const filtrada = lista
    .filter((i) => {
      const t = `${i.codigo} ${i.marca} ${i.nroFab} ${i.aCargo} ${i.tipoOtro || ''}`.toLowerCase()
      return t.includes(q.toLowerCase()) && (!fTipo || i.tipo === fTipo)
    })
    .sort((a, b) => estadoDe(a).orden - estadoDe(b).orden || a.codigo.localeCompare(b.codigo, 'es', { numeric: true }))

  const exportar = () => {
    const cab = ['Código', 'Tipo', 'Modalidad', 'N° fabricación', 'Marca', 'Frec. control (meses)', 'A cargo de', 'Apreciación', 'Última revisión', 'Vencimiento', 'Estado']
    const filas = lista.map((i) => [
      i.codigo, i.tipo === 'Otro' ? i.tipoOtro : i.tipo, i.modalidad, i.nroFab, i.marca, i.frecMeses, i.aCargo,
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
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => setEditando('nuevo')}>+ Nuevo instrumento</button>
          <button className="btn sec" onClick={exportar} disabled={!lista.length}>Exportar CSV</button>
        </div>
      </div>

      {filtrada.length === 0 && <div className="card vacio">No hay instrumentos para mostrar.</div>}
      {filtrada.map((i) => {
        const e = estadoDe(i)
        const t = tolDe(i, tols)
        return (
          <div className="lista-item" key={i.id}>
            <div>
              <div className="cod">{i.codigo}</div>
              <div className="meta">
                {i.tipo === 'Otro' ? i.tipoOtro || 'Otro' : i.tipo} · {i.modalidad} {i.marca && `· ${i.marca}`} {i.nroFab && `· N° ${i.nroFab}`}
              </div>
              <div className="meta">A cargo: {i.aCargo || '—'} · Última rev.: {fmt(i.ultimaRevision)} · Vence: {fmt(i.vencimiento)}</div>
              <div className="meta">Tolerancia: {t ? `${t.valor} mm (${t.origen})` : 'sin definir'}</div>
              <div className="row" style={{ marginTop: 8 }}>
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

function FormInstrumento({ inicial, id, lista, tols, alTerminar }) {
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

  const guardarInst = async () => {
    const codigo = f.codigo.trim()
    if (!codigo) return setErr('Falta el código del instrumento.')
    if (lista.some((i) => i.id !== id && i.codigo.toLowerCase() === codigo.toLowerCase())) return setErr('Ya existe un instrumento con ese código.')
    if (f.tipo === 'Otro' && !f.tipoOtro.trim()) return setErr('Indicá qué tipo de instrumento es.')
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
        <div>
          <label>Modalidad</label>
          <select value={f.modalidad} onChange={(e) => set('modalidad', e.target.value)}>
            {MODALIDADES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div><label>N° de fabricación</label><input value={f.nroFab} onChange={(e) => set('nroFab', e.target.value)} /></div>
        <div><label>Marca</label><input value={f.marca} onChange={(e) => set('marca', e.target.value)} /></div>
        <div><label>A cargo de</label><input value={f.aCargo} onChange={(e) => set('aCargo', e.target.value)} /></div>
        <div><label>Apreciación (mm)</label><input inputMode="decimal" value={f.apreciacion} onChange={(e) => set('apreciacion', e.target.value)} placeholder="0,01" /></div>
        <div>
          <label>Tolerancia propia (mm) — opcional</label>
          <input inputMode="decimal" value={f.tolerancia} onChange={(e) => set('tolerancia', e.target.value)} placeholder={deTabla ? `usa la tabla: ${deTabla.valor}` : 'sin definir en la tabla'} />
        </div>
        <div><label>Frecuencia de control (meses)</label><input type="number" min="1" value={f.frecMeses} onChange={(e) => cambiaRevisionOFrec('frecMeses', e.target.value)} /></div>
        <div><label>Última revisión</label><input type="date" value={f.ultimaRevision} onChange={(e) => cambiaRevisionOFrec('ultimaRevision', e.target.value)} /></div>
        <div><label>Fecha de vencimiento</label><input type="date" value={f.vencimiento} onChange={(e) => set('vencimiento', e.target.value)} /></div>
      </div>
      <div className="nota">El vencimiento se calcula solo (última revisión + frecuencia), pero lo podés corregir a mano. Si dejás la tolerancia propia vacía, se usa la de la pestaña Tolerancias para este tipo y modalidad.</div>
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
  const completo = cargados === PUNTOS
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
    if (tolInfo && !completo) return setErr(`Cargá los ${PUNTOS} puntos para que se calcule el resultado.`)
    const vence = resultado === 'Aprobado' ? sumarMeses(fecha, inst.frecMeses) || inst.vencimiento || '' : ''
    const id = nuevoId()
    await guardar('controles', id, {
      instrumentoId: inst.id, codigo: inst.codigo, fecha, galga: galga.trim(), incertidumbre: num(incert),
      puntos, resultado, resultadoAuto: !!auto, errorMax: puntos.length ? maxErr : null,
      tolerancia: tolInfo ? tolInfo.valor : null,
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
      </div>

      {inst && (
        <div className="nota">
          {inst.tipo === 'Otro' ? inst.tipoOtro : inst.tipo} · {inst.modalidad} · {inst.marca} · apreciación {inst.apreciacion || '—'} · frecuencia {inst.frecMeses} meses
        </div>
      )}

      <h2 style={{ marginTop: 16 }}>Mediciones ({PUNTOS})</h2>
      <div className="puntos">
        <span />
        <span className="h">Valor real (galga)</span><span className="h">Valor hallado</span><span className="h" style={{ textAlign: 'right' }}>Dif.</span>
        {reales.map((_, i) => (
          <PuntoFila key={i} i={i} real={reales[i]} hallado={hallados[i]} dif={difs[i]}
            onReal={(v) => setAt(reales, setReales, i, v)} onHallado={(v) => setAt(hallados, setHallados, i, v)} />
        ))}
      </div>

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
                  : <span className="nota">se calcula al cargar los {PUNTOS} puntos ({cargados}/{PUNTOS})</span>}
              </div>
            </>
          ) : (
            <>
              <div style={{ color: 'var(--warn)', fontSize: 14 }}>
                Este instrumento no tiene tolerancia definida (ni propia ni en la tabla de Calidad). El resultado hay que elegirlo a mano.
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
      await certificadoPDF(c, lista.find((i) => i.id === c.instrumentoId))
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
              <div className="cod">{c.codigo} <span className="meta">· {fmt(c.fecha)}</span></div>
              <div className="meta">Patrón: {c.galga || '—'} · Incert.: {c.incertidumbre ?? '—'} · Resp.: {c.responsable || '—'}</div>
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

  const filas = TIPOS.flatMap((t) => MODALIDADES.map((m) => ({ tipo: t, modalidad: m, key: tolKey(t, m) })))

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
      <h2>Tolerancias por tipo y modalidad</h2>
      <div className="nota" style={{ marginTop: 0, marginBottom: 10 }}>
        Error máximo permitido en mm, lo carga Gerencia de Calidad según su procedimiento. El control se aprueba si
        <b> error máximo + incertidumbre del patrón ≤ tolerancia</b>. Un instrumento puede tener además una tolerancia propia, que tiene prioridad.
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
          ['Marca', inst.marca || '—'],
          ['N° de fabricación', inst.nroFab || '—'],
          ['A cargo de', inst.aCargo || '—'],
          ['Apreciación', inst.apreciacion ? `${inst.apreciacion} mm` : '—'],
          ['Frecuencia de control', inst.frecMeses ? `${inst.frecMeses} meses` : '—'],
          ['Última revisión', fmt(inst.ultimaRevision)],
          ['Vencimiento', fmt(inst.vencimiento)],
          ['Tolerancia', t ? `${t.valor} mm (${t.origen})` : 'sin definir'],
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
                <button className="btn sec" onClick={() => certificadoPDF(ultimo, inst).catch(() => mostrar('No se pudo generar el PDF'))}>
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
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification('Solicitud de revisión', { body: `${s.codigo} - ${s.motivo}${s.maquina ? ` (máq. ${s.maquina})` : ''}\nPidió: ${s.solicitante || '—'}` })
      } catch { /* nada */ }
    }
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
