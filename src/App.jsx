import { useState, useEffect, useCallback, useRef } from "react";
import { initializeApp }                        from "firebase/app";
import { getDatabase, ref, set, update, get, onValue, off, query, orderByChild, startAt, onChildAdded, onChildChanged, onChildRemoved } from "firebase/database";

const QR_CDN = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
const FONTS = `@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;600&display=swap');`;

// ── Sonido de alerta ──────────────────────────────────────────────
function playAlert(type = "panol") {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = type === "panol" ? [523, 659, 784] : [440, 554, 659, 880];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = "sine"; osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.35, t + 0.05);
      gain.gain.linearRampToValueAtTime(0, t + 0.18);
      osc.start(t); osc.stop(t + 0.18);
    });
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  } catch (e) {}
}

// ── Hook notificaciones ───────────────────────────────────────────
function useNotifications(items, filterFn, logged, type) {
  const prevCount = useRef(null);
  const [toast, setToast] = useState(null);
  useEffect(() => {
    if (!logged) { prevCount.current = null; return; }
    const count = items.filter(filterFn).length;
    if (prevCount.current === null) { prevCount.current = count; return; }
    if (count > prevCount.current) {
      playAlert(type);
      setToast({ count: count - prevCount.current, type });
      setTimeout(() => setToast(null), 5000);
    }
    prevCount.current = count;
  }, [items, logged]);
  return toast;
}

// ── Toast ─────────────────────────────────────────────────────────
function Toast({ toast }) {
  if (!toast) return null;
  const isPanol = toast.type === "panol";
  return (
    <div style={{ position:"fixed", top:20, left:"50%", transform:"translateX(-50%)", zIndex:9999, display:"flex", alignItems:"center", gap:12, background: isPanol?"#16a34a":"#1d4ed8", color:"white", borderRadius:16, padding:"14px 20px", boxShadow:"0 8px 32px rgba(0,0,0,0.25)", minWidth:260, maxWidth:"90vw", animation:"slideDown 0.3s ease" }}>
      <style>{`@keyframes slideDown { from{opacity:0;transform:translateX(-50%) translateY(-20px)}to{opacity:1;transform:translateX(-50%) translateY(0)} }`}</style>
      <div style={{ fontSize:28 }}>{isPanol ? "📦" : "🔧"}</div>
      <div style={{ flex:1 }}>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:18, letterSpacing:2 }}>{isPanol ? "NUEVO PEDIDO" : "NUEVA SOLICITUD"}</div>
        <div style={{ fontSize:13, opacity:0.85 }}>{toast.count > 1 ? `${toast.count} nuevos` : "1 nuevo"} · Revisá el panel</div>
      </div>
    </div>
  );
}

// ── Storage ───────────────────────────────────────────────────────

// ── Firebase config ───────────────────────────────────────────────
const FB_CONFIG = {
  apiKey:            "AIzaSyATTeV7nVL3LG1H1x6yGMQ_2_KT3qmJ-nY",
  authDomain:        "emu---insumos.firebaseapp.com",
  databaseURL:       "https://emu---insumos-default-rtdb.firebaseio.com",
  projectId:         "emu---insumos",
  storageBucket:     "emu---insumos.firebasestorage.app",
  messagingSenderId: "200529926195",
  appId:             "1:200529926195:web:ddd711335129d824686b46",
};

// ── Firebase (modular SDK v12) ────────────────────────────────────

const _app = initializeApp(FB_CONFIG);
const _db  = getDatabase(_app);

async function fbSet(path, val) {
  await set(ref(_db, path), val);
}

async function fbUpdate(path, val) {
  await update(ref(_db, path), val);
}

function fbListen(path, cb) {
  const r = ref(_db, path);
  onValue(r, snap => cb(snap.exists() ? snap.val() : null));
  return () => off(r);
}

// ── Listener incremental (eficiente en ancho de banda) ─────────────
// A diferencia de fbListen (onValue), que retransmite TODA la colección
// cada vez que cambia un solo registro, esto usa child_added/changed/removed:
// cada evento trae solo el registro tocado, no la colección entera.
// Además admite un recorte por fecha (orderField + startAtValue) para no
// traer más que una ventana reciente por defecto.
function fbListenIncremental(path, cb, orderField, startAtValue) {
  const base = ref(_db, path);
  const q = orderField ? query(base, orderByChild(orderField), startAt(startAtValue)) : base;
  const store = {};
  let scheduled = false;
  const flush = () => { scheduled = false; cb({ ...store }); };
  const schedule = () => { if (!scheduled) { scheduled = true; setTimeout(flush, 60); } };

  const unsubAdd = onChildAdded(q,   snap => { store[snap.key] = snap.val(); schedule(); });
  const unsubChg = onChildChanged(q, snap => { store[snap.key] = snap.val(); schedule(); });
  const unsubRem = onChildRemoved(q, snap => { delete store[snap.key]; schedule(); });
  return () => { unsubAdd(); unsubChg(); unsubRem(); };
}

// Carga puntual (una sola vez, no deja un listener abierto) de la colección
// completa, para cuando un panel de administración necesita ver más allá
// de la ventana reciente (ej: estadísticas de "3 meses" o "todo").
async function fbGetAll(path) {
  const snap = await get(ref(_db, path));
  return snap.exists() ? snap.val() : {};
}

// ── Defaults ──────────────────────────────────────────────────────
const DEFAULT_INSUMOS = [
  { id:"i1", code:"BDMT040808", desc:"Inserto romboidal 80°" },
  { id:"i2", code:"CNMG120408", desc:"Inserto cuadrado neutro" },
  { id:"i3", code:"TNMG160408", desc:"Inserto triangular" },
  { id:"i4", code:"VCMT160408", desc:"Inserto rómbico 35°" },
  { id:"i5", code:"DCMT11T308", desc:"Inserto diamante 55°" },
  { id:"i6", code:"RCMT1204M0", desc:"Inserto redondo" },
  { id:"i7", code:"SNMG120408", desc:"Inserto cuadrado positivo" },
  { id:"i8", code:"WNMG080408", desc:"Inserto trigonal 80°" },
];
const DEFAULT_MACHINES = [
  { id:"m1", name:"Torno CNC-1" }, { id:"m2", name:"Torno CNC-2" },
  { id:"m3", name:"Fresadora F-1" }, { id:"m4", name:"Centro Mecanizado CM-1" },
];
const DEFAULT_TIPOS    = ["Falla eléctrica","Falla mecánica","Falla hidráulica","Ruido anormal","Vibración excesiva","Temperatura elevada","Error de control / CNC","Otro"];
const DEFAULT_MOTIVOS  = ["T.P.M.","Camb. Herramienta","Correcciones / P. a Punto","Limpieza","Derrames","Camb. Proceso","Manten. APC","Manten. ATC/Torreta","Alarmas","Alimentación M. en Bruto","Manten. General","Otros"];

const STATUS_PANOL = {
  pendiente:  { label:"Pendiente",  color:"#F59E0B", bg:"#FEF3C7" },
  preparando: { label:"Preparando", color:"#3B82F6", bg:"#DBEAFE" },
  listo:      { label:"Listo",      color:"#16a34a", bg:"#dcfce7" },
  entregado:  { label:"Entregado",  color:"#6B7280", bg:"#F3F4F6" },
  cancelado:  { label:"Cancelado",  color:"#EF4444", bg:"#FEE2E2" },
};
const STATUS_MANT = {
  pendiente: { label:"Pendiente", color:"#F59E0B", bg:"#FEF3C7" },
  recibido:  { label:"Recibido",  color:"#16a34a", bg:"#dcfce7" },
};
const ORANGE = "#ea580c";
const TURNOS_CONFIG = {
  "Mañana": { inicio:6,  slots:9, label:"06:00 - 14:30", duracionMin: 8.5*60 },
  "Tarde":  { inicio:14, slots:9, label:"14:30 - 23:00", duracionMin: 8.5*60 },
  "Noche":  { inicio:23, slots:8, label:"23:00 - 06:00", duracionMin: 7*60 },
};
const TURNOS = ["Mañana","Tarde","Noche"];

// ── Normalización / migración automática de registros viejos ────────
// Convierte cualquier registro (viejo o nuevo) al formato piezasCargadas:
// [{ numero, izq, der, scrapIzq, scrapDer, fundIzq, fundDer, pendIzq, pendDer }]
// No modifica los datos en Firebase — normaliza solo en memoria, para no
// tocar registros históricos ni arriesgar la base de datos en producción.
function normalizarRegistro(r) {
  if (Array.isArray(r.piezasCargadas) && r.piezasCargadas.length > 0) return r;

  const nums = [...new Set([...(r.piezas || []), ...(r.pieza ? [r.pieza] : [])])];
  const cargas = [];
  const total1 = (r.pieza1Izq || 0) + (r.pieza1Der || 0);
  const total2 = (r.pieza2Izq || 0) + (r.pieza2Der || 0);

  if (total1 > 0 || nums[0]) {
    // Toda la calidad (scrap/fundición/pendiente) del registro viejo se
    // atribuye acá, porque el formato anterior no la separaba por pieza.
    cargas.push({
      numero: nums[0] || "Sin especificar",
      izq: r.pieza1Izq || 0, der: r.pieza1Der || 0,
      scrapIzq: r.scrapIzq || 0, scrapDer: r.scrapDer || 0,
      fundIzq: r.fundIzq || 0, fundDer: r.fundDer || 0,
      pendIzq: r.pendIzq || 0, pendDer: r.pendDer || 0,
    });
  }
  if (total2 > 0 || nums[1]) {
    cargas.push({
      numero: nums[1] || "Sin especificar",
      izq: r.pieza2Izq || 0, der: r.pieza2Der || 0,
      scrapIzq: 0, scrapDer: 0, fundIzq: 0, fundDer: 0, pendIzq: 0, pendDer: 0,
    });
  }
  if (cargas.length === 0) {
    cargas.push({ numero: nums[0] || "Sin especificar", izq:0, der:0, scrapIzq:0, scrapDer:0, fundIzq:0, fundDer:0, pendIzq:0, pendDer:0 });
  }
  return { ...r, piezasCargadas: cargas };
}

// ── Cálculo de OEE ──────────────────────────────────────────────────
// registro: objeto guardado en prodRegistros (formato nuevo o viejo, se normaliza acá)
// piezas:   colección de piezas configuradas (con tiempoCiclo en segundos)
function calcularOEE(registroRaw, piezas) {
  const registro = normalizarRegistro(registroRaw);
  const cfg = TURNOS_CONFIG[registro.turno];
  const planificadoMin = cfg ? cfg.duracionMin : 0;

  const paradaMin = (registro.paradas || []).reduce((a, p) => a + (p.minutos || 0), 0);
  const disponibleMin = Math.max(0, planificadoMin - paradaMin);
  const disponibilidad = planificadoMin > 0 ? disponibleMin / planificadoMin : 0;

  let totalProducido = 0, totalOk = 0, tiempoIdealSeg = 0;
  for (const c of registro.piezasCargadas) {
    const producido = (c.izq || 0) + (c.der || 0);
    const malos = (c.scrapIzq||0)+(c.scrapDer||0)+(c.fundIzq||0)+(c.fundDer||0)+(c.pendIzq||0)+(c.pendDer||0);
    totalProducido += producido;
    totalOk += Math.max(0, producido - malos);
    const piezaCfg = piezas.find(pz => pz.numero === c.numero && pz.maquina === registro.maquina);
    const ciclo = piezaCfg?.tiempoCiclo ? parseFloat(piezaCfg.tiempoCiclo) : 0;
    tiempoIdealSeg += producido * ciclo;
  }

  const calidad = totalProducido > 0 ? totalOk / totalProducido : 0;
  const tiempoIdealMin = tiempoIdealSeg / 60;
  const rendimiento = disponibleMin > 0 ? Math.min(tiempoIdealMin / disponibleMin, 1) : 0;
  const oee = disponibilidad * rendimiento * calidad;

  return {
    planificadoMin, paradaMin, disponibleMin, disponibilidad,
    totalProducido, totalOk, calidad,
    tiempoIdealMin, rendimiento,
    oee,
    sinDatosDeCiclo: tiempoIdealSeg === 0 && totalProducido > 0,
  };
}

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #f0f4f1; font-family: 'DM Sans', sans-serif; min-height: 100vh; }
  :root {
    --green:#16a34a; --green-hi:#22c55e; --green-bg:#f0fdf4; --dark:#0f1f0f;
    --surface:#ffffff; --surface2:#f6faf7; --border:#d1e8d8; --text:#1a2e1a; --muted:#6b8f72; --page-bg:#f0f4f1;
  }
  select { appearance: none; }
`;


// ── Auditoría ─────────────────────────────────────────────────────
// Registra quién hizo un cambio de configuración y cuándo, sin bloquear
// el flujo si por algún motivo falla el guardado.
function registrarAuditoria(addAuditLog, area, quien, accion, detalle) {
  try {
    addAuditLog({
      id: `AUD${Date.now()}${Math.floor(Math.random()*1000)}`,
      area, quien: quien || "Sin identificar", accion, detalle: detalle || "",
      timestamp: new Date().toISOString(),
    });
  } catch (e) { console.error("Error al registrar auditoría:", e); }
}

// Input reutilizable para identificar a quién hace el cambio.
// Guarda el nombre en localStorage del dispositivo para no pedirlo cada vez.
function useQuien(storageKey) {
  const [quien, setQuien] = useState(() => {
    try { return localStorage.getItem(storageKey) || ""; } catch(e) { return ""; }
  });
  const updateQuien = (v) => {
    setQuien(v);
    try { localStorage.setItem(storageKey, v); } catch(e) {}
  };
  return [quien, updateQuien];
}

function QuienInput({ quien, setQuien }) {
  return (
    <div style={{ background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:12, padding:"10px 14px", marginBottom:14, display:"flex", alignItems:"center", gap:10 }}>
      <span style={{ fontSize:18 }}>🖊️</span>
      <div style={{ flex:1 }}>
        <div style={{ fontSize:10, color:"#9a6000", fontWeight:700, letterSpacing:1, textTransform:"uppercase", marginBottom:3 }}>Tu nombre (para el registro de cambios)</div>
        <input value={quien} onChange={e=>setQuien(e.target.value)} placeholder="Nombre y apellido"
          style={{ width:"100%", background:"white", border:"1px solid #fed7aa", borderRadius:8, padding:"7px 10px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:14, outline:"none" }} />
      </div>
    </div>
  );
}

// ── FAQ de fallas por máquina (compartido entre Producción y Mantenimiento) ──
function FaqView({ area, machines, operarios, faqs, addFaq, removeFaq, addAuditLog }) {
  const [quien, setQuien]     = useQuien(area === "produccion" ? "sig_quien_prod" : "sig_quien_mant");
  const [maquina, setMaquina] = useState(machines[0]?.name || "");
  const [titulo, setTitulo]   = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [filtroMaq, setFiltroMaq]     = useState("todas");
  const [expandedId, setExpandedId]   = useState(null);

  const lbl = { fontSize:12, color:"var(--muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 };
  const chip = (val, cur) => ({ background:val===cur?ORANGE:"var(--surface2)", border:`1px solid ${val===cur?ORANGE:"var(--border)"}`, borderRadius:8, padding:"8px 14px", color:val===cur?"white":"var(--text)", fontFamily:"'DM Sans'", fontSize:13, fontWeight:500, cursor:"pointer" });

  const handleAdd = () => {
    if (!titulo.trim() || !descripcion.trim() || !maquina) return;
    const entry = {
      id: `FAQ${Date.now()}`,
      maquina, titulo: titulo.trim(), descripcion: descripcion.trim(),
      autor: quien || "Sin identificar", area,
      createdAt: new Date().toISOString(),
    };
    addFaq(entry);
    registrarAuditoria(addAuditLog, area, quien, "Agregó una falla al FAQ", `${maquina} — ${titulo.trim()}`);
    setTitulo(""); setDescripcion("");
  };
  const handleRemove = (f) => {
    removeFaq(f.id);
    registrarAuditoria(addAuditLog, area, quien, "Eliminó una falla del FAQ", `${f.maquina} — ${f.titulo}`);
  };

  const filtered = faqs
    .filter(f => filtroMaq === "todas" || f.maquina === filtroMaq)
    .sort((a,b) => (b.createdAt||"").localeCompare(a.createdAt||""));

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      {area === "produccion"
        ? <QuienOperarioInput quien={quien} setQuien={setQuien} operarios={operarios||[]} />
        : <QuienInput quien={quien} setQuien={setQuien} />}

      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:ORANGE, marginBottom:14 }}>CARGAR FALLA CONOCIDA</div>
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <div>
            <label style={lbl}>Máquina</label>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
              {machines.map(m => <button key={m.id} onClick={() => setMaquina(m.name)} style={chip(m.name, maquina)}>{m.name}</button>)}
            </div>
          </div>
          <div>
            <label style={lbl}>Título (ej: "Falla ATC")</label>
            <input value={titulo} onChange={e=>setTitulo(e.target.value)} placeholder="Título de la falla"
              style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", fontSize:14, color:"var(--text)", outline:"none" }} />
          </div>
          <div>
            <label style={lbl}>Descripción / solución</label>
            <textarea value={descripcion} onChange={e=>setDescripcion(e.target.value)} placeholder='Ej: "Cuando falla el ATC, reiniciar la máquina y referenciar ejes."'
              style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", fontSize:14, color:"var(--text)", outline:"none", resize:"none", height:80 }} />
          </div>
          <button onClick={handleAdd} style={{ background:ORANGE, border:"none", borderRadius:10, padding:"12px", fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:"white", cursor:"pointer" }}>+ AGREGAR AL FAQ</button>
        </div>
      </div>

      <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
        <button style={chip("todas", filtroMaq)} onClick={() => setFiltroMaq("todas")}>Todas las máquinas</button>
        {machines.map(m => <button key={m.id} style={chip(m.name, filtroMaq)} onClick={() => setFiltroMaq(m.name)}>{m.name}</button>)}
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign:"center", color:"var(--muted)", padding:"2.5rem", background:"var(--surface)", borderRadius:16, border:"1px solid var(--border)" }}>
          Todavía no hay fallas cargadas{filtroMaq!=="todas" ? ` para ${filtroMaq}` : ""}.
        </div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {filtered.map(f => (
            <div key={f.id} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, overflow:"hidden" }}>
              <button onClick={() => setExpandedId(expandedId===f.id?null:f.id)} style={{ width:"100%", textAlign:"left", background:"none", border:"none", padding:"12px 16px", cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div>
                  <div style={{ fontFamily:"'Bebas Neue'", fontSize:15, color:"var(--text)", letterSpacing:1 }}>{f.titulo}</div>
                  <div style={{ fontSize:11, color:"var(--muted)", marginTop:2 }}>{f.maquina} · {f.autor}</div>
                </div>
                <span style={{ color:"var(--muted)" }}>{expandedId===f.id?"▲":"▼"}</span>
              </button>
              {expandedId===f.id && (
                <div style={{ borderTop:"1px solid var(--border)", padding:"12px 16px" }}>
                  <div style={{ fontSize:14, color:"var(--text)", whiteSpace:"pre-wrap", marginBottom:10 }}>{f.descripcion}</div>
                  <button onClick={() => handleRemove(f)} style={{ background:"none", border:"1px solid #EF444466", borderRadius:6, padding:"4px 10px", color:"#EF4444", cursor:"pointer", fontSize:12 }}>Eliminar</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Vista compacta de solo lectura para el operario, embebida en su puesto de trabajo.
function FaqPuestoWidget({ faqs, maquina }) {
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const propias = faqs.filter(f => f.maquina === maquina).sort((a,b) => (b.createdAt||"").localeCompare(a.createdAt||""));

  return (
    <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, overflow:"hidden" }}>
      <button onClick={() => setOpen(!open)} style={{ width:"100%", background:"none", border:"none", padding:"14px 16px", cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:18 }}>❓</span>
          <span style={{ fontFamily:"'Bebas Neue'", fontSize:15, letterSpacing:1, color:"var(--text)" }}>FALLAS CONOCIDAS</span>
          {propias.length > 0 && <span style={{ background:ORANGE, color:"white", borderRadius:999, padding:"1px 8px", fontSize:11, fontWeight:700 }}>{propias.length}</span>}
        </div>
        <span style={{ color:"var(--muted)" }}>{open?"▲":"▼"}</span>
      </button>
      {open && (
        <div style={{ borderTop:"1px solid var(--border)", padding:"10px 16px", display:"flex", flexDirection:"column", gap:6 }}>
          {propias.length === 0 ? (
            <div style={{ color:"var(--muted)", fontSize:13, padding:"8px 0" }}>Todavía no hay fallas conocidas cargadas para esta máquina.</div>
          ) : propias.map(f => (
            <div key={f.id} style={{ background:"var(--surface2)", borderRadius:10, overflow:"hidden" }}>
              <button onClick={() => setExpandedId(expandedId===f.id?null:f.id)} style={{ width:"100%", textAlign:"left", background:"none", border:"none", padding:"10px 12px", cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <span style={{ fontSize:14, fontWeight:600, color:"var(--text)" }}>{f.titulo}</span>
                <span style={{ color:"var(--muted)", fontSize:12 }}>{expandedId===f.id?"▲":"▼"}</span>
              </button>
              {expandedId===f.id && (
                <div style={{ padding:"0 12px 10px" }}>
                  <div style={{ fontSize:13, color:"var(--text)", whiteSpace:"pre-wrap" }}>{f.descripcion}</div>
                  <div style={{ fontSize:11, color:"var(--muted)", marginTop:6 }}>— {f.autor}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Identificación para Producción: elegir un operario existente (número) o
// escribir un nombre manualmente (para supervisores sin PIN de operario).
function QuienOperarioInput({ quien, setQuien, operarios }) {
  const esOperario = quien !== "" && operarios.some(o => o.numero === quien);
  return (
    <div style={{ background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:12, padding:"10px 14px", marginBottom:14 }}>
      <div style={{ fontSize:10, color:"#9a6000", fontWeight:700, letterSpacing:1, textTransform:"uppercase", marginBottom:6 }}>¿Quién hace este cambio? (para el registro)</div>
      <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
        <select value={esOperario ? quien : ""} onChange={e => setQuien(e.target.value)}
          style={{ background:"white", border:"1px solid #fed7aa", borderRadius:8, padding:"7px 10px", fontSize:14, color:"var(--text)", outline:"none" }}>
          <option value="">— Elegir operario —</option>
          {operarios.map(o => <option key={o.id} value={o.numero}>{o.numero}</option>)}
        </select>
        <input value={!esOperario ? quien : ""} onChange={e=>setQuien(e.target.value)} placeholder="O escribí tu nombre (supervisor / otro)"
          style={{ flex:1, minWidth:160, background:"white", border:"1px solid #fed7aa", borderRadius:8, padding:"7px 10px", fontSize:14, color:"var(--text)", outline:"none" }} />
      </div>
    </div>
  );
}

function HistorialAuditoria({ auditLog, area, cargaCompleta, cargarHistorialCompleto }) {
  const entradas = auditLog.filter(a => a.area === area).sort((a,b) => (b.timestamp||"").localeCompare(a.timestamp||""));
  const completo = cargaCompleta?.auditoria;
  const boton = cargarHistorialCompleto && (
    <button onClick={() => cargarHistorialCompleto("auditoria")} disabled={completo}
      style={{ background: completo ? "var(--surface2)" : ORANGE, border:"none", borderRadius:8, padding:"8px 14px", color: completo ? "var(--muted)" : "white", fontSize:12, fontWeight:600, cursor: completo ? "default" : "pointer" }}>
      {completo ? "✓ Historial completo cargado" : "Ver historial completo (más de 60 días)"}
    </button>
  );
  if (entradas.length === 0) {
    return (
      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {boton}
        <div style={{ textAlign:"center", color:"var(--muted)", padding:"2.5rem", background:"var(--surface)", borderRadius:16, border:"1px solid var(--border)" }}>Todavía no hay cambios registrados.</div>
      </div>
    );
  }
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      {boton}
      {entradas.map(a => (
        <div key={a.id} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"10px 14px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:3 }}>
            <span style={{ fontFamily:"'JetBrains Mono'", fontSize:13, fontWeight:700, color:"var(--text)" }}>{a.quien}</span>
            <span style={{ fontSize:11, color:"var(--muted)" }}>{a.timestamp ? new Date(a.timestamp).toLocaleString("es-AR") : ""}</span>
          </div>
          <div style={{ fontSize:13, color:"var(--text)" }}><strong>{a.accion}</strong>{a.detalle ? ` — ${a.detalle}` : ""}</div>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const params  = new URLSearchParams(window.location.search);
  const mqParam = params.get("maquina");

  const [ready,          setReady]          = useState(false);
  const [view,           setView]           = useState(mqParam ? "puesto" : "home");
  const [selMachine,     setSelMachine]     = useState(mqParam || null);
  const [pedidos,        setPedidos]        = useState([]);
  const [machines,       setMachines]       = useState(DEFAULT_MACHINES);
  const [insumos,        setInsumos]        = useState(DEFAULT_INSUMOS);
  const [panolPin,       setPanolPin]       = useState("1234");
  const [machineInsumos, setMachineInsumos] = useState({});
  const [panolLogged,    setPanolLogged]    = useState(false);
  const [mantenimientos, setMantenimientos] = useState([]);
  const [mantPin,        setMantPin]        = useState("5678");
  const [mantLogged,     setMantLogged]     = useState(false);
  const [tiposFalla,     setTiposFalla]     = useState(DEFAULT_TIPOS);
  const [prodRegistros,  setProdRegistros]  = useState([]);
  const [prodPin,        setProdPin]        = useState("9999");
  const [prodOperarios,  setProdOperarios]  = useState([]);
  const [prodPiezas,     setProdPiezas]     = useState([]);
  const [prodMotivos,    setProdMotivos]    = useState(DEFAULT_MOTIVOS);
  const [prodLogged,     setProdLogged]     = useState(false);
  const [auditLog,       setAuditLog]       = useState([]);
  const [faqs,           setFaqs]           = useState([]);
  const [cargaCompleta,  setCargaCompleta]  = useState({ pedidos:false, mantenimientos:false, prodRegistros:false, auditoria:false });

  useEffect(() => {
    const toArr = v => v ? Object.values(v) : [];
    const unsubs = [];
    // Ventana reciente por defecto para las colecciones que más crecen —
    // esto evita retransmitir años de historial cada vez que se abre la app.
    const dias = (n) => new Date(Date.now() - n*24*60*60*1000).toISOString().slice(0,10);
    unsubs.push(fbListenIncremental("pedidos",        v => setPedidos(toArr(v)),        "createdAt", dias(60)));
    unsubs.push(fbListenIncremental("mantenimientos", v => setMantenimientos(toArr(v)), "createdAt", dias(60)));
    unsubs.push(fbListen("machines",       v => setMachines(v ? toArr(v) : DEFAULT_MACHINES)));
    unsubs.push(fbListen("insumos",        v => setInsumos(v ? toArr(v) : DEFAULT_INSUMOS)));
    unsubs.push(fbListen("machineInsumos", v => setMachineInsumos(v || {})));
    unsubs.push(fbListen("panolPin",       v => { if (v) setPanolPin(v); }));
    unsubs.push(fbListen("mantPin",        v => { if (v) setMantPin(v); }));
    unsubs.push(fbListen("tiposFalla",     v => setTiposFalla(v ? toArr(v) : DEFAULT_TIPOS)));
    unsubs.push(fbListenIncremental("prodRegistros",  v => setProdRegistros(toArr(v)),  "fecha", dias(30)));
    unsubs.push(fbListen("prodPin",        v => { if (v) setProdPin(v); }));
    unsubs.push(fbListen("prodOperarios",  v => setProdOperarios(toArr(v))));
    unsubs.push(fbListen("prodPiezas",     v => setProdPiezas(toArr(v))));
    unsubs.push(fbListen("prodMotivos",    v => setProdMotivos(v ? toArr(v) : DEFAULT_MOTIVOS)));
    unsubs.push(fbListenIncremental("auditoria",      v => setAuditLog(toArr(v)),       "timestamp", dias(60)));
    unsubs.push(fbListen("faqs",           v => setFaqs(toArr(v))));

    const doSeed = async () => {
      try {
        const snap = await get(ref(_db, "machines"));
        if (!snap.exists()) {
          const mObj = {}; DEFAULT_MACHINES.forEach(m => { mObj[m.id] = m; });
          const iObj = {}; DEFAULT_INSUMOS.forEach(i  => { iObj[i.id] = i; });
          const tObj = {}; DEFAULT_TIPOS.forEach((t,i)   => { tObj[`t${i}`] = t; });
          const mtvObj = {}; DEFAULT_MOTIVOS.forEach((m,i) => { mtvObj[`mv${i}`] = m; });
          await fbSet("machines", mObj);
          await fbSet("insumos", iObj);
          await fbSet("tiposFalla", tObj);
          await fbSet("prodMotivos", mtvObj);
          await fbSet("panolPin", "1234");
          await fbSet("mantPin", "5678");
          await fbSet("prodPin", "9999");
        }
      } catch(e) {
        console.error("Firebase seed error:", e);
      } finally {
        setReady(true);
      }
    };
    doSeed();
    return () => unsubs.forEach(fn => fn());
  }, []);

  const addPedido         = useCallback((p) => fbSet(`pedidos/${p.id}`, p), []);
  const updatePedido      = useCallback((id, ch) => { fbUpdate(`pedidos/${id}`, ch); }, []);
  const addMantenimiento  = useCallback((m) => fbSet(`mantenimientos/${m.id}`, m), []);
  const updateMantenimiento = useCallback((id, ch) => { fbUpdate(`mantenimientos/${id}`, ch); }, []);
  const addProdRegistro   = useCallback((r) => fbSet(`prodRegistros/${r.id}`, r), []);
  const addAuditLog       = useCallback((entry) => fbSet(`auditoria/${entry.id}`, entry), []);
  const addFaq            = useCallback((f) => fbSet(`faqs/${f.id}`, f), []);
  const removeFaq         = useCallback((id) => fbSet(`faqs/${id}`, null), []);

  // Trae la colección completa una sola vez (no deja listener abierto) y la
  // mezcla con lo que ya está cargado por la ventana reciente. Se usa cuando
  // un panel pide ver más historial del que se sincroniza por defecto.
  const cargarHistorialCompleto = useCallback(async (coleccion) => {
    const setters = {
      pedidos: setPedidos, mantenimientos: setMantenimientos,
      prodRegistros: setProdRegistros, auditoria: setAuditLog,
    };
    const setter = setters[coleccion];
    if (!setter) return;
    let yaCargado = false;
    setCargaCompleta(prev => { yaCargado = !!prev[coleccion]; return prev; });
    if (yaCargado) return;
    try {
      const val = await fbGetAll(coleccion);
      const completos = Object.values(val);
      setter(prev => {
        const map = {}; prev.forEach(x => map[x.id] = x);
        completos.forEach(x => map[x.id] = x);
        return Object.values(map);
      });
      setCargaCompleta(prev => ({ ...prev, [coleccion]: true }));
    } catch (e) { console.error("Error al cargar historial completo:", e); }
  }, []);

  const handleSetMachines = useCallback((upd) => {
    setMachines(prev => { const next = typeof upd==="function"?upd(prev):upd; const obj={}; next.forEach(m=>{obj[m.id]=m;}); fbSet("machines",obj); return next; });
  }, []);
  const handleSetInsumos = useCallback((upd) => {
    setInsumos(prev => { const next = typeof upd==="function"?upd(prev):upd; const obj={}; next.forEach(i=>{obj[i.id]=i;}); fbSet("insumos",obj); return next; });
  }, []);
  const handleSetMachineInsumos = useCallback((upd) => {
    setMachineInsumos(prev => { const next = typeof upd==="function"?upd(prev):upd; fbSet("machineInsumos",next); return next; });
  }, []);
  const handleSetPanolPin  = useCallback((v) => { setPanolPin(v);  fbSet("panolPin",v);  }, []);
  const handleSetMantPin   = useCallback((v) => { setMantPin(v);   fbSet("mantPin",v);   }, []);
  const handleSetProdPin   = useCallback((v) => { setProdPin(v);   fbSet("prodPin",v);   }, []);
  const handleSetTiposFalla = useCallback((upd) => {
    setTiposFalla(prev => { const next = typeof upd==="function"?upd(prev):upd; const obj={}; next.forEach((t,i)=>{obj[`t${i}`]=t;}); fbSet("tiposFalla",obj); return next; });
  }, []);
  const handleSetProdOperarios = useCallback((upd) => {
    setProdOperarios(prev => { const next = typeof upd==="function"?upd(prev):upd; const obj={}; next.forEach(o=>{obj[o.id]=o;}); fbSet("prodOperarios",obj); return next; });
  }, []);
  const handleSetProdPiezas = useCallback((upd) => {
    setProdPiezas(prev => { const next = typeof upd==="function"?upd(prev):upd; const obj={}; next.forEach(p=>{obj[p.id]=p;}); fbSet("prodPiezas",obj); return next; });
  }, []);
  const handleSetProdMotivos = useCallback((upd) => {
    setProdMotivos(prev => { const next = typeof upd==="function"?upd(prev):upd; const obj={}; next.forEach((m,i)=>{obj[`mv${i}`]=m;}); fbSet("prodMotivos",obj); return next; });
  }, []);

  if (!ready) return (
    <div style={{ minHeight:"100vh", background:"#f0f4f1", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16 }}>
      <style>{FONTS}</style>
      <div style={{ fontFamily:"'Bebas Neue'", fontSize:32, color:"#16a34a", letterSpacing:5 }}>S.I.G</div>
      <div style={{ fontFamily:"'DM Sans'", color:"#6b8f72", fontSize:14, letterSpacing:1 }}>Conectando con el servidor...</div>
    </div>
  );

  return (
    <>
      <style>{FONTS}</style>
      <style>{CSS}</style>
      {view==="home"          && <HomeView          setView={setView} setSelMachine={setSelMachine} machines={machines} pedidos={pedidos} mantenimientos={mantenimientos} />}
      {view==="puesto"        && <PuestoView        machineName={selMachine} machines={machines} insumos={insumos} machineInsumos={machineInsumos} addPedido={addPedido} addMantenimiento={addMantenimiento} addRegistro={addProdRegistro} registros={prodRegistros} setView={setView} tiposFalla={tiposFalla} operarios={prodOperarios} piezas={prodPiezas} motivos={prodMotivos} faqs={faqs} />}
      {view==="panol"         && <PanolView         pedidos={pedidos} updatePedido={updatePedido} logged={panolLogged} setLogged={setPanolLogged} setView={setView} panolPin={panolPin} setPanolPin={handleSetPanolPin} machines={machines} setMachines={handleSetMachines} insumos={insumos} setInsumos={handleSetInsumos} machineInsumos={machineInsumos} setMachineInsumos={handleSetMachineInsumos} auditLog={auditLog} addAuditLog={addAuditLog} cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
      {view==="mantenimiento" && <MantenimientoView mantenimientos={mantenimientos} updateMantenimiento={updateMantenimiento} logged={mantLogged} setLogged={setMantLogged} setView={setView} mantPin={mantPin} setMantPin={handleSetMantPin} tiposFalla={tiposFalla} setTiposFalla={handleSetTiposFalla} machines={machines} auditLog={auditLog} addAuditLog={addAuditLog} faqs={faqs} addFaq={addFaq} removeFaq={removeFaq} cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
      {view==="produccion"    && <ProduccionView    registros={prodRegistros} addRegistro={addProdRegistro} logged={prodLogged} setLogged={setProdLogged} setView={setView} prodPin={prodPin} setProdPin={handleSetProdPin} operarios={prodOperarios} setOperarios={handleSetProdOperarios} piezas={prodPiezas} setPiezas={handleSetProdPiezas} motivos={prodMotivos} setMotivos={handleSetProdMotivos} machines={machines} auditLog={auditLog} addAuditLog={addAuditLog} faqs={faqs} addFaq={addFaq} removeFaq={removeFaq} cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
    </>
  );
}

function HomeView({ setView, setSelMachine, machines, pedidos, mantenimientos }) {
  const pendingPanol = pedidos.filter(p => p.status === "pendiente").length;
  const pendingMant  = mantenimientos.filter(m => m.status === "pendiente").length;
  return (
    <div style={{ minHeight:"100vh", background:"var(--page-bg)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"2rem" }}>
      <div style={{ maxWidth:460, width:"100%" }}>
        <div style={{ textAlign:"center", marginBottom:"2.5rem" }}>
          <div style={{ display:"inline-flex", alignItems:"center", gap:14, marginBottom:10 }}>
            <div style={{ textAlign:"left" }}>
              <div style={{ fontFamily:"'Bebas Neue'", fontSize:40, color:"var(--green)", letterSpacing:5, lineHeight:1 }}>S.I.G</div>
              <div style={{ fontSize:12, color:"var(--muted)", letterSpacing:2, marginTop:2, fontWeight:500 }}>SISTEMA DE GESTIÓN INTERNA</div>
            </div>
          </div>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.5rem" }}>
            <p style={{ color:"var(--muted)", fontSize:12, textTransform:"uppercase", letterSpacing:2, marginBottom:14, fontWeight:600 }}>Puesto de trabajo</p>
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {machines.map(m => (
                <button key={m.id} onClick={() => { setSelMachine(m.name); setView("puesto"); }}
                  style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"13px 16px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:15, fontWeight:500, cursor:"pointer", textAlign:"left", transition:"all 0.2s" }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor="var(--green)"; e.currentTarget.style.background="var(--green-bg)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor="var(--border)"; e.currentTarget.style.background="var(--surface2)"; }}>
                  🔧 {m.name}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display:"flex", gap:10 }}>
            <button onClick={() => setView("panol")}
              style={{ flex:1, background:"var(--green)", border:"none", borderRadius:16, padding:"1.1rem 1rem", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"space-between", transition:"opacity 0.2s" }}
              onMouseEnter={e=>e.currentTarget.style.opacity="0.9"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
              <div style={{ textAlign:"left" }}>
                <div style={{ fontFamily:"'Bebas Neue'", fontSize:20, letterSpacing:2, color:"white" }}>PANEL PAÑOL</div>
                <div style={{ fontSize:12, color:"rgba(255,255,255,0.75)", marginTop:2 }}>Insumos · Admin</div>
              </div>
              {pendingPanol > 0 && <div style={{ background:"#EF4444", color:"white", borderRadius:999, width:28, height:28, display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:700 }}>{pendingPanol}</div>}
            </button>
            <button onClick={() => setView("mantenimiento")}
              style={{ flex:1, background:"#1d4ed8", border:"none", borderRadius:16, padding:"1.1rem 1rem", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"space-between", transition:"opacity 0.2s" }}
              onMouseEnter={e=>e.currentTarget.style.opacity="0.9"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
              <div style={{ textAlign:"left" }}>
                <div style={{ fontFamily:"'Bebas Neue'", fontSize:20, letterSpacing:2, color:"white" }}>MANTENIMIENTO</div>
                <div style={{ fontSize:12, color:"rgba(255,255,255,0.75)", marginTop:2 }}>Solicitudes</div>
              </div>
              {pendingMant > 0 && <div style={{ background:"#EF4444", color:"white", borderRadius:999, width:28, height:28, display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:700 }}>{pendingMant}</div>}
            </button>
          </div>
          <button onClick={() => setView("produccion")}
            style={{ background:"#ea580c", border:"none", borderRadius:16, padding:"1.1rem 1.5rem", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"space-between", transition:"opacity 0.2s" }}
            onMouseEnter={e=>e.currentTarget.style.opacity="0.9"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
            <div style={{ textAlign:"left" }}>
              <div style={{ fontFamily:"'Bebas Neue'", fontSize:20, letterSpacing:2, color:"white" }}>PRODUCCIÓN</div>
              <div style={{ fontSize:12, color:"rgba(255,255,255,0.75)", marginTop:2 }}>Carga de planillas · Operarios · Reportes</div>
            </div>
            <span style={{ fontSize:28 }}>🏭</span>
          </button>
        </div>
        <div style={{ textAlign:"center", marginTop:24, color:"var(--muted)", fontSize:12 }}>S.I.G · Sistema interno de gestión</div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// PUESTO
// ════════════════════════════════════════════════════════════════════
function PuestoView({ machineName, machines, insumos, machineInsumos, addPedido, addMantenimiento, addRegistro, registros, setView, tiposFalla, operarios, piezas, motivos, faqs }) {
  const [tab, setTab]           = useState("insumos");
  const [qtys, setQtys]         = useState({});
  const [sentPedido, setSentPedido] = useState(false);
  const [nota, setNota]         = useState("");
  const [tipoFalla, setTipoFalla] = useState("");
  const [descFalla, setDescFalla] = useState("");
  const [sentMant, setSentMant] = useState(false);

  const machine  = machines.find(m => m.name === machineName) || { name: machineName, id: null };
  const assigned = machine.id && machineInsumos[machine.id];
  const lista    = (assigned && assigned.length > 0) ? insumos.filter(i => assigned.includes(i.id)) : insumos;
  const setQty   = (id, val) => setQtys(prev => ({ ...prev, [id]: Math.max(0, parseInt(val) || 0) }));
  const selected = lista.filter(i => qtys[i.id] > 0);
  const total    = Object.values(qtys).reduce((a, b) => a + b, 0);

  const [enviandoPedido, setEnviandoPedido] = useState(false);
  const [errorPedido, setErrorPedido] = useState("");
  const handlePedir = async () => {
    if (!selected.length) return;
    setEnviandoPedido(true);
    setErrorPedido("");
    try {
      await addPedido({ id:`P${Date.now()}`, machine:machine.name, items:selected.map(i=>({...i,qty:qtys[i.id]})), nota, status:"pendiente", createdAt:new Date().toISOString() });
      setSentPedido(true);
    } catch(e) {
      setErrorPedido("Error al enviar. Revisá tu conexión.");
      console.error(e);
    } finally {
      setEnviandoPedido(false);
    }
  };
  const [enviandoMant, setEnviandoMant] = useState(false);
  const [errorMant, setErrorMant] = useState("");
  const handleMant = async () => {
    if (!tipoFalla.trim()) return;
    setEnviandoMant(true);
    setErrorMant("");
    try {
      await addMantenimiento({ id:`M${Date.now()}`, machine:machine.name, tipo:tipoFalla, desc:descFalla, status:"pendiente", createdAt:new Date().toISOString() });
      setSentMant(true);
    } catch(e) {
      setErrorMant("Error al enviar. Revisá tu conexión.");
      console.error(e);
    } finally {
      setEnviandoMant(false);
    }
  };

  if (sentPedido) return (
    <div style={{ minHeight:"100vh", background:"var(--page-bg)", display:"flex", alignItems:"center", justifyContent:"center", padding:"2rem" }}>
      <div style={{ textAlign:"center", maxWidth:360 }}>
        <div style={{ fontSize:64, marginBottom:20 }}>✅</div>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:38, color:"var(--green)", letterSpacing:3, marginBottom:8 }}>¡PEDIDO ENVIADO!</div>
        <div style={{ color:"var(--muted)", marginBottom:28, fontSize:15 }}>El pañol fue notificado y está preparando tu pedido.</div>
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"1rem", marginBottom:24, textAlign:"left" }}>
          {selected.map(i => (
            <div key={i.id} style={{ display:"flex", justifyContent:"space-between", padding:"6px 0", borderBottom:"1px solid var(--border)", fontSize:14 }}>
              <span style={{ fontFamily:"'JetBrains Mono'", fontSize:12, color:"var(--green)" }}>{i.code}</span>
              <span style={{ color:"var(--muted)" }}>× {qtys[i.id]}</span>
            </div>
          ))}
        </div>
        <button onClick={() => { setSentPedido(false); setQtys({}); setNota(""); }}
          style={{ background:"var(--green)", border:"none", borderRadius:10, padding:"13px 32px", fontFamily:"'Bebas Neue'", fontSize:18, letterSpacing:2, cursor:"pointer", color:"white" }}>
          NUEVO PEDIDO
        </button>
      </div>
    </div>
  );

  if (sentMant) return (
    <div style={{ minHeight:"100vh", background:"var(--page-bg)", display:"flex", alignItems:"center", justifyContent:"center", padding:"2rem" }}>
      <div style={{ textAlign:"center", maxWidth:360 }}>
        <div style={{ fontSize:64, marginBottom:20 }}>🔔</div>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:36, color:"#1d4ed8", letterSpacing:3, marginBottom:8 }}>¡SOLICITUD ENVIADA!</div>
        <div style={{ color:"var(--muted)", marginBottom:28, fontSize:15 }}>El equipo de mantenimiento fue notificado.</div>
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"1rem", marginBottom:24, textAlign:"left" }}>
          <div style={{ fontSize:13, color:"var(--muted)", marginBottom:4 }}>Máquina</div>
          <div style={{ fontSize:15, fontWeight:600, color:"var(--text)", marginBottom:12 }}>{machine.name}</div>
          <div style={{ fontSize:13, color:"var(--muted)", marginBottom:4 }}>Tipo de falla</div>
          <div style={{ fontSize:15, fontWeight:600, color:"var(--text)" }}>{tipoFalla}</div>
          {descFalla && <><div style={{ fontSize:13, color:"var(--muted)", marginTop:12, marginBottom:4 }}>Descripción</div><div style={{ fontSize:14, color:"var(--text)" }}>{descFalla}</div></>}
        </div>
        <button onClick={() => { setSentMant(false); setTipoFalla(""); setDescFalla(""); }}
          style={{ background:"#1d4ed8", border:"none", borderRadius:10, padding:"13px 32px", fontFamily:"'Bebas Neue'", fontSize:18, letterSpacing:2, cursor:"pointer", color:"white" }}>
          NUEVA SOLICITUD
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight:"100vh", background:"var(--page-bg)", padding:"1.5rem" }}>
      <div style={{ maxWidth:540, margin:"0 auto" }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:20 }}>
          <button onClick={() => setView("home")} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 12px", color:"var(--muted)", cursor:"pointer", fontSize:18 }}>←</button>
          <div style={{ flex:1 }}>
            <div style={{ fontFamily:"'Bebas Neue'", fontSize:26, color:"var(--green)", letterSpacing:2 }}>{machine.name}</div>
          </div>
        </div>
        <div style={{ display:"flex", gap:8, marginBottom:20 }}>
          {[["insumos","📦 INSUMOS"],["mantenimiento","🔧 MANT."],["produccion","🏭 PROD."],["faq","❓ FAQ"]].map(([key,lbl]) => {
            const color = key==="insumos"?"var(--green)":key==="mantenimiento"?"#1d4ed8":key==="produccion"?ORANGE:"#6B7280";
            return (
              <button key={key} onClick={() => setTab(key)}
                style={{ flex:1, background:tab===key?color:"var(--surface)", border:`1px solid ${tab===key?color:"var(--border)"}`, borderRadius:12, padding:"11px 4px", color:tab===key?"white":"var(--muted)", fontFamily:"'Bebas Neue'", fontSize:13, letterSpacing:1, cursor:"pointer" }}>
                {lbl}
              </button>
            );
          })}
        </div>

        {tab === "insumos" && (
          <>
            <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:16 }}>
              {lista.map(ins => (
                <div key={ins.id} style={{ background:qtys[ins.id]>0?"var(--green-bg)":"var(--surface)", border:`1px solid ${qtys[ins.id]>0?"var(--green)":"var(--border)"}`, borderRadius:12, padding:"12px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", transition:"all 0.2s" }}>
                  <div style={{ flex:1 }}>
                    <div style={{ fontFamily:"'JetBrains Mono'", fontSize:12, color:"var(--green)", fontWeight:600 }}>{ins.code}</div>
                    <div style={{ color:"var(--text)", fontSize:14, marginTop:2 }}>{ins.desc}</div>
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <button onClick={() => setQty(ins.id,(qtys[ins.id]||0)-1)} style={{ width:32, height:32, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, color:"var(--text)", fontSize:18, cursor:"pointer" }}>−</button>
                    <span style={{ width:28, textAlign:"center", color:qtys[ins.id]>0?"var(--green)":"var(--muted)", fontWeight:600, fontSize:16 }}>{qtys[ins.id]||0}</span>
                    <button onClick={() => setQty(ins.id,(qtys[ins.id]||0)+1)} style={{ width:32, height:32, background:qtys[ins.id]>0?"var(--green)":"var(--surface2)", border:`1px solid ${qtys[ins.id]>0?"var(--green)":"var(--border)"}`, borderRadius:8, color:qtys[ins.id]>0?"white":"var(--text)", fontSize:18, cursor:"pointer" }}>+</button>
                  </div>
                </div>
              ))}
            </div>
            <textarea value={nota} onChange={e=>setNota(e.target.value)} placeholder="Nota adicional (opcional)..."
              style={{ width:"100%", background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:14, resize:"none", height:76, outline:"none", marginBottom:14 }} />
            {errorPedido && <div style={{ color:"#EF4444", fontSize:13, marginBottom:8, padding:"8px 12px", background:"#FEE2E2", borderRadius:8 }}>⚠️ {errorPedido}</div>}
            <button onClick={handlePedir} disabled={total===0||enviandoPedido}
              style={{ width:"100%", background:total>0?"var(--green)":"var(--surface2)", border:`1px solid ${total>0?"var(--green)":"var(--border)"}`, borderRadius:14, padding:"17px", fontFamily:"'Bebas Neue'", fontSize:20, letterSpacing:3, color:total>0?"white":"var(--muted)", cursor:total>0?"pointer":"not-allowed" }}>
              {enviandoPedido ? "ENVIANDO..." : total>0?`ENVIAR PEDIDO — ${total} item${total>1?"s":""}` : "SELECCIONÁ INSUMOS"}
            </button>
          </>
        )}

        {tab === "mantenimiento" && (
          <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.5rem" }}>
            <p style={{ color:"var(--muted)", fontSize:13, marginBottom:20 }}>Completá el formulario para solicitar mantenimiento en <strong>{machine.name}</strong>.</p>
            <div style={{ marginBottom:14 }}>
              <label style={{ color:"var(--muted)", fontSize:12, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:8, fontWeight:600 }}>Tipo de falla *</label>
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                {tiposFalla.map(tipo => (
                  <button key={tipo} onClick={() => setTipoFalla(tipo)}
                    style={{ background:tipoFalla===tipo?"#dbeafe":"var(--surface2)", border:`1px solid ${tipoFalla===tipo?"#1d4ed8":"var(--border)"}`, borderRadius:8, padding:"10px 14px", color:tipoFalla===tipo?"#1d4ed8":"var(--text)", fontFamily:"'DM Sans'", fontSize:14, fontWeight:tipoFalla===tipo?600:400, cursor:"pointer", textAlign:"left" }}>
                    {tipoFalla===tipo?"✓ ":""}{tipo}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ marginBottom:20 }}>
              <label style={{ color:"var(--muted)", fontSize:12, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:8, fontWeight:600 }}>Descripción adicional (opcional)</label>
              <textarea value={descFalla} onChange={e=>setDescFalla(e.target.value)} placeholder="Describí con más detalle el problema..."
                style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"12px 14px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:14, resize:"none", height:90, outline:"none" }} />
            </div>
            {errorMant && <div style={{ color:"#EF4444", fontSize:13, marginBottom:8, padding:"8px 12px", background:"#FEE2E2", borderRadius:8 }}>⚠️ {errorMant}</div>}
            <button onClick={handleMant} disabled={!tipoFalla||enviandoMant}
              style={{ width:"100%", background:tipoFalla?"#1d4ed8":"var(--surface2)", border:`1px solid ${tipoFalla?"#1d4ed8":"var(--border)"}`, borderRadius:12, padding:"16px", fontFamily:"'Bebas Neue'", fontSize:19, letterSpacing:2, color:tipoFalla?"white":"var(--muted)", cursor:tipoFalla?"pointer":"not-allowed" }}>
              {enviandoMant ? "ENVIANDO..." : "ENVIAR SOLICITUD DE MANTENIMIENTO"}
            </button>
          </div>
        )}
        {tab === "produccion" && (
          <PuestoProduccionView
            addRegistro={addRegistro}
            operarios={operarios}
            machines={machines}
            piezas={piezas}
            motivos={motivos}
            defaultMaquina={machine.name}
            registros={registros || []}
          />
        )}
        {tab === "faq" && <FaqPuestoWidget faqs={faqs || []} maquina={machine.name} />}
      </div>
    </div>
  );
}
// ════════════════════════════════════════════════════════════════════
function MantenimientoView({ mantenimientos, updateMantenimiento, logged, setLogged, setView, mantPin, setMantPin, tiposFalla, setTiposFalla, machines, auditLog, addAuditLog, faqs, addFaq, removeFaq, cargaCompleta, cargarHistorialCompleto }) {
  const [pin, setPin]         = useState("");
  const [error, setError]     = useState("");
  const [mainTab, setMainTab] = useState("solicitudes");
  const [filter, setFilter]   = useState("pendientes");

  const toast = useNotifications(mantenimientos, m => m.status === "pendiente", logged, "mantenimiento");

  const handleLogin = () => {
    if (pin === mantPin) { setLogged(true); setError(""); setPin(""); }
    else { setError("PIN incorrecto"); setPin(""); }
  };

  if (!logged) return (
    <div style={{ minHeight:"100vh", background:"var(--page-bg)", display:"flex", alignItems:"center", justifyContent:"center", padding:"2rem" }}>
      <div style={{ maxWidth:340, width:"100%", background:"var(--surface)", border:"1px solid var(--border)", borderRadius:20, padding:"2rem" }}>
        <button onClick={() => setView("home")} style={{ background:"none", border:"none", color:"var(--muted)", cursor:"pointer", fontSize:14, marginBottom:24 }}>← Volver</button>
        <div style={{ textAlign:"center", marginBottom:28 }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:32, color:"#1d4ed8", letterSpacing:4, marginBottom:10 }}>MANTENIMIENTO</div>
          <div style={{ color:"var(--muted)", fontSize:13, marginTop:4 }}>Ingresá tu PIN para continuar</div>
        </div>
        <input type="password" value={pin} onChange={e=>setPin(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleLogin()} placeholder="••••"
          style={{ width:"100%", background:"var(--surface2)", border:`1px solid ${error?"#EF4444":"var(--border)"}`, borderRadius:10, padding:"14px 16px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:20, letterSpacing:8, textAlign:"center", outline:"none", marginBottom:12 }} />
        {error && <div style={{ color:"#EF4444", fontSize:13, marginBottom:12, textAlign:"center" }}>{error}</div>}
        <button onClick={handleLogin} style={{ width:"100%", background:"#1d4ed8", border:"none", borderRadius:10, padding:"14px", fontFamily:"'Bebas Neue'", fontSize:20, letterSpacing:2, cursor:"pointer", color:"white" }}>INGRESAR</button>
      </div>
    </div>
  );

  const pendientes = mantenimientos.filter(m => m.status === "pendiente");
  const recibidos  = mantenimientos.filter(m => m.status === "recibido");
  const displayed  = filter === "pendientes" ? pendientes : recibidos;
  const newCount   = pendientes.length;
  const tabs = [{ key:"solicitudes",label:"🔔 SOLICITUDES" },{ key:"stats",label:"📊 ESTADÍSTICAS" },{ key:"faq",label:"❓ FAQ" },{ key:"tipos",label:"📋 TIPOS" },{ key:"pin",label:"🔑 PIN" },{ key:"historial",label:"🕓 HISTORIAL" }];

  return (
    <div style={{ minHeight:"100vh", background:"var(--page-bg)", padding:"1.5rem" }}>
      <Toast toast={toast} />
      <div style={{ maxWidth:640, margin:"0 auto" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20 }}>
          <div style={{ display:"flex", alignItems:"center", gap:14 }}>
            <div>
              <div style={{ fontFamily:"'Bebas Neue'", fontSize:28, color:"#1d4ed8", letterSpacing:3 }}>MANTENIMIENTO</div>
              {newCount>0 && mainTab==="solicitudes" && <div style={{ color:"#F59E0B", fontSize:13, marginTop:1, fontWeight:600 }}>⚡ {newCount} solicitud{newCount>1?"es":""} pendiente{newCount>1?"s":""}</div>}
            </div>
          </div>
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={() => setView("home")} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 14px", color:"var(--muted)", cursor:"pointer", fontSize:13, fontWeight:500 }}>🏠 Inicio</button>
            <button onClick={() => { setLogged(false); setView("home"); }} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 14px", color:"var(--muted)", cursor:"pointer", fontSize:13, fontWeight:500 }}>Salir</button>
          </div>
        </div>
        <div style={{ display:"flex", gap:6, marginBottom:20 }}>
          {tabs.map(({ key, label }) => (
            <button key={key} onClick={() => setMainTab(key)}
              style={{ flex:1, position:"relative", background:mainTab===key?"#1d4ed8":"var(--surface)", border:`1px solid ${mainTab===key?"#1d4ed8":"var(--border)"}`, borderRadius:12, padding:"12px 4px", color:mainTab===key?"white":"var(--muted)", fontFamily:"'Bebas Neue'", fontSize:13, letterSpacing:1, cursor:"pointer" }}>
              {label}
              {key==="solicitudes" && newCount>0 && mainTab!=="solicitudes" && <span style={{ position:"absolute", top:5, right:6, background:"#EF4444", color:"white", borderRadius:999, width:17, height:17, fontSize:10, display:"inline-flex", alignItems:"center", justifyContent:"center", fontWeight:700 }}>{newCount}</span>}
            </button>
          ))}
        </div>
        {mainTab==="solicitudes" && (
          <>
            <div style={{ display:"flex", gap:8, marginBottom:16 }}>
              {["pendientes","recibidos"].map(f => (
                <button key={f} onClick={() => setFilter(f)}
                  style={{ flex:1, background:filter===f?"var(--surface2)":"var(--surface)", border:`1px solid ${filter===f?"#1d4ed8":"var(--border)"}`, borderRadius:10, padding:"10px", color:filter===f?"var(--text)":"var(--muted)", fontFamily:"'Bebas Neue'", fontSize:14, letterSpacing:2, cursor:"pointer" }}>
                  {f==="pendientes"?`PENDIENTES (${pendientes.length})`:`RECIBIDOS (${recibidos.length})`}
                </button>
              ))}
            </div>
            {displayed.length===0
              ? <div style={{ textAlign:"center", color:"var(--muted)", padding:"3rem", background:"var(--surface)", borderRadius:16, border:"1px solid var(--border)" }}>{filter==="pendientes"?"🎉 No hay solicitudes pendientes":"No hay solicitudes recibidas aún"}</div>
              : <div style={{ display:"flex", flexDirection:"column", gap:10 }}>{displayed.map(m => <MantCard key={m.id} item={m} updateMantenimiento={updateMantenimiento} />)}</div>
            }
          </>
        )}
        {mainTab==="faq"          && <FaqView area="mantenimiento" machines={machines} faqs={faqs} addFaq={addFaq} removeFaq={removeFaq} addAuditLog={addAuditLog} />}
        {mainTab==="tipos"        && <TiposFallaEditor tiposFalla={tiposFalla} setTiposFalla={setTiposFalla} auditLog={auditLog} addAuditLog={addAuditLog} />}
        {mainTab==="pin"          && <MantConfigPin mantPin={mantPin} setMantPin={setMantPin} onClose={() => setMainTab("solicitudes")} auditLog={auditLog} addAuditLog={addAuditLog} />}
        {mainTab==="stats"        && <StatsMant mantenimientos={mantenimientos} machines={machines} cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
        {mainTab==="historial"    && <HistorialAuditoria auditLog={auditLog} area="mantenimiento" cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
      </div>
    </div>
  );
}

function MantCard({ item, updateMantenimiento }) {
  const st   = STATUS_MANT[item.status];
  const time = new Date(item.createdAt).toLocaleTimeString("es-AR", { hour:"2-digit", minute:"2-digit" });
  const date = new Date(item.createdAt).toLocaleDateString("es-AR");
  return (
    <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, overflow:"hidden" }}>
      <div style={{ background:st.bg, padding:"10px 16px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontFamily:"'Bebas Neue'", fontSize:17, color:"#0f1f0f", letterSpacing:1 }}>{item.machine}</span>
          <span style={{ background:"white", borderRadius:999, padding:"2px 10px", fontSize:12, color:st.color, fontWeight:600 }}>{st.label}</span>
        </div>
        <span style={{ fontSize:12, color:"#666" }}>{date} {time}</span>
      </div>
      <div style={{ padding:"14px 16px" }}>
        <div style={{ marginBottom:item.desc?10:0 }}>
          <span style={{ fontSize:12, color:"var(--muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:1 }}>Tipo de falla</span>
          <div style={{ fontSize:15, color:"var(--text)", fontWeight:600, marginTop:3 }}>{item.tipo}</div>
        </div>
        {item.desc && <div style={{ padding:"8px 10px", background:"var(--surface2)", borderRadius:8, color:"var(--muted)", fontSize:13, borderLeft:"3px solid #1d4ed8" }}>{item.desc}</div>}
      </div>
      {item.status==="pendiente" && (
        <div style={{ padding:"0 16px 14px" }}>
          <button onClick={() => updateMantenimiento(item.id, { status:"recibido", receivedAt:new Date().toISOString() })}
            style={{ width:"100%", background:"#1d4ed8", border:"none", borderRadius:10, padding:"11px", color:"white", fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, cursor:"pointer" }}>
            ✓ RECIBIDO
          </button>
        </div>
      )}
      {item.status==="recibido" && item.receivedAt && (
        <div style={{ padding:"0 16px 12px", fontSize:12, color:"var(--muted)", textAlign:"center" }}>
          Recibido el {new Date(item.receivedAt).toLocaleDateString("es-AR")} a las {new Date(item.receivedAt).toLocaleTimeString("es-AR", { hour:"2-digit", minute:"2-digit" })}
        </div>
      )}
    </div>
  );
}

function TiposFallaEditor({ tiposFalla, setTiposFalla, auditLog, addAuditLog }) {
  const [newTipo, setNewTipo] = useState("");
  const [quien, setQuien]     = useQuien("sig_quien_mant");
  const addTipo = () => { if (!newTipo.trim()) return; const t=newTipo.trim(); setTiposFalla(prev => [...prev, t]); setNewTipo(""); registrarAuditoria(addAuditLog, "mantenimiento", quien, "Agregó un tipo de falla", t); };
  const removeTipo = (idx) => { const t=tiposFalla[idx]; setTiposFalla(prev => prev.filter((_, i) => i !== idx)); registrarAuditoria(addAuditLog, "mantenimiento", quien, "Eliminó un tipo de falla", t); };
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      <QuienInput quien={quien} setQuien={setQuien} />
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
        <p style={{ color:"var(--muted)", fontSize:13, marginBottom:16 }}>Editá los tipos de falla disponibles para los operarios.</p>
        <div style={{ display:"flex", gap:8 }}>
          <input value={newTipo} onChange={e=>setNewTipo(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addTipo()} placeholder="Nuevo tipo de falla..."
            style={{ flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 14px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:14, outline:"none" }} />
          <button onClick={addTipo} style={{ background:"#1d4ed8", border:"none", borderRadius:8, padding:"10px 18px", fontFamily:"'Bebas Neue'", fontSize:16, cursor:"pointer", color:"white", letterSpacing:1, whiteSpace:"nowrap" }}>+ AGREGAR</button>
        </div>
      </div>
      {tiposFalla.map((tipo, idx) => (
        <div key={idx} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <span style={{ color:"var(--text)", fontSize:15 }}>{tipo}</span>
          <button onClick={() => removeTipo(idx)} style={{ background:"none", border:"1px solid #EF444466", borderRadius:6, padding:"5px 12px", color:"#EF4444", cursor:"pointer", fontSize:12 }}>Eliminar</button>
        </div>
      ))}
      {tiposFalla.length===0 && <div style={{ textAlign:"center", color:"var(--muted)", padding:"2rem", background:"var(--surface)", borderRadius:16, border:"1px solid var(--border)", fontSize:14 }}>No hay tipos de falla. Agregá al menos uno.</div>}
    </div>
  );
}

function MantConfigPin({ mantPin, setMantPin, onClose, auditLog, addAuditLog }) {
  const [newPin, setNewPin] = useState("");
  const [confPin, setConfPin] = useState("");
  const [msg, setMsg] = useState(null);
  const [quien, setQuien] = useQuien("sig_quien_mant");
  const handleSave = () => {
    if (newPin.length < 4)  { setMsg({ ok:false, text:"Mínimo 4 caracteres" }); return; }
    if (newPin !== confPin) { setMsg({ ok:false, text:"Los PINs no coinciden" }); return; }
    setMantPin(newPin); setNewPin(""); setConfPin("");
    setMsg({ ok:true, text:"✓ PIN actualizado correctamente" });
    registrarAuditoria(addAuditLog, "mantenimiento", quien, "Cambió el PIN de acceso a Mantenimiento");
    setTimeout(() => { setMsg(null); onClose(); }, 2000);
  };
  return (
    <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.5rem" }}>
      <QuienInput quien={quien} setQuien={setQuien} />
      <p style={{ color:"var(--muted)", fontSize:13, marginBottom:20 }}>Cambiá el PIN de acceso al panel de Mantenimiento. Mínimo 4 caracteres.</p>
      <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
        <div>
          <label style={{ color:"var(--muted)", fontSize:11, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 }}>Nuevo PIN</label>
          <input type="password" value={newPin} onChange={e=>setNewPin(e.target.value)} placeholder="••••"
            style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"12px 16px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:18, letterSpacing:6, textAlign:"center", outline:"none" }} />
        </div>
        <div>
          <label style={{ color:"var(--muted)", fontSize:11, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 }}>Confirmar PIN</label>
          <input type="password" value={confPin} onChange={e=>setConfPin(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleSave()} placeholder="••••"
            style={{ width:"100%", background:"var(--surface2)", border:`1px solid ${msg&&!msg.ok?"#EF4444":"var(--border)"}`, borderRadius:10, padding:"12px 16px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:18, letterSpacing:6, textAlign:"center", outline:"none" }} />
        </div>
        {msg && <div style={{ textAlign:"center", fontSize:13, color:msg.ok?"#16a34a":"#EF4444", padding:"8px", background:msg.ok?"#f0fdf4":"#FEE2E2", borderRadius:8 }}>{msg.text}</div>}
        <button onClick={handleSave} style={{ background:"#1d4ed8", border:"none", borderRadius:10, padding:"13px", fontFamily:"'Bebas Neue'", fontSize:18, letterSpacing:2, cursor:"pointer", color:"white" }}>GUARDAR NUEVO PIN</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// PAÑOL VIEW
// ════════════════════════════════════════════════════════════════════
function PanolView({ pedidos, updatePedido, logged, setLogged, setView, panolPin, setPanolPin, machines, setMachines, insumos, setInsumos, machineInsumos, setMachineInsumos, auditLog, addAuditLog, cargaCompleta, cargarHistorialCompleto }) {
  const [pin, setPin]         = useState("");
  const [error, setError]     = useState("");
  const [mainTab, setMainTab] = useState("pedidos");
  const [filter, setFilter]   = useState("activos");

  const toast = useNotifications(pedidos, p => p.status === "pendiente", logged, "panol");

  const handleLogin = () => {
    if (pin === panolPin) { setLogged(true); setError(""); setPin(""); }
    else { setError("PIN incorrecto"); setPin(""); }
  };

  if (!logged) return (
    <div style={{ minHeight:"100vh", background:"var(--page-bg)", display:"flex", alignItems:"center", justifyContent:"center", padding:"2rem" }}>
      <div style={{ maxWidth:340, width:"100%", background:"var(--surface)", border:"1px solid var(--border)", borderRadius:20, padding:"2rem" }}>
        <button onClick={() => setView("home")} style={{ background:"none", border:"none", color:"var(--muted)", cursor:"pointer", fontSize:14, marginBottom:24 }}>← Volver</button>
        <div style={{ textAlign:"center", marginBottom:28 }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:32, color:"var(--green)", letterSpacing:4, marginBottom:10 }}>PAÑOL</div>
          <div style={{ color:"var(--muted)", fontSize:13, marginTop:4 }}>Ingresá tu PIN para continuar</div>
        </div>
        <input type="password" value={pin} onChange={e=>setPin(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleLogin()} placeholder="••••"
          style={{ width:"100%", background:"var(--surface2)", border:`1px solid ${error?"#EF4444":"var(--border)"}`, borderRadius:10, padding:"14px 16px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:20, letterSpacing:8, textAlign:"center", outline:"none", marginBottom:12 }} />
        {error && <div style={{ color:"#EF4444", fontSize:13, marginBottom:12, textAlign:"center" }}>{error}</div>}
        <button onClick={handleLogin} style={{ width:"100%", background:"var(--green)", border:"none", borderRadius:10, padding:"14px", fontFamily:"'Bebas Neue'", fontSize:20, letterSpacing:2, cursor:"pointer", color:"white" }}>INGRESAR</button>
      </div>
    </div>
  );

  const activos   = pedidos.filter(p => !["entregado","cancelado"].includes(p.status));
  const historial = pedidos.filter(p => p.status === "entregado");
  const displayed = filter === "activos" ? activos : historial;
  const newCount  = pedidos.filter(p => p.status === "pendiente").length;
  const tabs = [{ key:"pedidos",label:"📦 PEDIDOS" },{ key:"stats",label:"📊 ESTADÍSTICAS" },{ key:"config",label:"⚙️ CONFIG" },{ key:"admin",label:"🛠 ADMIN" },{ key:"historial",label:"🕓 HISTORIAL" }];

  return (
    <div style={{ minHeight:"100vh", background:"var(--page-bg)", padding:"1.5rem" }}>
      <Toast toast={toast} />
      <div style={{ maxWidth:640, margin:"0 auto" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20 }}>
          <div style={{ display:"flex", alignItems:"center", gap:14 }}>
            <div>
              <div style={{ fontFamily:"'Bebas Neue'", fontSize:28, color:"var(--green)", letterSpacing:3 }}>PAÑOL</div>
              {newCount>0 && mainTab==="pedidos" && <div style={{ color:"#F59E0B", fontSize:13, marginTop:1, fontWeight:600 }}>⚡ {newCount} pedido{newCount>1?"s":""} nuevo{newCount>1?"s":""}</div>}
            </div>
          </div>
          <button onClick={() => { setLogged(false); setView("home"); }} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 16px", color:"var(--muted)", cursor:"pointer", fontSize:13, fontWeight:500 }}>Salir</button>
        </div>
        <div style={{ display:"flex", gap:6, marginBottom:20 }}>
          {tabs.map(({ key, label }) => (
            <button key={key} onClick={() => setMainTab(key)}
              style={{ flex:1, position:"relative", background:mainTab===key?"var(--green)":"var(--surface)", border:`1px solid ${mainTab===key?"var(--green)":"var(--border)"}`, borderRadius:12, padding:"12px 6px", color:mainTab===key?"white":"var(--muted)", fontFamily:"'Bebas Neue'", fontSize:15, letterSpacing:1, cursor:"pointer" }}>
              {label}
              {key==="pedidos" && newCount>0 && mainTab!=="pedidos" && <span style={{ position:"absolute", top:5, right:6, background:"#EF4444", color:"white", borderRadius:999, width:17, height:17, fontSize:10, display:"inline-flex", alignItems:"center", justifyContent:"center", fontWeight:700 }}>{newCount}</span>}
            </button>
          ))}
        </div>
        {mainTab==="pedidos" && (
          <>
            <div style={{ display:"flex", gap:8, marginBottom:16 }}>
              {["activos","historial"].map(f => (
                <button key={f} onClick={() => setFilter(f)}
                  style={{ flex:1, background:filter===f?"var(--surface2)":"var(--surface)", border:`1px solid ${filter===f?"var(--green)":"var(--border)"}`, borderRadius:10, padding:"10px", color:filter===f?"var(--text)":"var(--muted)", fontFamily:"'Bebas Neue'", fontSize:14, letterSpacing:2, cursor:"pointer" }}>
                  {f==="activos"?`ACTIVOS (${activos.length})`:`HISTORIAL (${historial.length})`}
                </button>
              ))}
            </div>
            {displayed.length===0
              ? <div style={{ textAlign:"center", color:"var(--muted)", padding:"3rem", background:"var(--surface)", borderRadius:16, border:"1px solid var(--border)" }}>{filter==="activos"?"🎉 No hay pedidos pendientes":"No hay pedidos entregados aún"}</div>
              : <div style={{ display:"flex", flexDirection:"column", gap:10 }}>{displayed.map(p => <PedidoCard key={p.id} pedido={p} updatePedido={updatePedido} />)}</div>
            }
          </>
        )}
        {mainTab==="config" && <ConfigPanel panolPin={panolPin} setPanolPin={setPanolPin} machines={machines} insumos={insumos} machineInsumos={machineInsumos} setMachineInsumos={setMachineInsumos} auditLog={auditLog} addAuditLog={addAuditLog} />}
        {mainTab==="admin"  && <AdminPanel  machines={machines} setMachines={setMachines} insumos={insumos} setInsumos={setInsumos} auditLog={auditLog} addAuditLog={addAuditLog} />}
        {mainTab==="stats"  && <StatsPanol  pedidos={pedidos} machines={machines} cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
        {mainTab==="historial" && <HistorialAuditoria auditLog={auditLog} area="panol" cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
      </div>
    </div>
  );
}

function PedidoCard({ pedido, updatePedido }) {
  const st   = STATUS_PANOL[pedido.status];
  const time = new Date(pedido.createdAt).toLocaleTimeString("es-AR", { hour:"2-digit", minute:"2-digit" });
  const date = new Date(pedido.createdAt).toLocaleDateString("es-AR");
  const actions = {
    pendiente:  [{ label:"▶ PREPARAR",            next:"preparando", color:"#3B82F6" }],
    preparando: [{ label:"✓ LISTO PARA ENTREGAR", next:"listo",      color:"#16a34a" }],
    listo:      [{ label:"📦 MARCAR ENTREGADO",   next:"entregado",  color:"#6B7280" }],
    entregado:  [],
  };
  const canCancel = ["pendiente","preparando","listo"].includes(pedido.status);
  return (
    <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, overflow:"hidden" }}>
      <div style={{ background:st.bg, padding:"10px 16px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontFamily:"'Bebas Neue'", fontSize:17, color:"#0f1f0f", letterSpacing:1 }}>{pedido.machine}</span>
          <span style={{ background:"white", borderRadius:999, padding:"2px 10px", fontSize:12, color:st.color, fontWeight:600 }}>{st.label}</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:12, color:"#666" }}>{date} {time}</span>
          {canCancel && (
            <button onClick={() => updatePedido(pedido.id, { status:"cancelado" })}
              style={{ background:"none", border:"1px solid #EF444466", borderRadius:6, padding:"3px 8px", color:"#EF4444", cursor:"pointer", fontSize:11, fontWeight:600 }}
              onMouseEnter={e=>{e.currentTarget.style.background="#FEE2E2";e.currentTarget.style.borderColor="#EF4444";}}
              onMouseLeave={e=>{e.currentTarget.style.background="none";e.currentTarget.style.borderColor="#EF444466";}}>
              ✕ Cancelar
            </button>
          )}
        </div>
      </div>
      <div style={{ padding:"12px 16px" }}>
        {pedido.items.map((item, i) => (
          <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"6px 0", borderBottom:i<pedido.items.length-1?"1px solid var(--border)":"none" }}>
            <div><span style={{ fontFamily:"'JetBrains Mono'", fontSize:12, color:"var(--green)" }}>{item.code}</span><span style={{ color:"var(--muted)", fontSize:12, marginLeft:8 }}>{item.desc}</span></div>
            <span style={{ color:"var(--text)", fontWeight:600, fontSize:15 }}>× {item.qty}</span>
          </div>
        ))}
        {pedido.nota && <div style={{ marginTop:8, padding:"8px 10px", background:"var(--surface2)", borderRadius:8, color:"var(--muted)", fontSize:13 }}>📝 {pedido.nota}</div>}
      </div>
      {actions[pedido.status]?.length > 0 && (
        <div style={{ padding:"0 16px 14px" }}>
          {actions[pedido.status].map(a => (
            <button key={a.next} onClick={() => updatePedido(pedido.id, { status:a.next })}
              style={{ width:"100%", background:a.color, border:"none", borderRadius:10, padding:"11px", color:"white", fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, cursor:"pointer" }}
              onMouseEnter={e=>e.currentTarget.style.opacity="0.88"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ConfigPanel({ panolPin, setPanolPin, machines, insumos, machineInsumos, setMachineInsumos, auditLog, addAuditLog }) {
  const [tab, setTab]         = useState("pin");
  const [newPin, setNewPin]   = useState("");
  const [confPin, setConfPin] = useState("");
  const [msg, setMsg]         = useState(null);
  const [selMach, setSelMach] = useState(machines[0]?.id || "");
  const [quien, setQuien]     = useQuien("sig_quien_panol");
  const handleChangePin = () => {
    if (newPin.length < 4)  { setMsg({ ok:false, text:"Mínimo 4 caracteres" }); return; }
    if (newPin !== confPin) { setMsg({ ok:false, text:"Los PINs no coinciden" }); return; }
    setPanolPin(newPin); setNewPin(""); setConfPin("");
    setMsg({ ok:true, text:"✓ PIN actualizado" });
    registrarAuditoria(addAuditLog, "panol", quien, "Cambió el PIN de acceso a Pañol");
    setTimeout(() => setMsg(null), 3000);
  };
  const machine  = machines.find(m => m.id === selMach);
  const assigned = machineInsumos[selMach] || [];
  const toggle   = (id) => {
    const ins = insumos.find(i=>i.id===id);
    const cur = machineInsumos[selMach]||[];
    const willAdd = !cur.includes(id);
    setMachineInsumos(prev => { const c=prev[selMach]||[]; return { ...prev, [selMach]:c.includes(id)?c.filter(x=>x!==id):[...c,id] }; });
    registrarAuditoria(addAuditLog, "panol", quien, willAdd ? "Asignó un insumo a máquina" : "Quitó un insumo de máquina", `${ins?.code||id} → ${machine?.name||selMach}`);
  };
  const selAll   = () => { setMachineInsumos(prev => ({ ...prev, [selMach]:insumos.map(i=>i.id) })); registrarAuditoria(addAuditLog, "panol", quien, "Asignó todos los insumos a máquina", machine?.name||selMach); };
  const clrAll   = () => { setMachineInsumos(prev => ({ ...prev, [selMach]:[] })); registrarAuditoria(addAuditLog, "panol", quien, "Quitó todos los insumos de máquina", machine?.name||selMach); };
  return (
    <div>
      <QuienInput quien={quien} setQuien={setQuien} />
      <div style={{ display:"flex", gap:8, marginBottom:16 }}>
        {[["pin","🔑 Cambiar PIN"],["insumos","🔧 Insumos por máquina"]].map(([key,lbl]) => (
          <button key={key} onClick={() => setTab(key)}
            style={{ flex:1, background:tab===key?"var(--surface2)":"var(--surface)", border:`1px solid ${tab===key?"var(--green)":"var(--border)"}`, borderRadius:10, padding:"11px 6px", color:tab===key?"var(--text)":"var(--muted)", fontFamily:"'DM Sans'", fontSize:13, fontWeight:500, cursor:"pointer" }}>
            {lbl}
          </button>
        ))}
      </div>
      {tab==="pin" && (
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.5rem" }}>
          <p style={{ color:"var(--muted)", fontSize:13, marginBottom:20 }}>Cambiá el PIN de acceso al panel Pañol. Mínimo 4 caracteres.</p>
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            <div>
              <label style={{ color:"var(--muted)", fontSize:11, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 }}>Nuevo PIN</label>
              <input type="password" value={newPin} onChange={e=>setNewPin(e.target.value)} placeholder="••••"
                style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"12px 16px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:18, letterSpacing:6, textAlign:"center", outline:"none" }} />
            </div>
            <div>
              <label style={{ color:"var(--muted)", fontSize:11, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 }}>Confirmar PIN</label>
              <input type="password" value={confPin} onChange={e=>setConfPin(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleChangePin()} placeholder="••••"
                style={{ width:"100%", background:"var(--surface2)", border:`1px solid ${msg&&!msg.ok?"#EF4444":"var(--border)"}`, borderRadius:10, padding:"12px 16px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:18, letterSpacing:6, textAlign:"center", outline:"none" }} />
            </div>
            {msg && <div style={{ textAlign:"center", fontSize:13, color:msg.ok?"#16a34a":"#EF4444", padding:"8px", background:msg.ok?"#f0fdf4":"#FEE2E2", borderRadius:8 }}>{msg.text}</div>}
            <button onClick={handleChangePin} style={{ background:"var(--green)", border:"none", borderRadius:10, padding:"13px", fontFamily:"'Bebas Neue'", fontSize:18, letterSpacing:2, cursor:"pointer", color:"white" }}>GUARDAR NUEVO PIN</button>
          </div>
        </div>
      )}
      {tab==="insumos" && (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
            <label style={{ color:"var(--muted)", fontSize:11, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:10 }}>Seleccionar máquina</label>
            <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
              {machines.map(m => (
                <button key={m.id} onClick={() => setSelMach(m.id)}
                  style={{ background:selMach===m.id?"var(--green)":"var(--surface2)", border:`1px solid ${selMach===m.id?"var(--green)":"var(--border)"}`, borderRadius:8, padding:"8px 16px", color:selMach===m.id?"white":"var(--text)", fontFamily:"'DM Sans'", fontSize:14, fontWeight:500, cursor:"pointer" }}>
                  {m.name}
                </button>
              ))}
            </div>
          </div>
          {machine && (
            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, overflow:"hidden" }}>
              <div style={{ padding:"12px 16px", borderBottom:"1px solid var(--border)", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div>
                  <div style={{ fontFamily:"'Bebas Neue'", fontSize:17, color:"var(--green)", letterSpacing:2 }}>{machine.name}</div>
                  <div style={{ color:"var(--muted)", fontSize:12 }}>{assigned.length===0?"Sin asignación → muestra todos":`${assigned.length} insumo${assigned.length>1?"s":""} asignado${assigned.length>1?"s":""}`}</div>
                </div>
                <div style={{ display:"flex", gap:6 }}>
                  <button onClick={selAll} style={{ background:"none", border:"1px solid var(--border)", borderRadius:6, padding:"4px 10px", color:"var(--muted)", cursor:"pointer", fontSize:12 }}>Todos</button>
                  <button onClick={clrAll} style={{ background:"none", border:"1px solid var(--border)", borderRadius:6, padding:"4px 10px", color:"var(--muted)", cursor:"pointer", fontSize:12 }}>Ninguno</button>
                </div>
              </div>
              {insumos.map((ins, idx) => {
                const checked = assigned.includes(ins.id);
                return (
                  <div key={ins.id} onClick={() => toggle(ins.id)}
                    style={{ display:"flex", alignItems:"center", gap:12, padding:"11px 16px", cursor:"pointer", borderBottom:idx<insumos.length-1?"1px solid var(--border)":"none", background:checked?"var(--green-bg)":"transparent", transition:"background 0.15s" }}
                    onMouseEnter={e=>e.currentTarget.style.background=checked?"#dcfce7":"var(--surface2)"}
                    onMouseLeave={e=>e.currentTarget.style.background=checked?"var(--green-bg)":"transparent"}>
                    <div style={{ width:22, height:22, borderRadius:6, border:`2px solid ${checked?"var(--green)":"var(--border)"}`, background:checked?"var(--green)":"transparent", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                      {checked && <span style={{ fontSize:13, color:"white", fontWeight:700 }}>✓</span>}
                    </div>
                    <div style={{ flex:1 }}>
                      <div style={{ fontFamily:"'JetBrains Mono'", fontSize:12, color:checked?"var(--green)":"var(--muted)" }}>{ins.code}</div>
                      <div style={{ color:"var(--text)", fontSize:14 }}>{ins.desc}</div>
                    </div>
                  </div>
                );
              })}
              {assigned.length===0 && <div style={{ padding:"10px 16px", color:"var(--muted)", fontSize:12, background:"var(--surface2)", borderTop:"1px solid var(--border)" }}>ℹ️ Sin selección, el puesto verá todos los insumos.</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AdminPanel({ machines, setMachines, insumos, setInsumos, auditLog, addAuditLog }) {
  const [tab, setTab]               = useState("maquinas");
  const [newMachine, setNewMachine] = useState("");
  const [newIns, setNewIns]         = useState({ code:"", desc:"" });
  const [selQR, setSelQR]           = useState(machines[0]?.name || "");
  const [qrReady, setQrReady]       = useState(false);
  const [quien, setQuien]           = useQuien("sig_quien_panol");

  useEffect(() => {
    if (tab!=="qr"||!selQR) return;
    setQrReady(false);
    const container = document.getElementById("qr-box");
    if (!container) return;
    container.innerHTML = "";
    const url = `${window.location.origin}${window.location.pathname}?maquina=${encodeURIComponent(selQR)}`;
    const gen = () => { new window.QRCode(container, { text:url, width:200, height:200, colorDark:"#0f1f0f", colorLight:"#ffffff" }); setQrReady(true); };
    if (window.QRCode) gen();
    else { const s=document.createElement("script"); s.src=QR_CDN; s.onload=gen; document.head.appendChild(s); }
  }, [tab, selQR]);

  const addMachine = () => { if (!newMachine.trim()) return; const nombre=newMachine.trim(); setMachines(p=>[...p,{id:`m${Date.now()}`,name:nombre}]); setNewMachine(""); registrarAuditoria(addAuditLog, "panol", quien, "Agregó una máquina", nombre); };
  const remMachine = (id) => { const m=machines.find(x=>x.id===id); setMachines(p=>p.filter(m=>m.id!==id)); registrarAuditoria(addAuditLog, "panol", quien, "Eliminó una máquina", m?.name||id); };
  const addIns     = () => { if (!newIns.code.trim()||!newIns.desc.trim()) return; setInsumos(p=>[...p,{id:`i${Date.now()}`,...newIns}]); registrarAuditoria(addAuditLog, "panol", quien, "Agregó un insumo", `${newIns.code} — ${newIns.desc}`); setNewIns({code:"",desc:""}); };
  const remIns     = (id) => { const i=insumos.find(x=>x.id===id); setInsumos(p=>p.filter(i=>i.id!==id)); registrarAuditoria(addAuditLog, "panol", quien, "Eliminó un insumo", i?.code||id); };

  return (
    <div>
      <QuienInput quien={quien} setQuien={setQuien} />
      <div style={{ display:"flex", gap:6, marginBottom:16 }}>
        {[["maquinas","🔧 Máquinas"],["insumos","📦 Insumos"],["qr","⬛ QR"]].map(([key,lbl]) => (
          <button key={key} onClick={() => setTab(key)}
            style={{ flex:1, background:tab===key?"var(--surface2)":"var(--surface)", border:`1px solid ${tab===key?"var(--green)":"var(--border)"}`, borderRadius:10, padding:"10px 4px", color:tab===key?"var(--text)":"var(--muted)", fontFamily:"'DM Sans'", fontSize:13, fontWeight:500, cursor:"pointer" }}>
            {lbl}
          </button>
        ))}
      </div>
      {tab==="maquinas" && (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem", display:"flex", gap:8 }}>
            <input value={newMachine} onChange={e=>setNewMachine(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addMachine()} placeholder="Nombre de nueva máquina..."
              style={{ flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 14px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:14, outline:"none" }} />
            <button onClick={addMachine} style={{ background:"var(--green)", border:"none", borderRadius:8, padding:"10px 18px", fontFamily:"'Bebas Neue'", fontSize:16, cursor:"pointer", color:"white", letterSpacing:1 }}>+ AGREGAR</button>
          </div>
          {machines.map(m => (
            <div key={m.id} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ color:"var(--text)", fontSize:15 }}>🔧 {m.name}</span>
              <button onClick={()=>remMachine(m.id)} style={{ background:"none", border:"1px solid #EF444466", borderRadius:6, padding:"5px 12px", color:"#EF4444", cursor:"pointer", fontSize:12 }}>Eliminar</button>
            </div>
          ))}
        </div>
      )}
      {tab==="insumos" && (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem", display:"flex", flexDirection:"column", gap:8 }}>
            <input value={newIns.code} onChange={e=>setNewIns(p=>({...p,code:e.target.value.toUpperCase()}))} placeholder="Código (Ej: BDMT040808)"
              style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 14px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, outline:"none" }} />
            <input value={newIns.desc} onChange={e=>setNewIns(p=>({...p,desc:e.target.value}))} placeholder="Descripción del inserto"
              style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 14px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:14, outline:"none" }} />
            <button onClick={addIns} style={{ background:"var(--green)", border:"none", borderRadius:8, padding:"10px", fontFamily:"'Bebas Neue'", fontSize:16, cursor:"pointer", color:"white", letterSpacing:1 }}>+ AGREGAR INSUMO</button>
          </div>
          {insumos.map(i => (
            <div key={i.id} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div>
                <div style={{ fontFamily:"'JetBrains Mono'", fontSize:12, color:"var(--green)" }}>{i.code}</div>
                <div style={{ color:"var(--text)", fontSize:14, marginTop:2 }}>{i.desc}</div>
              </div>
              <button onClick={()=>remIns(i.id)} style={{ background:"none", border:"1px solid #EF444466", borderRadius:6, padding:"5px 12px", color:"#EF4444", cursor:"pointer", fontSize:12 }}>Eliminar</button>
            </div>
          ))}
        </div>
      )}
      {tab==="qr" && (
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.75rem" }}>
          <p style={{ color:"var(--muted)", fontSize:13, marginBottom:14 }}>Seleccioná una máquina, generá el QR e imprimilo para pegarlo en el puesto.</p>
          <select value={selQR} onChange={e=>setSelQR(e.target.value)}
            style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"12px 16px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:15, marginBottom:20, outline:"none" }}>
            {machines.map(m=><option key={m.id} value={m.name}>{m.name}</option>)}
          </select>
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:16 }}>
            <div style={{ background:"var(--surface2)", border:"2px solid var(--green)", padding:16, borderRadius:14, minWidth:232, minHeight:232, display:"flex", alignItems:"center", justifyContent:"center" }}>
              <div id="qr-box"/>
            </div>
            {qrReady && (
              <>
                <div style={{ textAlign:"center" }}>
                  <div style={{ fontFamily:"'Bebas Neue'", fontSize:20, color:"var(--text)", letterSpacing:2 }}>{selQR}</div>
                  <div style={{ color:"var(--muted)", fontSize:12, marginTop:4 }}>Escaneá para hacer un pedido</div>
                </div>
                <button onClick={()=>window.print()} style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"10px 28px", color:"var(--text)", cursor:"pointer", fontFamily:"'DM Sans'", fontSize:14 }}>🖨️ Imprimir QR</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// ESTADÍSTICAS PAÑOL
// ════════════════════════════════════════════════════════════════════
function StatsPanol({ pedidos, machines, cargaCompleta, cargarHistorialCompleto }) {
  useEffect(() => { cargarHistorialCompleto && cargarHistorialCompleto("pedidos"); }, []);
  const allMachineNames = [...new Set([
    ...machines.map(m => m.name),
    ...pedidos.map(p => p.machine)
  ])].sort();

  const [excluded, setExcluded] = useState(new Set());
  const [periodo, setPeriodo]   = useState("todo"); // "todo" | "mes_actual" | "mes_anterior" | "3meses" | mes específico "2025-01"

  const toggleMachine = (name) => {
    setExcluded(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };
  const selectAll = () => setExcluded(new Set());
  const clearAll  = () => setExcluded(new Set(allMachineNames));

  // Filtro de período
  const now   = new Date();
  const mesActual   = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  const mesAnterior = (() => { const d = new Date(now); d.setMonth(d.getMonth()-1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; })();

  // Meses disponibles en los pedidos
  const mesesDisponibles = [...new Set(
    pedidos.map(p => p.createdAt ? p.createdAt.slice(0,7) : null).filter(Boolean)
  )].sort().reverse();

  const matchesPeriodo = (p) => {
    if (!p.createdAt) return true;
    const mes = p.createdAt.slice(0,7);
    if (periodo === "todo")          return true;
    if (periodo === "mes_actual")    return mes === mesActual;
    if (periodo === "mes_anterior")  return mes === mesAnterior;
    if (periodo === "3meses") {
      const d = new Date(now); d.setMonth(d.getMonth()-3);
      return new Date(p.createdAt) >= d;
    }
    return mes === periodo;
  };

  const selected   = allMachineNames.filter(n => !excluded.has(n));
  const filtered   = pedidos.filter(p => !excluded.has(p.machine) && p.status !== "cancelado" && matchesPeriodo(p));
  const entregados = filtered.filter(p => p.status === "entregado");

  const insumoMap = {};
  entregados.forEach(p => {
    p.items.forEach(it => {
      if (!insumoMap[it.code]) insumoMap[it.code] = { code:it.code, desc:it.desc, total:0 };
      insumoMap[it.code].total += it.qty;
    });
  });
  const insumosList = Object.values(insumoMap).sort((a,b) => b.total - a.total);
  const maxInsumo   = insumosList[0]?.total || 1;

  const pedidosPorMaquina = {};
  allMachineNames.forEach(m => { pedidosPorMaquina[m] = filtered.filter(p => p.machine === m).length; });
  const maxPedidos = Math.max(...Object.values(pedidosPorMaquina), 1);

  const totalPedidos    = filtered.length;
  const totalEntregados = entregados.length;
  const totalItems      = entregados.reduce((acc, p) => acc + p.items.reduce((a,i) => a+i.qty, 0), 0);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>

      {cargaCompleta && !cargaCompleta.pedidos && (
        <div style={{ background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:10, padding:"8px 12px", fontSize:12, color:"#9a6000" }}>
          ⏳ Cargando historial completo (por defecto solo se sincronizan los últimos 60 días)...
        </div>
      )}

      {/* Selector de máquinas */}
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:"var(--muted)" }}>FILTRAR POR MÁQUINA</div>
          <div style={{ display:"flex", gap:6 }}>
            <button onClick={selectAll} style={{ background:"none", border:"1px solid var(--border)", borderRadius:6, padding:"4px 10px", color:"var(--muted)", cursor:"pointer", fontSize:12 }}>Todas</button>
            <button onClick={clearAll}  style={{ background:"none", border:"1px solid var(--border)", borderRadius:6, padding:"4px 10px", color:"var(--muted)", cursor:"pointer", fontSize:12 }}>Ninguna</button>
          </div>
        </div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
          {allMachineNames.map(name => (
            <button key={name} onClick={() => toggleMachine(name)}
              style={{ background:selected.includes(name)?"var(--green)":"var(--surface2)", border:`1px solid ${selected.includes(name)?"var(--green)":"var(--border)"}`, borderRadius:8, padding:"7px 14px", color:selected.includes(name)?"white":"var(--text)", fontFamily:"'DM Sans'", fontSize:13, fontWeight:500, cursor:"pointer", transition:"all 0.15s" }}>
              {name}
            </button>
          ))}
          {allMachineNames.length === 0 && <div style={{ color:"var(--muted)", fontSize:13 }}>No hay pedidos registrados aún.</div>}
        </div>
      </div>

      {/* Selector de período */}
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:"var(--muted)", marginBottom:12 }}>FILTRAR POR PERÍODO</div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
          {[
            { key:"todo",          label:"Todo" },
            { key:"mes_actual",    label:"Este mes" },
            { key:"mes_anterior",  label:"Mes anterior" },
            { key:"3meses",        label:"Últimos 3 meses" },
            ...mesesDisponibles.filter(m => m !== mesActual && m !== mesAnterior).map(m => ({
              key: m,
              label: new Date(m+"-01").toLocaleDateString("es-AR", { month:"long", year:"numeric" })
            }))
          ].map(op => (
            <button key={op.key} onClick={() => setPeriodo(op.key)}
              style={{ background:periodo===op.key?"var(--green)":"var(--surface2)", border:`1px solid ${periodo===op.key?"var(--green)":"var(--border)"}`, borderRadius:8, padding:"7px 14px", color:periodo===op.key?"white":"var(--text)", fontFamily:"'DM Sans'", fontSize:13, fontWeight:500, cursor:"pointer", transition:"all 0.15s" }}>
              {op.label}
            </button>
          ))}
        </div>
      </div>

      {/* Totales */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
        {[
          { label:"PEDIDOS TOTALES",   value:totalPedidos,   color:"var(--green)" },
          { label:"ENTREGADOS",        value:totalEntregados, color:"#3B82F6" },
          { label:"UNIDADES GASTADAS", value:totalItems,     color:"#f59e0b" },
        ].map(card => (
          <div key={card.label} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:14, padding:"1rem", textAlign:"center" }}>
            <div style={{ fontFamily:"'Bebas Neue'", fontSize:34, color:card.color }}>{card.value}</div>
            <div style={{ fontSize:11, color:"var(--muted)", fontWeight:600, letterSpacing:1, marginTop:2 }}>{card.label}</div>
          </div>
        ))}
      </div>

      {/* Insumos más consumidos */}
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:"var(--muted)", marginBottom:14 }}>INSUMOS MÁS CONSUMIDOS</div>
        {insumosList.length === 0
          ? <div style={{ color:"var(--muted)", fontSize:13, textAlign:"center", padding:"1rem" }}>Sin datos aún (solo cuenta pedidos entregados)</div>
          : insumosList.map(ins => (
            <div key={ins.code} style={{ marginBottom:10 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                <div>
                  <span style={{ fontFamily:"'JetBrains Mono'", fontSize:12, color:"var(--green)" }}>{ins.code}</span>
                  <span style={{ fontSize:13, color:"var(--text)", marginLeft:8 }}>{ins.desc}</span>
                </div>
                <span style={{ fontFamily:"'Bebas Neue'", fontSize:16, color:"var(--green)" }}>{ins.total} un.</span>
              </div>
              <div style={{ height:8, background:"var(--surface2)", borderRadius:4, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${(ins.total/maxInsumo)*100}%`, background:"var(--green)", borderRadius:4, transition:"width 0.5s" }}/>
              </div>
            </div>
          ))
        }
      </div>

      {/* Pedidos por máquina */}
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:"var(--muted)", marginBottom:14 }}>PEDIDOS POR MÁQUINA</div>
        {allMachineNames.length === 0
          ? <div style={{ color:"var(--muted)", fontSize:13, textAlign:"center", padding:"1rem" }}>Sin datos aún</div>
          : allMachineNames.filter(m => selected.includes(m)).map(maq => {
            const count = pedidosPorMaquina[maq] || 0;
            return (
              <div key={maq} style={{ marginBottom:10 }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                  <span style={{ fontSize:14, color:"var(--text)", fontWeight:500 }}>🔧 {maq}</span>
                  <span style={{ fontFamily:"'Bebas Neue'", fontSize:16, color:"#3B82F6" }}>{count} pedido{count!==1?"s":""}</span>
                </div>
                <div style={{ height:8, background:"var(--surface2)", borderRadius:4, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:`${(count/maxPedidos)*100}%`, background:"#3B82F6", borderRadius:4, transition:"width 0.5s" }}/>
                </div>
              </div>
            );
          })
        }
      </div>

      {/* Detalle de insumos por máquina seleccionada */}
      {selected.length === 1 && (
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:"var(--muted)", marginBottom:14 }}>DETALLE: {selected[0]}</div>
          {(() => {
            const detalle = {};
            entregados.filter(p => p.machine === selected[0]).forEach(p => {
              p.items.forEach(it => {
                if (!detalle[it.code]) detalle[it.code] = { code:it.code, desc:it.desc, total:0 };
                detalle[it.code].total += it.qty;
              });
            });
            const list = Object.values(detalle).sort((a,b) => b.total - a.total);
            return list.length === 0
              ? <div style={{ color:"var(--muted)", fontSize:13 }}>Sin pedidos entregados para esta máquina</div>
              : list.map(ins => (
                <div key={ins.code} style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid var(--border)" }}>
                  <div>
                    <div style={{ fontFamily:"'JetBrains Mono'", fontSize:12, color:"var(--green)" }}>{ins.code}</div>
                    <div style={{ fontSize:13, color:"var(--text)" }}>{ins.desc}</div>
                  </div>
                  <div style={{ fontFamily:"'Bebas Neue'", fontSize:20, color:"var(--green)", alignSelf:"center" }}>{ins.total} un.</div>
                </div>
              ));
          })()}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// ESTADÍSTICAS MANTENIMIENTO
// ════════════════════════════════════════════════════════════════════
function StatsMant({ mantenimientos, machines, cargaCompleta, cargarHistorialCompleto }) {
  useEffect(() => { cargarHistorialCompleto && cargarHistorialCompleto("mantenimientos"); }, []);
  const allMachineNames = [...new Set([
    ...machines.map(m => m.name),
    ...mantenimientos.map(m => m.machine)
  ])].sort();

  const [excluded, setExcluded] = useState(new Set());
  const [periodo, setPeriodo]   = useState("todo");

  const toggleMachine = (name) => {
    setExcluded(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };
  const selectAll = () => setExcluded(new Set());
  const clearAll  = () => setExcluded(new Set(allMachineNames));

  const now = new Date();
  const mesActual   = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  const mesAnterior = (() => { const d = new Date(now); d.setMonth(d.getMonth()-1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; })();

  const mesesDisponibles = [...new Set(
    mantenimientos.map(m => m.createdAt ? m.createdAt.slice(0,7) : null).filter(Boolean)
  )].sort().reverse();

  const matchesPeriodo = (m) => {
    if (!m.createdAt) return true;
    const mes = m.createdAt.slice(0,7);
    if (periodo === "todo")         return true;
    if (periodo === "mes_actual")   return mes === mesActual;
    if (periodo === "mes_anterior") return mes === mesAnterior;
    if (periodo === "3meses") {
      const d = new Date(now); d.setMonth(d.getMonth()-3);
      return new Date(m.createdAt) >= d;
    }
    return mes === periodo;
  };

  const selected = allMachineNames.filter(n => !excluded.has(n));
  const filtered = mantenimientos.filter(m => !excluded.has(m.machine) && matchesPeriodo(m));

  const tipoMap = {};
  filtered.forEach(m => { tipoMap[m.tipo] = (tipoMap[m.tipo] || 0) + 1; });
  const tiposList = Object.entries(tipoMap).sort((a,b) => b[1]-a[1]);
  const maxTipo   = tiposList[0]?.[1] || 1;

  const fallasPorMaquina = {};
  allMachineNames.forEach(m => { fallasPorMaquina[m] = filtered.filter(f => f.machine === m).length; });
  const maxFallas = Math.max(...Object.values(fallasPorMaquina), 1);

  const totalFallas     = filtered.length;
  const totalPendientes = filtered.filter(m => m.status === "pendiente").length;
  const totalRecibidos  = filtered.filter(m => m.status === "recibido").length;
  const BLUE = "#1d4ed8";

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>

      {cargaCompleta && !cargaCompleta.mantenimientos && (
        <div style={{ background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:10, padding:"8px 12px", fontSize:12, color:"#9a6000" }}>
          ⏳ Cargando historial completo (por defecto solo se sincronizan los últimos 60 días)...
        </div>
      )}

      {/* Selector */}
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:"var(--muted)" }}>FILTRAR POR MÁQUINA</div>
          <div style={{ display:"flex", gap:6 }}>
            <button onClick={selectAll} style={{ background:"none", border:"1px solid var(--border)", borderRadius:6, padding:"4px 10px", color:"var(--muted)", cursor:"pointer", fontSize:12 }}>Todas</button>
            <button onClick={clearAll}  style={{ background:"none", border:"1px solid var(--border)", borderRadius:6, padding:"4px 10px", color:"var(--muted)", cursor:"pointer", fontSize:12 }}>Ninguna</button>
          </div>
        </div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
          {allMachineNames.length === 0
            ? <div style={{ color:"var(--muted)", fontSize:13 }}>No hay solicitudes registradas aún.</div>
            : allMachineNames.map(name => {
              const isSelected = !excluded.has(name);
              return (
                <button key={name} onClick={() => toggleMachine(name)}
                  style={{ background:isSelected?BLUE:"var(--surface2)", border:`1px solid ${isSelected?BLUE:"var(--border)"}`, borderRadius:8, padding:"7px 14px", color:isSelected?"white":"var(--text)", fontFamily:"'DM Sans'", fontSize:13, fontWeight:500, cursor:"pointer", transition:"all 0.15s" }}>
                  {name}
                </button>
              );
            })
          }
        </div>
      </div>

      {/* Selector de período */}
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:"var(--muted)", marginBottom:12 }}>FILTRAR POR PERÍODO</div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
          {[
            { key:"todo",         label:"Todo" },
            { key:"mes_actual",   label:"Este mes" },
            { key:"mes_anterior", label:"Mes anterior" },
            { key:"3meses",       label:"Últimos 3 meses" },
            ...mesesDisponibles.filter(m => m !== mesActual && m !== mesAnterior).map(m => ({
              key: m,
              label: new Date(m+"-01").toLocaleDateString("es-AR", { month:"long", year:"numeric" })
            }))
          ].map(op => (
            <button key={op.key} onClick={() => setPeriodo(op.key)}
              style={{ background:periodo===op.key?BLUE:"var(--surface2)", border:`1px solid ${periodo===op.key?BLUE:"var(--border)"}`, borderRadius:8, padding:"7px 14px", color:periodo===op.key?"white":"var(--text)", fontFamily:"'DM Sans'", fontSize:13, fontWeight:500, cursor:"pointer", transition:"all 0.15s" }}>
              {op.label}
            </button>
          ))}
        </div>
      </div>

      {/* Totales */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
        {[
          { label:"FALLAS TOTALES",  value:totalFallas,     color:BLUE },
          { label:"PENDIENTES",      value:totalPendientes, color:"#f59e0b" },
          { label:"RECIBIDAS",       value:totalRecibidos,  color:"var(--green)" },
        ].map(card => (
          <div key={card.label} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:14, padding:"1rem", textAlign:"center" }}>
            <div style={{ fontFamily:"'Bebas Neue'", fontSize:34, color:card.color }}>{card.value}</div>
            <div style={{ fontSize:11, color:"var(--muted)", fontWeight:600, letterSpacing:1, marginTop:2 }}>{card.label}</div>
          </div>
        ))}
      </div>

      {/* Tipos de falla */}
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:"var(--muted)", marginBottom:14 }}>TIPOS DE FALLA MÁS FRECUENTES</div>
        {tiposList.length === 0
          ? <div style={{ color:"var(--muted)", fontSize:13, textAlign:"center", padding:"1rem" }}>Sin datos aún</div>
          : tiposList.map(([tipo, count]) => (
            <div key={tipo} style={{ marginBottom:10 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                <span style={{ fontSize:14, color:"var(--text)", fontWeight:500 }}>{tipo}</span>
                <span style={{ fontFamily:"'Bebas Neue'", fontSize:16, color:BLUE }}>{count} {count===1?"vez":"veces"}</span>
              </div>
              <div style={{ height:8, background:"var(--surface2)", borderRadius:4, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${(count/maxTipo)*100}%`, background:BLUE, borderRadius:4 }}/>
              </div>
            </div>
          ))
        }
      </div>

      {/* Fallas por máquina */}
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:"var(--muted)", marginBottom:14 }}>FALLAS POR MÁQUINA</div>
        {allMachineNames.length === 0
          ? <div style={{ color:"var(--muted)", fontSize:13, textAlign:"center", padding:"1rem" }}>Sin datos aún</div>
          : allMachineNames.filter(m => !excluded.has(m)).map(maq => {
            const count = fallasPorMaquina[maq] || 0;
            return (
              <div key={maq} style={{ marginBottom:10 }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                  <span style={{ fontSize:14, color:"var(--text)", fontWeight:500 }}>🔧 {maq}</span>
                  <span style={{ fontFamily:"'Bebas Neue'", fontSize:16, color:BLUE }}>{count} falla{count!==1?"s":""}</span>
                </div>
                <div style={{ height:8, background:"var(--surface2)", borderRadius:4, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:`${(count/maxFallas)*100}%`, background:BLUE, borderRadius:4 }}/>
                </div>
              </div>
            );
          })
        }
      </div>

      {/* Detalle máquina individual */}
      {selected.length === 1 && (
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:"var(--muted)", marginBottom:14 }}>DETALLE: {selected[0]}</div>
          {(() => {
            const detalle = {};
            filtered.filter(m => m.machine === selected[0]).forEach(m => {
              detalle[m.tipo] = (detalle[m.tipo] || 0) + 1;
            });
            const list = Object.entries(detalle).sort((a,b) => b[1]-a[1]);
            return list.length === 0
              ? <div style={{ color:"var(--muted)", fontSize:13 }}>Sin fallas registradas para esta máquina</div>
              : list.map(([tipo, count]) => (
                <div key={tipo} style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid var(--border)" }}>
                  <div style={{ fontSize:14, color:"var(--text)", fontWeight:500 }}>{tipo}</div>
                  <div style={{ fontFamily:"'Bebas Neue'", fontSize:20, color:BLUE }}>{count}x</div>
                </div>
              ));
          })()}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// PRODUCCIÓN VIEW
// ════════════════════════════════════════════════════════════════════
function ProduccionView({ registros, addRegistro, logged, setLogged, setView, prodPin, setProdPin, operarios, setOperarios, piezas, setPiezas, motivos, setMotivos, machines, auditLog, addAuditLog, faqs, addFaq, removeFaq, cargaCompleta, cargarHistorialCompleto }) {
  const [loginStep, setLoginStep]   = useState("panel"); // "panel" | "operario"
  const [pin, setPin]               = useState("");
  const [error, setError]           = useState("");
  const [mainTab, setMainTab]       = useState("registros");

  // Login panel producción
  const handlePanelLogin = () => {
    if (pin === prodPin) { setLogged(true); setError(""); setPin(""); }
    else { setError("PIN incorrecto"); setPin(""); }
  };

  if (!logged) return (
    <div style={{ minHeight:"100vh", background:"var(--page-bg)", display:"flex", alignItems:"center", justifyContent:"center", padding:"2rem" }}>
      <div style={{ maxWidth:340, width:"100%", background:"var(--surface)", border:"1px solid var(--border)", borderRadius:20, padding:"2rem" }}>
        <button onClick={() => setView("home")} style={{ background:"none", border:"none", color:"var(--muted)", cursor:"pointer", fontSize:14, marginBottom:24 }}>← Volver</button>
        <div style={{ textAlign:"center", marginBottom:28 }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:32, color:ORANGE, letterSpacing:4, marginBottom:10 }}>PRODUCCIÓN</div>
          <div style={{ color:"var(--muted)", fontSize:13, marginTop:4 }}>Panel supervisor · Ingresá el PIN</div>
        </div>
        <input type="password" value={pin} onChange={e=>setPin(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handlePanelLogin()} placeholder="••••"
          style={{ width:"100%", background:"var(--surface2)", border:`1px solid ${error?"#EF4444":"var(--border)"}`, borderRadius:10, padding:"14px 16px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:20, letterSpacing:8, textAlign:"center", outline:"none", marginBottom:12 }} />
        {error && <div style={{ color:"#EF4444", fontSize:13, marginBottom:12, textAlign:"center" }}>{error}</div>}
        <button onClick={handlePanelLogin} style={{ width:"100%", background:ORANGE, border:"none", borderRadius:10, padding:"14px", fontFamily:"'Bebas Neue'", fontSize:20, letterSpacing:2, cursor:"pointer", color:"white" }}>INGRESAR</button>
      </div>
    </div>
  );

  const tabs = [
    { key:"registros", label:"📋 REGISTROS" },
    { key:"oee",       label:"📊 OEE" },
    { key:"faq",       label:"❓ FAQ" },
    { key:"config",    label:"⚙️ CONFIG" },
    { key:"historial", label:"🕓 HISTORIAL" },
  ];

  return (
    <div style={{ minHeight:"100vh", background:"var(--page-bg)", padding:"1.5rem" }}>
      <div style={{ maxWidth:700, margin:"0 auto" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20 }}>
          <div style={{ display:"flex", alignItems:"center", gap:14 }}>
            <div>
              <div style={{ fontFamily:"'Bebas Neue'", fontSize:28, color:ORANGE, letterSpacing:3 }}>PRODUCCIÓN</div>
              <div style={{ fontSize:12, color:"var(--muted)", marginTop:1 }}>La carga se realiza desde cada puesto de trabajo</div>
            </div>
          </div>
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={() => setView("home")} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 14px", color:"var(--muted)", cursor:"pointer", fontSize:13 }}>🏠 Inicio</button>
            <button onClick={() => { setLogged(false); setView("home"); }} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 14px", color:"var(--muted)", cursor:"pointer", fontSize:13 }}>Salir</button>
          </div>
        </div>

        <div style={{ display:"flex", gap:6, marginBottom:20 }}>
          {tabs.map(({ key, label }) => (
            <button key={key} onClick={() => setMainTab(key)}
              style={{ flex:1, background:mainTab===key?ORANGE:"var(--surface)", border:`1px solid ${mainTab===key?ORANGE:"var(--border)"}`, borderRadius:12, padding:"12px 6px", color:mainTab===key?"white":"var(--muted)", fontFamily:"'Bebas Neue'", fontSize:15, letterSpacing:1, cursor:"pointer", transition:"all 0.2s" }}>
              {label}
            </button>
          ))}
        </div>

        {mainTab==="registros" && <RegistrosView registros={registros} operarios={operarios} machines={machines} piezas={piezas} cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
        {mainTab==="oee"       && <OeeDashboardView registros={registros} machines={machines} piezas={piezas} cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
        {mainTab==="faq"       && <FaqView area="produccion" machines={machines} operarios={operarios} faqs={faqs} addFaq={addFaq} removeFaq={removeFaq} addAuditLog={addAuditLog} />}
        {mainTab==="config"    && <ProdConfigView prodPin={prodPin} setProdPin={setProdPin} operarios={operarios} setOperarios={setOperarios} piezas={piezas} setPiezas={setPiezas} motivos={motivos} setMotivos={setMotivos} machines={machines} auditLog={auditLog} addAuditLog={addAuditLog} />}
        {mainTab==="historial" && <HistorialAuditoria auditLog={auditLog} area="produccion" cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
      </div>
    </div>
  );
}

// ── Registros View ────────────────────────────────────────────────
function RegistrosView({ registros, operarios, machines, piezas, cargaCompleta, cargarHistorialCompleto }) {
  const [filtroMaq,   setFiltroMaq]   = useState("todas");
  const [filtroOp,    setFiltroOp]    = useState("todos");
  const [filtroTurno, setFiltroTurno] = useState("todos");
  const [filtroFecha, setFiltroFecha] = useState("");
  const [selected,    setSelected]    = useState(null);

  // Fechas disponibles
  const fechasDisponibles = [...new Set(registros.map(r => r.fecha))].sort().reverse();
  const TURNOS_ORDEN = ["Mañana","Tarde","Noche"];
  const filtered = registros.filter(r => {
    if (filtroMaq   !== "todas" && r.maquina !== filtroMaq)   return false;
    if (filtroOp    !== "todos" && r.operario !== filtroOp)   return false;
    if (filtroTurno !== "todos" && r.turno    !== filtroTurno)return false;
    if (filtroFecha !== ""      && r.fecha    !== filtroFecha) return false;
    return true;
  }).sort((a, b) => {
    if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    if (b.fecha !== a.fecha) return b.fecha.localeCompare(a.fecha);
    return TURNOS_ORDEN.indexOf(b.turno) - TURNOS_ORDEN.indexOf(a.turno);
  });

  const selStyle = (val, cur) => ({
    background: val===cur ? ORANGE : "var(--surface2)",
    border: `1px solid ${val===cur ? ORANGE : "var(--border)"}`,
    borderRadius:8, padding:"6px 12px", color:val===cur?"white":"var(--text)",
    fontFamily:"'DM Sans'", fontSize:13, fontWeight:500, cursor:"pointer", whiteSpace:"nowrap"
  });

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      {cargarHistorialCompleto && (
        <button onClick={() => cargarHistorialCompleto("prodRegistros")} disabled={cargaCompleta?.prodRegistros}
          style={{ background: cargaCompleta?.prodRegistros ? "var(--surface2)" : ORANGE, border:"none", borderRadius:8, padding:"8px 14px", color: cargaCompleta?.prodRegistros ? "var(--muted)" : "white", fontSize:12, fontWeight:600, cursor: cargaCompleta?.prodRegistros ? "default" : "pointer", alignSelf:"flex-start" }}>
          {cargaCompleta?.prodRegistros ? "✓ Historial completo cargado" : "Ver turnos más viejos que 30 días"}
        </button>
      )}
      {/* Filtros */}
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem", display:"flex", flexDirection:"column", gap:10 }}>
        <div>
          <div style={{ fontSize:11, color:"var(--muted)", fontWeight:600, letterSpacing:1, marginBottom:7, textTransform:"uppercase" }}>Fecha</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
            <button style={selStyle("", filtroFecha)} onClick={() => setFiltroFecha("")}>Todas</button>
            {fechasDisponibles.slice(0,7).map(f => (
              <button key={f} style={selStyle(f, filtroFecha)} onClick={() => setFiltroFecha(f)}>
                {new Date(f+"T12:00:00").toLocaleDateString("es-AR",{day:"2-digit",month:"2-digit"})}
              </button>
            ))}
            {filtroFecha==="" && (
              <input type="date" value={filtroFecha} onChange={e=>setFiltroFecha(e.target.value)}
                style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"5px 10px", color:"var(--text)", fontSize:13, outline:"none", cursor:"pointer" }} />
            )}
          </div>
        </div>
        <div>
          <div style={{ fontSize:11, color:"var(--muted)", fontWeight:600, letterSpacing:1, marginBottom:7, textTransform:"uppercase" }}>Máquina</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
            <button style={selStyle("todas", filtroMaq)} onClick={() => setFiltroMaq("todas")}>Todas</button>
            {machines.map(m => <button key={m.id} style={selStyle(m.name, filtroMaq)} onClick={() => setFiltroMaq(m.name)}>{m.name}</button>)}
          </div>
        </div>
        <div>
          <div style={{ fontSize:11, color:"var(--muted)", fontWeight:600, letterSpacing:1, marginBottom:7, textTransform:"uppercase" }}>Operario</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
            <button style={selStyle("todos", filtroOp)} onClick={() => setFiltroOp("todos")}>Todos</button>
            {operarios.map(o => <button key={o.id} style={selStyle(o.numero, filtroOp)} onClick={() => setFiltroOp(o.numero)}>{o.numero}</button>)}
          </div>
        </div>
        <div>
          <div style={{ fontSize:11, color:"var(--muted)", fontWeight:600, letterSpacing:1, marginBottom:7, textTransform:"uppercase" }}>Turno</div>
          <div style={{ display:"flex", gap:6 }}>
            <button style={selStyle("todos", filtroTurno)} onClick={() => setFiltroTurno("todos")}>Todos</button>
            {TURNOS.map(t => <button key={t} style={selStyle(t, filtroTurno)} onClick={() => setFiltroTurno(t)}>{t}</button>)}
          </div>
        </div>
      </div>

      {filtered.length === 0
        ? <div style={{ textAlign:"center", color:"var(--muted)", padding:"3rem", background:"var(--surface)", borderRadius:16, border:"1px solid var(--border)" }}>No hay registros para los filtros seleccionados</div>
        : filtered.map(r => (
          <div key={r.id} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, overflow:"hidden", cursor:"pointer" }} onClick={() => setSelected(selected===r.id ? null : r.id)}>
            {/* Card header */}
            <div style={{ background:"#fff7ed", borderBottom:"1px solid #fed7aa", padding:"10px 16px" }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:6 }}>
                <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                  <span style={{ fontFamily:"'Bebas Neue'", fontSize:16, color:"#0f1f0f", letterSpacing:1 }}>{r.maquina}</span>
                  <span style={{ background:"white", borderRadius:999, padding:"2px 10px", fontSize:12, color:"#6B7280", fontWeight:600 }}>{r.operario}</span>
                  <span style={{ background:"white", borderRadius:999, padding:"2px 10px", fontSize:12, color:ORANGE, fontWeight:600 }}>{r.turno}</span>
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  {(() => {
                    const oeeData = calcularOEE(r, piezas);
                    if (oeeData.planificadoMin === 0) return null;
                    const pct = Math.round(oeeData.oee * 100);
                    const color = pct >= 75 ? "#16a34a" : pct >= 50 ? "#f59e0b" : "#EF4444";
                    return (
                      <span title={oeeData.sinDatosDeCiclo ? "Falta cargar tiempo de ciclo de la pieza" : ""}
                        style={{ background:oeeData.sinDatosDeCiclo?"var(--surface2)":`${color}22`, border:`1px solid ${oeeData.sinDatosDeCiclo?"var(--border)":color}`, borderRadius:999, padding:"3px 10px", fontSize:11, fontWeight:700, color:oeeData.sinDatosDeCiclo?"var(--muted)":color }}>
                        OEE {oeeData.sinDatosDeCiclo ? "—" : `${pct}%`}
                      </span>
                    );
                  })()}
                  <span style={{ fontSize:12, color:"#666" }}>{new Date(r.fecha+"T12:00:00").toLocaleDateString("es-AR")}</span>
                  <span style={{ fontSize:14, color:"var(--muted)" }}>{selected===r.id?"▲":"▼"}</span>
                </div>
              </div>
              {/* Pieza(s) — siempre visible, bien clara */}
              <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", marginTop:8 }}>
                <span style={{ fontSize:10, color:"#9a6000", fontWeight:700, letterSpacing:1, textTransform:"uppercase" }}>Pieza:</span>
                {normalizarRegistro(r).piezasCargadas.map((c,i) => (
                  <span key={i} style={{ background:"white", border:"1px solid #fed7aa", borderRadius:6, padding:"2px 9px", fontSize:12, fontFamily:"'JetBrains Mono'", fontWeight:700, color:"#0f1f0f" }}>{c.numero}</span>
                ))}
              </div>
            </div>

            {/* Resumen siempre visible — detalle por pieza */}
            <div style={{ padding:"10px 16px", display:"flex", flexDirection:"column", gap:8 }}>
              {normalizarRegistro(r).piezasCargadas.map((c,i) => {
                const producido = (c.izq||0)+(c.der||0);
                const sc = (c.scrapIzq||0)+(c.scrapDer||0);
                const fun = (c.fundIzq||0)+(c.fundDer||0);
                const pend = (c.pendIzq||0)+(c.pendDer||0);
                const ok = Math.max(0, producido - sc - fun - pend);
                return (
                  <div key={i} style={{ background:"var(--surface2)", borderRadius:10, padding:"8px 12px" }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                      <span style={{ fontFamily:"'JetBrains Mono'", fontSize:12, fontWeight:700, color:"var(--text)" }}>{c.numero}</span>
                      <span style={{ fontFamily:"'Bebas Neue'", fontSize:18, color:"#1d4ed8" }}>{producido} <span style={{ fontSize:11, color:"var(--muted)" }}>pzs</span></span>
                    </div>
                    <div style={{ display:"flex", gap:10, flexWrap:"wrap", fontSize:11 }}>
                      <span style={{ color:"var(--muted)" }}>Izq {c.izq||0} · Der {c.der||0}</span>
                      {sc>0   && <span style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:6, padding:"2px 8px", color:"#EF4444", fontWeight:600 }}>Scrap {sc}</span>}
                      {fun>0  && <span style={{ background:"#fefce8", border:"1px solid #fde68a", borderRadius:6, padding:"2px 8px", color:"#f59e0b", fontWeight:600 }}>Fund. {fun}</span>}
                      {pend>0 && <span style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:6, padding:"2px 8px", color:"#6B7280", fontWeight:600 }}>Pend. {pend}</span>}
                      <span style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:6, padding:"2px 8px", color:"#16a34a", fontWeight:700 }}>OK {ok}</span>
                    </div>
                  </div>
                );
              })}
              <div style={{ textAlign:"right", fontSize:11, color:"var(--muted)", marginTop:2 }}>
                Total del turno: <strong style={{ color:"var(--text)" }}>{normalizarRegistro(r).piezasCargadas.reduce((a,c)=>a+(c.izq||0)+(c.der||0),0)} piezas</strong>
              </div>
            </div>

            {/* Detalle expandido */}
            {selected===r.id && (
              <div style={{ borderTop:"1px solid var(--border)", padding:"12px 16px" }}>
                {/* Desglose OEE */}
                {(() => {
                  const o = calcularOEE(r, piezas);
                  if (o.planificadoMin === 0) return null;
                  const Bar = ({ label, val, color }) => (
                    <div style={{ marginBottom:8 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"var(--text)", marginBottom:3 }}>
                        <span>{label}</span><span style={{ fontWeight:700, color }}>{Math.round(val*100)}%</span>
                      </div>
                      <div style={{ background:"var(--surface2)", borderRadius:6, height:8, overflow:"hidden" }}>
                        <div style={{ width:`${Math.min(val,1)*100}%`, background:color, height:"100%", borderRadius:6 }} />
                      </div>
                    </div>
                  );
                  return (
                    <div style={{ marginBottom:16, background:"var(--surface2)", borderRadius:12, padding:"12px 14px" }}>
                      <div style={{ fontSize:12, color:"var(--muted)", fontWeight:600, marginBottom:10, textTransform:"uppercase", letterSpacing:1 }}>OEE del turno</div>
                      {o.sinDatosDeCiclo && (
                        <div style={{ fontSize:12, color:"#9a6000", background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:8, padding:"6px 10px", marginBottom:10 }}>
                          ⚠️ Falta cargar el tiempo de ciclo de esta pieza en Config → Piezas. El Rendimiento se muestra en 0%.
                        </div>
                      )}
                      <Bar label="Disponibilidad" val={o.disponibilidad} color="#3B82F6" />
                      <Bar label="Rendimiento"    val={o.rendimiento}    color={ORANGE} />
                      <Bar label="Calidad"        val={o.calidad}        color="#16a34a" />
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:10, paddingTop:10, borderTop:"1px solid var(--border)" }}>
                        <span style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:"var(--text)" }}>OEE TOTAL</span>
                        <span style={{ fontFamily:"'Bebas Neue'", fontSize:26, color: o.oee>=0.75?"#16a34a":o.oee>=0.5?"#f59e0b":"#EF4444" }}>{Math.round(o.oee*100)}%</span>
                      </div>
                      <div style={{ fontSize:11, color:"var(--muted)", marginTop:6 }}>
                        Parado {o.paradaMin} min de {o.planificadoMin} min planificados · {o.totalOk}/{o.totalProducido} piezas OK
                      </div>
                    </div>
                  );
                })()}
                {/* Gráfico de barras por hora */}
                {r.piezasPorHora && r.piezasPorHora.some(v=>v>0) && (
                  <div style={{ marginBottom:16 }}>
                    <div style={{ fontSize:12, color:"var(--muted)", fontWeight:600, marginBottom:8, textTransform:"uppercase", letterSpacing:1 }}>Piezas por hora</div>
                    <GraficoPiezas data={r.piezasPorHora} horaInicio={r.horaInicio||6} />
                  </div>
                )}
                {/* Tiempos parada */}
                {r.paradas && r.paradas.some(p=>p.minutos>0) && (
                  <div style={{ marginBottom:12 }}>
                    <div style={{ fontSize:12, color:"var(--muted)", fontWeight:600, marginBottom:8, textTransform:"uppercase", letterSpacing:1 }}>Tiempos de parada</div>
                    {r.paradas.filter(p=>p.minutos>0).map((p,i) => (
                      <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"5px 0", borderBottom:"1px solid var(--border)", fontSize:13 }}>
                        <span style={{ color:"var(--text)" }}>{p.motivo}</span>
                        <span style={{ fontWeight:600, color:"#EF4444" }}>{p.minutos} min</span>
                      </div>
                    ))}
                    <div style={{ display:"flex", justifyContent:"space-between", padding:"6px 0", fontSize:13, fontWeight:600 }}>
                      <span style={{ color:"var(--text)" }}>Total parado</span>
                      <span style={{ color:"#EF4444" }}>{r.paradas.reduce((a,p)=>a+(p.minutos||0),0)} min</span>
                    </div>
                  </div>
                )}
                {r.obs && <div style={{ padding:"8px 10px", background:"var(--surface2)", borderRadius:8, color:"var(--muted)", fontSize:13 }}>📝 {r.obs}</div>}
              </div>
            )}
          </div>
        ))
      }
    </div>
  );
}

// ── Gráfico de barras por hora ────────────────────────────────────
function GraficoPiezas({ data, horaInicio }) {
  const max = Math.max(...data, 1);
  const horas = data.map((_, i) => {
    const h = (horaInicio + i) % 24;
    return `${h}:00`;
  });
  return (
    <div style={{ display:"flex", alignItems:"flex-end", gap:3, height:90 }}>
      {data.map((val, i) => (
        <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
          <div style={{ fontSize:9, color:ORANGE, fontWeight:600 }}>{val||""}</div>
          <div style={{ width:"100%", background: val>0 ? ORANGE : "var(--surface2)", borderRadius:"3px 3px 0 0", height:`${Math.max((val/max)*64, val>0?4:2)}px`, transition:"height 0.3s" }}/>
          <div style={{ fontSize:8, color:"var(--muted)", textAlign:"center", lineHeight:1.1 }}>{horas[i]}</div>
        </div>
      ))}
    </div>
  );
}

// ── Dashboard de OEE agregado ──────────────────────────────────────
function OeeDashboardView({ registros, machines, piezas, cargaCompleta, cargarHistorialCompleto }) {
  const [rango,     setRango]     = useState(30); // días hacia atrás, 0 = todo el histórico
  const [filtroMaq, setFiltroMaq] = useState("todas");

  // Por defecto solo se sincronizan los últimos 30 días de producción.
  // Si se pide un rango más amplio, traemos el resto una sola vez.
  useEffect(() => {
    if ((rango === 0 || rango > 30) && cargarHistorialCompleto) {
      cargarHistorialCompleto("prodRegistros");
    }
  }, [rango]);

  const hoyISO = new Date().toISOString().slice(0,10);
  const desde = rango > 0 ? new Date(Date.now() - rango*24*60*60*1000).toISOString().slice(0,10) : null;

  const enRango = registros
    .filter(r => !desde || r.fecha >= desde)
    .filter(r => filtroMaq === "todas" || r.maquina === filtroMaq);

  // Promedio por máquina (solo turnos con tiempo de ciclo cargado, si no el Rendimiento no es real)
  const porMaquina = machines.map(m => {
    const regs = enRango.filter(r => r.maquina === m.name);
    const calc = regs.map(r => calcularOEE(r, piezas)).filter(o => o.planificadoMin > 0);
    const validos = calc.filter(o => !o.sinDatosDeCiclo);
    const n = validos.length;
    const avg = (key) => n > 0 ? validos.reduce((a,o)=>a+o[key],0)/n : 0;
    return {
      maquina: m.name,
      turnos: regs.length,
      turnosValidos: n,
      oee: avg("oee"), disponibilidad: avg("disponibilidad"), rendimiento: avg("rendimiento"), calidad: avg("calidad"),
    };
  }).filter(x => x.turnos > 0);

  // Tendencia diaria (promedio de OEE de todas las máquinas filtradas, por fecha)
  const porFecha = {};
  enRango.forEach(r => {
    const o = calcularOEE(r, piezas);
    if (o.planificadoMin === 0 || o.sinDatosDeCiclo) return;
    (porFecha[r.fecha] = porFecha[r.fecha] || []).push(o.oee);
  });
  const tendencia = Object.entries(porFecha)
    .map(([fecha, vals]) => ({ fecha, oee: vals.reduce((a,b)=>a+b,0)/vals.length }))
    .sort((a,b) => a.fecha.localeCompare(b.fecha));

  const conDatos = porMaquina.filter(m => m.turnosValidos > 0);
  const mejor = conDatos.length ? [...conDatos].sort((a,b)=>b.oee-a.oee)[0] : null;
  const peor  = conDatos.length > 1 ? [...conDatos].sort((a,b)=>a.oee-b.oee)[0] : null;
  const totalTurnos = enRango.length;
  const totalValidos = porMaquina.reduce((a,m)=>a+m.turnosValidos,0);

  const colorPct = (v) => v>=0.75 ? "#16a34a" : v>=0.5 ? "#f59e0b" : "#EF4444";

  const MiniBar = ({ label, val, color }) => (
    <div style={{ marginBottom:6 }}>
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"var(--muted)", marginBottom:2 }}>
        <span>{label}</span><span style={{ fontWeight:700, color }}>{Math.round(val*100)}%</span>
      </div>
      <div style={{ background:"var(--surface2)", borderRadius:4, height:5, overflow:"hidden" }}>
        <div style={{ width:`${Math.min(val,1)*100}%`, background:color, height:"100%" }} />
      </div>
    </div>
  );

  const selStyle = (val, cur) => ({
    background: val===cur ? ORANGE : "var(--surface2)",
    border: `1px solid ${val===cur ? ORANGE : "var(--border)"}`,
    borderRadius:8, padding:"6px 12px", color:val===cur?"white":"var(--text)",
    fontFamily:"'DM Sans'", fontSize:13, fontWeight:500, cursor:"pointer", whiteSpace:"nowrap"
  });

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      {/* Filtros */}
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem", display:"flex", flexDirection:"column", gap:10 }}>
        <div>
          <div style={{ fontSize:11, color:"var(--muted)", fontWeight:600, letterSpacing:1, marginBottom:7, textTransform:"uppercase" }}>Período</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
            {[[7,"7 días"],[30,"30 días"],[90,"90 días"],[0,"Todo"]].map(([v,l]) => (
              <button key={v} style={selStyle(v, rango)} onClick={() => setRango(v)}>{l}</button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize:11, color:"var(--muted)", fontWeight:600, letterSpacing:1, marginBottom:7, textTransform:"uppercase" }}>Máquina</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
            <button style={selStyle("todas", filtroMaq)} onClick={() => setFiltroMaq("todas")}>Todas</button>
            {machines.map(m => <button key={m.id} style={selStyle(m.name, filtroMaq)} onClick={() => setFiltroMaq(m.name)}>{m.name}</button>)}
          </div>
        </div>
      </div>

      {(rango === 0 || rango > 30) && !cargaCompleta?.prodRegistros && (
        <div style={{ background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:10, padding:"8px 12px", fontSize:12, color:"#9a6000" }}>
          ⏳ Cargando historial completo (por defecto solo se sincronizan los últimos 30 días)...
        </div>
      )}

      {totalTurnos === 0 ? (
        <div style={{ textAlign:"center", color:"var(--muted)", padding:"3rem", background:"var(--surface)", borderRadius:16, border:"1px solid var(--border)" }}>
          No hay turnos cargados en este período.
        </div>
      ) : totalValidos === 0 ? (
        <div style={{ textAlign:"center", color:"#9a6000", padding:"2rem", background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:16 }}>
          ⚠️ Hay {totalTurnos} turno(s) en este período, pero ninguno tiene el tiempo de ciclo de su pieza cargado (Config → Piezas). Sin eso no se puede calcular el OEE real.
        </div>
      ) : (
        <>
          {/* Destacados */}
          {mejor && (
            <div style={{ display:"grid", gridTemplateColumns: peor && peor.maquina!==mejor.maquina ? "1fr 1fr" : "1fr", gap:10 }}>
              <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:14, padding:"1rem" }}>
                <div style={{ fontSize:11, color:"#166534", fontWeight:700, letterSpacing:1, marginBottom:4 }}>🏆 MEJOR MÁQUINA</div>
                <div style={{ fontFamily:"'Bebas Neue'", fontSize:18, color:"#0f1f0f" }}>{mejor.maquina}</div>
                <div style={{ fontFamily:"'Bebas Neue'", fontSize:28, color:"#16a34a" }}>{Math.round(mejor.oee*100)}%</div>
              </div>
              {peor && peor.maquina !== mejor.maquina && (
                <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:14, padding:"1rem" }}>
                  <div style={{ fontSize:11, color:"#991b1b", fontWeight:700, letterSpacing:1, marginBottom:4 }}>⚠️ A MEJORAR</div>
                  <div style={{ fontFamily:"'Bebas Neue'", fontSize:18, color:"#0f1f0f" }}>{peor.maquina}</div>
                  <div style={{ fontFamily:"'Bebas Neue'", fontSize:28, color:"#EF4444" }}>{Math.round(peor.oee*100)}%</div>
                </div>
              )}
            </div>
          )}

          {/* Tendencia diaria */}
          {tendencia.length > 1 && (
            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
              <div style={{ fontFamily:"'Bebas Neue'", fontSize:15, letterSpacing:2, color:ORANGE, marginBottom:14 }}>TENDENCIA DE OEE</div>
              <div style={{ display:"flex", alignItems:"flex-end", gap:4, height:90 }}>
                {tendencia.map((t,i) => (
                  <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:3, height:"100%", justifyContent:"flex-end" }}>
                    <span style={{ fontSize:9, color:colorPct(t.oee), fontWeight:700 }}>{Math.round(t.oee*100)}</span>
                    <div style={{ width:"100%", background:colorPct(t.oee), borderRadius:"3px 3px 0 0", height:`${Math.max(t.oee*64,3)}px` }} />
                    <span style={{ fontSize:8, color:"var(--muted)" }}>{new Date(t.fecha+"T12:00:00").toLocaleDateString("es-AR",{day:"2-digit",month:"2-digit"})}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Por máquina */}
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {porMaquina.map(m => (
              <div key={m.maquina} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.1rem" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                  <div>
                    <div style={{ fontFamily:"'Bebas Neue'", fontSize:17, color:"var(--text)", letterSpacing:1 }}>{m.maquina}</div>
                    <div style={{ fontSize:11, color:"var(--muted)" }}>{m.turnos} turno{m.turnos!==1?"s":""} · {m.turnosValidos} con OEE calculable</div>
                  </div>
                  {m.turnosValidos > 0 ? (
                    <div style={{ fontFamily:"'Bebas Neue'", fontSize:32, color:colorPct(m.oee) }}>{Math.round(m.oee*100)}%</div>
                  ) : (
                    <div style={{ fontSize:12, color:"var(--muted)", fontStyle:"italic" }}>Sin ciclo cargado</div>
                  )}
                </div>
                {m.turnosValidos > 0 && (
                  <div>
                    <MiniBar label="Disponibilidad" val={m.disponibilidad} color="#3B82F6" />
                    <MiniBar label="Rendimiento"    val={m.rendimiento}    color={ORANGE} />
                    <MiniBar label="Calidad"        val={m.calidad}        color="#16a34a" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function NuevaCargaView({ addRegistro, operarios, machines, piezas, motivos, defaultMaquina }) {
  const [loggedOp, setLoggedOp] = useState(null);
  const [opNumero, setOpNumero] = useState("");
  const [opPin,    setOpPin]    = useState("");
  const [opError,  setOpError]  = useState("");
  const [step,     setStep]     = useState("login");
  const [sent,     setSent]     = useState(false);

  // Form state
  const today = new Date().toISOString().slice(0,10);
  const [fecha,      setFecha]      = useState(today);
  const [turno,      setTurno]      = useState("Mañana");
  const [maquina,    setMaquina]    = useState(defaultMaquina || machines[0]?.name || "");
  const [pieza,      setPieza]      = useState("");
  const [cargas,     setCargas]     = useState([]); // [{numero, izq, der, scrapIzq, scrapDer, fundIzq, fundDer, pendIzq, pendDer}]
  const [piezasSeleccionadas, setPiezasSeleccionadas] = useState([]);
  const [piezasPorHora, setPiezasPorHora] = useState(() => Array(TURNOS_CONFIG["Mañana"].slots).fill(""));
  const [paradas,    setParadas]    = useState(motivos.map(m => ({ motivo:m, minutos:"" })));
  const [obs,        setObs]        = useState("");
  const [formErrors, setFormErrors] = useState([]);

  const cargaVacia = (numero) => ({ numero, izq:"", der:"", scrapIzq:"", scrapDer:"", fundIzq:"", fundDer:"", pendIzq:"", pendDer:"" });

  const togglePiezaCarga = (numero) => {
    setCargas(prev => prev.find(c => c.numero === numero) ? prev.filter(c => c.numero !== numero) : [...prev, cargaVacia(numero)]);
    setPiezasSeleccionadas(prev => prev.includes(numero) ? prev.filter(x=>x!==numero) : [...prev, numero]);
  };
  const addPiezaManual = () => {
    const num = pieza.trim();
    if (!num || cargas.find(c => c.numero === num)) { setPieza(""); return; }
    setCargas(prev => [...prev, cargaVacia(num)]);
    setPieza("");
  };
  const removeCarga = (numero) => {
    setCargas(prev => prev.filter(c => c.numero !== numero));
    setPiezasSeleccionadas(prev => prev.filter(x => x !== numero));
  };
  const updateCarga = (numero, field, value) => {
    setCargas(prev => prev.map(c => c.numero === numero ? { ...c, [field]: value } : c));
  };

  // Cuando cambia el turno, resetear piezasPorHora con la cantidad de slots correcta
  const handleTurnoChange = (t) => {
    setTurno(t);
    setPiezasPorHora(Array(TURNOS_CONFIG[t].slots).fill(""));
  };

  useEffect(() => {
    setParadas(motivos.map(m => ({ motivo:m, minutos:"" })));
  }, [motivos]);

  useEffect(() => {
    if (formErrors.length > 0) setFormErrors([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fecha, turno, maquina, cargas, piezasPorHora, paradas]);

  const piezasMaquina = piezas.filter(p => p.maquina === maquina);

  const handleOpLogin = () => {
    const op = operarios.find(o => o.numero === opNumero.trim() && o.pin === opPin);
    if (op) { setLoggedOp(op); setOpError(""); setOpNumero(""); setOpPin(""); setStep("form"); }
    else { setOpError("Número de operario o PIN incorrecto"); setOpPin(""); }
  };

  // ── Validaciones antes de guardar ──────────────────────────────
  const validarCarga = () => {
    const errores = [];

    if (cargas.length === 0) errores.push('Agregá al menos una pieza en "Piezas cargadas"');

    let totalProducido = 0, totalDescartes = 0;
    cargas.forEach(c => {
      const campos = { izq:c.izq, der:c.der, "scrap izq":c.scrapIzq, "scrap der":c.scrapDer, "fundición izq":c.fundIzq, "fundición der":c.fundDer, "pendiente izq":c.pendIzq, "pendiente der":c.pendDer };
      for (const [label, val] of Object.entries(campos)) {
        if (val !== "" && parseInt(val) < 0) errores.push(`"${c.numero}" — ${label} no puede ser negativo`);
      }
      const producido = (parseInt(c.izq)||0)+(parseInt(c.der)||0);
      const descartes = (parseInt(c.scrapIzq)||0)+(parseInt(c.scrapDer)||0)+(parseInt(c.fundIzq)||0)+(parseInt(c.fundDer)||0)+(parseInt(c.pendIzq)||0)+(parseInt(c.pendDer)||0);
      if (descartes > producido) errores.push(`"${c.numero}" — Scrap + Fundición + Pendiente (${descartes}) no puede superar lo producido (${producido})`);
      totalProducido += producido;
      totalDescartes += descartes;
    });

    piezasPorHora.forEach((v, i) => {
      if (v !== "" && parseInt(v) < 0) errores.push(`"Piezas por hora" (columna ${i+1}) no puede ser negativo`);
    });
    paradas.forEach(p => {
      if (p.minutos !== "" && parseInt(p.minutos) < 0) errores.push(`Los minutos de parada de "${p.motivo}" no pueden ser negativos`);
    });

    const planificadoMin = TURNOS_CONFIG[turno]?.duracionMin || 0;
    const totalParadaMin = paradas.reduce((a,p)=>a+(parseInt(p.minutos)||0),0);
    if (totalParadaMin > planificadoMin) {
      errores.push(`El total de paradas (${totalParadaMin} min) supera la duración del turno (${planificadoMin} min)`);
    }

    if (!fecha) errores.push("Falta seleccionar la fecha");
    if (!maquina) errores.push("Falta seleccionar la máquina");

    return errores;
  };

  const handleSubmit = () => {
    const errores = validarCarga();
    if (errores.length > 0) {
      setFormErrors(errores);
      return;
    }
    setFormErrors([]);
    const cfg = TURNOS_CONFIG[turno];
    const registro = {
      id: `R${Date.now()}`,
      fecha, turno, maquina,
      operario: loggedOp?.numero || "—",
      piezasCargadas: cargas.map(c => ({
        numero: c.numero,
        izq: parseInt(c.izq)||0, der: parseInt(c.der)||0,
        scrapIzq: parseInt(c.scrapIzq)||0, scrapDer: parseInt(c.scrapDer)||0,
        fundIzq: parseInt(c.fundIzq)||0, fundDer: parseInt(c.fundDer)||0,
        pendIzq: parseInt(c.pendIzq)||0, pendDer: parseInt(c.pendDer)||0,
      })),
      piezas: cargas.map(c => c.numero),
      horaInicio: cfg.inicio,
      piezasPorHora: piezasPorHora.map(v => parseInt(v)||0),
      paradas: paradas.map(p => ({ motivo:p.motivo, minutos:parseInt(p.minutos)||0 })),
      obs,
      createdAt: new Date().toISOString(),
    };
    addRegistro(registro);
    setSent(true);
  };

  if (sent) return (
    <div style={{ textAlign:"center", padding:"3rem", background:"var(--surface)", borderRadius:16, border:"1px solid var(--border)" }}>
      <div style={{ fontSize:56, marginBottom:16 }}>✅</div>
      <div style={{ fontFamily:"'Bebas Neue'", fontSize:32, color:ORANGE, letterSpacing:3, marginBottom:8 }}>¡PRODUCCIÓN CARGADA!</div>
      <div style={{ color:"var(--muted)", marginBottom:24 }}>{maquina} · {turno} · {fecha}</div>
      <button onClick={() => { setSent(false); setPieza(""); setPiezasSeleccionadas([]); setCargas([]); setPiezasPorHora(Array(TURNOS_CONFIG[turno].slots).fill("")); setParadas(motivos.map(m=>({motivo:m,minutos:""}))); setObs(""); }}
        style={{ background:ORANGE, border:"none", borderRadius:10, padding:"13px 32px", fontFamily:"'Bebas Neue'", fontSize:18, letterSpacing:2, cursor:"pointer", color:"white" }}>
        NUEVA CARGA
      </button>
    </div>
  );

  // Login del operario con número + PIN
  if (step === "login") return (
    <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"2rem", maxWidth:360, margin:"0 auto" }}>
      <div style={{ textAlign:"center", marginBottom:24 }}>
        <div style={{ fontSize:40, marginBottom:8 }}>👷</div>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:24, color:ORANGE, letterSpacing:3 }}>IDENTIFICATE</div>
        <div style={{ color:"var(--muted)", fontSize:13, marginTop:4 }}>Ingresá tu número de operario y PIN</div>
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        <div>
          <label style={{ fontSize:11, color:"var(--muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 }}>Número de operario</label>
          <input value={opNumero} onChange={e=>setOpNumero(e.target.value)} placeholder="ej: OP 121"
            style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"13px 16px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:16, outline:"none" }} />
        </div>
        <div>
          <label style={{ fontSize:11, color:"var(--muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 }}>PIN</label>
          <input type="password" value={opPin} onChange={e=>setOpPin(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleOpLogin()} placeholder="••••"
            style={{ width:"100%", background:"var(--surface2)", border:`1px solid ${opError?"#EF4444":"var(--border)"}`, borderRadius:10, padding:"13px 16px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:20, letterSpacing:8, textAlign:"center", outline:"none" }} />
        </div>
        {opError && <div style={{ color:"#EF4444", fontSize:13, textAlign:"center" }}>{opError}</div>}
        <button onClick={handleOpLogin} style={{ background:ORANGE, border:"none", borderRadius:10, padding:"13px", fontFamily:"'Bebas Neue'", fontSize:18, letterSpacing:2, cursor:"pointer", color:"white", marginTop:4 }}>INGRESAR</button>
      </div>
    </div>
  );

  const inputStyle = { width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:14, outline:"none" };
  const labelStyle = { fontSize:12, color:"var(--muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 };
  const numInput   = { ...inputStyle, textAlign:"center", fontFamily:"'JetBrains Mono'", fontSize:16, fontWeight:600 };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      {/* Operario logueado */}
      <div style={{ background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:12, padding:"12px 16px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:24 }}>👷</span>
          <div>
            <div style={{ fontFamily:"'Bebas Neue'", fontSize:18, color:ORANGE, letterSpacing:2 }}>{loggedOp.numero}</div>
            <div style={{ fontSize:12, color:"#9a6000" }}>Operario identificado</div>
          </div>
        </div>
        <button onClick={() => { setLoggedOp(null); setStep("login"); }} style={{ background:"none", border:"1px solid #fed7aa", borderRadius:6, padding:"4px 10px", color:"#9a6000", cursor:"pointer", fontSize:12 }}>Cambiar</button>
      </div>

      {/* Datos generales */}
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem", display:"flex", flexDirection:"column", gap:12 }}>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:ORANGE, marginBottom:4 }}>DATOS GENERALES</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          <div><label style={labelStyle}>Fecha</label><input type="date" value={fecha} onChange={e=>setFecha(e.target.value)} style={inputStyle} /></div>
          <div>
            <label style={labelStyle}>Turno</label>
            <div style={{ display:"flex", gap:6 }}>
              {TURNOS.map(t => (
                <button key={t} onClick={() => handleTurnoChange(t)}
                  style={{ flex:1, background:turno===t?ORANGE:"var(--surface2)", border:`1px solid ${turno===t?ORANGE:"var(--border)"}`, borderRadius:8, padding:"8px 4px", color:turno===t?"white":"var(--text)", fontFamily:"'DM Sans'", fontSize:13, fontWeight:500, cursor:"pointer" }}>
                  <div>{t}</div>
                  <div style={{ fontSize:10, opacity:0.8 }}>{TURNOS_CONFIG[t].label}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div>
          <label style={labelStyle}>Máquina</label>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
            {machines.map(m => <button key={m.id} onClick={() => { setMaquina(m.name); setPieza(""); setCargas([]); setPiezasSeleccionadas([]); }} style={{ background:maquina===m.name?ORANGE:"var(--surface2)", border:`1px solid ${maquina===m.name?ORANGE:"var(--border)"}`, borderRadius:8, padding:"8px 14px", color:maquina===m.name?"white":"var(--text)", fontFamily:"'DM Sans'", fontSize:14, fontWeight:500, cursor:"pointer" }}>{m.name}</button>)}
          </div>
        </div>
        <div>
          <label style={labelStyle}>Número de pieza</label>
          {piezasMaquina.length > 0 ? (
            <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:8 }}>
              {piezasMaquina.map(p => {
                const sel = piezasSeleccionadas.includes(p.numero);
                return (
                  <button key={p.id} onClick={() => togglePiezaCarga(p.numero)} style={{ background:sel?ORANGE:"var(--surface2)", border:`1px solid ${sel?ORANGE:"var(--border)"}`, borderRadius:8, padding:"8px 14px", color:sel?"white":"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, cursor:"pointer" }}>
                    {sel?"✓ ":""}{p.numero}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div style={{ display:"flex", gap:8 }}>
            <input value={pieza} onChange={e=>setPieza(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addPiezaManual()} placeholder="Número de pieza adicional (opcional)" style={{ ...inputStyle, fontFamily:"'JetBrains Mono'", flex:1 }} />
            <button onClick={addPiezaManual} style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"0 16px", color:"var(--text)", fontFamily:"'Bebas Neue'", fontSize:14, cursor:"pointer" }}>+ AGREGAR</button>
          </div>
        </div>
      </div>

      {/* Cantidad de piezas — una tarjeta por cada pieza cargada */}
      {cargas.length === 0 ? (
        <div style={{ background:"var(--surface)", border:"1px dashed var(--border)", borderRadius:16, padding:"1.5rem", textAlign:"center", color:"var(--muted)", fontSize:14 }}>
          Seleccioná o agregá al menos una pieza arriba para cargar cantidades.
        </div>
      ) : cargas.map((c, ci) => {
        const producido = (parseInt(c.izq)||0)+(parseInt(c.der)||0);
        const sc   = (parseInt(c.scrapIzq)||0)+(parseInt(c.scrapDer)||0);
        const fun  = (parseInt(c.fundIzq)||0)+(parseInt(c.fundDer)||0);
        const pend = (parseInt(c.pendIzq)||0)+(parseInt(c.pendDer)||0);
        const okIzq = Math.max(0, (parseInt(c.izq)||0) - (parseInt(c.scrapIzq)||0) - (parseInt(c.fundIzq)||0) - (parseInt(c.pendIzq)||0));
        const okDer = Math.max(0, (parseInt(c.der)||0) - (parseInt(c.scrapDer)||0) - (parseInt(c.fundDer)||0) - (parseInt(c.pendDer)||0));
        const ok = okIzq + okDer;

        const QRow = ({ label, color, field } ) => (
          <div style={{ display:"grid", gridTemplateColumns:"70px 1fr 1fr 50px", gap:6, alignItems:"center", marginBottom:6 }}>
            <div style={{ fontSize:11, color, fontWeight:700, letterSpacing:1 }}>{label}</div>
            <input type="number" value={c[field+"Izq"]} onChange={e=>updateCarga(c.numero, field+"Izq", e.target.value)} placeholder="Izq"
              style={{ background:"var(--surface)", border:`1px solid ${parseInt(c[field+"Izq"])>0?color:"var(--border)"}`, borderRadius:6, padding:"7px 4px", color:parseInt(c[field+"Izq"])>0?color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:14, outline:"none", textAlign:"center", width:"100%" }} />
            <input type="number" value={c[field+"Der"]} onChange={e=>updateCarga(c.numero, field+"Der", e.target.value)} placeholder="Der"
              style={{ background:"var(--surface)", border:`1px solid ${parseInt(c[field+"Der"])>0?color:"var(--border)"}`, borderRadius:6, padding:"7px 4px", color:parseInt(c[field+"Der"])>0?color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:14, outline:"none", textAlign:"center", width:"100%" }} />
            <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, color, textAlign:"center" }}>{(parseInt(c[field+"Izq"])||0)+(parseInt(c[field+"Der"])||0)}</div>
          </div>
        );

        return (
          <div key={c.numero} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
              <div style={{ fontFamily:"'JetBrains Mono'", fontSize:15, color:ORANGE, fontWeight:700 }}>{c.numero}</div>
              <button onClick={() => removeCarga(c.numero)} style={{ background:"none", border:"1px solid #EF444466", borderRadius:6, padding:"4px 10px", color:"#EF4444", cursor:"pointer", fontSize:12 }}>Quitar</button>
            </div>

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:12 }}>
              <div><label style={labelStyle}>IZQ (producido)</label><input type="number" value={c.izq} onChange={e=>updateCarga(c.numero,"izq",e.target.value)} placeholder="0" style={numInput} /></div>
              <div><label style={labelStyle}>DER (producido)</label><input type="number" value={c.der} onChange={e=>updateCarga(c.numero,"der",e.target.value)} placeholder="0" style={numInput} /></div>
            </div>
            <div style={{ textAlign:"center", marginBottom:12, fontFamily:"'Bebas Neue'", fontSize:20, color:ORANGE }}>{producido} pzs</div>

            <div style={{ background:"var(--surface2)", borderRadius:12, padding:"12px" }}>
              <div style={{ display:"grid", gridTemplateColumns:"70px 1fr 1fr 50px", gap:6, marginBottom:8 }}>
                <div/>
                <div style={{ fontSize:10, color:"var(--muted)", fontWeight:600, textAlign:"center", letterSpacing:1 }}>IZQ</div>
                <div style={{ fontSize:10, color:"var(--muted)", fontWeight:600, textAlign:"center", letterSpacing:1 }}>DER</div>
                <div style={{ fontSize:10, color:"var(--muted)", fontWeight:600, textAlign:"center", letterSpacing:1 }}>TOTAL</div>
              </div>
              <QRow label="SCRAP"     color="#EF4444" field="scrap" />
              <QRow label="FUNDICIÓN" color="#f59e0b" field="fund" />
              <QRow label="PENDIENTE" color="#6B7280" field="pend" />
              <div style={{ display:"grid", gridTemplateColumns:"70px 1fr 1fr 50px", gap:6, alignItems:"center", borderTop:"1px solid var(--border)", paddingTop:6, marginTop:6 }}>
                <div style={{ fontSize:11, color:"#16a34a", fontWeight:700, letterSpacing:1 }}>OK</div>
                <div style={{ fontFamily:"'Bebas Neue'", fontSize:18, color:"#16a34a", textAlign:"center" }}>{okIzq}</div>
                <div style={{ fontFamily:"'Bebas Neue'", fontSize:18, color:"#16a34a", textAlign:"center" }}>{okDer}</div>
                <div style={{ fontFamily:"'Bebas Neue'", fontSize:18, color:"#16a34a", textAlign:"center" }}>{ok}</div>
              </div>
            </div>
          </div>
        );
      })}

      {/* Resumen total de todas las piezas cargadas */}
      {cargas.length > 0 && (() => {
        let total = 0, sc = 0, fun = 0, pend = 0;
        cargas.forEach(c => {
          total += (parseInt(c.izq)||0)+(parseInt(c.der)||0);
          sc    += (parseInt(c.scrapIzq)||0)+(parseInt(c.scrapDer)||0);
          fun   += (parseInt(c.fundIzq)||0)+(parseInt(c.fundDer)||0);
          pend  += (parseInt(c.pendIzq)||0)+(parseInt(c.pendDer)||0);
        });
        const ok = Math.max(0, total - sc - fun - pend);
        return (
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            <div style={{ background:"#fff7ed", borderRadius:10, padding:"10px", border:"1px solid #fed7aa", textAlign:"center" }}>
              <div style={{ fontFamily:"'Bebas Neue'", fontSize:30, color:ORANGE }}>{total}</div>
              <div style={{ fontSize:11, color:"#9a6000", fontWeight:600 }}>TOTAL PRODUCIDO (TODAS LAS PIEZAS)</div>
            </div>
            <div style={{ background:ok>0?"#f0fdf4":"var(--surface2)", borderRadius:10, padding:"10px", border:`1px solid ${ok>0?"#bbf7d0":"var(--border)"}`, textAlign:"center" }}>
              <div style={{ fontFamily:"'Bebas Neue'", fontSize:30, color:ok>0?"#16a34a":"var(--muted)" }}>{ok}</div>
              <div style={{ fontSize:11, color:ok>0?"#166534":"var(--muted)", fontWeight:600 }}>OK TOTAL</div>
            </div>
          </div>
        );
      })()}

      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:ORANGE }}>PIEZAS POR HORA</div>
          <div style={{ fontSize:12, color:"var(--muted)" }}>{TURNOS_CONFIG[turno].label}</div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:`repeat(${Math.min(piezasPorHora.length, 5)},1fr)`, gap:6 }}>
          {piezasPorHora.map((val, i) => {
            const h = (TURNOS_CONFIG[turno].inicio + i) % 24;
            const hSig = (h + 1) % 24;
            return (
              <div key={i} style={{ textAlign:"center" }}>
                <div style={{ fontSize:9, color:"var(--muted)", marginBottom:3 }}>{h}:00-{hSig}:00</div>
                <input type="number" value={val} onChange={e => { const n=[...piezasPorHora]; n[i]=e.target.value; setPiezasPorHora(n); }} placeholder="0"
                  style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:6, padding:"6px 4px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:14, outline:"none", textAlign:"center" }} />
              </div>
            );
          })}
        </div>
        {piezasPorHora.some(v => parseInt(v)>0) && (
          <div style={{ marginTop:14 }}>
            <GraficoPiezas data={piezasPorHora.map(v=>parseInt(v)||0)} horaInicio={TURNOS_CONFIG[turno].inicio} />
          </div>
        )}
      </div>

      {/* Tiempos de parada */}
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:ORANGE, marginBottom:14 }}>MÁQUINA PARADA × HORA/MIN</div>
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {paradas.map((p, i) => (
            <div key={i} style={{ display:"flex", alignItems:"center", gap:10 }}>
              <div style={{ flex:1, fontSize:13, color:"var(--text)" }}>{p.motivo}</div>
              <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                <input type="number" value={p.minutos} onChange={e => { const n=[...paradas]; n[i]={...n[i],minutos:e.target.value}; setParadas(n); }} placeholder="0" min="0"
                  style={{ width:70, background:"var(--surface2)", border:`1px solid ${parseInt(p.minutos)>0?"#EF4444":"var(--border)"}`, borderRadius:8, padding:"7px 8px", color:parseInt(p.minutos)>0?"#EF4444":"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:14, outline:"none", textAlign:"center" }} />
                <span style={{ fontSize:12, color:"var(--muted)" }}>min</span>
              </div>
            </div>
          ))}
        </div>
        {paradas.some(p=>parseInt(p.minutos)>0) && (
          <div style={{ marginTop:10, padding:"8px 12px", background:"#fef2f2", borderRadius:8, display:"flex", justifyContent:"space-between" }}>
            <span style={{ fontSize:13, fontWeight:600, color:"#EF4444" }}>Total parado</span>
            <span style={{ fontFamily:"'Bebas Neue'", fontSize:18, color:"#EF4444" }}>{paradas.reduce((a,p)=>a+(parseInt(p.minutos)||0),0)} min</span>
          </div>
        )}
      </div>

      {/* Observaciones */}
      <textarea value={obs} onChange={e=>setObs(e.target.value)} placeholder="Observaciones adicionales (opcional)..."
        style={{ width:"100%", background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:14, resize:"none", height:80, outline:"none" }} />

      {formErrors.length > 0 && (
        <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:12, padding:"14px 16px" }}>
          <div style={{ fontSize:13, fontWeight:700, color:"#EF4444", marginBottom:6 }}>⚠️ Revisá estos datos antes de guardar:</div>
          {formErrors.map((e, i) => (
            <div key={i} style={{ fontSize:13, color:"#991b1b", padding:"2px 0" }}>· {e}</div>
          ))}
        </div>
      )}

      <button onClick={handleSubmit}
        style={{ width:"100%", background:ORANGE, border:"none", borderRadius:14, padding:"18px", fontFamily:"'Bebas Neue'", fontSize:20, letterSpacing:3, cursor:"pointer", color:"white" }}>
        GUARDAR PRODUCCIÓN
      </button>
    </div>
  );
}

// ── Config del panel de producción ────────────────────────────────
function ProdConfigView({ prodPin, setProdPin, operarios, setOperarios, piezas, setPiezas, motivos, setMotivos, machines, auditLog, addAuditLog }) {
  const [tab, setTab]           = useState("pin");
  const [newPin, setNewPin]     = useState("");
  const [confPin, setConfPin]   = useState("");
  const [msg, setMsg]           = useState(null);
  const [newOpNum, setNewOpNum] = useState("");
  const [newOpPin, setNewOpPin] = useState("");
  const [newPiezaMaq, setNewPiezaMaq] = useState(machines[0]?.name||"");
  const [newPiezaNum, setNewPiezaNum] = useState("");
  const [newPiezaCiclo, setNewPiezaCiclo] = useState("");
  const [newMotivo, setNewMotivo]     = useState("");
  const [editCicloId, setEditCicloId] = useState(null);
  const [editCicloVal, setEditCicloVal] = useState("");
  const [quien, setQuien] = useQuien("sig_quien_prod");

  const handleSavePin = () => {
    if (newPin.length < 4)  { setMsg({ ok:false, text:"Mínimo 4 caracteres" }); return; }
    if (newPin !== confPin) { setMsg({ ok:false, text:"Los PINs no coinciden" }); return; }
    setProdPin(newPin); setNewPin(""); setConfPin("");
    setMsg({ ok:true, text:"✓ PIN actualizado" });
    registrarAuditoria(addAuditLog, "produccion", quien, "Cambió el PIN del panel de Producción");
    setTimeout(() => setMsg(null), 3000);
  };
  const addOperario  = () => {
    if (!newOpNum.trim()||!newOpPin.trim()) return;
    const num = newOpNum.trim();
    setOperarios(p=>[...p,{id:`op${Date.now()}`,numero:num,pin:newOpPin.trim()}]);
    registrarAuditoria(addAuditLog, "produccion", quien, "Agregó un operario", num);
    setNewOpNum(""); setNewOpPin("");
  };
  const remOperario  = (id) => { const o=operarios.find(x=>x.id===id); setOperarios(p=>p.filter(o=>o.id!==id)); registrarAuditoria(addAuditLog, "produccion", quien, "Eliminó un operario", o?.numero||id); };
  const addPieza     = () => {
    if (!newPiezaNum.trim()) return;
    setPiezas(p=>[...p,{id:`pz${Date.now()}`,maquina:newPiezaMaq,numero:newPiezaNum.trim(),tiempoCiclo:parseFloat(newPiezaCiclo)||0}]);
    registrarAuditoria(addAuditLog, "produccion", quien, "Agregó una pieza", `${newPiezaNum.trim()} (${newPiezaMaq})${newPiezaCiclo?` — ciclo ${newPiezaCiclo}s`:""}`);
    setNewPiezaNum(""); setNewPiezaCiclo("");
  };
  const remPieza     = (id) => { const p=piezas.find(x=>x.id===id); setPiezas(prev=>prev.filter(x=>x.id!==id)); registrarAuditoria(addAuditLog, "produccion", quien, "Eliminó una pieza", p?`${p.numero} (${p.maquina})`:id); };
  const startEditCiclo = (p) => { setEditCicloId(p.id); setEditCicloVal(p.tiempoCiclo ? String(p.tiempoCiclo) : ""); };
  const saveEditCiclo  = (id) => {
    const p = piezas.find(x=>x.id===id);
    setPiezas(prev => prev.map(x => x.id===id ? { ...x, tiempoCiclo: parseFloat(editCicloVal)||0 } : x));
    registrarAuditoria(addAuditLog, "produccion", quien, "Editó el tiempo de ciclo de una pieza", `${p?.numero||id}: ${editCicloVal||0}s`);
    setEditCicloId(null); setEditCicloVal("");
  };
  const addMotivo    = () => {
    if (!newMotivo.trim()) return;
    const m = newMotivo.trim();
    setMotivos(p=>[...p,m]); registrarAuditoria(addAuditLog, "produccion", quien, "Agregó un motivo de parada", m); setNewMotivo("");
  };
  const remMotivo    = (idx) => { const m=motivos[idx]; setMotivos(p=>p.filter((_,i)=>i!==idx)); registrarAuditoria(addAuditLog, "produccion", quien, "Eliminó un motivo de parada", m); };

  const configTabs = [
    { key:"pin",       label:"🔑 PIN" },
    { key:"operarios", label:"👷 Operarios" },
    { key:"piezas",    label:"⚙️ Piezas" },
    { key:"motivos",   label:"⏸ Motivos parada" },
  ];

  return (
    <div>
      <div style={{ display:"flex", gap:6, marginBottom:16, flexWrap:"wrap" }}>
        {configTabs.map(({ key, label }) => (
          <button key={key} onClick={() => setTab(key)}
            style={{ background:tab===key?ORANGE:"var(--surface)", border:`1px solid ${tab===key?ORANGE:"var(--border)"}`, borderRadius:10, padding:"10px 14px", color:tab===key?"white":"var(--muted)", fontFamily:"'Bebas Neue'", fontSize:13, letterSpacing:1, cursor:"pointer" }}>
            {label}
          </button>
        ))}
      </div>

      <QuienOperarioInput quien={quien} setQuien={setQuien} operarios={operarios} />

      {/* PIN */}
      {tab==="pin" && (
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.5rem" }}>
          <p style={{ color:"var(--muted)", fontSize:13, marginBottom:20 }}>Cambiá el PIN de acceso al panel de Producción. Mínimo 4 caracteres.</p>
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            <div><label style={{ color:"var(--muted)", fontSize:11, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 }}>Nuevo PIN</label>
              <input type="password" value={newPin} onChange={e=>setNewPin(e.target.value)} placeholder="••••" style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"12px 16px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:18, letterSpacing:6, textAlign:"center", outline:"none" }} /></div>
            <div><label style={{ color:"var(--muted)", fontSize:11, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 }}>Confirmar PIN</label>
              <input type="password" value={confPin} onChange={e=>setConfPin(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleSavePin()} placeholder="••••" style={{ width:"100%", background:"var(--surface2)", border:`1px solid ${msg&&!msg.ok?"#EF4444":"var(--border)"}`, borderRadius:10, padding:"12px 16px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:18, letterSpacing:6, textAlign:"center", outline:"none" }} /></div>
            {msg && <div style={{ textAlign:"center", fontSize:13, color:msg.ok?"#16a34a":"#EF4444", padding:"8px", background:msg.ok?"#f0fdf4":"#FEE2E2", borderRadius:8 }}>{msg.text}</div>}
            <button onClick={handleSavePin} style={{ background:ORANGE, border:"none", borderRadius:10, padding:"13px", fontFamily:"'Bebas Neue'", fontSize:18, letterSpacing:2, cursor:"pointer", color:"white" }}>GUARDAR NUEVO PIN</button>
          </div>
        </div>
      )}

      {/* Operarios */}
      {tab==="operarios" && (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
            <div style={{ fontFamily:"'Bebas Neue'", fontSize:15, letterSpacing:2, color:ORANGE, marginBottom:12 }}>AGREGAR OPERARIO</div>
            <div style={{ display:"flex", gap:8, marginBottom:8 }}>
              <input value={newOpNum} onChange={e=>setNewOpNum(e.target.value)} placeholder="Número (ej: OP 121)" style={{ flex:2, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, outline:"none" }} />
              <input type="password" value={newOpPin} onChange={e=>setNewOpPin(e.target.value)} placeholder="PIN" style={{ flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, letterSpacing:4, outline:"none" }} />
            </div>
            <button onClick={addOperario} style={{ width:"100%", background:ORANGE, border:"none", borderRadius:8, padding:"10px", fontFamily:"'Bebas Neue'", fontSize:15, cursor:"pointer", color:"white", letterSpacing:1 }}>+ AGREGAR OPERARIO</button>
          </div>
          {operarios.map(o => (
            <div key={o.id} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div style={{ display:"flex", gap:12, alignItems:"center" }}>
                <span style={{ fontSize:20 }}>👷</span>
                <div>
                  <div style={{ fontFamily:"'JetBrains Mono'", fontSize:14, fontWeight:600, color:"var(--text)" }}>{o.numero}</div>
                  <div style={{ fontSize:12, color:"var(--muted)" }}>PIN: {"•".repeat(o.pin?.length||4)}</div>
                </div>
              </div>
              <button onClick={() => remOperario(o.id)} style={{ background:"none", border:"1px solid #EF444466", borderRadius:6, padding:"5px 12px", color:"#EF4444", cursor:"pointer", fontSize:12 }}>Eliminar</button>
            </div>
          ))}
        </div>
      )}

      {/* Piezas por máquina */}
      {tab==="piezas" && (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
            <div style={{ fontFamily:"'Bebas Neue'", fontSize:15, letterSpacing:2, color:ORANGE, marginBottom:12 }}>AGREGAR PIEZA</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:10 }}>
              {machines.map(m => <button key={m.id} onClick={() => setNewPiezaMaq(m.name)} style={{ background:newPiezaMaq===m.name?ORANGE:"var(--surface2)", border:`1px solid ${newPiezaMaq===m.name?ORANGE:"var(--border)"}`, borderRadius:8, padding:"7px 14px", color:newPiezaMaq===m.name?"white":"var(--text)", fontFamily:"'DM Sans'", fontSize:13, cursor:"pointer" }}>{m.name}</button>)}
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <input value={newPiezaNum} onChange={e=>setNewPiezaNum(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addPieza()} placeholder="Número de pieza (ej: F09-244/245)" style={{ flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, outline:"none" }} />
              <input type="number" value={newPiezaCiclo} onChange={e=>setNewPiezaCiclo(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addPieza()} placeholder="Ciclo (seg)" style={{ width:110, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, outline:"none", textAlign:"center" }} />
              <button onClick={addPieza} style={{ background:ORANGE, border:"none", borderRadius:8, padding:"10px 18px", fontFamily:"'Bebas Neue'", fontSize:15, cursor:"pointer", color:"white" }}>+ AGREGAR</button>
            </div>
            <div style={{ fontSize:11, color:"var(--muted)", marginTop:6 }}>El tiempo de ciclo (en segundos) se usa para calcular el Rendimiento del OEE.</div>
          </div>
          {machines.map(m => {
            const mp = piezas.filter(p => p.maquina === m.name);
            if (mp.length === 0) return null;
            return (
              <div key={m.id}>
                <div style={{ fontSize:12, color:"var(--muted)", fontWeight:600, letterSpacing:1, textTransform:"uppercase", marginBottom:6 }}>{m.name}</div>
                {mp.map(p => (
                  <div key={p.id} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"10px 14px", display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6, gap:8 }}>
                    <span style={{ fontFamily:"'JetBrains Mono'", fontSize:13, color:"var(--text)" }}>{p.numero}</span>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      {editCicloId === p.id ? (
                        <>
                          <input type="number" autoFocus value={editCicloVal} onChange={e=>setEditCicloVal(e.target.value)} onKeyDown={e=>e.key==="Enter"&&saveEditCiclo(p.id)}
                            style={{ width:80, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:6, padding:"5px 8px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:12, outline:"none", textAlign:"center" }} />
                          <button onClick={() => saveEditCiclo(p.id)} style={{ background:"#16a34a", border:"none", borderRadius:6, padding:"5px 10px", color:"white", cursor:"pointer", fontSize:12 }}>✓</button>
                        </>
                      ) : (
                        <button onClick={() => startEditCiclo(p)} style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:6, padding:"5px 10px", color:p.tiempoCiclo?ORANGE:"var(--muted)", cursor:"pointer", fontSize:12, fontFamily:"'JetBrains Mono'" }}>
                          {p.tiempoCiclo ? `${p.tiempoCiclo}s` : "Sin ciclo"}
                        </button>
                      )}
                      <button onClick={() => remPieza(p.id)} style={{ background:"none", border:"1px solid #EF444466", borderRadius:6, padding:"4px 10px", color:"#EF4444", cursor:"pointer", fontSize:12 }}>Eliminar</button>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* Motivos de parada */}
      {tab==="motivos" && (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem", display:"flex", gap:8 }}>
            <input value={newMotivo} onChange={e=>setNewMotivo(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addMotivo()} placeholder="Nuevo motivo de parada..."
              style={{ flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:14, outline:"none" }} />
            <button onClick={addMotivo} style={{ background:ORANGE, border:"none", borderRadius:8, padding:"10px 18px", fontFamily:"'Bebas Neue'", fontSize:15, cursor:"pointer", color:"white" }}>+ AGREGAR</button>
          </div>
          {motivos.map((m, idx) => (
            <div key={idx} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontSize:14, color:"var(--text)" }}>{m}</span>
              <button onClick={() => remMotivo(idx)} style={{ background:"none", border:"1px solid #EF444466", borderRadius:6, padding:"5px 12px", color:"#EF4444", cursor:"pointer", fontSize:12 }}>Eliminar</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Vista de producción desde el puesto: cargar + ver turnos anteriores ──
function PuestoProduccionView({ addRegistro, operarios, machines, piezas, motivos, defaultMaquina, registros }) {
  const [subTab, setSubTab] = useState("cargar");

  // Últimos 2 turnos de esta máquina
  const turnosOrden = ["Mañana","Tarde","Noche"];
  const ultimos2 = registros
    .filter(r => r.maquina === defaultMaquina)
    .sort((a,b) => {
      if (b.fecha !== a.fecha) return b.fecha.localeCompare(a.fecha);
      return turnosOrden.indexOf(b.turno) - turnosOrden.indexOf(a.turno);
    })
    .slice(0, 2);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      <div style={{ display:"flex", gap:8 }}>
        {[["cargar","➕ CARGAR"],["ver","👁 ÚLTIMOS 2 TURNOS"]].map(([key,lbl]) => (
          <button key={key} onClick={() => setSubTab(key)}
            style={{ flex:1, background:subTab===key?ORANGE:"var(--surface)", border:`1px solid ${subTab===key?ORANGE:"var(--border)"}`, borderRadius:10, padding:"10px 6px", color:subTab===key?"white":"var(--muted)", fontFamily:"'Bebas Neue'", fontSize:13, letterSpacing:1, cursor:"pointer" }}>
            {lbl}
          </button>
        ))}
      </div>

      {subTab==="cargar" && (
        <NuevaCargaView addRegistro={addRegistro} operarios={operarios} machines={machines} piezas={piezas} motivos={motivos} defaultMaquina={defaultMaquina} />
      )}

      {subTab==="ver" && (
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {ultimos2.length === 0
            ? <div style={{ textAlign:"center", color:"var(--muted)", padding:"2.5rem", background:"var(--surface)", borderRadius:16, border:"1px solid var(--border)" }}>
                No hay turnos registrados para esta máquina aún.
              </div>
            : ultimos2.map((r, idx) => (
              <div key={r.id} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, overflow:"hidden" }}>
                {/* Header */}
                <div style={{ background:"#fff7ed", borderBottom:"1px solid #fed7aa", padding:"10px 16px" }}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:6 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                      <span style={{ fontFamily:"'Bebas Neue'", fontSize:15, color:"#0f1f0f" }}>{r.turno}</span>
                      <span style={{ background:"white", borderRadius:999, padding:"2px 8px", fontSize:11, color:ORANGE, fontWeight:600 }}>{r.operario}</span>
                      <span style={{ fontSize:11, color:"var(--muted)" }}>{TURNOS_CONFIG[r.turno]?.label}</span>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      {(() => {
                        const o = calcularOEE(r, piezas);
                        if (o.planificadoMin === 0 || o.sinDatosDeCiclo) return null;
                        const pct = Math.round(o.oee * 100);
                        const color = pct >= 75 ? "#16a34a" : pct >= 50 ? "#f59e0b" : "#EF4444";
                        return <span style={{ background:`${color}22`, border:`1px solid ${color}`, borderRadius:999, padding:"2px 9px", fontSize:11, fontWeight:700, color }}>OEE {pct}%</span>;
                      })()}
                      <span style={{ fontSize:11, color:"#666" }}>{new Date(r.fecha+"T12:00:00").toLocaleDateString("es-AR")}</span>
                    </div>
                  </div>
                  {/* Pieza(s) — siempre visible */}
                  <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", marginTop:8 }}>
                    <span style={{ fontSize:10, color:"#9a6000", fontWeight:700, letterSpacing:1, textTransform:"uppercase" }}>Pieza:</span>
                    {normalizarRegistro(r).piezasCargadas.map((c,i) => (
                      <span key={i} style={{ background:"white", border:"1px solid #fed7aa", borderRadius:6, padding:"2px 9px", fontSize:12, fontFamily:"'JetBrains Mono'", fontWeight:700, color:"#0f1f0f" }}>{c.numero}</span>
                    ))}
                  </div>
                </div>

                {/* Resumen piezas — detalle por pieza */}
                <div style={{ padding:"10px 16px", display:"flex", flexDirection:"column", gap:8 }}>
                  {normalizarRegistro(r).piezasCargadas.map((c,i) => {
                    const producido = (c.izq||0)+(c.der||0);
                    const sc = (c.scrapIzq||0)+(c.scrapDer||0);
                    const fun = (c.fundIzq||0)+(c.fundDer||0);
                    const pend = (c.pendIzq||0)+(c.pendDer||0);
                    const ok = Math.max(0, producido - sc - fun - pend);
                    return (
                      <div key={i} style={{ background:"var(--surface2)", borderRadius:10, padding:"8px 12px" }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                          <span style={{ fontFamily:"'JetBrains Mono'", fontSize:12, fontWeight:700, color:"var(--text)" }}>{c.numero}</span>
                          <span style={{ fontFamily:"'Bebas Neue'", fontSize:18, color:"#1d4ed8" }}>{producido} <span style={{ fontSize:11, color:"var(--muted)" }}>pzs</span></span>
                        </div>
                        <div style={{ display:"flex", gap:10, flexWrap:"wrap", fontSize:11 }}>
                          <span style={{ color:"var(--muted)" }}>Izq {c.izq||0} · Der {c.der||0}</span>
                          {sc>0   && <span style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:6, padding:"2px 8px", color:"#EF4444", fontWeight:600 }}>Scrap {sc}</span>}
                          {fun>0  && <span style={{ background:"#fefce8", border:"1px solid #fde68a", borderRadius:6, padding:"2px 8px", color:"#f59e0b", fontWeight:600 }}>Fund. {fun}</span>}
                          {pend>0 && <span style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:6, padding:"2px 8px", color:"#6B7280", fontWeight:600 }}>Pend. {pend}</span>}
                          <span style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:6, padding:"2px 8px", color:"#16a34a", fontWeight:700 }}>OK {ok}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Gráfico */}
                {r.piezasPorHora && r.piezasPorHora.some(v=>v>0) && (
                  <div style={{ padding:"0 16px 10px" }}>
                    <GraficoPiezas data={r.piezasPorHora} horaInicio={r.horaInicio||6} />
                  </div>
                )}

                {/* Paradas */}
                {r.paradas && r.paradas.some(p=>p.minutos>0) && (
                  <div style={{ margin:"0 16px 12px", padding:"10px 12px", background:"#fef2f2", borderRadius:10, border:"1px solid #fecaca" }}>
                    <div style={{ fontSize:11, color:"#EF4444", fontWeight:600, letterSpacing:1, textTransform:"uppercase", marginBottom:6 }}>⚠️ Paradas registradas</div>
                    {r.paradas.filter(p=>p.minutos>0).map((p,i) => (
                      <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"var(--text)", padding:"3px 0", borderBottom:"1px solid #fecaca" }}>
                        <span>{p.motivo}</span><span style={{ fontWeight:600, color:"#EF4444" }}>{p.minutos} min</span>
                      </div>
                    ))}
                    <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, fontWeight:700, color:"#EF4444", paddingTop:4 }}>
                      <span>Total parado</span>
                      <span>{r.paradas.reduce((a,p)=>a+(p.minutos||0),0)} min</span>
                    </div>
                  </div>
                )}

                {r.obs && <div style={{ margin:"0 16px 12px", padding:"8px 10px", background:"var(--surface2)", borderRadius:8, color:"var(--muted)", fontSize:12 }}>📝 {r.obs}</div>}
              </div>
            ))
          }
        </div>
      )}
    </div>
  );
}
