import { useState, useEffect, useCallback, useRef } from "react";
import { initializeApp }                        from "firebase/app";
import { getDatabase, ref, set, update, get, onValue, off, query, orderByChild, startAt, onChildAdded, onChildChanged, onChildRemoved } from "firebase/database";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";
import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import Calibres from "./calibres/Calibres.jsx";

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
const _auth = getAuth(_app);

// Login anónimo: le da a cada dispositivo una identidad de Firebase sin
// pedirle nada al usuario. Necesario para que las reglas "auth != null"
// no bloqueen la lectura/escritura.
function iniciarAuthAnonima() {
  return new Promise((resolve) => {
    onAuthStateChanged(_auth, (user) => {
      if (user) { resolve(user); return; }
      signInAnonymously(_auth).catch((e) => console.error("Error de autenticación anónima:", e));
    });
  });
}

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

// ── Exportar a Excel ────────────────────────────────────────────────
// hojas: { "Nombre de hoja": [ {col1: val, col2: val}, ... ], ... }
function exportarExcel(nombreArchivo, hojas) {
  try {
    const wb = XLSX.utils.book_new();
    Object.entries(hojas).forEach(([nombreHoja, filas]) => {
      const ws = XLSX.utils.json_to_sheet(filas);
      XLSX.utils.book_append_sheet(wb, ws, nombreHoja.slice(0, 31)); // Excel limita el nombre de hoja a 31 caracteres
    });
    const fecha = new Date().toISOString().slice(0,10);
    XLSX.writeFile(wb, `${nombreArchivo}_${fecha}.xlsx`);
  } catch (e) {
    console.error("Error al exportar a Excel:", e);
    alert("No se pudo generar el Excel. Probá de nuevo.");
  }
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
  const minutosPorHora = cfg ? cfg.duracionMin / cfg.slots : 0;
  const horasExcluidas = (registro.horasExcluidas || []).filter(Boolean).length;
  const planificadoMin = cfg ? Math.max(0, cfg.duracionMin - horasExcluidas * minutosPorHora) : 0;

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


// ── FAQ de fallas por máquina (compartido entre Producción y Mantenimiento) ──
function FaqView({ area, machines, operarios, faqs, addFaq, removeFaq }) {
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
      maquina, titulo: titulo.trim(), descripcion: descripcion.trim(), area,
      createdAt: new Date().toISOString(),
    };
    addFaq(entry);
    setTitulo(""); setDescripcion("");
  };
  const handleRemove = (f) => {
    removeFaq(f.id);
  };

  const filtered = faqs
    .filter(f => filtroMaq === "todas" || f.maquina === filtroMaq)
    .sort((a,b) => (b.createdAt||"").localeCompare(a.createdAt||""));

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
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
                  <div style={{ fontSize:11, color:"var(--muted)", marginTop:2 }}>{f.maquina}</div>
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
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Backup manual (sin depender del plan Blaze) ─────────────────────
// Descarga toda la base de datos como un archivo JSON al dispositivo,
// para tener una copia de seguridad propia sin necesitar Firebase Blaze.
function BackupManual() {
  const [loading, setLoading] = useState(false);

  const handleBackup = async () => {
    setLoading(true);
    try {
      const colecciones = ["pedidos","mantenimientos","prodRegistros","machines","insumos","machineInsumos","tiposFalla","prodOperarios","prodPiezas","prodMotivos","faqs","panolPin","mantPin","prodPin"];
      const data = {};
      for (const c of colecciones) {
        data[c] = await fbGetAll(c);
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const fecha = new Date().toISOString().slice(0,19).replace(/[:T]/g, "-");
      a.href = url; a.download = `SGI_backup_${fecha}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Error al generar backup:", e);
      alert("No se pudo generar el backup. Probá de nuevo.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.5rem" }}>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:ORANGE, marginBottom:10 }}>BACKUP MANUAL</div>
        <div style={{ fontSize:13, color:"var(--muted)", marginBottom:16, lineHeight:1.5 }}>
          Descarga una copia completa de toda la base de datos (pedidos, mantenimientos, producción, configuración y FAQ) en un archivo JSON al celular. Guardalo en un lugar seguro (Google Drive, por ejemplo) como respaldo periódico — se recomienda hacerlo cada semana.
        </div>
        <button onClick={handleBackup} disabled={loading}
          style={{ background: loading ? "var(--surface2)" : ORANGE, border:"none", borderRadius:10, padding:"14px", fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color: loading ? "var(--muted)" : "white", cursor: loading ? "default" : "pointer", width:"100%" }}>
          {loading ? "GENERANDO BACKUP..." : "💾 DESCARGAR BACKUP COMPLETO"}
        </button>
      </div>
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
  const [mantenimientos, setMantenimientos] = useState([]);
  const [mantPin,        setMantPin]        = useState("5678");
  const [tiposFalla,     setTiposFalla]     = useState(DEFAULT_TIPOS);
  const [prodRegistros,  setProdRegistros]  = useState([]);
  const [prodPin,        setProdPin]        = useState("9999");
  const [prodOperarios,  setProdOperarios]  = useState([]);
  const [prodPiezas,     setProdPiezas]     = useState([]);
  const [prodMotivos,    setProdMotivos]    = useState(DEFAULT_MOTIVOS);
  const [faqs,           setFaqs]           = useState([]);
  const [calidadPlantillas, setCalidadPlantillas] = useState([]);
  const [calidadRegistros,  setCalidadRegistros]  = useState([]);
  const [calidadDocumentos, setCalidadDocumentos] = useState([]);
  const [descartes,       setDescartes]       = useState([]);
  const [motivosScrap,      setMotivosScrap]      = useState([]);
  const [motivosPendiente,  setMotivosPendiente]  = useState([]);
  const [motivosFundicion,  setMotivosFundicion]  = useState([]);
  const [cargaCompleta,  setCargaCompleta]  = useState({ pedidos:false, mantenimientos:false, prodRegistros:false });

  useEffect(() => {
    const toArr = v => v ? Object.values(v) : [];
    const unsubs = [];
    let cancelado = false;

    const iniciar = async () => {
      // Esperamos a tener una identidad anónima antes de leer/escribir nada,
      // porque las reglas de Firebase ahora exigen "auth != null".
      await iniciarAuthAnonima();
      if (cancelado) return;

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
      unsubs.push(fbListen("faqs",           v => setFaqs(toArr(v))));
      unsubs.push(fbListen("calidadPlantillas", v => setCalidadPlantillas(toArr(v))));
      unsubs.push(fbListen("calidadDocumentos", v => setCalidadDocumentos(toArr(v))));
      unsubs.push(fbListenIncremental("descartes", v => setDescartes(toArr(v)), "createdAt", dias(60)));
      unsubs.push(fbListen("motivosScrap",     v => setMotivosScrap(toArr(v))));
      unsubs.push(fbListen("motivosPendiente", v => setMotivosPendiente(toArr(v))));
      unsubs.push(fbListen("motivosFundicion", v => setMotivosFundicion(toArr(v))));
      unsubs.push(fbListenIncremental("calidadRegistros", v => setCalidadRegistros(toArr(v)), "createdAt", dias(60)));

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
          // Usuario admin de arranque: si todavía no existe ningún operario
          // marcado como admin, lo creamos para poder entrar por primera vez
          // y dar de alta operarios con sus accesos por área.
          const opSnap = await get(ref(_db, "prodOperarios"));
          const opVal = opSnap.exists() ? opSnap.val() : {};
          const yaHayAdmin = Object.values(opVal).some(o => o.isAdmin);
          if (!yaHayAdmin) {
            await fbSet("prodOperarios/op_admin", { id:"op_admin", numero:"admin", pin:"1234", isAdmin:true, panol:false, mantenimiento:false, produccion:false, operador:false });
          }
        } catch(e) {
          console.error("Firebase seed error:", e);
        } finally {
          setReady(true);
        }
      };
      doSeed();
    };

    iniciar();
    return () => { cancelado = true; unsubs.forEach(fn => fn()); };
  }, []);

  const addPedido         = useCallback((p) => fbSet(`pedidos/${p.id}`, p), []);
  const updatePedido      = useCallback((id, ch) => { fbUpdate(`pedidos/${id}`, ch); }, []);
  const addMantenimiento  = useCallback((m) => fbSet(`mantenimientos/${m.id}`, m), []);
  const updateMantenimiento = useCallback((id, ch) => { fbUpdate(`mantenimientos/${id}`, ch); }, []);
  const addProdRegistro   = useCallback((r) => fbSet(`prodRegistros/${r.id}`, r), []);
  const addFaq            = useCallback((f) => fbSet(`faqs/${f.id}`, f), []);
  const removeFaq         = useCallback((id) => fbSet(`faqs/${id}`, null), []);
  const addCalidadPlantilla    = useCallback((p) => fbSet(`calidadPlantillas/${p.id}`, p), []);
  const removeCalidadPlantilla = useCallback((id) => fbSet(`calidadPlantillas/${id}`, null), []);
  const addCalidadDocumento    = useCallback((d) => fbSet(`calidadDocumentos/${d.id}`, d), []);
  const removeCalidadDocumento = useCallback((id) => fbSet(`calidadDocumentos/${id}`, null), []);
  const setCalidadRegistro     = useCallback((r) => fbSet(`calidadRegistros/${r.id}`, r), []);
  const updateCalidadRegistro  = useCallback((id, ch) => { fbUpdate(`calidadRegistros/${id}`, ch); }, []);

  // Trae la colección completa una sola vez (no deja listener abierto) y la
  // mezcla con lo que ya está cargado por la ventana reciente. Se usa cuando
  // un panel pide ver más historial del que se sincroniza por defecto.
  const cargarHistorialCompleto = useCallback(async (coleccion) => {
    const setters = {
      pedidos: setPedidos, mantenimientos: setMantenimientos,
      prodRegistros: setProdRegistros,
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
  const handleSetMotivosScrap = useCallback((upd) => {
    setMotivosScrap(prev => { const next = typeof upd==="function"?upd(prev):upd; const obj={}; next.forEach((m,i)=>{obj[`mv${i}`]=m;}); fbSet("motivosScrap",obj); return next; });
  }, []);
  const handleSetMotivosPendiente = useCallback((upd) => {
    setMotivosPendiente(prev => { const next = typeof upd==="function"?upd(prev):upd; const obj={}; next.forEach((m,i)=>{obj[`mv${i}`]=m;}); fbSet("motivosPendiente",obj); return next; });
  }, []);
  const handleSetMotivosFundicion = useCallback((upd) => {
    setMotivosFundicion(prev => { const next = typeof upd==="function"?upd(prev):upd; const obj={}; next.forEach((m,i)=>{obj[`mv${i}`]=m;}); fbSet("motivosFundicion",obj); return next; });
  }, []);
  const addDescarte = useCallback((d) => fbSet(`descartes/${d.id}`, d), []);
  const updateDescarte = useCallback((id, ch) => { fbUpdate(`descartes/${id}`, ch); }, []);
  const removeDescarte = useCallback((id) => fbSet(`descartes/${id}`, null), []);

  if (!ready) return (
    <div style={{ minHeight:"100vh", background:"#f0f4f1", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16 }}>
      <style>{FONTS}</style>
      <div style={{ fontFamily:"'Bebas Neue'", fontSize:28, color:"#16a34a", letterSpacing:2, textAlign:"center" }}>SISTEMA DE GESTIÓN INTERNA</div>
      <div style={{ fontFamily:"'DM Sans'", color:"#6b8f72", fontSize:14, letterSpacing:1 }}>Conectando con el servidor...</div>
    </div>
  );

  return (
    <>
      <style>{FONTS}</style>
      <style>{CSS}</style>
      {view==="home"          && <HomeView          setView={setView} setSelMachine={setSelMachine} machines={machines} pedidos={pedidos} mantenimientos={mantenimientos} calidadRegistros={calidadRegistros} />}
      {view==="puesto"        && <PuestoView        machineName={selMachine} machines={machines} insumos={insumos} machineInsumos={machineInsumos} addPedido={addPedido} pedidos={pedidos} addMantenimiento={addMantenimiento} addRegistro={addProdRegistro} registros={prodRegistros} setView={setView} tiposFalla={tiposFalla} operarios={prodOperarios} piezas={prodPiezas} motivos={prodMotivos} faqs={faqs} calidadPlantillas={calidadPlantillas} calidadRegistros={calidadRegistros} setCalidadRegistro={setCalidadRegistro} calidadDocumentos={calidadDocumentos} addDescarte={addDescarte} updateDescarte={updateDescarte} removeDescarte={removeDescarte} descartes={descartes} motivosScrap={motivosScrap} motivosPendiente={motivosPendiente} motivosFundicion={motivosFundicion} />}
      {view==="calidad"       && <CalidadView       setView={setView} operarios={prodOperarios} setOperarios={handleSetProdOperarios} plantillas={calidadPlantillas} addPlantilla={addCalidadPlantilla} removePlantilla={removeCalidadPlantilla} registros={calidadRegistros} updateRegistro={updateCalidadRegistro} documentos={calidadDocumentos} addDocumento={addCalidadDocumento} removeDocumento={removeCalidadDocumento} descartes={descartes} machines={machines} piezas={prodPiezas} />}
      {view==="panol"         && <PanolView         pedidos={pedidos} updatePedido={updatePedido} setView={setView} panolPin={panolPin} setPanolPin={handleSetPanolPin} machines={machines} setMachines={handleSetMachines} insumos={insumos} setInsumos={handleSetInsumos} machineInsumos={machineInsumos} setMachineInsumos={handleSetMachineInsumos} operarios={prodOperarios} setOperarios={handleSetProdOperarios} cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
      {view==="mantenimiento" && <MantenimientoView mantenimientos={mantenimientos} updateMantenimiento={updateMantenimiento} setView={setView} mantPin={mantPin} setMantPin={handleSetMantPin} tiposFalla={tiposFalla} setTiposFalla={handleSetTiposFalla} machines={machines} operarios={prodOperarios} setOperarios={handleSetProdOperarios} faqs={faqs} addFaq={addFaq} removeFaq={removeFaq} cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
      {view==="produccion"    && <ProduccionView    registros={prodRegistros} addRegistro={addProdRegistro} setView={setView} prodPin={prodPin} setProdPin={handleSetProdPin} operarios={prodOperarios} setOperarios={handleSetProdOperarios} piezas={prodPiezas} setPiezas={handleSetProdPiezas} motivos={prodMotivos} setMotivos={handleSetProdMotivos} machines={machines} faqs={faqs} addFaq={addFaq} removeFaq={removeFaq} cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} descartes={descartes} motivosScrap={motivosScrap} setMotivosScrap={handleSetMotivosScrap} motivosPendiente={motivosPendiente} setMotivosPendiente={handleSetMotivosPendiente} motivosFundicion={motivosFundicion} setMotivosFundicion={handleSetMotivosFundicion} />}
    </>
  );
}

function HomeView({ setView, setSelMachine, machines, pedidos, mantenimientos, calidadRegistros }) {
  const [qMaquina, setQMaquina] = useState("");
  const pendingPanol = pedidos.filter(p => p.status === "pendiente").length;
  const pendingMant  = mantenimientos.filter(m => m.status === "pendiente").length;
  const pendingCalidad = (calidadRegistros||[]).filter(r => r.estado === "enviado" && !r.revisado).length;
  const maquinasFiltradas = machines.filter(m => !qMaquina.trim() || m.name.toLowerCase().includes(qMaquina.toLowerCase()));
  return (
    <div style={{ minHeight:"100vh", background:"var(--page-bg)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"2rem" }}>
      <div style={{ maxWidth:460, width:"100%" }}>
        <div style={{ textAlign:"center", marginBottom:"2.5rem" }}>
          <div style={{ display:"inline-flex", alignItems:"center", gap:14, marginBottom:10 }}>
            <div style={{ textAlign:"left" }}>
              <div style={{ fontFamily:"'Bebas Neue'", fontSize:28, color:"var(--green)", letterSpacing:2, lineHeight:1.1 }}>SISTEMA DE GESTIÓN INTERNA</div>
            </div>
          </div>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.5rem" }}>
            <p style={{ color:"var(--muted)", fontSize:12, textTransform:"uppercase", letterSpacing:2, marginBottom:14, fontWeight:600 }}>Puesto de trabajo</p>
            {machines.length > 5 && (
              <input value={qMaquina} onChange={e=>setQMaquina(e.target.value)} placeholder="🔍 Buscar máquina..."
                style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"10px 14px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:14, outline:"none", marginBottom:10 }} />
            )}
            <div style={{ display:"flex", flexDirection:"column", gap:8, maxHeight:machines.length>6?320:"none", overflowY:machines.length>6?"auto":"visible" }}>
              {maquinasFiltradas.map(m => (
                <button key={m.id} onClick={() => { setSelMachine(m.name); setView("puesto"); }}
                  style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"13px 16px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:15, fontWeight:500, cursor:"pointer", textAlign:"left", transition:"all 0.2s" }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor="var(--green)"; e.currentTarget.style.background="var(--green-bg)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor="var(--border)"; e.currentTarget.style.background="var(--surface2)"; }}>
                  🔧 {m.name}
                </button>
              ))}
              {maquinasFiltradas.length===0 && <div style={{ textAlign:"center", color:"var(--muted)", padding:"1rem", fontSize:13 }}>No se encontraron máquinas.</div>}
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
          <button onClick={() => setView("calidad")}
            style={{ background:"#7C3AED", border:"none", borderRadius:16, padding:"1.1rem 1.5rem", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"space-between", transition:"opacity 0.2s" }}
            onMouseEnter={e=>e.currentTarget.style.opacity="0.9"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
            <div style={{ textAlign:"left" }}>
              <div style={{ fontFamily:"'Bebas Neue'", fontSize:20, letterSpacing:2, color:"white" }}>CALIDAD</div>
              <div style={{ fontSize:12, color:"rgba(255,255,255,0.75)", marginTop:2 }}>Planillas de control por pieza</div>
            </div>
            {pendingCalidad > 0 ? <div style={{ background:"#EF4444", color:"white", borderRadius:999, width:28, height:28, display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:700 }}>{pendingCalidad}</div> : <span style={{ fontSize:28 }}>🧪</span>}
          </button>
        </div>
        <div style={{ textAlign:"center", marginTop:24, color:"var(--muted)", fontSize:12 }}>Sistema de Gestión Interna</div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// PUESTO
// ════════════════════════════════════════════════════════════════════
// ── Calidad: llenado de planilla de control por el operario en la máquina ──
// El operario elige una pieza, elige la planilla (puede haber más de una por
// pieza), y va agregando una fila por cada pieza física que mide, hasta
// enviarla a Calidad. Autoguarda el avance para no perder nada si se corta.
// Evalúa una medida (numérica con tolerancia, o Tapón P-NP) contra su campo.
// Se usa igual en la carga del operario, en lo recibido por Calidad y en las estadísticas.
// Determina si una medida corresponde controlarla en una posición dada
// (1° pieza cargada, 2°, 3°...). Las plantillas nuevas tienen un flag "todas"
// explícito (checkbox), o si no, una lista de posiciones exactas (ej: [1,3,6,9] —
// el "1" ahí es la pieza 1 literal, no un caso especial). Las plantillas viejas
// que todavía tengan "frecuencia" (cada N piezas) siguen funcionando igual.
// ── Mini gráfico de variación de una medida a lo largo de la tanda ────────
// Solo tiene sentido para medidas numéricas que se controlan en todas las
// piezas. SVG puro, sin librerías, para no sumarle peso a la app.
// Cpk de una medida: qué tan centrado y consistente está el proceso respecto
// a la tolerancia. Solo tiene sentido para cotas críticas con varios datos.
function calcularCpk(campo, filas) {
  const valores = filas.map(f => parseFloat(f.valores[campo.id])).filter(v => !isNaN(v));
  if (valores.length < 2) return null;
  const media = valores.reduce((a,v)=>a+v,0) / valores.length;
  const varianza = valores.reduce((a,v)=>a+Math.pow(v-media,2),0) / (valores.length-1);
  const sigma = Math.sqrt(varianza);
  if (sigma === 0) return { cpk: Infinity, media, sigma, n: valores.length };
  const cpu = (campo.tolMax - media) / (3*sigma);
  const cpl = (media - campo.tolMin) / (3*sigma);
  return { cpk: Math.min(cpu, cpl), media, sigma, n: valores.length };
}

// Cpk histórico: junta las piezas de TODAS las planillas enviadas (y la que
// está en curso) para esta plantilla, no solo el turno actual — así no se
// reinicia cada vez que se envía una planilla nueva. Si se pasa "maquina",
// filtra solo lo cargado en esa máquina (para no mezclar el desempeño de
// varias máquinas distintas en un mismo número).
function calcularCpkHistorico(campo, plantillaId, registros, maquina) {
  const filas = registros
    .filter(r => r.plantillaId === plantillaId && (!maquina || r.maquina === maquina))
    .flatMap(r => r.filas || []);
  return calcularCpk(campo, filas);
}

function MedidaChart({ campo, filas }) {
  const puntos = filas
    .map((f,i) => ({ pos:i+1, val: parseFloat(f.valores[campo.id]) }))
    .filter(p => !isNaN(p.val));
  if (puntos.length < 2) return null;

  const w = 100, h = 24, padY = 3;
  const valores = puntos.map(p=>p.val);
  const minV = Math.min(...valores, campo.tolMin);
  const maxV = Math.max(...valores, campo.tolMax);
  const rango = (maxV - minV) || 1;
  const x = (i) => (i/(puntos.length-1)) * w;
  const y = (v) => h - padY - ((v-minV)/rango) * (h - 2*padY);
  const path = puntos.map((p,i) => `${i===0?"M":"L"} ${x(i).toFixed(1)} ${y(p.val).toFixed(1)}`).join(" ");
  const yMin = y(campo.tolMin), yMax = y(campo.tolMax);

  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display:"block" }}>
      <rect x={0} y={Math.min(yMin,yMax)} width={w} height={Math.abs(yMax-yMin)} fill="#16a34a" opacity={0.10} />
      <path d={path} fill="none" stroke="#7C3AED" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {puntos.map((p,i) => (
        <circle key={i} cx={x(i)} cy={y(p.val)} r={1.6} fill={p.val>=campo.tolMin && p.val<=campo.tolMax ? "#16a34a" : "#EF4444"} />
      ))}
    </svg>
  );
}

function aplicaEnPosicion(campo, posicion) {
  if (campo.todas) return true;
  if (campo.posiciones && campo.posiciones.length) return campo.posiciones.includes(posicion);
  return (posicion - 1) % (campo.frecuencia || 1) === 0;
}

function evaluarMedida(campo, val) {
  if (campo.tipo === "tapon") {
    const tieneValor = val === "OK" || val === "NOK";
    return { tieneValor, dentro: val==="OK", fuera: val==="NOK" };
  }
  const num = parseFloat(val);
  const tieneValor = val !== "" && val != null && !isNaN(num);
  const dentro = tieneValor && num >= campo.tolMin && num <= campo.tolMax;
  return { tieneValor, dentro, fuera: tieneValor && !dentro };
}

function CalidadOperarioView({ plantillas, registros, setRegistro, operario, maquina }) {
  const [q, setQ]                 = useState("");
  const [piezaSel, setPiezaSel]   = useState("");
  const [abiertas, setAbiertas]   = useState([]); // ids de plantillas abiertas como columnas
  const [pickerOpen, setPickerOpen] = useState(true);

  const piezas = [...new Set(plantillas.map(p => p.piezaCodigo))].sort();
  const piezasFiltradas = piezas.filter(p => !q.trim() || p.toLowerCase().includes(q.toLowerCase()));
  const plantillasDePieza = plantillas.filter(p => p.piezaCodigo === piezaSel);

  const abrirPlantilla = (pl) => {
    setAbiertas(prev => prev.includes(pl.id) ? prev : [...prev, pl.id]);
    setPickerOpen(false); setPiezaSel(""); setQ("");
  };
  const cerrarColumna = (id) => setAbiertas(prev => prev.filter(x=>x!==id));

  const columnas = abiertas.map(id => plantillas.find(p=>p.id===id)).filter(Boolean);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      {columnas.length > 0 && !pickerOpen && (
        <button onClick={()=>setPickerOpen(true)} style={{ alignSelf:"flex-start", background:"var(--surface2)", border:"1px dashed var(--border)", borderRadius:10, padding:"9px 14px", color:"var(--text)", cursor:"pointer", fontSize:13, fontWeight:600 }}>+ Abrir otra planilla</button>
      )}

      {pickerOpen && (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          <input value={q} onChange={e=>{ setQ(e.target.value); setPiezaSel(""); }} placeholder="Buscar pieza por código..."
            style={{ width:"100%", background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"12px 14px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:15, outline:"none" }} />

          {!piezaSel && (
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {piezasFiltradas.map(p => (
                <button key={p} onClick={()=>setPiezaSel(p)}
                  style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"13px 16px", textAlign:"left", cursor:"pointer", fontFamily:"'JetBrains Mono'", fontSize:15, color:"var(--text)", fontWeight:600 }}>
                  {p}
                </button>
              ))}
              {piezasFiltradas.length===0 && <div style={{ textAlign:"center", color:"var(--muted)", padding:"1.5rem" }}>No se encontraron piezas con planillas de control.</div>}
            </div>
          )}

          {piezaSel && (
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              <button onClick={()=>{ setPiezaSel(""); }} style={{ alignSelf:"flex-start", background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"7px 12px", color:"var(--muted)", cursor:"pointer", fontSize:12 }}>← Elegir otra pieza</button>
              {plantillasDePieza.map(pl => {
                const activo = registros.find(r => r.plantillaId === pl.id && r.maquina === maquina && r.operario === operario?.numero && r.estado === "en_progreso");
                const yaAbierta = abiertas.includes(pl.id);
                return (
                  <button key={pl.id} onClick={()=>abrirPlantilla(pl)}
                    style={{ background:"var(--surface)", border:`1px solid ${yaAbierta?"#7C3AED":"var(--border)"}`, borderRadius:14, padding:"16px", textAlign:"left", cursor:"pointer" }}>
                    <div style={{ fontFamily:"'Bebas Neue'", fontSize:17, color:"#7C3AED", letterSpacing:1 }}>{pl.nombre}</div>
                    <div style={{ fontSize:12, color:"var(--muted)", marginTop:3 }}>{pl.campos.length} medida{pl.campos.length>1?"s":""} a controlar</div>
                    {activo && <div style={{ fontSize:12, color:"#16a34a", marginTop:4, fontWeight:600 }}>▶ Tenés un avance guardado ({activo.filas?.length||0} pieza{activo.filas?.length===1?"":"s"} cargada{activo.filas?.length===1?"":"s"})</div>}
                    {yaAbierta && <div style={{ fontSize:12, color:"#7C3AED", marginTop:4, fontWeight:600 }}>✓ Ya está abierta abajo</div>}
                  </button>
                );
              })}
              {plantillasDePieza.length===0 && (
                <div style={{ textAlign:"center", color:"var(--muted)", padding:"1.5rem", background:"var(--surface)", borderRadius:16, border:"1px solid var(--border)" }}>Esta pieza no tiene planillas de control cargadas.</div>
              )}
            </div>
          )}
          {columnas.length > 0 && (
            <button onClick={()=>setPickerOpen(false)} style={{ alignSelf:"flex-start", background:"none", border:"none", color:"var(--muted)", cursor:"pointer", fontSize:12, textDecoration:"underline" }}>Cerrar buscador</button>
          )}
        </div>
      )}

      {columnas.length > 0 && (
        <>
          {columnas.length > 1 && <div style={{ fontSize:11, color:"var(--muted)" }}>Deslizá hacia los costados para ver las demás planillas abiertas →</div>}
          <div style={{ display:"flex", gap:14, overflowX:"auto", paddingBottom:6 }}>
            {columnas.map(pl => (
              <CalidadColumna key={pl.id} plantilla={pl} registros={registros} setRegistro={setRegistro} operario={operario} maquina={maquina} onCerrar={()=>cerrarColumna(pl.id)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Una planilla abierta en su propia columna vertical: el operario puede
// tener varias abiertas a la vez, una al lado de la otra. El avance de cada
// una queda atado a plantilla+máquina+operario, así si otro operario entra
// después no ve (ni pisa) lo que dejó cargado el anterior.
function CalidadColumna({ plantilla, registros, setRegistro, operario, maquina, onCerrar }) {
  const registroActivo = registros.find(r => r.plantillaId === plantilla.id && r.maquina === maquina && r.operario === operario?.numero && r.estado === "en_progreso");
  const filas = registroActivo?.filas || [];
  const numeroInicial = registroActivo?.numeroInicial || "";
  const numeroFinal   = registroActivo?.numeroFinal || "";
  const [abiertaIdx, setAbiertaIdx] = useState(null);
  const [buscar, setBuscar]         = useState("");

  const guardar = (cambios) => {
    const base = registroActivo || {
      id: `CAL${Date.now()}`, plantillaId: plantilla.id, piezaCodigo: plantilla.piezaCodigo,
      plantillaNombre: plantilla.nombre, maquina, operario: operario?.numero || "—",
      estado: "en_progreso", filas: [], createdAt: new Date().toISOString(),
    };
    setRegistro({ ...base, ...cambios, updatedAt: new Date().toISOString() });
  };

  const setNumeroInicial = (val) => guardar({ numeroInicial: val });
  const setNumeroFinal   = (val) => guardar({ numeroFinal: val });

  const agregarFila = () => {
    if (!numeroInicial) return;
    const vacio = {}; plantilla.campos.forEach(c => vacio[c.id] = c.tipo==="tapon" ? "" : (c.nominal!=="" && c.nominal!=null ? String(c.nominal) : ""));
    const nums = filas.map(f=>parseInt(f.numeroPieza)).filter(n=>!isNaN(n));
    const siguiente = nums.length ? Math.max(...nums)+1 : parseInt(numeroInicial);
    guardar({ filas: [...filas, { numeroPieza: String(siguiente), valores: vacio, comentario: "" }] });
    setAbiertaIdx(filas.length); // la recién agregada queda abierta; las demás se minimizan
  };
  const setValor = (idxFila, campoId, val) => {
    guardar({ filas: filas.map((f,i) => i===idxFila ? { ...f, valores:{ ...f.valores, [campoId]:val } } : f) });
  };
  const setComentario = (idxFila, val) => {
    guardar({ filas: filas.map((f,i) => i===idxFila ? { ...f, comentario:val } : f) });
  };
  const quitarFila = (idxFila) => { guardar({ filas: filas.filter((_,i)=>i!==idxFila) }); setAbiertaIdx(null); };

  const puedeEnviar = filas.length>0 && !!numeroInicial && !!numeroFinal;
  const enviar = () => {
    if (!registroActivo || !puedeEnviar) return;
    setRegistro({ ...registroActivo, estado:"enviado", enviadoAt:new Date().toISOString() });
    onCerrar();
  };

  const buscarIdx = buscar.trim() ? filas.findIndex(f => String(f.numeroPieza) === buscar.trim()) : -1;

  // Medidas numéricas controladas al 100% de las piezas: acá sí tiene sentido
  // mostrar un mini gráfico de variación a lo largo de la tanda.
  const camposConGrafico = plantilla.campos.filter(c => c.tipo==="numero" && c.critica);

  const inputBase = { width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:14, fontWeight:700, outline:"none" };

  return (
    <div style={{ flex:"0 0 340px", width:340, display:"flex", flexDirection:"column", gap:10 }}>
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:14, padding:"12px 14px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, color:"#7C3AED", letterSpacing:1 }}>{plantilla.nombre}</div>
          <div style={{ fontSize:11, color:"var(--muted)" }}>{plantilla.piezaCodigo}</div>
        </div>
        <button onClick={onCerrar} style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"5px 10px", color:"var(--muted)", cursor:"pointer", fontSize:12 }}>✕</button>
      </div>

      <div style={{ background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:12, padding:"12px 14px" }}>
        <label style={{ fontSize:11, color:"#9a6000", fontWeight:700, display:"block", marginBottom:4 }}>N° de pieza inicial (al arrancar el turno)</label>
        <input value={numeroInicial} onChange={e=>setNumeroInicial(e.target.value)} placeholder="ej: 540" inputMode="numeric" disabled={filas.length>0}
          style={{ width:"100%", background: filas.length>0 ? "var(--surface2)" : "white", border:"1px solid #fed7aa", borderRadius:8, padding:"10px 12px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:15, fontWeight:700, outline:"none" }} />
        {!numeroInicial && <div style={{ fontSize:11, color:"#9a6000", marginTop:4 }}>Completá esto antes de agregar piezas.</div>}
      </div>

      {camposConGrafico.length > 0 && filas.length >= 2 && (
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"10px 12px", display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ fontSize:10, color:"var(--muted)", fontWeight:700, textTransform:"uppercase", letterSpacing:1 }}>Variación en este turno · Cpk histórico de esta máquina (cotas críticas)</div>
          {camposConGrafico.map(c => {
            const cpkInfo = calcularCpkHistorico(c, plantilla.id, registros, maquina);
            return (
              <div key={c.id}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:2 }}>
                  <span style={{ fontSize:11, color:"var(--text)" }}>{c.label}</span>
                  {cpkInfo && (
                    <span style={{ fontSize:11, fontWeight:700, color: cpkInfo.cpk===Infinity ? "#16a34a" : cpkInfo.cpk>=1.33 ? "#16a34a" : cpkInfo.cpk>=1 ? "#f59e0b" : "#EF4444" }}>
                      Cpk {cpkInfo.cpk===Infinity ? "∞" : cpkInfo.cpk.toFixed(2)}
                    </span>
                  )}
                </div>
                <MedidaChart campo={c} filas={filas} />
              </div>
            );
          })}
        </div>
      )}

      {filas.length > 2 && (
        <input value={buscar} onChange={e=>setBuscar(e.target.value)} placeholder="🔍 Buscar N° de pieza para editar..." inputMode="numeric"
          style={{ background:"var(--surface)", border:`1px solid ${buscar.trim() && buscarIdx===-1 ? "#EF4444" : "var(--border)"}`, borderRadius:10, padding:"10px 12px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, outline:"none" }} />
      )}
      {buscar.trim() && buscarIdx===-1 && <div style={{ fontSize:11, color:"#EF4444" }}>No se encontró esa pieza en esta planilla.</div>}
      {buscar.trim() && buscarIdx!==-1 && abiertaIdx!==buscarIdx && (
        <button onClick={()=>{ setAbiertaIdx(buscarIdx); setBuscar(""); }} style={{ background:"#EDE9FE", border:"1px solid #7C3AED66", borderRadius:10, padding:"10px 12px", color:"#7C3AED", cursor:"pointer", fontSize:13, fontWeight:600, textAlign:"left" }}>
          Abrir pieza N° {filas[buscarIdx].numeroPieza} para editar →
        </button>
      )}

      {filas.map((fila, idx) => {
        const abierta = abiertaIdx === idx;
        const camposAplicables = plantilla.campos.filter(c => aplicaEnPosicion(c, idx+1));
        const algunaFuera = camposAplicables.some(c => evaluarMedida(c, fila.valores[c.id]).fuera);
        const todasCargadas = camposAplicables.length>0 && camposAplicables.every(c => evaluarMedida(c, fila.valores[c.id]).tieneValor);

        if (!abierta) {
          return (
            <button key={idx} onClick={()=>setAbiertaIdx(idx)}
              style={{ background:"var(--surface)", border:`1px solid ${algunaFuera?"#EF444466":"var(--border)"}`, borderRadius:12, padding:"10px 14px", display:"flex", justifyContent:"space-between", alignItems:"center", cursor:"pointer", textAlign:"left" }}>
              <span style={{ fontFamily:"'Bebas Neue'", fontSize:14, color:"var(--text)", letterSpacing:1 }}>PIEZA N° {fila.numeroPieza}</span>
              <span style={{ display:"flex", alignItems:"center", gap:6 }}>
                {algunaFuera && <span style={{ fontSize:11, color:"#EF4444", fontWeight:700 }}>⚠</span>}
                {!algunaFuera && todasCargadas && <span style={{ fontSize:11, color:"#16a34a", fontWeight:700 }}>✓</span>}
                <span style={{ color:"var(--muted)", fontSize:13 }}>▾</span>
              </span>
            </button>
          );
        }

        return (
          <div key={idx} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:14, padding:"14px 16px", display:"flex", flexDirection:"column", gap:10 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:10 }}>
              <button onClick={()=>setAbiertaIdx(null)} style={{ background:"none", border:"none", padding:0, cursor:"pointer", display:"flex", alignItems:"center", gap:6 }}>
                <span style={{ fontFamily:"'Bebas Neue'", fontSize:16, color:"var(--text)", letterSpacing:1 }}>PIEZA N° {fila.numeroPieza}</span>
                <span style={{ color:"var(--muted)", fontSize:13 }}>▴ minimizar</span>
              </button>
              <button onClick={()=>quitarFila(idx)} style={{ background:"none", border:"none", color:"#EF4444", cursor:"pointer", fontSize:12, flexShrink:0 }}>Quitar</button>
            </div>
            {camposAplicables.map(campo => {
              const val = fila.valores[campo.id];
              const { dentro, fuera } = evaluarMedida(campo, val);
              return (
                <div key={campo.id}>
                  <label style={{ fontSize:11, color:"var(--muted)", display:"block", marginBottom:4 }}>
                    {campo.label} {campo.tipo!=="tapon" && <span style={{ color:"#9AA7AE" }}>· nom. {campo.nominal!==""?campo.nominal:"—"} · [{campo.tolMin} a {campo.tolMax}]</span>}
                  </label>
                  {campo.tipo === "tapon" ? (
                    <div style={{ display:"flex", gap:8 }}>
                      <button onClick={()=>setValor(idx, campo.id, "OK")}
                        style={{ flex:1, padding:"10px", borderRadius:8, border:`2px solid ${val==="OK"?"#16a34a":"var(--border)"}`, background: val==="OK"?"#16a34a":"var(--surface2)", color: val==="OK"?"white":"var(--muted)", fontWeight:700, fontSize:13, cursor:"pointer" }}>OK</button>
                      <button onClick={()=>setValor(idx, campo.id, "NOK")}
                        style={{ flex:1, padding:"10px", borderRadius:8, border:`2px solid ${val==="NOK"?"#EF4444":"var(--border)"}`, background: val==="NOK"?"#EF4444":"var(--surface2)", color: val==="NOK"?"white":"var(--muted)", fontWeight:700, fontSize:13, cursor:"pointer" }}>NO OK</button>
                    </div>
                  ) : (
                    <input value={val ?? ""} onChange={e=>setValor(idx, campo.id, e.target.value)} inputMode="decimal"
                      style={{ ...inputBase, textAlign:"left",
                        background: dentro ? "#E7F5EF" : fuera ? "#FEF2F2" : "var(--surface2)",
                        border:`2px solid ${dentro ? "#16a34a" : fuera ? "#EF4444" : "var(--border)"}`,
                        color: dentro ? "#166534" : fuera ? "#B91C1C" : "var(--text)" }} />
                  )}
                </div>
              );
            })}
            <div>
              <label style={{ fontSize:11, color:"var(--muted)", display:"block", marginBottom:4 }}>Comentario</label>
              <input value={fila.comentario||""} onChange={e=>setComentario(idx, e.target.value)} placeholder="Observación (opcional)"
                style={{ ...inputBase, fontFamily:"'DM Sans'", fontWeight:400, fontSize:13 }} />
            </div>
          </div>
        );
      })}

      {filas.length===0 && (
        <div style={{ textAlign:"center", color:"var(--muted)", padding:"1.25rem", background:"var(--surface)", borderRadius:14, border:"1px solid var(--border)", fontSize:13 }}>Todavía no cargaste ninguna pieza.</div>
      )}

      <button onClick={agregarFila} disabled={!numeroInicial}
        style={{ background:"var(--surface2)", border:"1px dashed var(--border)", borderRadius:12, padding:"14px", color: !numeroInicial ? "var(--muted)" : "var(--text)", fontFamily:"'Bebas Neue'", fontSize:15, letterSpacing:1, cursor: !numeroInicial ? "not-allowed" : "pointer" }}>+ AGREGAR PIEZA</button>

      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 14px" }}>
        <label style={{ fontSize:11, color:"var(--muted)", fontWeight:700, display:"block", marginBottom:4 }}>N° de pieza final (al terminar el turno)</label>
        <input value={numeroFinal} onChange={e=>setNumeroFinal(e.target.value)} placeholder="ej: 612" inputMode="numeric"
          style={inputBase} />
      </div>

      {!puedeEnviar && filas.length>0 && (
        <div style={{ fontSize:11.5, color:"#B91C1C", textAlign:"center" }}>Completá el N° de pieza final para poder enviar.</div>
      )}
      <button onClick={enviar} disabled={!puedeEnviar}
        style={{ background: !puedeEnviar ? "var(--surface2)" : "#7C3AED", border:"none", borderRadius:14, padding:"16px", fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:1, color: !puedeEnviar ? "var(--muted)" : "white", cursor: !puedeEnviar ? "not-allowed" : "pointer" }}>
        ENVIAR {filas.length>0 ? `(${filas.length})` : ""}
      </button>
    </div>
  );
}

function PuestoView({ machineName, machines, insumos, machineInsumos, addPedido, pedidos, addMantenimiento, addRegistro, registros, setView, tiposFalla, operarios, piezas, motivos, faqs, calidadPlantillas, calidadRegistros, setCalidadRegistro, calidadDocumentos, addDescarte, updateDescarte, removeDescarte, descartes, motivosScrap, motivosPendiente, motivosFundicion }) {
  const [operador, setOperador] = useState(null);
  const [tab, setTab]           = useState("insumos");
  const [qtys, setQtys]         = useState({});
  const [sentPedido, setSentPedido] = useState(false);
  const [nota, setNota]         = useState("");
  const [tipoFalla, setTipoFalla] = useState("");
  const [descFalla, setDescFalla] = useState("");
  const [sentMant, setSentMant] = useState(false);

  const machine  = machines.find(m => m.name === machineName) || { name: machineName, id: null };

  // Avisa en pantalla cuando pañol marca como entregado un pedido hecho por
  // este operario en esta máquina. Solo funciona mientras esta pantalla está
  // abierta (no es una notificación push al celular bloqueado).
  const [pedidoListoToast, setPedidoListoToast] = useState(null);
  const vistosRef = useRef(null);
  useEffect(() => {
    if (!operador || !pedidos) return;
    const entregadosPropios = pedidos.filter(p => p.machine === machine.name && p.operario === operador.numero && p.status === "entregado").map(p => p.id);
    if (vistosRef.current === null) { vistosRef.current = new Set(entregadosPropios); return; }
    const nuevos = entregadosPropios.filter(id => !vistosRef.current.has(id));
    if (nuevos.length > 0) {
      setPedidoListoToast(true);
      setTimeout(() => setPedidoListoToast(null), 5000);
    }
    vistosRef.current = new Set(entregadosPropios);
  }, [pedidos, operador]);

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
      await addPedido({ id:`P${Date.now()}`, machine:machine.name, items:selected.map(i=>({...i,qty:qtys[i.id]})), nota, status:"pendiente", operario:operador?.numero||"—", createdAt:new Date().toISOString() });
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

  if (!operador) return (
    <AreaLoginGate area="operador" titulo={machine.name} color="var(--green)" operarios={operarios} allowAdmin={false} setView={setView}
      onOperario={(op) => setOperador(op)} />
  );

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
      {pedidoListoToast && (
        <div style={{ position:"fixed", top:20, left:"50%", transform:"translateX(-50%)", zIndex:9999, display:"flex", alignItems:"center", gap:12, background:"#16a34a", color:"white", borderRadius:16, padding:"14px 20px", boxShadow:"0 8px 32px rgba(0,0,0,0.25)", minWidth:260, maxWidth:"90vw" }}>
          <div style={{ fontSize:28 }}>📦</div>
          <div style={{ flex:1 }}>
            <div style={{ fontFamily:"'Bebas Neue'", fontSize:18, letterSpacing:2 }}>TU PEDIDO ESTÁ LISTO</div>
            <div style={{ fontSize:13, opacity:0.85 }}>Ya fue entregado en {machine.name}</div>
          </div>
        </div>
      )}
      <div style={{ maxWidth:540, margin:"0 auto" }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:20 }}>
          <button onClick={() => setView("home")} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 12px", color:"var(--muted)", cursor:"pointer", fontSize:18 }}>←</button>
          <div style={{ flex:1 }}>
            <div style={{ fontFamily:"'Bebas Neue'", fontSize:26, color:"var(--green)", letterSpacing:2 }}>{machine.name}</div>
          </div>
        </div>
        <div style={{ background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:10, padding:"8px 12px", marginBottom:16, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:16 }}>👷</span>
            <span style={{ fontFamily:"'JetBrains Mono'", fontSize:13, fontWeight:600, color:"#9a6000" }}>{operador.numero}</span>
          </div>
          <button onClick={() => setOperador(null)} style={{ background:"none", border:"1px solid #fed7aa", borderRadius:6, padding:"4px 10px", color:"#9a6000", cursor:"pointer", fontSize:12 }}>Cambiar operario</button>
        </div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginBottom:20 }}>
          {[["insumos","📦 INSUMOS"],["mantenimiento","🔧 MANT."],["produccion","🏭 PROD."],["calidad","🧪 CALIDAD"],["documentacion","📄 DOCS"],["faq","❓ FAQ"]].map(([key,lbl]) => {
            const color = key==="insumos"?"var(--green)":key==="mantenimiento"?"#1d4ed8":key==="produccion"?ORANGE:key==="calidad"?"#7C3AED":key==="documentacion"?"#0E7490":"#6B7280";
            return (
              <button key={key} onClick={() => setTab(key)}
                style={{ flex:"1 1 30%", minWidth:90, background:tab===key?color:"var(--surface)", border:`1px solid ${tab===key?color:"var(--border)"}`, borderRadius:12, padding:"11px 4px", color:tab===key?"white":"var(--muted)", fontFamily:"'Bebas Neue'", fontSize:13, letterSpacing:1, cursor:"pointer" }}>
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
            operario={operador}
            machines={machines}
            piezas={piezas}
            motivos={motivos}
            defaultMaquina={machine.name}
            registros={registros || []}
            addDescarte={addDescarte}
            updateDescarte={updateDescarte}
            removeDescarte={removeDescarte}
            descartes={descartes||[]}
            motivosScrap={motivosScrap||[]}
            motivosPendiente={motivosPendiente||[]}
            motivosFundicion={motivosFundicion||[]}
          />
        )}
        {tab === "calidad" && (
          <CalidadOperarioView plantillas={calidadPlantillas||[]} registros={calidadRegistros||[]} setRegistro={setCalidadRegistro} operario={operador} maquina={machine.name} />
        )}
        {tab === "documentacion" && (
          <DocumentacionPuestoView documentos={calidadDocumentos||[]} />
        )}
        {tab === "faq" && <FaqPuestoWidget faqs={faqs || []} maquina={machine.name} />}
      </div>
    </div>
  );
}

// ── Documentación (lado operario): buscar pieza y abrir los PDF que subió
// Calidad para esa pieza. Simplemente abre el link de descarga en una
// pestaña nueva — el navegador se encarga de mostrar el PDF.
function DocumentacionPuestoView({ documentos }) {
  const [q, setQ]           = useState("");
  const [piezaSel, setPiezaSel] = useState("");

  const piezas = [...new Set(documentos.map(d=>d.piezaCodigo))].sort();
  const piezasFiltradas = piezas.filter(p => !q.trim() || p.toLowerCase().includes(q.toLowerCase()));
  const docsDePieza = documentos.filter(d => d.piezaCodigo === piezaSel);

  if (!piezaSel) {
    return (
      <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Buscar pieza por código..."
          style={{ width:"100%", background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"12px 14px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:15, outline:"none" }} />
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {piezasFiltradas.map(p => (
            <button key={p} onClick={()=>setPiezaSel(p)}
              style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"13px 16px", textAlign:"left", cursor:"pointer", fontFamily:"'JetBrains Mono'", fontSize:15, color:"var(--text)", fontWeight:600 }}>
              {p}
            </button>
          ))}
          {piezasFiltradas.length===0 && <div style={{ textAlign:"center", color:"var(--muted)", padding:"1.5rem" }}>No hay documentación cargada para esa búsqueda.</div>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      <button onClick={()=>{ setPiezaSel(""); setQ(""); }} style={{ alignSelf:"flex-start", background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"7px 12px", color:"var(--muted)", cursor:"pointer", fontSize:12 }}>← Elegir otra pieza</button>
      <div style={{ fontFamily:"'Bebas Neue'", fontSize:18, color:"#0E7490", letterSpacing:1 }}>{piezaSel}</div>
      {docsDePieza.map(d => (
        <a key={d.id} href={d.url} target="_blank" rel="noopener noreferrer"
          style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"14px 16px", display:"flex", alignItems:"center", gap:12, textDecoration:"none" }}>
          <span style={{ fontSize:26 }}>📄</span>
          <div style={{ minWidth:0 }}>
            <div style={{ color:"var(--text)", fontSize:15, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{d.nombre}</div>
            <div style={{ fontSize:11, color:"var(--muted)" }}>Tocá para abrir el PDF</div>
          </div>
        </a>
      ))}
      {docsDePieza.length===0 && <div style={{ textAlign:"center", color:"var(--muted)", padding:"1.5rem" }}>Esta pieza no tiene documentos cargados.</div>}
    </div>
  );
}
// ════════════════════════════════════════════════════════════════════
// ── Login por operario, compartido entre Pañol / Mantenimiento / Producción ──
// Cada operario tiene flags panol/mantenimiento/produccion que definen a qué
// paneles puede entrar. "admin" es un operario especial (isAdmin) que solo
// accede al panel de configuración de operarios, sin importar por qué área
// haya entrado. También queda el PIN de área viejo como acceso de emergencia.
function AreaLoginGate({ area, titulo, color, operarios, allowAdmin = true, onOperario, onAdmin, setView }) {
  const [numero, setNumero]     = useState("");
  const [pin, setPin]           = useState("");
  const [error, setError]       = useState("");

  const handleLogin = () => {
    const num = numero.trim();
    if (!num || !pin) { setError("Completá usuario y PIN"); return; }
    if (allowAdmin && num === "admin") {
      const admin = operarios.find(o => o.isAdmin);
      if (admin && admin.pin === pin) { setError(""); onAdmin(); return; }
      setError("Usuario o PIN incorrecto"); setPin(""); return;
    }
    const op = operarios.find(o => o.numero === num && o.pin === pin && !o.isAdmin);
    if (!op) { setError("Usuario o PIN incorrecto"); setPin(""); return; }
    // Compatibilidad: los operarios cargados antes de tener flags de acceso
    // conservan acceso a Producción y a Operador salvo que se les saque explícitamente.
    const tieneAcceso = (area === "produccion" || area === "operador") ? op[area] !== false : !!op[area];
    if (!tieneAcceso) { setError("Ese usuario no tiene acceso a esta área"); setPin(""); return; }
    setError(""); onOperario(op);
  };

  return (
    <div style={{ minHeight:"100vh", background:"var(--page-bg)", display:"flex", alignItems:"center", justifyContent:"center", padding:"2rem" }}>
      <div style={{ maxWidth:340, width:"100%", background:"var(--surface)", border:"1px solid var(--border)", borderRadius:20, padding:"2rem" }}>
        <button onClick={() => setView("home")} style={{ background:"none", border:"none", color:"var(--muted)", cursor:"pointer", fontSize:14, marginBottom:24 }}>← Volver</button>
        <div style={{ textAlign:"center", marginBottom:28 }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:32, color, letterSpacing:4, marginBottom:10 }}>{titulo}</div>
          <div style={{ color:"var(--muted)", fontSize:13, marginTop:4 }}>Ingresá tu usuario y PIN</div>
        </div>
        <input value={numero} onChange={e=>setNumero(e.target.value)} placeholder="Usuario / N° de operario"
          style={{ width:"100%", background:"var(--surface2)", border:`1px solid ${error?"#EF4444":"var(--border)"}`, borderRadius:10, padding:"12px 14px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:15, outline:"none", marginBottom:10 }} />
        <input type="password" value={pin} onChange={e=>setPin(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleLogin()} placeholder="PIN"
          style={{ width:"100%", background:"var(--surface2)", border:`1px solid ${error?"#EF4444":"var(--border)"}`, borderRadius:10, padding:"14px 16px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:20, letterSpacing:8, textAlign:"center", outline:"none", marginBottom:12 }} />
        {error && <div style={{ color:"#EF4444", fontSize:13, marginBottom:12, textAlign:"center" }}>{error}</div>}
        <button onClick={handleLogin} style={{ width:"100%", background:color, border:"none", borderRadius:10, padding:"14px", fontFamily:"'Bebas Neue'", fontSize:20, letterSpacing:2, cursor:"pointer", color:"white" }}>INGRESAR</button>
      </div>
    </div>
  );
}

// ── Panel de operarios: alta, baja y accesos por área ────────────────
// Lo usa tanto el admin (pantalla completa, único destino al que puede
// entrar) como el tab "Operarios" dentro de la config de Producción.
function OperariosManager({ operarios, setOperarios }) {
  const [newOpNum, setNewOpNum] = useState("");
  const [newOpPin, setNewOpPin] = useState("");
  const [newAcc, setNewAcc]     = useState({ panol:false, mantenimiento:false, produccion:false, operador:false, calidad:false });

  const addOperario = () => {
    if (!newOpNum.trim()||!newOpPin.trim()) return;
    setOperarios(p => [...p, { id:`op${Date.now()}`, numero:newOpNum.trim(), pin:newOpPin.trim(), panol:newAcc.panol, mantenimiento:newAcc.mantenimiento, produccion:newAcc.produccion, operador:newAcc.operador, calidad:newAcc.calidad }]);
    setNewOpNum(""); setNewOpPin(""); setNewAcc({ panol:false, mantenimiento:false, produccion:false, operador:false, calidad:false });
  };
  const remOperario   = (id) => setOperarios(p => p.filter(o => o.id !== id));
  const toggleAcceso  = (id, campo) => setOperarios(p => p.map(o => o.id===id ? { ...o, [campo]: !o[campo] } : o));

  const chkLbl = { display:"flex", alignItems:"center", gap:5, fontSize:12, color:"var(--text)" };
  const AccesosChecks = ({ value, onChange }) => (
    <div style={{ display:"flex", gap:12, flexWrap:"wrap" }}>
      <label style={chkLbl}><input type="checkbox" checked={value.operador} onChange={()=>onChange("operador")} /> Operador (máquina)</label>
      <label style={chkLbl}><input type="checkbox" checked={value.panol} onChange={()=>onChange("panol")} /> Pañol</label>
      <label style={chkLbl}><input type="checkbox" checked={value.mantenimiento} onChange={()=>onChange("mantenimiento")} /> Mantenimiento</label>
      <label style={chkLbl}><input type="checkbox" checked={value.produccion} onChange={()=>onChange("produccion")} /> Producción</label>
      <label style={chkLbl}><input type="checkbox" checked={value.calidad} onChange={()=>onChange("calidad")} /> Calidad</label>
    </div>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:15, letterSpacing:2, color:ORANGE, marginBottom:12 }}>AGREGAR OPERARIO</div>
        <div style={{ display:"flex", gap:8, marginBottom:10 }}>
          <input value={newOpNum} onChange={e=>setNewOpNum(e.target.value)} placeholder="Usuario (ej: OP 121)" style={{ flex:2, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, outline:"none" }} />
          <input type="password" value={newOpPin} onChange={e=>setNewOpPin(e.target.value)} placeholder="PIN" style={{ flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, letterSpacing:4, outline:"none" }} />
        </div>
        <div style={{ marginBottom:12 }}>
          <AccesosChecks value={newAcc} onChange={(campo)=>setNewAcc(a=>({ ...a, [campo]: !a[campo] }))} />
        </div>
        <button onClick={addOperario} style={{ width:"100%", background:ORANGE, border:"none", borderRadius:8, padding:"10px", fontFamily:"'Bebas Neue'", fontSize:15, cursor:"pointer", color:"white", letterSpacing:1 }}>+ AGREGAR OPERARIO</button>
      </div>
      {operarios.map(o => (
        <div key={o.id} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px", display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div style={{ display:"flex", gap:12, alignItems:"center" }}>
              <span style={{ fontSize:20 }}>{o.isAdmin ? "🔑" : "👷"}</span>
              <div>
                <div style={{ fontFamily:"'JetBrains Mono'", fontSize:14, fontWeight:600, color:"var(--text)" }}>{o.numero}{o.isAdmin && <span style={{ marginLeft:8, fontSize:10, color:ORANGE, fontWeight:700 }}>ADMIN</span>}</div>
                <div style={{ fontSize:12, color:"var(--muted)" }}>PIN: {"•".repeat(o.pin?.length||4)}</div>
              </div>
            </div>
            {!o.isAdmin && (
              <button onClick={() => remOperario(o.id)} style={{ background:"none", border:"1px solid #EF444466", borderRadius:6, padding:"5px 12px", color:"#EF4444", cursor:"pointer", fontSize:12 }}>Eliminar</button>
            )}
          </div>
          {!o.isAdmin && (
            <AccesosChecks value={{ panol:!!o.panol, mantenimiento:!!o.mantenimiento, produccion:o.produccion!==false, operador:o.operador!==false, calidad:!!o.calidad }} onChange={(campo)=>toggleAcceso(o.id, campo)} />
          )}
        </div>
      ))}
      {operarios.filter(o=>!o.isAdmin).length===0 && <div style={{ textAlign:"center", color:"var(--muted)", padding:"1.5rem", background:"var(--surface)", borderRadius:16, border:"1px solid var(--border)", fontSize:13 }}>Todavía no hay operarios cargados.</div>}
    </div>
  );
}

// ── Calidad: alta de plantillas de control por pieza y recepción de las
// planillas que van completando los operarios en las máquinas ────────────
function CalidadView({ setView, operarios, setOperarios, plantillas, addPlantilla, removePlantilla, registros, updateRegistro, documentos, addDocumento, removeDocumento, descartes, machines, piezas }) {
  const [authMode, setAuthMode]             = useState(null);
  const [loggedOperario, setLoggedOperario] = useState(null);
  const [mainTab, setMainTab]               = useState("plantillas");
  const isLogged = authMode !== null;

  const salir = () => { setAuthMode(null); setLoggedOperario(null); setView("home"); };

  if (!isLogged) return (
    <AreaLoginGate area="calidad" titulo="CALIDAD" color="#7C3AED" operarios={operarios} setView={setView}
      onOperario={(op) => { setLoggedOperario(op); setAuthMode("operario"); }}
      onAdmin={() => setAuthMode("admin")} />
  );

  if (authMode === "admin") return (
    <div style={{ minHeight:"100vh", background:"var(--page-bg)", padding:"1.5rem" }}>
      <div style={{ maxWidth:700, margin:"0 auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:24, letterSpacing:2, color:ORANGE }}>OPERARIOS</div>
          <button onClick={salir} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 14px", color:"var(--muted)", cursor:"pointer", fontSize:13, fontWeight:500 }}>Salir</button>
        </div>
        <OperariosManager operarios={operarios} setOperarios={setOperarios} />
      </div>
    </div>
  );

  const pendientes = registros.filter(r => r.estado === "enviado" && !r.revisado).length;

  return (
    <div style={{ minHeight:"100vh", background:"var(--page-bg)", padding:"1.5rem" }}>
      <div style={{ maxWidth:760, margin:"0 auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:28, color:"#7C3AED", letterSpacing:3 }}>CALIDAD</div>
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={() => setView("home")} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 14px", color:"var(--muted)", cursor:"pointer", fontSize:13, fontWeight:500 }}>🏠 Inicio</button>
            <button onClick={salir} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 14px", color:"var(--muted)", cursor:"pointer", fontSize:13, fontWeight:500 }}>Salir</button>
          </div>
        </div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginBottom:20 }}>
          {[["plantillas","📋 PLANTILLAS"],["recibidos",`📥 RECIBIDOS${pendientes>0?` (${pendientes})`:""}`],["stats","📊 ESTADÍSTICAS"],["documentos","📄 DOCUMENTACIÓN"],["descartes","🗑️ DESCARTES"],["calibres","📏 INSTRUMENTOS"]].map(([key,lbl]) => (
            <button key={key} onClick={() => setMainTab(key)}
              style={{ flex:"1 1 45%", minWidth:120, background:mainTab===key?"#7C3AED":"var(--surface)", border:`1px solid ${mainTab===key?"#7C3AED":"var(--border)"}`, borderRadius:12, padding:"12px 6px", color:mainTab===key?"white":"var(--muted)", fontFamily:"'Bebas Neue'", fontSize:13, letterSpacing:1, cursor:"pointer" }}>
              {lbl}
            </button>
          ))}
        </div>
        {mainTab==="plantillas" && <CalidadPlantillasView plantillas={plantillas} addPlantilla={addPlantilla} removePlantilla={removePlantilla} />}
        {mainTab==="recibidos"  && <CalidadRecibidosView registros={registros} plantillas={plantillas} updateRegistro={updateRegistro} />}
        {mainTab==="calibres" && <Calibres embebido />}
        {mainTab==="stats"      && <CalidadStatsView registros={registros} plantillas={plantillas} />}
        {mainTab==="documentos" && <CalidadDocumentacionView documentos={documentos} addDocumento={addDocumento} removeDocumento={removeDocumento} />}
        {mainTab==="descartes"  && <DescartesView descartes={descartes||[]} machines={machines||[]} piezas={piezas||[]} />}
      </div>
    </div>
  );
}

// ── Calidad → Plantillas: definir por pieza qué campos hay que medir ──────
function CalidadPlantillasView({ plantillas, addPlantilla, removePlantilla }) {
  const [editingId, setEditingId]     = useState(null);
  const [piezaCodigo, setPiezaCodigo] = useState("");
  const [nombre, setNombre]           = useState("");
  const [campos, setCampos]           = useState([]);
  const [campoLabel, setCampoLabel]   = useState("");
  const [campoTipo, setCampoTipo]     = useState("numero");
  const [campoNominal, setCampoNominal] = useState("");
  const [campoMin, setCampoMin]       = useState("");
  const [campoMax, setCampoMax]       = useState("");
  const [campoPos, setCampoPos]       = useState("");
  const [campoTodas, setCampoTodas]   = useState(false);
  const [campoCritica, setCampoCritica] = useState(false);
  const [campoPosErr, setCampoPosErr] = useState("");

  const limpiarForm = () => {
    setEditingId(null); setPiezaCodigo(""); setNombre(""); setCampos([]);
    setCampoLabel(""); setCampoTipo("numero"); setCampoNominal(""); setCampoMin(""); setCampoMax(""); setCampoPos(""); setCampoTodas(false); setCampoCritica(false); setCampoPosErr("");
  };

  const iniciarEdicion = (pl) => {
    setEditingId(pl.id); setPiezaCodigo(pl.piezaCodigo); setNombre(pl.nombre); setCampos(pl.campos);
    window.scrollTo?.({ top:0, behavior:"smooth" });
  };

  const parsearPosiciones = (texto) => {
    const nums = texto.split(",").map(s=>parseInt(s.trim())).filter(n=>!isNaN(n) && n>0);
    return [...new Set(nums)].sort((a,b)=>a-b);
  };

  const agregarCampo = () => {
    if (!campoLabel.trim()) return;
    if (campoTipo==="numero" && (campoMin===""||campoMax==="")) return;
    let posiciones = [];
    if (!campoTodas) {
      posiciones = parsearPosiciones(campoPos);
      if (posiciones.length===0) { setCampoPosErr("Escribí al menos una posición (ej: 1,3,6,9) o tildá \"Todas las piezas\""); return; }
    }
    setCampos(c => [...c, { id:`c${Date.now()}`, label:campoLabel.trim(), tipo:campoTipo,
      nominal: campoTipo==="tapon" ? "" : (campoNominal===""?"":parseFloat(campoNominal)),
      tolMin: campoTipo==="tapon" ? null : parseFloat(campoMin),
      tolMax: campoTipo==="tapon" ? null : parseFloat(campoMax),
      todas: campoTodas, posiciones, critica: campoTipo==="numero" ? campoCritica : false }]);
    setCampoLabel(""); setCampoTipo("numero"); setCampoNominal(""); setCampoMin(""); setCampoMax(""); setCampoPos(""); setCampoTodas(false); setCampoCritica(false); setCampoPosErr("");
  };
  const quitarCampo = (id) => setCampos(c => c.filter(x=>x.id!==id));

  const guardarPlantilla = () => {
    if (!piezaCodigo.trim() || !nombre.trim() || campos.length===0) return;
    const id = editingId || `PL${Date.now()}`;
    const existente = plantillas.find(p => p.id === editingId);
    addPlantilla({ id, piezaCodigo:piezaCodigo.trim().toUpperCase(), nombre:nombre.trim(), campos,
      createdAt: existente?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() });
    limpiarForm();
  };

  const describirPosiciones = (c) => {
    if (c.todas) return "todas las piezas";
    if (c.posiciones && c.posiciones.length) return `piezas ${c.posiciones.join(", ")}`;
    return `cada ${c.frecuencia||1} pieza${(c.frecuencia||1)>1?"s":""} (config. vieja)`;
  };

  const porPieza = {};
  plantillas.forEach(p => { (porPieza[p.piezaCodigo] = porPieza[p.piezaCodigo] || []).push(p); });

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <div style={{ background:"var(--surface)", border:`1px solid ${editingId?"#7C3AED":"var(--border)"}`, borderRadius:16, padding:"1.25rem", display:"flex", flexDirection:"column", gap:10 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:1, color:"#7C3AED" }}>{editingId ? "EDITANDO PLANTILLA" : "NUEVA PLANTILLA"}</div>
          {editingId && <button onClick={limpiarForm} style={{ background:"none", border:"none", color:"var(--muted)", cursor:"pointer", fontSize:12, textDecoration:"underline" }}>Cancelar edición</button>}
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <input value={piezaCodigo} onChange={e=>setPiezaCodigo(e.target.value)} placeholder="Código de pieza (ej: F09244)"
            style={{ flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, outline:"none" }} />
          <input value={nombre} onChange={e=>setNombre(e.target.value)} placeholder="Nombre (ej: Control dimensional)"
            style={{ flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:13, outline:"none" }} />
        </div>

        <div style={{ borderTop:"1px solid var(--border)", paddingTop:10, marginTop:4 }}>
          <div style={{ fontSize:11, color:"var(--muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>Medidas a controlar</div>
          {campos.map(c => (
            <div key={c.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", background:"var(--surface2)", borderRadius:8, padding:"7px 10px", marginBottom:6 }}>
              <span style={{ fontSize:13, color:"var(--text)" }}>
                {c.critica && <span style={{ background:"#FEE2E2", color:"#B91C1C", fontSize:10, fontWeight:700, borderRadius:6, padding:"1px 6px", marginRight:6 }}>CRÍTICA</span>}
                {c.label} — {c.tipo==="tapon" ? "Tapón P-NP" : `nominal ${c.nominal!==""?c.nominal:"—"}, rango [${c.tolMin} a ${c.tolMax}]`}
                <em style={{ color:"var(--muted)", fontStyle:"normal", fontSize:11 }}> · {describirPosiciones(c)}</em>
              </span>
              <button onClick={()=>quitarCampo(c.id)} style={{ background:"none", border:"none", color:"#EF4444", cursor:"pointer", fontSize:12, flexShrink:0 }}>✕</button>
            </div>
          ))}
          <div style={{ display:"flex", flexDirection:"column", gap:6, marginTop:8 }}>
            <div style={{ display:"flex", gap:6 }}>
              <input value={campoLabel} onChange={e=>setCampoLabel(e.target.value)} placeholder="Nombre de la medida (ej: Diámetro exterior mm)"
                style={{ flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"9px 11px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:13, outline:"none" }} />
              <select value={campoTipo} onChange={e=>setCampoTipo(e.target.value)}
                style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"9px 8px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:12, outline:"none" }}>
                <option value="numero">Numérica</option>
                <option value="tapon">Tapón P-NP</option>
              </select>
            </div>
            {campoTipo==="numero" && (
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                <div style={{ flex:"1 1 90px" }}>
                  <label style={{ fontSize:10, color:"var(--muted)" }}>Nominal</label>
                  <input type="number" value={campoNominal} onChange={e=>setCampoNominal(e.target.value)} placeholder="20"
                    style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"9px 11px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, outline:"none" }} />
                </div>
                <div style={{ flex:"1 1 90px" }}>
                  <label style={{ fontSize:10, color:"var(--muted)" }}>Mínimo</label>
                  <input type="number" value={campoMin} onChange={e=>setCampoMin(e.target.value)} placeholder="19.9"
                    style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"9px 11px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, outline:"none" }} />
                </div>
                <div style={{ flex:"1 1 90px" }}>
                  <label style={{ fontSize:10, color:"var(--muted)" }}>Máximo</label>
                  <input type="number" value={campoMax} onChange={e=>setCampoMax(e.target.value)} placeholder="20.1"
                    style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"9px 11px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, outline:"none" }} />
                </div>
              </div>
            )}
            <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:12.5, color:"var(--text)" }}>
              <input type="checkbox" checked={campoTodas} onChange={e=>{ setCampoTodas(e.target.checked); setCampoPosErr(""); }} />
              Controlar todas las piezas
            </label>
            {campoTipo==="numero" && (
              <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:12.5, color:"#B91C1C" }}>
                <input type="checkbox" checked={campoCritica} onChange={e=>setCampoCritica(e.target.checked)} />
                Cota crítica (habilita gráfico de variación y Cpk)
              </label>
            )}
            {!campoTodas && (
              <div>
                <label style={{ fontSize:10, color:"var(--muted)" }}>Piezas a controlar (ej: 1,3,6,9)</label>
                <input value={campoPos} onChange={e=>{ setCampoPos(e.target.value); setCampoPosErr(""); }} placeholder="1,3,6,9"
                  style={{ width:"100%", background:"var(--surface2)", border:`1px solid ${campoPosErr?"#EF4444":"var(--border)"}`, borderRadius:8, padding:"9px 11px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, outline:"none" }} />
                {campoPosErr && <div style={{ color:"#EF4444", fontSize:11, marginTop:3 }}>{campoPosErr}</div>}
              </div>
            )}
            <button onClick={agregarCampo} disabled={!campoLabel.trim()||(campoTipo==="numero"&&(campoMin===""||campoMax===""))}
              style={{ background:"var(--surface2)", border:"1px dashed var(--border)", borderRadius:8, padding:"9px 14px", color:"var(--text)", cursor:"pointer", fontSize:13 }}>+ Agregar medida</button>
          </div>
        </div>

        <button onClick={guardarPlantilla} disabled={!piezaCodigo.trim()||!nombre.trim()||campos.length===0}
          style={{ background: (!piezaCodigo.trim()||!nombre.trim()||campos.length===0) ? "var(--surface2)" : "#7C3AED", border:"none", borderRadius:8, padding:"12px", fontFamily:"'Bebas Neue'", fontSize:15, letterSpacing:1, color: (!piezaCodigo.trim()||!nombre.trim()||campos.length===0) ? "var(--muted)" : "white", cursor: (!piezaCodigo.trim()||!nombre.trim()||campos.length===0) ? "not-allowed" : "pointer" }}>
          {editingId ? "✓ GUARDAR CAMBIOS" : "+ GUARDAR PLANTILLA"}
        </button>
      </div>

      {Object.entries(porPieza).map(([pieza, pls]) => (
        <div key={pieza}>
          <div style={{ fontFamily:"'JetBrains Mono'", fontSize:13, color:"var(--muted)", marginBottom:6 }}>{pieza}</div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {pls.map(pl => (
              <div key={pl.id} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center", gap:10 }}>
                <div style={{ minWidth:0 }}>
                  <div style={{ fontFamily:"'Bebas Neue'", fontSize:15, color:"var(--text)" }}>{pl.nombre}</div>
                  <div style={{ fontSize:11, color:"var(--muted)", marginTop:2 }}>{pl.campos.length} campo{pl.campos.length>1?"s":""}: {pl.campos.map(c=>c.label).join(", ")}</div>
                </div>
                <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                  <button onClick={()=>iniciarEdicion(pl)} style={{ background:"none", border:"1px solid #7C3AED66", borderRadius:6, padding:"5px 12px", color:"#7C3AED", cursor:"pointer", fontSize:12 }}>Editar</button>
                  <button onClick={()=>removePlantilla(pl.id)} style={{ background:"none", border:"1px solid #EF444466", borderRadius:6, padding:"5px 12px", color:"#EF4444", cursor:"pointer", fontSize:12 }}>Eliminar</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {plantillas.length===0 && <div style={{ textAlign:"center", color:"var(--muted)", padding:"1.5rem" }}>Todavía no hay plantillas cargadas.</div>}
    </div>
  );
}

// ── Calidad → Recibidos: planillas que los operarios ya enviaron ─────────
function CalidadRecibidosView({ registros, plantillas, updateRegistro }) {
  const [subTab, setSubTab]   = useState("lista"); // "lista" | "buscar"
  const [verId, setVerId]     = useState(null);
  const [fPieza, setFPieza]   = useState("");
  const [fMaquina, setFMaquina] = useState("");
  const [fDesde, setFDesde]   = useState("");
  const [fHasta, setFHasta]   = useState("");

  const enviados = registros.filter(r => r.estado === "enviado").sort((a,b) => (b.enviadoAt||"").localeCompare(a.enviadoAt||""));
  const piezasDisp   = [...new Set(enviados.map(r=>r.piezaCodigo))].sort();
  const maquinasDisp = [...new Set(enviados.map(r=>r.maquina))].sort();

  const enviadosFiltrados = enviados.filter(r => {
    if (fPieza && r.piezaCodigo !== fPieza) return false;
    if (fMaquina && r.maquina !== fMaquina) return false;
    const fecha = (r.enviadoAt||"").slice(0,10);
    if (fDesde && fecha < fDesde) return false;
    if (fHasta && fecha > fHasta) return false;
    return true;
  });

  const abierto = enviados.find(r => r.id === verId);

  const exportarUno = (r) => {
    const plantilla = plantillas.find(p => p.id === r.plantillaId);
    const campos = plantilla?.campos || [];
    const filas = (r.filas||[]).map(f => {
      const fila = { "N° de pieza": f.numeroPieza || "" };
      campos.forEach(c => { fila[c.label] = c.tipo==="tapon" ? (f.valores[c.id]==="OK"?"OK":f.valores[c.id]==="NOK"?"NO OK":"") : (f.valores[c.id] || ""); });
      fila["Comentario"] = f.comentario || "";
      return fila;
    });
    exportarExcel(`SGI_calidad_${r.piezaCodigo}_${r.plantillaNombre}_${(r.enviadoAt||"").slice(0,10)}`, { "Control": filas });
  };

  const descargarCertificadoPdf = (r) => {
    const plantilla = plantillas.find(p => p.id === r.plantillaId);
    const doc = new jsPDF({ unit:"mm", format:"a4" });
    const pageW = 210, pageH = 297, marginX = 15, marginTop = 20, marginBottom = 20;
    let y = marginTop;
    const checkPage = (needed=8) => { if (y + needed > pageH - marginBottom) { doc.addPage(); y = marginTop; } };

    doc.setFont("helvetica","bold"); doc.setFontSize(14); doc.setTextColor(0);
    doc.text("CERTIFICADO DE CONTROL DE CALIDAD", marginX, y); y += 8;
    doc.setFont("helvetica","normal"); doc.setFontSize(11);
    doc.text(r.plantillaNombre || "", marginX, y); y += 6;
    doc.setFontSize(9); doc.setTextColor(90);
    doc.text(`Pieza: ${r.piezaCodigo}    Máquina: ${r.maquina}    Operario: ${r.operario}`, marginX, y); y += 5;
    doc.text(`Enviado: ${r.enviadoAt ? new Date(r.enviadoAt).toLocaleString("es-AR") : ""}`, marginX, y); y += 5;
    if (r.numeroInicial || r.numeroFinal) { doc.text(`Rango de piezas: ${r.numeroInicial||"—"} a ${r.numeroFinal||"—"}`, marginX, y); y += 5; }
    const totalFilas = r.filas?.length||0;
    const filasConDesvio = (r.filas||[]).filter(f => (plantilla?.campos||[]).some(c => evaluarMedida(c, f.valores[c.id]).fuera)).length;
    doc.text(`${totalFilas} pieza(s) controlada(s) — ${filasConDesvio} con algún desvío`, marginX, y); y += 8;
    doc.setTextColor(0); doc.setDrawColor(200); doc.line(marginX, y, pageW-marginX, y); y += 6;

    // Gráfico de variación + Cpk para las cotas críticas (dibujado a mano con
    // primitivas de jsPDF: sin rasterizar el SVG ni sumar otra librería).
    const camposCriticos = (plantilla?.campos||[]).filter(c => c.tipo==="numero" && c.critica);
    if (camposCriticos.length > 0 && totalFilas >= 2) {
      checkPage(10);
      doc.setFont("helvetica","bold"); doc.setFontSize(10); doc.setTextColor(0);
      doc.text("VARIACIÓN EN EL TURNO / CPK HISTÓRICO DE ESTA MÁQUINA (COTAS CRÍTICAS)", marginX, y); y += 6;
      const chartW = pageW - 2*marginX - 30, chartH = 20;
      camposCriticos.forEach(c => {
        checkPage(chartH + 12);
        const puntos = (r.filas||[]).map(f=>parseFloat(f.valores[c.id])).filter(v=>!isNaN(v));
        const cpkInfo = calcularCpkHistorico(c, r.plantillaId, registros, r.maquina);
        doc.setFont("helvetica","normal"); doc.setFontSize(9); doc.setTextColor(0);
        doc.text(c.label, marginX, y);
        if (cpkInfo) {
          const cpkTxt = `Cpk ${cpkInfo.cpk===Infinity?"∞":cpkInfo.cpk.toFixed(2)}`;
          if (cpkInfo.cpk!==Infinity && cpkInfo.cpk<1) doc.setTextColor(220,38,38);
          else if (cpkInfo.cpk!==Infinity && cpkInfo.cpk<1.33) doc.setTextColor(217,119,6);
          else doc.setTextColor(22,163,74);
          doc.text(cpkTxt, pageW-marginX-doc.getTextWidth(cpkTxt), y);
          doc.setTextColor(0);
        }
        y += 3;
        if (puntos.length >= 2) {
          const minV = Math.min(...puntos, c.tolMin), maxV = Math.max(...puntos, c.tolMax);
          const rango = (maxV-minV) || 1;
          const chartX = marginX, chartY = y;
          const px = (i) => chartX + (i/(puntos.length-1))*chartW;
          const py = (v) => chartY + chartH - ((v-minV)/rango)*chartH;
          const yMin = py(c.tolMin), yMax = py(c.tolMax);
          doc.setFillColor(230,247,239);
          doc.rect(chartX, Math.min(yMin,yMax), chartW, Math.abs(yMax-yMin), "F");
          doc.setDrawColor(124,58,237); doc.setLineWidth(0.3);
          for (let i=0; i<puntos.length-1; i++) doc.line(px(i), py(puntos[i]), px(i+1), py(puntos[i+1]));
          puntos.forEach((v,i) => {
            const dentro = v>=c.tolMin && v<=c.tolMax;
            doc.setFillColor(...(dentro ? [22,163,74] : [220,38,38]));
            doc.circle(px(i), py(v), 0.6, "F");
          });
          doc.setDrawColor(200);
          y += chartH + 5;
        } else {
          y += 4;
        }
      });
      doc.setDrawColor(200); doc.line(marginX, y, pageW-marginX, y); y += 6;
    }

    (r.filas||[]).forEach(f => {
      checkPage(10);
      doc.setFont("helvetica","bold"); doc.setFontSize(10); doc.setTextColor(0);
      doc.text(`Pieza N° ${f.numeroPieza || "—"}`, marginX, y); y += 6;
      doc.setFont("helvetica","normal"); doc.setFontSize(9);
      (plantilla?.campos||[]).forEach(c => {
        checkPage(6);
        const val = f.valores[c.id];
        const { tieneValor, dentro, fuera } = evaluarMedida(c, val);
        const valorTxt = c.tipo==="tapon" ? (tieneValor ? (val==="OK"?"OK":"NO OK") : "—") : (val || "—");
        if (dentro) doc.setTextColor(22,163,74);
        else if (fuera) doc.setTextColor(220,38,38);
        else doc.setTextColor(60);
        doc.text(`${c.label}: ${valorTxt}`, marginX+4, y);
        y += 5;
      });
      doc.setTextColor(0);
      if (f.comentario) {
        checkPage(6);
        doc.setFont("helvetica","italic"); doc.setFontSize(8.5);
        const lineas = doc.splitTextToSize(`Comentario: ${f.comentario}`, pageW-2*marginX-4);
        doc.text(lineas, marginX+4, y); y += lineas.length*4.2;
        doc.setFont("helvetica","normal");
      }
      y += 3;
    });

    checkPage(20); y += 8;
    doc.setDrawColor(200); doc.line(marginX, y, pageW-marginX, y); y += 8;
    doc.setFontSize(9); doc.setTextColor(90);
    doc.text("Revisado por Calidad: ___________________________", marginX, y);
    doc.text("Fecha: ___________________", pageW-marginX-45, y);

    doc.save(`SGI_certificado_${r.piezaCodigo}_${(r.enviadoAt||"").slice(0,10)}.pdf`);
  };

  const selStyle = { flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"9px 10px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:13, outline:"none" };

  if (abierto) {
    const plantilla = plantillas.find(p => p.id === abierto.plantillaId);
    const totalFilas = abierto.filas?.length || 0;
    const filasConDesvio = (abierto.filas||[]).filter(f => (plantilla?.campos||[]).some(c => evaluarMedida(c, f.valores[c.id]).fuera)).length;
    return (
      <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
        <button onClick={()=>setVerId(null)} style={{ alignSelf:"flex-start", background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"7px 14px", color:"var(--muted)", cursor:"pointer", fontSize:12 }}>← Volver</button>

        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
            <div style={{ fontSize:10, color:"var(--muted)", letterSpacing:2, fontWeight:700, marginBottom:6 }}>CERTIFICADO DE CONTROL DE CALIDAD</div>
            <div style={{ fontFamily:"'Bebas Neue'", fontSize:19, color:"#7C3AED" }}>{abierto.plantillaNombre}</div>
            <div style={{ fontSize:12, color:"var(--muted)", marginTop:4 }}>Pieza: <strong>{abierto.piezaCodigo}</strong> · Máquina: <strong>{abierto.maquina}</strong> · Operario: <strong>{abierto.operario}</strong></div>
            <div style={{ fontSize:12, color:"var(--muted)", marginTop:2 }}>Enviado: {abierto.enviadoAt ? new Date(abierto.enviadoAt).toLocaleString("es-AR") : ""}</div>
            {(abierto.numeroInicial || abierto.numeroFinal) && <div style={{ fontSize:12, color:"var(--muted)", marginTop:2 }}>Rango de piezas: <strong>{abierto.numeroInicial||"—"}</strong> a <strong>{abierto.numeroFinal||"—"}</strong></div>}
            <div style={{ fontSize:12, color:"var(--muted)", marginTop:2 }}>{totalFilas} pieza{totalFilas===1?"":"s"} controlada{totalFilas===1?"":"s"} · {filasConDesvio} con algún desvío</div>
          </div>
          {(() => {
            const camposConGrafico = (plantilla?.campos||[]).filter(c => c.tipo==="numero" && c.critica);
            if (camposConGrafico.length===0 || (abierto.filas||[]).length<2) return null;
            return (
              <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1rem", display:"flex", flexDirection:"column", gap:10 }}>
                <div style={{ fontSize:10, color:"var(--muted)", fontWeight:700, textTransform:"uppercase", letterSpacing:1 }}>Variación en este turno · Cpk histórico de esta máquina (cotas críticas)</div>
                {camposConGrafico.map(c => {
                  const cpkInfo = calcularCpkHistorico(c, abierto.plantillaId, registros, abierto.maquina);
                  return (
                    <div key={c.id}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:3 }}>
                        <span style={{ fontSize:12, color:"var(--text)" }}>{c.label}</span>
                        {cpkInfo && (
                          <span style={{ fontSize:12, fontWeight:700, color: cpkInfo.cpk===Infinity ? "#16a34a" : cpkInfo.cpk>=1.33 ? "#16a34a" : cpkInfo.cpk>=1 ? "#f59e0b" : "#EF4444" }}>
                            Cpk {cpkInfo.cpk===Infinity ? "∞" : cpkInfo.cpk.toFixed(2)}
                          </span>
                        )}
                      </div>
                      <MedidaChart campo={c} filas={abierto.filas} />
                    </div>
                  );
                })}
              </div>
            );
          })()}
          {(abierto.filas||[]).map((f,i) => (
            <div key={i} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px" }}>
              <div style={{ fontFamily:"'Bebas Neue'", fontSize:14, color:"var(--text)", marginBottom:6 }}>PIEZA N° {f.numeroPieza || "—"}</div>
              {(plantilla?.campos||[]).map(c => {
                const val = f.valores[c.id];
                const { tieneValor, dentro, fuera } = evaluarMedida(c, val);
                return (
                  <div key={c.id} style={{ display:"flex", justifyContent:"space-between", fontSize:13, padding:"4px 0", borderBottom:"1px solid var(--border)" }}>
                    <span style={{ color:"var(--muted)" }}>{c.label} <em style={{ fontStyle:"normal", fontSize:11 }}>{c.tipo==="tapon" ? "(Tapón P-NP)" : `(nominal ${c.nominal!==""?c.nominal:"—"}, rango [${c.tolMin} a ${c.tolMax}])`}</em></span>
                    <span style={{ color: dentro?"#16a34a":fuera?"#EF4444":"var(--text)", fontFamily:"'JetBrains Mono'", fontWeight:700 }}>
                      {c.tipo==="tapon" ? (tieneValor ? (val==="OK"?"OK":"NO OK") : "—") : (val || "—")}
                    </span>
                  </div>
                );
              })}
              {f.comentario && (
                <div style={{ marginTop:8, paddingTop:8, borderTop:"1px dashed var(--border)", fontSize:12.5, color:"var(--text)" }}>
                  <span style={{ color:"var(--muted)" }}>💬 </span>{f.comentario}
                </div>
              )}
            </div>
          ))}
          <div style={{ display:"flex", justifyContent:"space-between", marginTop:20, paddingTop:14, borderTop:"1px solid var(--border)", fontSize:12, color:"var(--muted)" }}>
            <div>Revisado por Calidad: ___________________</div>
            <div>Fecha: ___________________</div>
          </div>
        </div>

        <div style={{ display:"flex", gap:8 }}>
          <button onClick={()=>exportarUno(abierto)} style={{ flex:1, background:"#16a34a", border:"none", borderRadius:10, padding:"12px", color:"white", fontWeight:700, cursor:"pointer", fontSize:13 }}>📊 Excel</button>
          <button onClick={()=>descargarCertificadoPdf(abierto)} style={{ flex:1, background:"#7C3AED", border:"none", borderRadius:10, padding:"12px", color:"white", fontWeight:700, cursor:"pointer", fontSize:13 }}>📄 Descargar certificado (PDF)</button>
          {!abierto.revisado && <button onClick={()=>updateRegistro(abierto.id,{revisado:true})} style={{ flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"12px", color:"var(--text)", fontWeight:700, cursor:"pointer", fontSize:13 }}>✓ Revisado</button>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <div style={{ display:"flex", gap:8 }}>
        {[["lista","📋 Planillas"],["buscar","🔍 Buscar pieza"]].map(([key,lbl]) => (
          <button key={key} onClick={()=>setSubTab(key)}
            style={{ flex:1, background:subTab===key?"#7C3AED":"var(--surface)", border:`1px solid ${subTab===key?"#7C3AED":"var(--border)"}`, borderRadius:10, padding:"9px 6px", color:subTab===key?"white":"var(--muted)", fontFamily:"'DM Sans'", fontSize:13, fontWeight:600, cursor:"pointer" }}>
            {lbl}
          </button>
        ))}
      </div>

      {subTab === "lista" && (
        <>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            <select value={fPieza} onChange={e=>setFPieza(e.target.value)} style={selStyle}>
              <option value="">Todas las piezas</option>
              {piezasDisp.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={fMaquina} onChange={e=>setFMaquina(e.target.value)} style={selStyle}>
              <option value="">Todas las máquinas</option>
              {maquinasDisp.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div style={{ display:"flex", gap:8 }}>
            <input type="date" value={fDesde} onChange={e=>setFDesde(e.target.value)} style={selStyle} />
            <input type="date" value={fHasta} onChange={e=>setFHasta(e.target.value)} style={selStyle} />
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {enviadosFiltrados.map(r => (
              <button key={r.id} onClick={()=>setVerId(r.id)}
                style={{ background:"var(--surface)", border:`1px solid ${r.revisado?"var(--border)":"#7C3AED66"}`, borderRadius:12, padding:"12px 16px", textAlign:"left", cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div>
                  <div style={{ fontFamily:"'Bebas Neue'", fontSize:15, color:"var(--text)" }}>{r.plantillaNombre} — {r.piezaCodigo}</div>
                  <div style={{ fontSize:11, color:"var(--muted)", marginTop:2 }}>{r.maquina} · 👷 {r.operario} · {r.filas?.length||0} pieza{r.filas?.length===1?"":"s"}{r.numeroInicial?` (${r.numeroInicial}–${r.numeroFinal||"?"})`:""} · {r.enviadoAt ? new Date(r.enviadoAt).toLocaleDateString("es-AR") : ""}</div>
                </div>
                {!r.revisado && <span style={{ background:"#EDE9FE", color:"#7C3AED", fontSize:11, fontWeight:700, borderRadius:999, padding:"3px 10px" }}>Nuevo</span>}
              </button>
            ))}
            {enviadosFiltrados.length===0 && <div style={{ textAlign:"center", color:"var(--muted)", padding:"1.5rem" }}>No hay planillas para este filtro.</div>}
          </div>
        </>
      )}

      {subTab === "buscar" && <CalidadBuscarPiezaView registros={enviados} plantillas={plantillas} piezasDisp={piezasDisp} maquinasDisp={maquinasDisp} />}
    </div>
  );
}

// ── Calidad → Buscar pieza: trayectoria de un N° de pieza puntual ─────────
function CalidadBuscarPiezaView({ registros, plantillas, piezasDisp, maquinasDisp }) {
  const [numeroPieza, setNumeroPieza] = useState("");
  const [pieza, setPieza]             = useState("");
  const [maquina, setMaquina]         = useState("");

  const selStyle = { flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"9px 10px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:13, outline:"none" };

  const resultados = [];
  if (numeroPieza.trim()) {
    registros.forEach(r => {
      if (pieza && r.piezaCodigo !== pieza) return;
      if (maquina && r.maquina !== maquina) return;
      const plantilla = plantillas.find(p => p.id === r.plantillaId);
      (r.filas||[]).forEach(f => {
        if (String(f.numeroPieza||"").trim() === numeroPieza.trim()) {
          resultados.push({ registro:r, fila:f, plantilla });
        }
      });
    });
    resultados.sort((a,b) => (b.registro.enviadoAt||"").localeCompare(a.registro.enviadoAt||""));
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      <input value={numeroPieza} onChange={e=>setNumeroPieza(e.target.value)} placeholder="N° de pieza a buscar (ej: 105)" inputMode="numeric"
        style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"12px 14px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:15, outline:"none" }} />
      <div style={{ display:"flex", gap:8 }}>
        <select value={pieza} onChange={e=>setPieza(e.target.value)} style={selStyle}>
          <option value="">Todas las piezas</option>
          {piezasDisp.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={maquina} onChange={e=>setMaquina(e.target.value)} style={selStyle}>
          <option value="">Todas las máquinas</option>
          {maquinasDisp.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {!numeroPieza.trim() && <div style={{ textAlign:"center", color:"var(--muted)", padding:"1.5rem" }}>Escribí un N° de pieza para ver su historial.</div>}
      {numeroPieza.trim() && resultados.length===0 && <div style={{ textAlign:"center", color:"var(--muted)", padding:"1.5rem" }}>No se encontraron mediciones para esa pieza.</div>}

      {resultados.map(({ registro, fila, plantilla }, i) => (
        <div key={i} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
            <span style={{ fontFamily:"'Bebas Neue'", fontSize:15, color:"#7C3AED" }}>{registro.plantillaNombre} — {registro.piezaCodigo}</span>
            <span style={{ fontSize:11, color:"var(--muted)" }}>{registro.enviadoAt ? new Date(registro.enviadoAt).toLocaleDateString("es-AR") : ""}</span>
          </div>
          <div style={{ fontSize:11, color:"var(--muted)", marginBottom:8 }}>{registro.maquina} · 👷 {registro.operario}</div>
          {(plantilla?.campos||[]).map(c => {
            const val = fila.valores[c.id];
            const { tieneValor, dentro, fuera } = evaluarMedida(c, val);
            return (
              <div key={c.id} style={{ display:"flex", justifyContent:"space-between", fontSize:13, padding:"3px 0" }}>
                <span style={{ color:"var(--muted)" }}>{c.label}</span>
                <span style={{ color: dentro?"#16a34a":fuera?"#EF4444":"var(--text)", fontFamily:"'JetBrains Mono'", fontWeight:700 }}>
                  {c.tipo==="tapon" ? (tieneValor ? (val==="OK"?"OK":"NO OK") : "—") : (val || "—")}
                </span>
              </div>
            );
          })}
          {fila.comentario && <div style={{ marginTop:6, fontSize:12, color:"var(--text)" }}><span style={{ color:"var(--muted)" }}>💬 </span>{fila.comentario}</div>}
        </div>
      ))}
    </div>
  );
}

// ── Calidad → Estadísticas: qué medidas salen más fuera de tolerancia ────
function CalidadStatsView({ registros, plantillas }) {
  const [piezaSel, setPiezaSel]     = useState("");
  const [maquinaSel, setMaquinaSel] = useState("");

  const enviados = registros.filter(r => r.estado === "enviado");
  const piezasDisponibles   = [...new Set(enviados.map(r=>r.piezaCodigo))].sort();
  const maquinasDisponibles = [...new Set(enviados.filter(r=>!piezaSel||r.piezaCodigo===piezaSel).map(r=>r.maquina))].sort();

  const filtrados = enviados.filter(r => (!piezaSel || r.piezaCodigo===piezaSel) && (!maquinaSel || r.maquina===maquinaSel));

  const statsPorMedida = {};
  let totalPiezasMedidas = 0, piezasConAlgunaFuera = 0;

  filtrados.forEach(r => {
    const plantilla = plantillas.find(p=>p.id===r.plantillaId);
    if (!plantilla) return;
    (r.filas||[]).forEach(f => {
      totalPiezasMedidas++;
      let algunaFuera = false;
      plantilla.campos.forEach(c => {
        const val = f.valores[c.id];
        const { tieneValor, fuera } = evaluarMedida(c, val);
        if (!tieneValor) return;
        if (!statsPorMedida[c.label]) statsPorMedida[c.label] = { total:0, fuera:0 };
        statsPorMedida[c.label].total++;
        if (fuera) { statsPorMedida[c.label].fuera++; algunaFuera = true; }
      });
      if (algunaFuera) piezasConAlgunaFuera++;
    });
  });

  const filasStats = Object.entries(statsPorMedida)
    .map(([label,v]) => ({ label, ...v, pct: v.total ? Math.round(v.fuera/v.total*100) : 0 }))
    .sort((a,b) => b.fuera - a.fuera);

  const pctOk = totalPiezasMedidas > 0 ? Math.round((1 - piezasConAlgunaFuera/totalPiezasMedidas)*100) : null;

  const selStyle = { flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"10px 12px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:13, outline:"none" };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <div style={{ display:"flex", gap:8 }}>
        <select value={piezaSel} onChange={e=>{ setPiezaSel(e.target.value); setMaquinaSel(""); }} style={selStyle}>
          <option value="">Todas las piezas</option>
          {piezasDisponibles.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={maquinaSel} onChange={e=>setMaquinaSel(e.target.value)} style={selStyle}>
          <option value="">Todas las máquinas</option>
          {maquinasDisponibles.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      <div style={{ display:"flex", gap:10 }}>
        <div style={{ flex:1, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:14, padding:"1rem", textAlign:"center" }}>
          <div style={{ fontSize:11, color:"var(--muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:1 }}>Piezas medidas</div>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:30, color:"var(--text)" }}>{totalPiezasMedidas}</div>
        </div>
        <div style={{ flex:1, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:14, padding:"1rem", textAlign:"center" }}>
          <div style={{ fontSize:11, color:"var(--muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:1 }}>% dentro de tolerancia</div>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:30, color: pctOk==null ? "var(--muted)" : pctOk>=95 ? "#16a34a" : pctOk>=85 ? "#f59e0b" : "#EF4444" }}>{pctOk==null?"—":`${pctOk}%`}</div>
        </div>
      </div>

      <div style={{ fontSize:12, color:"var(--muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:1 }}>Medidas que más se van de tolerancia</div>
      {filasStats.length === 0 && (
        <div style={{ textAlign:"center", color:"var(--muted)", padding:"1.5rem", background:"var(--surface)", borderRadius:16, border:"1px solid var(--border)" }}>Todavía no hay planillas enviadas para este filtro.</div>
      )}
      {filasStats.map(f => (
        <div key={f.label} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
            <span style={{ fontSize:13, color:"var(--text)", fontWeight:600 }}>{f.label}</span>
            <span style={{ fontSize:13, color: f.pct>15?"#EF4444":f.pct>5?"#f59e0b":"#16a34a", fontWeight:700 }}>{f.fuera} / {f.total} ({f.pct}%)</span>
          </div>
          <div style={{ background:"var(--surface2)", borderRadius:999, height:8, overflow:"hidden" }}>
            <div style={{ width:`${f.pct}%`, background: f.pct>15?"#EF4444":f.pct>5?"#f59e0b":"#16a34a", height:"100%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Calidad → Documentación: PDFs de referencia por pieza (hojas de datos,
// planos, etc). Se guardan en Firebase Storage; acá solo se administra el
// listado y se sube/borra el archivo. El operario los consulta desde la
// máquina, en la pestaña "Documentación" de Puesto.
function CalidadDocumentacionView({ documentos, addDocumento, removeDocumento }) {
  const [piezaCodigo, setPiezaCodigo] = useState("");
  const [nombre, setNombre]           = useState("");
  const [url, setUrl]                 = useState("");
  const [error, setError]             = useState("");

  const piezasExistentes = [...new Set(documentos.map(d=>d.piezaCodigo))].sort();

  const agregar = () => {
    setError("");
    if (!piezaCodigo.trim() || !nombre.trim() || !url.trim()) { setError("Completá pieza, nombre y el link del PDF."); return; }
    if (!/^https?:\/\//i.test(url.trim())) { setError("El link tiene que empezar con http:// o https://"); return; }
    const id = `DOC${Date.now()}`;
    addDocumento({ id, piezaCodigo: piezaCodigo.trim().toUpperCase(), nombre: nombre.trim(), url: url.trim(), agregadoAt: new Date().toISOString() });
    setPiezaCodigo(""); setNombre(""); setUrl("");
  };

  const borrar = (doc) => removeDocumento(doc.id);

  const porPieza = {};
  documentos.forEach(d => { (porPieza[d.piezaCodigo] = porPieza[d.piezaCodigo] || []).push(d); });

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem", display:"flex", flexDirection:"column", gap:10 }}>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:1, color:"#7C3AED" }}>AGREGAR DOCUMENTO</div>
        <div style={{ fontSize:12, color:"var(--muted)", lineHeight:1.4 }}>
          Subí el PDF a Google Drive, tocá <strong>Compartir → Cualquier persona con el enlace</strong>, copiá el link y pegalo acá.
        </div>
        <input value={piezaCodigo} onChange={e=>setPiezaCodigo(e.target.value)} placeholder="Código de pieza (ej: F09244)" list="piezas-doc-existentes"
          style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, outline:"none" }} />
        <datalist id="piezas-doc-existentes">{piezasExistentes.map(p => <option key={p} value={p} />)}</datalist>
        <input value={nombre} onChange={e=>setNombre(e.target.value)} placeholder="Nombre del documento (ej: Plano de control)"
          style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:13, outline:"none" }} />
        <input value={url} onChange={e=>setUrl(e.target.value)} placeholder="Link de Google Drive (o cualquier link) al PDF"
          style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:13, outline:"none" }} />
        {error && <div style={{ color:"#EF4444", fontSize:12 }}>{error}</div>}
        <button onClick={agregar}
          style={{ background:"#7C3AED", border:"none", borderRadius:8, padding:"12px", fontFamily:"'Bebas Neue'", fontSize:15, letterSpacing:1, color:"white", cursor:"pointer" }}>
          + AGREGAR DOCUMENTO
        </button>
      </div>

      {Object.entries(porPieza).map(([pieza, docs]) => (
        <div key={pieza}>
          <div style={{ fontFamily:"'JetBrains Mono'", fontSize:13, color:"var(--muted)", marginBottom:6 }}>{pieza}</div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {docs.map(d => (
              <div key={d.id} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center", gap:10 }}>
                <a href={d.url} target="_blank" rel="noopener noreferrer" style={{ display:"flex", alignItems:"center", gap:10, textDecoration:"none", minWidth:0, flex:1 }}>
                  <span style={{ fontSize:22 }}>📄</span>
                  <div style={{ minWidth:0 }}>
                    <div style={{ color:"var(--text)", fontSize:14, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{d.nombre}</div>
                    <div style={{ fontSize:11, color:"var(--muted)" }}>{new Date(d.agregadoAt).toLocaleDateString("es-AR")}</div>
                  </div>
                </a>
                <button onClick={()=>borrar(d)} style={{ background:"none", border:"1px solid #EF444466", borderRadius:6, padding:"5px 12px", color:"#EF4444", cursor:"pointer", fontSize:12, flexShrink:0 }}>Eliminar</button>
              </div>
            ))}
          </div>
        </div>
      ))}
      {documentos.length===0 && <div style={{ textAlign:"center", color:"var(--muted)", padding:"1.5rem" }}>Todavía no se agregó ningún documento.</div>}
    </div>
  );
}

function MantenimientoView({ mantenimientos, updateMantenimiento, setView, mantPin, setMantPin, tiposFalla, setTiposFalla, machines, operarios, setOperarios, faqs, addFaq, removeFaq, cargaCompleta, cargarHistorialCompleto }) {
  const [authMode, setAuthMode]         = useState(null); // null | "operario" | "admin" | "areaPin"
  const [loggedOperario, setLoggedOperario] = useState(null);
  const [mainTab, setMainTab] = useState("solicitudes");
  const [filter, setFilter]   = useState("pendientes");
  const isLogged = authMode !== null;

  const toast = useNotifications(mantenimientos, m => m.status === "pendiente", isLogged, "mantenimiento");

  const salir = () => { setAuthMode(null); setLoggedOperario(null); setView("home"); };

  if (!isLogged) return (
    <AreaLoginGate area="mantenimiento" titulo="MANTENIMIENTO" color="#1d4ed8" operarios={operarios} setView={setView}
      onOperario={(op) => { setLoggedOperario(op); setAuthMode("operario"); }}
      onAdmin={() => setAuthMode("admin")} />
  );

  if (authMode === "admin") return (
    <div style={{ minHeight:"100vh", background:"var(--page-bg)", padding:"1.5rem" }}>
      <div style={{ maxWidth:700, margin:"0 auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:24, letterSpacing:2, color:ORANGE }}>OPERARIOS</div>
          <button onClick={salir} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 14px", color:"var(--muted)", cursor:"pointer", fontSize:13, fontWeight:500 }}>Salir</button>
        </div>
        <OperariosManager operarios={operarios} setOperarios={setOperarios} />
      </div>
    </div>
  );

  const pendientes = mantenimientos.filter(m => m.status === "pendiente");
  const recibidos  = mantenimientos.filter(m => m.status === "recibido");
  const displayed  = filter === "pendientes" ? pendientes : recibidos;
  const newCount   = pendientes.length;

  // Alerta de falla recurrente: mismo tipo de falla 2+ veces en la misma máquina en los últimos 15 días
  const alertasRecurrentes = (() => {
    const ventanaMs = 15 * 24 * 60 * 60 * 1000;
    const ahora = Date.now();
    const grupos = {};
    mantenimientos.forEach(m => {
      if (!m.createdAt || !m.tipo) return;
      const t = new Date(m.createdAt).getTime();
      if (Number.isNaN(t) || ahora - t > ventanaMs) return;
      const key = `${m.machine}|||${m.tipo}`;
      (grupos[key] = grupos[key] || []).push(m);
    });
    return Object.entries(grupos)
      .filter(([, arr]) => arr.length >= 2)
      .map(([key, arr]) => { const [machine, tipo] = key.split("|||"); return { machine, tipo, count: arr.length }; })
      .sort((a, b) => b.count - a.count);
  })();
  const tabs = [{ key:"solicitudes",label:"🔔 SOLICITUDES" },{ key:"stats",label:"📊 ESTADÍSTICAS" },{ key:"faq",label:"❓ FAQ" },{ key:"tipos",label:"📋 TIPOS" },{ key:"pin",label:"🔑 PIN" }];

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
            <button onClick={salir} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 14px", color:"var(--muted)", cursor:"pointer", fontSize:13, fontWeight:500 }}>Salir</button>
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
            {alertasRecurrentes.length > 0 && (
              <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:16 }}>
                {alertasRecurrentes.map(a => (
                  <div key={a.machine + a.tipo} style={{ background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:10, padding:"10px 14px", fontSize:13, color:"#9a6000" }}>
                    ⚠️ <strong>{a.machine}</strong> tuvo {a.count} fallas de "{a.tipo}" en los últimos 15 días
                  </div>
                ))}
              </div>
            )}
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
        {mainTab==="faq"          && <FaqView area="mantenimiento" machines={machines} faqs={faqs} addFaq={addFaq} removeFaq={removeFaq} />}
        {mainTab==="tipos"        && <TiposFallaEditor tiposFalla={tiposFalla} setTiposFalla={setTiposFalla} />}
        {mainTab==="pin"          && <MantConfigPin mantPin={mantPin} setMantPin={setMantPin} onClose={() => setMainTab("solicitudes")} />}
        {mainTab==="stats"        && <StatsMant mantenimientos={mantenimientos} machines={machines} cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
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

function TiposFallaEditor({ tiposFalla, setTiposFalla }) {
  const [newTipo, setNewTipo] = useState("");
  const addTipo = () => { if (!newTipo.trim()) return; const t=newTipo.trim(); setTiposFalla(prev => [...prev, t]); setNewTipo(""); };
  const removeTipo = (idx) => { setTiposFalla(prev => prev.filter((_, i) => i !== idx)); };
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
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

function MantConfigPin({ mantPin, setMantPin, onClose }) {
  const [newPin, setNewPin] = useState("");
  const [confPin, setConfPin] = useState("");
  const [msg, setMsg] = useState(null);
  const handleSave = () => {
    if (newPin.length < 4)  { setMsg({ ok:false, text:"Mínimo 4 caracteres" }); return; }
    if (newPin !== confPin) { setMsg({ ok:false, text:"Los PINs no coinciden" }); return; }
    setMantPin(newPin); setNewPin(""); setConfPin("");
    setMsg({ ok:true, text:"✓ PIN actualizado correctamente" });
    setTimeout(() => { setMsg(null); onClose(); }, 2000);
  };
  return (
    <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.5rem" }}>
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
function PanolView({ pedidos, updatePedido, setView, panolPin, setPanolPin, machines, setMachines, insumos, setInsumos, machineInsumos, setMachineInsumos, operarios, setOperarios, cargaCompleta, cargarHistorialCompleto }) {
  const [authMode, setAuthMode]             = useState(null);
  const [loggedOperario, setLoggedOperario] = useState(null);
  const [mainTab, setMainTab] = useState("pedidos");
  const [filter, setFilter]   = useState("activos");
  const isLogged = authMode !== null;

  const toast = useNotifications(pedidos, p => p.status === "pendiente", isLogged, "panol");

  // Al marcar un pedido como entregado, descuenta automáticamente el stock
  // de cada insumo entregado (no se puede deshacer desde acá).
  const entregarPedido = (pedido) => {
    setInsumos(prev => prev.map(ins => {
      const item = pedido.items.find(it => it.id === ins.id);
      return item ? { ...ins, stock: Math.max(0, (ins.stock||0) - (item.qty||0)) } : ins;
    }));
    updatePedido(pedido.id, { status:"entregado" });
  };

  const salir = () => { setAuthMode(null); setLoggedOperario(null); setView("home"); };

  if (!isLogged) return (
    <AreaLoginGate area="panol" titulo="PAÑOL" color="var(--green)" operarios={operarios} setView={setView}
      onOperario={(op) => { setLoggedOperario(op); setAuthMode("operario"); }}
      onAdmin={() => setAuthMode("admin")} />
  );

  if (authMode === "admin") return (
    <div style={{ minHeight:"100vh", background:"var(--page-bg)", padding:"1.5rem" }}>
      <div style={{ maxWidth:700, margin:"0 auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:24, letterSpacing:2, color:ORANGE }}>OPERARIOS</div>
          <button onClick={salir} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 14px", color:"var(--muted)", cursor:"pointer", fontSize:13, fontWeight:500 }}>Salir</button>
        </div>
        <OperariosManager operarios={operarios} setOperarios={setOperarios} />
      </div>
    </div>
  );

  const activos   = pedidos.filter(p => !["entregado","cancelado"].includes(p.status));
  const historial = pedidos.filter(p => p.status === "entregado");
  const displayed = filter === "activos" ? activos : historial;
  const newCount  = pedidos.filter(p => p.status === "pendiente").length;
  const tabs = [{ key:"pedidos",label:"📦 PEDIDOS" },{ key:"stock",label:"📊 STOCK" },{ key:"stats",label:"📈 ESTADÍSTICAS" },{ key:"config",label:"⚙️ CONFIG" },{ key:"admin",label:"🛠 ADMIN" }];

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
          <button onClick={salir} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 16px", color:"var(--muted)", cursor:"pointer", fontSize:13, fontWeight:500 }}>Salir</button>
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
              : <div style={{ display:"flex", flexDirection:"column", gap:10 }}>{displayed.map(p => <PedidoCard key={p.id} pedido={p} updatePedido={updatePedido} onEntregar={entregarPedido} />)}</div>
            }
          </>
        )}
        {mainTab==="stock"  && <StockPanolView insumos={insumos} setInsumos={setInsumos} />}
        {mainTab==="config" && <ConfigPanel panolPin={panolPin} setPanolPin={setPanolPin} machines={machines} insumos={insumos} machineInsumos={machineInsumos} setMachineInsumos={setMachineInsumos} />}
        {mainTab==="admin"  && <AdminPanel  machines={machines} setMachines={setMachines} insumos={insumos} setInsumos={setInsumos} />}
        {mainTab==="stats"  && <StatsPanol  pedidos={pedidos} machines={machines} cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
      </div>
    </div>
  );
}

function PedidoCard({ pedido, updatePedido, onEntregar }) {
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
          {pedido.operario && pedido.operario!=="—" && <span style={{ background:"white", borderRadius:999, padding:"2px 10px", fontSize:12, color:"#6B7280", fontWeight:600 }}>👷 {pedido.operario}</span>}
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
            <button key={a.next} onClick={() => a.next==="entregado" ? onEntregar(pedido) : updatePedido(pedido.id, { status:a.next })}
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

// ── Stock de insumos en Pañol ──────────────────────────────────────
// Ajuste rápido +/- del stock de cada insumo, con alerta cuando cae por
// debajo del mínimo configurado (el mínimo se define desde ⚙️ Admin → Insumos).
function StockPanolView({ insumos, setInsumos }) {
  const [q, setQ] = useState("");
  const ajustar   = (id, delta) => setInsumos(p => p.map(i => i.id===id ? { ...i, stock: Math.max(0, (i.stock||0)+delta) } : i));
  const setCampo  = (id, campo, val) => setInsumos(p => p.map(i => i.id===id ? { ...i, [campo]: val==="" ? "" : Math.max(0, parseInt(val)||0) } : i));

  const filtrados = insumos.filter(i => !q.trim() || i.code.toLowerCase().includes(q.toLowerCase()) || i.desc.toLowerCase().includes(q.toLowerCase()));
  const bajos = insumos.filter(i => (i.stockMin||0) > 0 && (i.stock||0) <= (i.stockMin||0));

  const numInput = { width:70, textAlign:"center", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"7px 4px", fontFamily:"'JetBrains Mono'", fontSize:15, fontWeight:700, outline:"none" };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      {bajos.length > 0 && (
        <div style={{ background:"#FEF2F2", border:"1px solid #FCA5A5", borderRadius:14, padding:"14px 18px" }}>
          <div style={{ fontWeight:700, color:"#B91C1C", fontSize:14, marginBottom:6 }}>⚠ {bajos.length} insumo{bajos.length>1?"s":""} por debajo del stock mínimo</div>
          <div style={{ fontSize:13, color:"#991B1B" }}>{bajos.map(i=>i.code).join(" · ")}</div>
        </div>
      )}
      <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Buscar insumo por código o descripción..."
        style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"11px 14px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:14, outline:"none" }} />
      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {filtrados.map(i => {
          const bajo = (i.stockMin||0) > 0 && (i.stock||0) <= (i.stockMin||0);
          return (
            <div key={i.id} style={{ background:"var(--surface)", border:`1px solid ${bajo?"#EF444466":"var(--border)"}`, borderRadius:12, padding:"12px 16px", display:"flex", flexDirection:"column", gap:10 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div style={{ minWidth:0 }}>
                  <div style={{ fontFamily:"'JetBrains Mono'", fontSize:12, color:"var(--green)" }}>{i.code}</div>
                  <div style={{ color:"var(--text)", fontSize:14, marginTop:2 }}>{i.desc}</div>
                </div>
                {bajo && <span style={{ background:"#FEE2E2", color:"#B91C1C", fontSize:11, fontWeight:700, borderRadius:999, padding:"3px 10px", flexShrink:0 }}>⚠ Stock bajo</span>}
              </div>
              <div style={{ display:"flex", gap:20, flexWrap:"wrap" }}>
                <div>
                  <label style={{ fontSize:11, color:"var(--muted)", display:"block", marginBottom:4 }}>Stock actual</label>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <button onClick={()=>ajustar(i.id,-1)} style={{ width:28, height:34, borderRadius:8, border:"1px solid var(--border)", background:"var(--surface2)", color:"var(--text)", fontSize:16, cursor:"pointer" }}>−</button>
                    <input type="number" min="0" inputMode="numeric" value={i.stock ?? 0}
                      onChange={e=>setCampo(i.id,"stock",e.target.value)}
                      onFocus={e=>e.target.select()}
                      onBlur={()=>{ if (i.stock==="") setCampo(i.id,"stock","0"); }}
                      style={{ ...numInput, color:bajo?"#EF4444":"var(--text)" }} />
                    <button onClick={()=>ajustar(i.id,1)} style={{ width:28, height:34, borderRadius:8, border:"1px solid var(--border)", background:"var(--surface2)", color:"var(--text)", fontSize:16, cursor:"pointer" }}>+</button>
                  </div>
                </div>
                <div>
                  <label style={{ fontSize:11, color:"var(--muted)", display:"block", marginBottom:4 }}>Stock mínimo</label>
                  <input type="number" min="0" inputMode="numeric" value={i.stockMin ?? 0}
                    onChange={e=>setCampo(i.id,"stockMin",e.target.value)}
                    onFocus={e=>e.target.select()}
                    onBlur={()=>{ if (i.stockMin==="") setCampo(i.id,"stockMin","0"); }}
                    style={{ ...numInput, color:"var(--text)" }} />
                </div>
              </div>
            </div>
          );
        })}
        {filtrados.length===0 && <div style={{ textAlign:"center", color:"var(--muted)", padding:"1.5rem" }}>No se encontraron insumos.</div>}
      </div>
    </div>
  );
}

function ConfigPanel({ panolPin, setPanolPin, machines, insumos, machineInsumos, setMachineInsumos }) {
  const [tab, setTab]         = useState("pin");
  const [newPin, setNewPin]   = useState("");
  const [confPin, setConfPin] = useState("");
  const [msg, setMsg]         = useState(null);
  const [selMach, setSelMach] = useState(machines[0]?.id || "");
  const handleChangePin = () => {
    if (newPin.length < 4)  { setMsg({ ok:false, text:"Mínimo 4 caracteres" }); return; }
    if (newPin !== confPin) { setMsg({ ok:false, text:"Los PINs no coinciden" }); return; }
    setPanolPin(newPin); setNewPin(""); setConfPin("");
    setMsg({ ok:true, text:"✓ PIN actualizado" });
    setTimeout(() => setMsg(null), 3000);
  };
  const machine  = machines.find(m => m.id === selMach);
  const assigned = machineInsumos[selMach] || [];
  const toggle   = (id) => {
    setMachineInsumos(prev => { const c=prev[selMach]||[]; return { ...prev, [selMach]:c.includes(id)?c.filter(x=>x!==id):[...c,id] }; });
  };
  const selAll   = () => { setMachineInsumos(prev => ({ ...prev, [selMach]:insumos.map(i=>i.id) })); };
  const clrAll   = () => { setMachineInsumos(prev => ({ ...prev, [selMach]:[] })); };
  return (
    <div>
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

function AdminPanel({ machines, setMachines, insumos, setInsumos }) {
  const [tab, setTab]               = useState("maquinas");
  const [newMachine, setNewMachine] = useState("");
  const [newIns, setNewIns]         = useState({ code:"", desc:"", stock:"", stockMin:"" });
  const [selQR, setSelQR]           = useState(machines[0]?.name || "");
  const [qrReady, setQrReady]       = useState(false);

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

  const addMachine = () => { if (!newMachine.trim()) return; const nombre=newMachine.trim(); setMachines(p=>[...p,{id:`m${Date.now()}`,name:nombre}]); setNewMachine(""); };
  const remMachine = (id) => { setMachines(p=>p.filter(m=>m.id!==id)); };
  const addIns     = () => { if (!newIns.code.trim()||!newIns.desc.trim()) return; setInsumos(p=>[...p,{id:`i${Date.now()}`,code:newIns.code,desc:newIns.desc,stock:parseInt(newIns.stock)||0,stockMin:parseInt(newIns.stockMin)||0}]); setNewIns({code:"",desc:"",stock:"",stockMin:""}); };
  const remIns     = (id) => { setInsumos(p=>p.filter(i=>i.id!==id)); };
  const setStockVal = (id, campo, val) => { setInsumos(p => p.map(i => i.id===id ? { ...i, [campo]: Math.max(0, parseInt(val)||0) } : i)); };

  return (
    <div>
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
            <div style={{ display:"flex", gap:8 }}>
              <input type="number" min="0" value={newIns.stock} onChange={e=>setNewIns(p=>({...p,stock:e.target.value}))} placeholder="Stock inicial"
                style={{ flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 14px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, outline:"none" }} />
              <input type="number" min="0" value={newIns.stockMin} onChange={e=>setNewIns(p=>({...p,stockMin:e.target.value}))} placeholder="Stock mínimo"
                style={{ flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 14px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, outline:"none" }} />
            </div>
            <button onClick={addIns} style={{ background:"var(--green)", border:"none", borderRadius:8, padding:"10px", fontFamily:"'Bebas Neue'", fontSize:16, cursor:"pointer", color:"white", letterSpacing:1 }}>+ AGREGAR INSUMO</button>
          </div>
          {insumos.map(i => {
            const bajo = (i.stockMin||0) > 0 && (i.stock||0) <= (i.stockMin||0);
            return (
            <div key={i.id} style={{ background:"var(--surface)", border:`1px solid ${bajo?"#EF444466":"var(--border)"}`, borderRadius:12, padding:"12px 16px", display:"flex", flexDirection:"column", gap:10 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div>
                  <div style={{ fontFamily:"'JetBrains Mono'", fontSize:12, color:"var(--green)" }}>{i.code}</div>
                  <div style={{ color:"var(--text)", fontSize:14, marginTop:2 }}>{i.desc}</div>
                </div>
                <button onClick={()=>remIns(i.id)} style={{ background:"none", border:"1px solid #EF444466", borderRadius:6, padding:"5px 12px", color:"#EF4444", cursor:"pointer", fontSize:12 }}>Eliminar</button>
              </div>
              <div style={{ display:"flex", gap:14, alignItems:"center" }}>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <label style={{ fontSize:11, color:"var(--muted)" }}>Stock</label>
                  <input type="number" min="0" value={i.stock||0} onChange={e=>setStockVal(i.id,"stock",e.target.value)}
                    style={{ width:64, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:6, padding:"5px 8px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, outline:"none" }} />
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <label style={{ fontSize:11, color:"var(--muted)" }}>Mínimo</label>
                  <input type="number" min="0" value={i.stockMin||0} onChange={e=>setStockVal(i.id,"stockMin",e.target.value)}
                    style={{ width:64, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:6, padding:"5px 8px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:13, outline:"none" }} />
                </div>
                {bajo && <span style={{ background:"#FEE2E2", color:"#B91C1C", fontSize:11, fontWeight:700, borderRadius:999, padding:"3px 10px" }}>⚠ Stock bajo</span>}
              </div>
            </div>
          );})}
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

  const handleExportar = () => {
    const hojaInsumos = insumosList.map(i => ({ "Código": i.code, "Descripción": i.desc, "Cantidad retirada": i.total }));
    const hojaMaquinas = allMachineNames.map(m => ({ "Máquina": m, "Pedidos": pedidosPorMaquina[m] || 0 }));
    exportarExcel("SIG_panol_estadisticas", { "Insumos más retirados": hojaInsumos, "Pedidos por máquina": hojaMaquinas });
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>

      <button onClick={handleExportar} disabled={filtered.length===0}
        style={{ background: filtered.length===0 ? "var(--surface2)" : "#16a34a", border:"none", borderRadius:8, padding:"8px 14px", color: filtered.length===0 ? "var(--muted)" : "white", fontSize:12, fontWeight:600, cursor: filtered.length===0 ? "default" : "pointer", alignSelf:"flex-start" }}>
        📊 Exportar a Excel
      </button>

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

  const handleExportar = () => {
    const hojaTipos = tiposList.map(([tipo, cant]) => ({ "Tipo de falla": tipo, "Cantidad": cant }));
    const hojaMaquinas = allMachineNames.map(m => ({ "Máquina": m, "Fallas": fallasPorMaquina[m] || 0 }));
    const hojaDetalle = filtered.map(f => ({
      "Fecha": f.createdAt ? new Date(f.createdAt).toLocaleString("es-AR") : "",
      "Máquina": f.machine, "Tipo": f.tipo, "Estado": f.status, "Observaciones": f.obs || "",
    }));
    exportarExcel("SIG_mantenimiento_estadisticas", { "Por tipo": hojaTipos, "Por máquina": hojaMaquinas, "Detalle": hojaDetalle });
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>

      <button onClick={handleExportar} disabled={filtered.length===0}
        style={{ background: filtered.length===0 ? "var(--surface2)" : "#16a34a", border:"none", borderRadius:8, padding:"8px 14px", color: filtered.length===0 ? "var(--muted)" : "white", fontSize:12, fontWeight:600, cursor: filtered.length===0 ? "default" : "pointer", alignSelf:"flex-start" }}>
        📊 Exportar a Excel
      </button>

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
// ── Registro de descartes (SCRAP / Pendiente / Fundición) por pieza ──────
// Vista compartida entre Producción y Calidad: filtra por máquina y pieza,
// y cuenta cada categoría por separado (no se mezclan entre sí).
function DescartesView({ descartes, machines, piezas }) {
  const [fMaquina, setFMaquina] = useState("");
  const [fPieza, setFPieza]     = useState("");

  const piezasDisponibles = [...new Set(descartes.filter(d=>!fMaquina||d.maquina===fMaquina).map(d=>d.pieza))].sort();

  const filtrados = descartes.filter(d => (!fMaquina || d.maquina===fMaquina) && (!fPieza || d.pieza===fPieza));
  const porCategoria = { scrap:0, pendiente:0, fundicion:0 };
  filtrados.forEach(d => { if (porCategoria[d.categoria]!=null) porCategoria[d.categoria]++; });

  const labels = { scrap:{ txt:"SCRAP", color:"#EF4444" }, pendiente:{ txt:"PENDIENTE", color:"#6B7280" }, fundicion:{ txt:"FUNDICIÓN", color:"#f59e0b" } };
  const selStyle = { flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"9px 10px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:13, outline:"none" };

  const ordenados = [...filtrados].sort((a,b) => (b.createdAt||"").localeCompare(a.createdAt||""));

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <div style={{ display:"flex", gap:8 }}>
        <select value={fMaquina} onChange={e=>{ setFMaquina(e.target.value); setFPieza(""); }} style={selStyle}>
          <option value="">Todas las máquinas</option>
          {machines.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
        </select>
        <select value={fPieza} onChange={e=>setFPieza(e.target.value)} style={selStyle}>
          <option value="">Todas las piezas</option>
          {piezasDisponibles.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      <div style={{ display:"flex", gap:10 }}>
        {Object.entries(labels).map(([key,{txt,color}]) => (
          <div key={key} style={{ flex:1, background:"var(--surface)", border:`1px solid ${color}44`, borderRadius:14, padding:"1rem", textAlign:"center" }}>
            <div style={{ fontSize:10, color, fontWeight:700, letterSpacing:1 }}>{txt}</div>
            <div style={{ fontFamily:"'Bebas Neue'", fontSize:30, color }}>{porCategoria[key]}</div>
          </div>
        ))}
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {ordenados.map(d => {
          const l = labels[d.categoria] || { txt:d.categoria, color:"var(--muted)" };
          return (
            <div key={d.id} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                <span style={{ background:`${l.color}22`, color:l.color, fontSize:11, fontWeight:700, borderRadius:999, padding:"2px 10px" }}>{l.txt}</span>
                <span style={{ fontSize:11, color:"var(--muted)" }}>{d.createdAt ? new Date(d.createdAt).toLocaleString("es-AR") : ""}</span>
              </div>
              <div style={{ fontSize:13, color:"var(--text)" }}>Pieza N° <strong>{d.numeroPieza}</strong> · {d.pieza} · {d.maquina}</div>
              <div style={{ fontSize:12, color:"var(--muted)", marginTop:2 }}>Motivo: {d.motivo} · 👷 {d.operario}</div>
            </div>
          );
        })}
        {ordenados.length===0 && <div style={{ textAlign:"center", color:"var(--muted)", padding:"1.5rem" }}>No hay descartes registrados para este filtro.</div>}
      </div>
    </div>
  );
}

function ProduccionView({ registros, addRegistro, setView, prodPin, setProdPin, operarios, setOperarios, piezas, setPiezas, motivos, setMotivos, machines, faqs, addFaq, removeFaq, cargaCompleta, cargarHistorialCompleto, descartes, motivosScrap, setMotivosScrap, motivosPendiente, setMotivosPendiente, motivosFundicion, setMotivosFundicion }) {
  const [authMode, setAuthMode]             = useState(null);
  const [loggedOperario, setLoggedOperario] = useState(null);
  const [mainTab, setMainTab]       = useState("inicio");
  const isLogged = authMode !== null;

  const salir = () => { setAuthMode(null); setLoggedOperario(null); setView("home"); };

  if (!isLogged) return (
    <AreaLoginGate area="produccion" titulo="PRODUCCIÓN" color={ORANGE} operarios={operarios} setView={setView}
      onOperario={(op) => { setLoggedOperario(op); setAuthMode("operario"); }}
      onAdmin={() => setAuthMode("admin")} />
  );

  if (authMode === "admin") return (
    <div style={{ minHeight:"100vh", background:"var(--page-bg)", padding:"1.5rem" }}>
      <div style={{ maxWidth:700, margin:"0 auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:24, letterSpacing:2, color:ORANGE }}>OPERARIOS</div>
          <button onClick={salir} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 14px", color:"var(--muted)", cursor:"pointer", fontSize:13, fontWeight:500 }}>Salir</button>
        </div>
        <OperariosManager operarios={operarios} setOperarios={setOperarios} />
      </div>
    </div>
  );

  const tabs = [
    { key:"inicio",    label:"🏠 INICIO" },
    { key:"registros", label:"📋 REGISTROS" },
    { key:"oee",       label:"📊 OEE" },
    { key:"operarios", label:"👷 OPERARIOS" },
    { key:"descartes", label:"🗑️ DESCARTES" },
    { key:"reporte",   label:"🗓️ REPORTE" },
    { key:"faq",       label:"❓ FAQ" },
    { key:"config",    label:"⚙️ CONFIG" },
    { key:"backup",    label:"💾 BACKUP" },
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
            <button onClick={salir} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 14px", color:"var(--muted)", cursor:"pointer", fontSize:13 }}>Salir</button>
          </div>
        </div>

        <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:20 }}>
          {tabs.map(({ key, label }) => (
            <button key={key} onClick={() => setMainTab(key)}
              style={{ flex:"1 1 30%", minWidth:100, background:mainTab===key?ORANGE:"var(--surface)", border:`1px solid ${mainTab===key?ORANGE:"var(--border)"}`, borderRadius:12, padding:"10px 6px", color:mainTab===key?"white":"var(--muted)", fontFamily:"'Bebas Neue'", fontSize:13.5, letterSpacing:1, cursor:"pointer", transition:"all 0.2s" }}>
              {label}
            </button>
          ))}
        </div>

        {mainTab==="inicio"    && <InicioProduccionView registros={registros} machines={machines} piezas={piezas} cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
        {mainTab==="registros" && <RegistrosView registros={registros} operarios={operarios} machines={machines} piezas={piezas} cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
        {mainTab==="oee"       && <OeeDashboardView registros={registros} machines={machines} piezas={piezas} cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
        {mainTab==="operarios" && <OperarioMetricsView registros={registros} piezas={piezas} operarios={operarios} cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
        {mainTab==="descartes" && <DescartesView descartes={descartes||[]} machines={machines} piezas={piezas} />}
        {mainTab==="reporte"   && <ReporteSemanalView registros={registros} machines={machines} piezas={piezas} cargaCompleta={cargaCompleta} cargarHistorialCompleto={cargarHistorialCompleto} />}
        {mainTab==="faq"       && <FaqView area="produccion" machines={machines} operarios={operarios} faqs={faqs} addFaq={addFaq} removeFaq={removeFaq} />}
        {mainTab==="config"    && <ProdConfigView prodPin={prodPin} setProdPin={setProdPin} operarios={operarios} setOperarios={setOperarios} piezas={piezas} setPiezas={setPiezas} motivos={motivos} setMotivos={setMotivos} machines={machines} motivosScrap={motivosScrap} setMotivosScrap={setMotivosScrap} motivosPendiente={motivosPendiente} setMotivosPendiente={setMotivosPendiente} motivosFundicion={motivosFundicion} setMotivosFundicion={setMotivosFundicion} />}
        {mainTab==="backup"    && <BackupManual />}
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

  const handleExportar = () => {
    const filas = [];
    filtered.forEach(r => {
      const o = calcularOEE(r, piezas);
      const norm = normalizarRegistro(r);
      norm.piezasCargadas.forEach(c => {
        const producido = (c.izq||0)+(c.der||0);
        const malos = (c.scrapIzq||0)+(c.scrapDer||0)+(c.fundIzq||0)+(c.fundDer||0)+(c.pendIzq||0)+(c.pendDer||0);
        filas.push({
          "Fecha": r.fecha, "Turno": r.turno, "Máquina": r.maquina, "Operario": r.operario,
          "Pieza": c.numero, "Izq": c.izq||0, "Der": c.der||0, "Total producido": producido,
          "Scrap": (c.scrapIzq||0)+(c.scrapDer||0), "Fundición": (c.fundIzq||0)+(c.fundDer||0), "Pendiente": (c.pendIzq||0)+(c.pendDer||0),
          "OK": Math.max(0, producido - malos),
          "OEE %": o.planificadoMin>0 && !o.sinDatosDeCiclo ? Math.round(o.oee*100) : "",
          "Disponibilidad %": o.planificadoMin>0 ? Math.round(o.disponibilidad*100) : "",
          "Rendimiento %": o.planificadoMin>0 && !o.sinDatosDeCiclo ? Math.round(o.rendimiento*100) : "",
          "Calidad %": o.planificadoMin>0 ? Math.round(o.calidad*100) : "",
          "Observaciones": r.obs || "",
        });
      });
    });
    exportarExcel("SIG_produccion", { "Registros": filas });
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
        {cargarHistorialCompleto && (
          <button onClick={() => cargarHistorialCompleto("prodRegistros")} disabled={cargaCompleta?.prodRegistros}
            style={{ background: cargaCompleta?.prodRegistros ? "var(--surface2)" : ORANGE, border:"none", borderRadius:8, padding:"8px 14px", color: cargaCompleta?.prodRegistros ? "var(--muted)" : "white", fontSize:12, fontWeight:600, cursor: cargaCompleta?.prodRegistros ? "default" : "pointer" }}>
            {cargaCompleta?.prodRegistros ? "✓ Historial completo cargado" : "Ver turnos más viejos que 30 días"}
          </button>
        )}
        <button onClick={handleExportar} disabled={filtered.length===0}
          style={{ background: filtered.length===0 ? "var(--surface2)" : "#16a34a", border:"none", borderRadius:8, padding:"8px 14px", color: filtered.length===0 ? "var(--muted)" : "white", fontSize:12, fontWeight:600, cursor: filtered.length===0 ? "default" : "pointer" }}>
          📊 Exportar a Excel
        </button>
      </div>
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
// ── Pantalla de inicio de Producción: resumen rápido de OEE ──────────
function InicioProduccionView({ registros, machines, piezas, cargaCompleta, cargarHistorialCompleto }) {
  useEffect(() => { if (cargarHistorialCompleto) cargarHistorialCompleto("prodRegistros"); }, []);

  const hoyISO   = new Date().toISOString().slice(0,10);
  const hace7ISO = new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10);

  const deHoy    = registros.filter(r => r.fecha === hoyISO);
  const deSemana = registros.filter(r => r.fecha >= hace7ISO);

  const calcVal = (regs) => regs.map(r => calcularOEE(r, piezas)).filter(o => o.planificadoMin > 0 && !o.sinDatosDeCiclo);
  const promedio = (arr, key) => arr.length ? arr.reduce((a,o)=>a+o[key],0)/arr.length : null;

  const oeeHoy    = promedio(calcVal(deHoy), "oee");
  const oeeSemana = promedio(calcVal(deSemana), "oee");
  const piezasHoy = deHoy.reduce((a,r) => a + calcularOEE(r, piezas).totalProducido, 0);

  const porMaquina = machines.map(m => {
    const val = calcVal(deSemana.filter(r => r.maquina === m.name));
    return { maquina:m.name, oee: promedio(val,"oee"), n: val.length };
  }).filter(x => x.n > 0);
  const mejor = porMaquina.length ? [...porMaquina].sort((a,b)=>b.oee-a.oee)[0] : null;
  const peor  = porMaquina.length > 1 ? [...porMaquina].sort((a,b)=>a.oee-b.oee)[0] : null;

  const colorPct = (v) => v>=0.75 ? "#16a34a" : v>=0.5 ? "#f59e0b" : "#EF4444";
  const pct = (v) => v==null ? "—" : `${Math.round(v*100)}%`;

  const StatCard = ({ label, value, color, sub }) => (
    <div style={{ flex:1, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.1rem", textAlign:"center" }}>
      <div style={{ fontSize:11, color:"var(--muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>{label}</div>
      <div style={{ fontFamily:"'Bebas Neue'", fontSize:34, color: color||"var(--text)" }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:"var(--muted)", marginTop:2 }}>{sub}</div>}
    </div>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <div style={{ display:"flex", gap:10 }}>
        <StatCard label="OEE hoy" value={pct(oeeHoy)} color={oeeHoy==null?undefined:colorPct(oeeHoy)} />
        <StatCard label="OEE últimos 7 días" value={pct(oeeSemana)} color={oeeSemana==null?undefined:colorPct(oeeSemana)} />
        <StatCard label="Piezas hoy" value={piezasHoy} />
      </div>
      <div style={{ display:"flex", gap:10 }}>
        <div style={{ flex:1, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.1rem" }}>
          <div style={{ fontSize:11, color:"var(--muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>🏆 Mejor máquina (7 días)</div>
          {mejor ? (
            <>
              <div style={{ fontFamily:"'Bebas Neue'", fontSize:20, color:"var(--text)" }}>{mejor.maquina}</div>
              <div style={{ fontFamily:"'Bebas Neue'", fontSize:26, color:colorPct(mejor.oee) }}>{pct(mejor.oee)} OEE</div>
            </>
          ) : <div style={{ color:"var(--muted)", fontSize:13 }}>Sin datos suficientes todavía</div>}
        </div>
        <div style={{ flex:1, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.1rem" }}>
          <div style={{ fontSize:11, color:"var(--muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>⚠️ A vigilar (7 días)</div>
          {peor ? (
            <>
              <div style={{ fontFamily:"'Bebas Neue'", fontSize:20, color:"var(--text)" }}>{peor.maquina}</div>
              <div style={{ fontFamily:"'Bebas Neue'", fontSize:26, color:colorPct(peor.oee) }}>{pct(peor.oee)} OEE</div>
            </>
          ) : <div style={{ color:"var(--muted)", fontSize:13 }}>Sin datos suficientes todavía</div>}
        </div>
      </div>
      <div style={{ fontSize:11, color:"var(--muted)", textAlign:"center" }}>OEE calculado solo sobre turnos con tiempo de ciclo cargado para cada pieza.</div>
    </div>
  );
}

// ── Reporte semanal de Producción (OEE) ───────────────────────────────
function ReporteSemanalView({ registros, machines, piezas, cargaCompleta, cargarHistorialCompleto }) {
  useEffect(() => { if (cargarHistorialCompleto) cargarHistorialCompleto("prodRegistros"); }, []);

  const hoy = new Date();
  const desdeDate = new Date(hoy.getTime() - 6*24*60*60*1000); // últimos 7 días incluyendo hoy
  const desdeISO = desdeDate.toISOString().slice(0,10);
  const hastaISO = hoy.toISOString().slice(0,10);

  const enRango = registros.filter(r => r.fecha >= desdeISO && r.fecha <= hastaISO);

  const porMaquina = machines.map(m => {
    const regs = enRango.filter(r => r.maquina === m.name);
    const calc = regs.map(r => calcularOEE(r, piezas)).filter(o => o.planificadoMin > 0);
    const validos = calc.filter(o => !o.sinDatosDeCiclo);
    const n = validos.length;
    const avg = (key) => n > 0 ? validos.reduce((a,o)=>a+o[key],0)/n : null;
    const piezasTotal = calc.reduce((a,o)=>a+o.totalProducido,0);
    return { maquina:m.name, turnos:regs.length, oee:avg("oee"), disponibilidad:avg("disponibilidad"), rendimiento:avg("rendimiento"), calidad:avg("calidad"), piezasTotal };
  }).filter(x => x.turnos > 0);

  const colorPct = (v) => v==null ? "var(--muted)" : v>=0.75 ? "#16a34a" : v>=0.5 ? "#f59e0b" : "#EF4444";
  const pct = (v) => v==null ? "—" : `${Math.round(v*100)}%`;

  const handleExportar = () => {
    const filas = porMaquina.map(m => ({
      "Máquina": m.maquina, "Turnos cargados": m.turnos, "Piezas producidas": m.piezasTotal,
      "OEE promedio": m.oee!=null ? `${Math.round(m.oee*100)}%` : "—",
      "Disponibilidad": m.disponibilidad!=null ? `${Math.round(m.disponibilidad*100)}%` : "—",
      "Rendimiento": m.rendimiento!=null ? `${Math.round(m.rendimiento*100)}%` : "—",
      "Calidad": m.calidad!=null ? `${Math.round(m.calidad*100)}%` : "—",
    }));
    exportarExcel(`SGI_reporte_semanal_${desdeISO}_a_${hastaISO}`, { "Reporte semanal": filas });
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.1rem" }}>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:1, color:ORANGE, marginBottom:4 }}>REPORTE SEMANAL — OEE</div>
        <div style={{ fontSize:12, color:"var(--muted)", marginBottom:12 }}>{desdeISO} a {hastaISO}</div>
        <button onClick={handleExportar} disabled={porMaquina.length===0}
          style={{ width:"100%", background: porMaquina.length===0 ? "var(--surface2)" : "#16a34a", border:"none", borderRadius:8, padding:"11px", color: porMaquina.length===0 ? "var(--muted)" : "white", fontSize:13, fontWeight:700, cursor: porMaquina.length===0 ? "default" : "pointer" }}>
          📊 Descargar reporte (Excel)
        </button>
      </div>
      {porMaquina.length === 0 && (
        <div style={{ textAlign:"center", color:"var(--muted)", padding:"2rem", background:"var(--surface)", borderRadius:16, border:"1px solid var(--border)" }}>Todavía no hay cargas de producción esta semana.</div>
      )}
      {porMaquina.map(m => (
        <div key={m.maquina} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
            <span style={{ fontFamily:"'Bebas Neue'", fontSize:17, color:"var(--text)" }}>{m.maquina}</span>
            <span style={{ fontFamily:"'Bebas Neue'", fontSize:22, color:colorPct(m.oee) }}>{pct(m.oee)}</span>
          </div>
          <div style={{ fontSize:11, color:"var(--muted)" }}>{m.turnos} turno{m.turnos>1?"s":""} · {m.piezasTotal} piezas · Disp {pct(m.disponibilidad)} · Rend {pct(m.rendimiento)} · Cal {pct(m.calidad)}</div>
        </div>
      ))}
    </div>
  );
}

// ── Métricas de carga por operario (solo OEE de Producción) ──────────
function OperarioMetricsView({ registros, piezas, operarios, cargaCompleta, cargarHistorialCompleto }) {
  useEffect(() => { if (cargarHistorialCompleto) cargarHistorialCompleto("prodRegistros"); }, []);

  const porOperario = {};
  registros.forEach(r => {
    const op = r.operario || "Sin identificar";
    (porOperario[op] = porOperario[op] || []).push(r);
  });

  const filas = Object.entries(porOperario).map(([op, regs]) => {
    const calc = regs.map(r => calcularOEE(r, piezas)).filter(o => o.planificadoMin > 0);
    const validos = calc.filter(o => !o.sinDatosDeCiclo);
    const oeeProm = validos.length ? validos.reduce((a,o)=>a+o.oee,0)/validos.length : null;
    const piezasTotal = calc.reduce((a,o)=>a+o.totalProducido,0);
    return { operario:op, turnos:regs.length, oeeProm, piezasTotal };
  }).sort((a,b) => b.turnos - a.turnos);

  const colorPct = (v) => v==null ? "var(--muted)" : v>=0.75 ? "#16a34a" : v>=0.5 ? "#f59e0b" : "#EF4444";
  const pct = (v) => v==null ? "—" : `${Math.round(v*100)}%`;

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      <div style={{ fontSize:12, color:"var(--muted)", marginBottom:2 }}>Turnos de producción cargados por cada operario, con su OEE promedio. No incluye pedidos a pañol ni avisos de mantenimiento.</div>
      {filas.length === 0 && (
        <div style={{ textAlign:"center", color:"var(--muted)", padding:"2rem", background:"var(--surface)", borderRadius:16, border:"1px solid var(--border)" }}>Todavía no hay cargas de producción registradas.</div>
      )}
      {filas.map(f => (
        <div key={f.operario} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontFamily:"'JetBrains Mono'", fontSize:14, fontWeight:600, color:"var(--text)" }}>👷 {f.operario}</div>
            <div style={{ fontSize:11, color:"var(--muted)", marginTop:2 }}>{f.turnos} turno{f.turnos>1?"s":""} cargado{f.turnos>1?"s":""} · {f.piezasTotal} piezas</div>
          </div>
          <span style={{ fontFamily:"'Bebas Neue'", fontSize:22, color:colorPct(f.oeeProm) }}>{pct(f.oeeProm)}</span>
        </div>
      ))}
    </div>
  );
}

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

  // Pareto de paradas: minutos totales por motivo, en el rango/máquina filtrados
  const paradasMap = {};
  enRango.forEach(r => {
    (r.paradas || []).forEach(p => {
      if (p.minutos > 0) paradasMap[p.motivo] = (paradasMap[p.motivo] || 0) + p.minutos;
    });
  });
  const paradasList = Object.entries(paradasMap).sort((a, b) => b[1] - a[1]);
  const maxParada = paradasList[0]?.[1] || 1;
  const totalMinParadas = paradasList.reduce((a, [, m]) => a + m, 0);

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

  const handleExportar = () => {
    const filas = porMaquina.map(m => ({
      "Máquina": m.maquina, "Turnos en el período": m.turnos, "Turnos con OEE calculable": m.turnosValidos,
      "OEE %": m.turnosValidos>0 ? Math.round(m.oee*100) : "",
      "Disponibilidad %": m.turnosValidos>0 ? Math.round(m.disponibilidad*100) : "",
      "Rendimiento %": m.turnosValidos>0 ? Math.round(m.rendimiento*100) : "",
      "Calidad %": m.turnosValidos>0 ? Math.round(m.calidad*100) : "",
    }));
    const tend = tendencia.map(t => ({ "Fecha": t.fecha, "OEE promedio %": Math.round(t.oee*100) }));
    const hojaParadas = paradasList.map(([motivo, min]) => ({ "Motivo de parada": motivo, "Minutos totales": min }));
    exportarExcel("SIG_oee", { "Por máquina": filas, "Tendencia diaria": tend, "Paradas": hojaParadas });
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      <button onClick={handleExportar} disabled={porMaquina.length===0}
        style={{ background: porMaquina.length===0 ? "var(--surface2)" : "#16a34a", border:"none", borderRadius:8, padding:"8px 14px", color: porMaquina.length===0 ? "var(--muted)" : "white", fontSize:12, fontWeight:600, cursor: porMaquina.length===0 ? "default" : "pointer", alignSelf:"flex-start" }}>
        📊 Exportar a Excel
      </button>
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

      {/* Pareto de paradas — no depende del tiempo de ciclo, se muestra siempre que haya paradas cargadas */}
      {paradasList.length > 0 && (
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:15, letterSpacing:2, color:ORANGE, marginBottom:4 }}>PARETO DE PARADAS</div>
          <div style={{ fontSize:11, color:"var(--muted)", marginBottom:14 }}>{totalMinParadas} min parados en total en el período seleccionado</div>
          {paradasList.map(([motivo, min]) => (
            <div key={motivo} style={{ marginBottom:10 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                <span style={{ fontSize:14, color:"var(--text)", fontWeight:500 }}>{motivo}</span>
                <span style={{ fontFamily:"'Bebas Neue'", fontSize:16, color:"#EF4444" }}>{min} min</span>
              </div>
              <div style={{ height:8, background:"var(--surface2)", borderRadius:4, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${(min/maxParada)*100}%`, background:"#EF4444", borderRadius:4 }}/>
              </div>
            </div>
          ))}
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

// ── Modal obligatorio: al marcar una pieza como SCRAP / Pendiente / Fundición,
// pide N° de pieza y motivo (de la lista que cargó Producción para esa categoría).
function DescarteModal({ modal, onClose, motivosScrap, motivosPendiente, motivosFundicion, onGuardar, onEliminar }) {
  const editando = !!modal.id;
  const [numeroPieza, setNumeroPieza] = useState(modal.numeroPieza || "");
  const [motivo, setMotivo]           = useState(modal.motivo || "");

  const info = {
    scrap:     { titulo:"SCRAP",     color:"#EF4444", lista:motivosScrap },
    pendiente: { titulo:"PENDIENTE", color:"#6B7280", lista:motivosPendiente },
    fundicion: { titulo:"FUNDICIÓN", color:"#f59e0b", lista:motivosFundicion },
  }[modal.categoria];

  const puedeGuardar = numeroPieza.trim() && motivo;

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:9999, display:"flex", alignItems:"center", justifyContent:"center", padding:"1.5rem" }}>
      <div style={{ background:"var(--surface)", borderRadius:16, padding:"1.5rem", maxWidth:380, width:"100%", border:`2px solid ${info.color}` }}>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:19, letterSpacing:2, color:info.color, marginBottom:4 }}>{editando ? "EDITAR" : "REGISTRAR"} {info.titulo}</div>
        <div style={{ fontSize:12, color:"var(--muted)", marginBottom:16 }}>Pieza: {modal.piezaNumero}</div>

        <label style={{ fontSize:11, color:"var(--muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 }}>N° de pieza</label>
        <input value={numeroPieza} onChange={e=>setNumeroPieza(e.target.value)} placeholder="ej: 542" inputMode="numeric" autoFocus
          style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"12px 14px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:16, fontWeight:700, outline:"none", marginBottom:14 }} />

        <label style={{ fontSize:11, color:"var(--muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 }}>Motivo</label>
        {info.lista.length === 0 ? (
          <div style={{ fontSize:12, color:"#EF4444", marginBottom:14 }}>Todavía no hay motivos de {info.titulo.toLowerCase()} cargados — pedile a Producción que los cargue en Config.</div>
        ) : (
          <select value={motivo} onChange={e=>setMotivo(e.target.value)}
            style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"12px 14px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:14, outline:"none", marginBottom:14 }}>
            <option value="">— Elegir motivo —</option>
            {info.lista.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        )}

        {editando && (
          <button onClick={onEliminar} style={{ width:"100%", background:"none", border:"1px solid #EF444466", borderRadius:10, padding:"10px", color:"#EF4444", cursor:"pointer", fontWeight:600, fontSize:13, marginBottom:10 }}>
            🗑️ Eliminar este registro (la pieza se liberó / me equivoqué)
          </button>
        )}
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={onClose} style={{ flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"12px", color:"var(--muted)", cursor:"pointer", fontWeight:600 }}>Cancelar</button>
          <button onClick={()=>onGuardar(numeroPieza.trim(), motivo)} disabled={!puedeGuardar}
            style={{ flex:1, background: puedeGuardar ? info.color : "var(--surface2)", border:"none", borderRadius:10, padding:"12px", color: puedeGuardar ? "white" : "var(--muted)", cursor: puedeGuardar ? "pointer" : "not-allowed", fontWeight:700 }}>Guardar</button>
        </div>
      </div>
    </div>
  );
}

function NuevaCargaView({ addRegistro, operario, machines, piezas, motivos, defaultMaquina, addDescarte, updateDescarte, removeDescarte, descartes, motivosScrap, motivosPendiente, motivosFundicion }) {
  const [sent,     setSent]     = useState(false);
  const [modalDescarte, setModalDescarte] = useState(null); // { categoria, piezaNumero }

  // Form state
  const today = new Date().toISOString().slice(0,10);
  const [fecha,      setFecha]      = useState(today);
  const [turno,      setTurno]      = useState("Mañana");
  const [maquina,    setMaquina]    = useState(defaultMaquina || machines[0]?.name || "");
  const [pieza,      setPieza]      = useState("");
  const [cargas,     setCargas]     = useState([]); // [{numero, izq, der, scrapIzq, scrapDer, fundIzq, fundDer, pendIzq, pendDer}]
  const [piezasSeleccionadas, setPiezasSeleccionadas] = useState([]);
  const [piezasPorHora, setPiezasPorHora] = useState(() => Array(TURNOS_CONFIG["Mañana"].slots).fill(""));
  const [horasExcluidas, setHorasExcluidas] = useState(() => Array(TURNOS_CONFIG["Mañana"].slots).fill(false));
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
    setHorasExcluidas(Array(TURNOS_CONFIG[t].slots).fill(false));
  };

  const toggleHoraExcluida = (i) => {
    setHorasExcluidas(prev => prev.map((v,idx) => idx===i ? !v : v));
    if (!horasExcluidas[i]) { const n=[...piezasPorHora]; n[i]=""; setPiezasPorHora(n); }
  };

  useEffect(() => {
    setParadas(motivos.map(m => ({ motivo:m, minutos:"" })));
  }, [motivos]);

  useEffect(() => {
    if (formErrors.length > 0) setFormErrors([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fecha, turno, maquina, cargas, piezasPorHora, paradas]);

  const piezasMaquina = piezas.filter(p => p.maquina === maquina);

  // ── Validaciones antes de guardar ──────────────────────────────
  const validarCarga = () => {
    const errores = [];

    if (cargas.length === 0) errores.push('Agregá al menos una pieza en "Piezas cargadas"');

    let totalProducido = 0, totalDescartes = 0, totalPorCiclo = 0;
    cargas.forEach(c => {
      const campos = { izq:c.izq, der:c.der, "scrap izq":c.scrapIzq, "scrap der":c.scrapDer, "fundición izq":c.fundIzq, "fundición der":c.fundDer, "pendiente izq":c.pendIzq, "pendiente der":c.pendDer };
      for (const [label, val] of Object.entries(campos)) {
        if (val !== "" && parseInt(val) < 0) errores.push(`"${c.numero}" — ${label} no puede ser negativo`);
      }
      const producido = (parseInt(c.izq)||0)+(parseInt(c.der)||0);
      const descartesCount = (parseInt(c.scrapIzq)||0)+(parseInt(c.scrapDer)||0)+(parseInt(c.fundIzq)||0)+(parseInt(c.fundDer)||0)+(parseInt(c.pendIzq)||0)+(parseInt(c.pendDer)||0);
      if (descartesCount > producido) errores.push(`"${c.numero}" — Scrap + Fundición + Pendiente (${descartesCount}) no puede superar lo producido (${producido})`);
      totalProducido += producido;
      totalDescartes += descartesCount;
      // Para el gráfico por hora tomamos una sola celda (izq o der, la que
      // corresponda), no la suma de ambos lados — así el operario carga el
      // conteo de un solo lado por hora sin tener que sumarlos a mano.
      totalPorCiclo += Math.max(parseInt(c.izq)||0, parseInt(c.der)||0);

      // La cantidad escrita en Scrap/Fundición/Pendiente tiene que coincidir
      // con la cantidad de piezas individuales cargadas con "+ registrar" para
      // esa misma pieza — si no, falta (o sobra) el detalle de alguna.
      const scrapTot = (parseInt(c.scrapIzq)||0)+(parseInt(c.scrapDer)||0);
      const fundTot  = (parseInt(c.fundIzq)||0)+(parseInt(c.fundDer)||0);
      const pendTot  = (parseInt(c.pendIzq)||0)+(parseInt(c.pendDer)||0);
      const misDeEstaPieza = (descartes||[]).filter(d => d.maquina===maquina && d.fecha===fecha && d.turno===turno && d.pieza===c.numero);
      const cargadosScrap = misDeEstaPieza.filter(d=>d.categoria==="scrap").length;
      const cargadosFund  = misDeEstaPieza.filter(d=>d.categoria==="fundicion").length;
      const cargadosPend  = misDeEstaPieza.filter(d=>d.categoria==="pendiente").length;
      if (scrapTot > 0 && cargadosScrap !== scrapTot) errores.push(`"${c.numero}" — anotaste ${scrapTot} SCRAP pero cargaste el detalle de ${cargadosScrap} (usá "+ registrar N° de pieza y motivo")`);
      if (fundTot  > 0 && cargadosFund  !== fundTot)  errores.push(`"${c.numero}" — anotaste ${fundTot} FUNDICIÓN pero cargaste el detalle de ${cargadosFund} (usá "+ registrar N° de pieza y motivo")`);
      if (pendTot  > 0 && cargadosPend  !== pendTot)  errores.push(`"${c.numero}" — anotaste ${pendTot} PENDIENTE pero cargaste el detalle de ${cargadosPend} (usá "+ registrar N° de pieza y motivo")`);
    });

    piezasPorHora.forEach((v, i) => {
      if (v !== "" && parseInt(v) < 0) errores.push(`"Piezas por hora" (columna ${i+1}) no puede ser negativo`);
    });
    const sumaPorHora = piezasPorHora.reduce((a,v) => a + (parseInt(v)||0), 0);
    const algunaHoraCargada = piezasPorHora.some(v => v !== "");
    if (algunaHoraCargada && sumaPorHora !== totalPorCiclo) {
      errores.push(`La suma de "Piezas por hora" (${sumaPorHora}) no coincide con lo cargado en Piezas cargadas (${totalPorCiclo} — se cuenta un solo lado, izq. o der., por pieza)`);
    }
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
      operario: operario?.numero || "—",
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
      horasExcluidas: horasExcluidas,
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
      <button onClick={() => { setSent(false); setPieza(""); setPiezasSeleccionadas([]); setCargas([]); setPiezasPorHora(Array(TURNOS_CONFIG[turno].slots).fill("")); setHorasExcluidas(Array(TURNOS_CONFIG[turno].slots).fill(false)); setParadas(motivos.map(m=>({motivo:m,minutos:""}))); setObs(""); }}
        style={{ background:ORANGE, border:"none", borderRadius:10, padding:"13px 32px", fontFamily:"'Bebas Neue'", fontSize:18, letterSpacing:2, cursor:"pointer", color:"white" }}>
        NUEVA CARGA
      </button>
    </div>
  );

  const inputStyle = { width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:14, outline:"none" };
  const labelStyle = { fontSize:12, color:"var(--muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:6 };
  const numInput   = { ...inputStyle, textAlign:"center", fontFamily:"'JetBrains Mono'", fontSize:16, fontWeight:600 };

  const misDescartes = (descartes||[]).filter(d => d.maquina===maquina && d.fecha===fecha && d.turno===turno);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      {modalDescarte && (
        <DescarteModal
          modal={modalDescarte}
          onClose={()=>setModalDescarte(null)}
          motivosScrap={motivosScrap||[]} motivosPendiente={motivosPendiente||[]} motivosFundicion={motivosFundicion||[]}
          onGuardar={(numeroPieza, motivo) => {
            if (modalDescarte.id) {
              updateDescarte(modalDescarte.id, { numeroPieza, motivo });
            } else {
              addDescarte({
                id: `DSC${Date.now()}`, categoria: modalDescarte.categoria, pieza: modalDescarte.piezaNumero,
                numeroPieza, motivo, maquina, turno, fecha, operario: operario?.numero || "—",
                createdAt: new Date().toISOString(),
              });
            }
            setModalDescarte(null);
          }}
          onEliminar={() => { removeDescarte(modalDescarte.id); setModalDescarte(null); }}
        />
      )}
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
              <button onClick={()=>setModalDescarte({ categoria:"scrap", piezaNumero:c.numero })} style={{ background:"none", border:"1px dashed #EF444466", borderRadius:6, padding:"5px 8px", color:"#EF4444", cursor:"pointer", fontSize:10.5, fontWeight:600, width:"100%", marginBottom:8 }}>+ registrar N° de pieza y motivo (SCRAP)</button>
              <QRow label="FUNDICIÓN" color="#f59e0b" field="fund" />
              <button onClick={()=>setModalDescarte({ categoria:"fundicion", piezaNumero:c.numero })} style={{ background:"none", border:"1px dashed #f59e0b66", borderRadius:6, padding:"5px 8px", color:"#f59e0b", cursor:"pointer", fontSize:10.5, fontWeight:600, width:"100%", marginBottom:8 }}>+ registrar N° de pieza y motivo (FUNDICIÓN)</button>
              <QRow label="PENDIENTE" color="#6B7280" field="pend" />
              <button onClick={()=>setModalDescarte({ categoria:"pendiente", piezaNumero:c.numero })} style={{ background:"none", border:"1px dashed #6B728066", borderRadius:6, padding:"5px 8px", color:"#6B7280", cursor:"pointer", fontSize:10.5, fontWeight:600, width:"100%", marginBottom:8 }}>+ registrar N° de pieza y motivo (PENDIENTE)</button>
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

      {/* Descartes cargados en esta carga (SCRAP / Fundición / Pendiente), editables */}
      {misDescartes.length > 0 && (
        <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem", display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:ORANGE, marginBottom:4 }}>DESCARTES CARGADOS ({misDescartes.length})</div>
          {misDescartes.map(d => {
            const info = { scrap:{txt:"SCRAP",color:"#EF4444"}, pendiente:{txt:"PENDIENTE",color:"#6B7280"}, fundicion:{txt:"FUNDICIÓN",color:"#f59e0b"} }[d.categoria] || {txt:d.categoria,color:"var(--muted)"};
            return (
              <button key={d.id} onClick={()=>setModalDescarte({ id:d.id, categoria:d.categoria, piezaNumero:d.pieza, numeroPieza:d.numeroPieza, motivo:d.motivo })}
                style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"10px 14px", display:"flex", justifyContent:"space-between", alignItems:"center", cursor:"pointer", textAlign:"left" }}>
                <div>
                  <span style={{ background:`${info.color}22`, color:info.color, fontSize:10, fontWeight:700, borderRadius:999, padding:"2px 8px", marginRight:8 }}>{info.txt}</span>
                  <span style={{ fontSize:13, color:"var(--text)" }}>Pieza N° {d.numeroPieza} · {d.pieza}</span>
                  <div style={{ fontSize:11, color:"var(--muted)", marginTop:2 }}>Motivo: {d.motivo}</div>
                </div>
                <span style={{ color:"var(--muted)", fontSize:12 }}>Editar →</span>
              </button>
            );
          })}
        </div>
      )}

      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:"1.25rem" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:2, color:ORANGE }}>PIEZAS POR HORA</div>
          <div style={{ fontSize:12, color:"var(--muted)" }}>{TURNOS_CONFIG[turno].label}</div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:`repeat(${Math.min(piezasPorHora.length, 5)},1fr)`, gap:6 }}>
          {piezasPorHora.map((val, i) => {
            const h = (TURNOS_CONFIG[turno].inicio + i) % 24;
            const hSig = (h + 1) % 24;
            const excluida = horasExcluidas[i];
            return (
              <div key={i} style={{ textAlign:"center" }}>
                <div style={{ fontSize:9, color:"var(--muted)", marginBottom:3 }}>{h}:00-{hSig}:00</div>
                <input type="number" value={val} disabled={excluida} onChange={e => { const n=[...piezasPorHora]; n[i]=e.target.value; setPiezasPorHora(n); }} placeholder={excluida?"—":"0"}
                  style={{ width:"100%", background: excluida ? "var(--border)" : "var(--surface2)", border:"1px solid var(--border)", borderRadius:6, padding:"6px 4px", color: excluida ? "var(--muted)" : "var(--text)", fontFamily:"'JetBrains Mono'", fontSize:14, outline:"none", textAlign:"center" }} />
                <button onClick={()=>toggleHoraExcluida(i)}
                  style={{ marginTop:3, width:"100%", background: excluida ? "#F59E0B" : "none", border: excluida ? "none" : "1px solid var(--border)", borderRadius:5, padding:"3px 2px", color: excluida ? "white" : "var(--muted)", fontSize:8.5, fontWeight:600, cursor:"pointer" }}>
                  {excluida ? "NO CONTAB." : "no funcionó"}
                </button>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize:11, color:"var(--muted)", marginTop:8 }}>Marcá "no funcionó" en las horas donde la máquina estuvo parada por completo (arranque tarde, corte, etc.) — no se van a contar como tiempo planificado a la hora de calcular el OEE.</div>
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
function ProdConfigView({ prodPin, setProdPin, operarios, setOperarios, piezas, setPiezas, motivos, setMotivos, machines, motivosScrap, setMotivosScrap, motivosPendiente, setMotivosPendiente, motivosFundicion, setMotivosFundicion }) {
  const [tab, setTab]           = useState("pin");
  const [newPin, setNewPin]     = useState("");
  const [confPin, setConfPin]   = useState("");
  const [msg, setMsg]           = useState(null);
  const [newPiezaMaq, setNewPiezaMaq] = useState(machines[0]?.name||"");
  const [newPiezaNum, setNewPiezaNum] = useState("");
  const [newPiezaCiclo, setNewPiezaCiclo] = useState("");
  const [newMotivo, setNewMotivo]     = useState("");
  const [editCicloId, setEditCicloId] = useState(null);
  const [editCicloVal, setEditCicloVal] = useState("");

  const handleSavePin = () => {
    if (newPin.length < 4)  { setMsg({ ok:false, text:"Mínimo 4 caracteres" }); return; }
    if (newPin !== confPin) { setMsg({ ok:false, text:"Los PINs no coinciden" }); return; }
    setProdPin(newPin); setNewPin(""); setConfPin("");
    setMsg({ ok:true, text:"✓ PIN actualizado" });
    setTimeout(() => setMsg(null), 3000);
  };
  const addPieza     = () => {
    if (!newPiezaNum.trim()) return;
    setPiezas(p=>[...p,{id:`pz${Date.now()}`,maquina:newPiezaMaq,numero:newPiezaNum.trim(),tiempoCiclo:parseFloat(newPiezaCiclo)||0}]);
    setNewPiezaNum(""); setNewPiezaCiclo("");
  };
  const remPieza     = (id) => { setPiezas(prev=>prev.filter(x=>x.id!==id)); };
  const startEditCiclo = (p) => { setEditCicloId(p.id); setEditCicloVal(p.tiempoCiclo ? String(p.tiempoCiclo) : ""); };
  const saveEditCiclo  = (id) => {
    setPiezas(prev => prev.map(x => x.id===id ? { ...x, tiempoCiclo: parseFloat(editCicloVal)||0 } : x));
    setEditCicloId(null); setEditCicloVal("");
  };
  const addMotivo    = () => {
    if (!newMotivo.trim()) return;
    const m = newMotivo.trim();
    setMotivos(p=>[...p,m]); setNewMotivo("");
  };
  const remMotivo    = (idx) => { setMotivos(p=>p.filter((_,i)=>i!==idx)); };

  const [newMotivoScrap, setNewMotivoScrap] = useState("");
  const [newMotivoPend, setNewMotivoPend]   = useState("");
  const [newMotivoFund, setNewMotivoFund]   = useState("");
  const addMotivoCat = (setter, val, clear) => { if (!val.trim()) return; setter(p=>[...p, val.trim()]); clear(""); };
  const remMotivoCat = (setter, idx) => setter(p=>p.filter((_,i)=>i!==idx));

  const configTabs = [
    { key:"pin",       label:"🔑 PIN" },
    { key:"operarios", label:"👷 Operarios" },
    { key:"piezas",    label:"⚙️ Piezas" },
    { key:"motivos",   label:"⏸ Motivos parada" },
    { key:"descartes", label:"🗑️ Motivos descarte" },
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
      {tab==="operarios" && <OperariosManager operarios={operarios} setOperarios={setOperarios} />}

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

      {/* Motivos de descarte: 3 listas independientes (SCRAP / Pendiente / Fundición) */}
      {tab==="descartes" && (
        <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
          {[
            { titulo:"SCRAP",     color:"#EF4444", lista:motivosScrap,     setLista:setMotivosScrap,     val:newMotivoScrap, setVal:setNewMotivoScrap },
            { titulo:"PENDIENTE", color:"#6B7280", lista:motivosPendiente, setLista:setMotivosPendiente, val:newMotivoPend,  setVal:setNewMotivoPend },
            { titulo:"FUNDICIÓN", color:"#f59e0b", lista:motivosFundicion, setLista:setMotivosFundicion, val:newMotivoFund,  setVal:setNewMotivoFund },
          ].map(({ titulo, color, lista, setLista, val, setVal }) => (
            <div key={titulo}>
              <div style={{ fontFamily:"'Bebas Neue'", fontSize:14, letterSpacing:1, color, marginBottom:8 }}>MOTIVOS DE {titulo}</div>
              <div style={{ display:"flex", gap:8, marginBottom:8 }}>
                <input value={val} onChange={e=>setVal(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addMotivoCat(setLista,val,setVal)} placeholder={`Nuevo motivo de ${titulo.toLowerCase()}...`}
                  style={{ flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"9px 11px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:13, outline:"none" }} />
                <button onClick={()=>addMotivoCat(setLista,val,setVal)} style={{ background:color, border:"none", borderRadius:8, padding:"9px 16px", fontFamily:"'Bebas Neue'", fontSize:13, cursor:"pointer", color:"white" }}>+ AGREGAR</button>
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                {lista.map((m, idx) => (
                  <div key={idx} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"9px 14px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <span style={{ fontSize:13, color:"var(--text)" }}>{m}</span>
                    <button onClick={()=>remMotivoCat(setLista, idx)} style={{ background:"none", border:"1px solid #EF444466", borderRadius:6, padding:"4px 10px", color:"#EF4444", cursor:"pointer", fontSize:11 }}>Eliminar</button>
                  </div>
                ))}
                {lista.length===0 && <div style={{ fontSize:12, color:"var(--muted)" }}>Todavía no hay motivos de {titulo.toLowerCase()} cargados.</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Vista de producción desde el puesto: cargar + ver turnos anteriores ──
function PuestoProduccionView({ addRegistro, operario, machines, piezas, motivos, defaultMaquina, registros, addDescarte, updateDescarte, removeDescarte, descartes, motivosScrap, motivosPendiente, motivosFundicion }) {
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

  // Banner de entrega de turno: resumen accionable del turno anterior de esta máquina
  const bannerEntrega = (() => {
    const ultimo = ultimos2[0];
    if (!ultimo) return null;
    const piezasN = normalizarRegistro(ultimo).piezasCargadas;
    const totalPend = piezasN.reduce((a, c) => a + (c.pendIzq || 0) + (c.pendDer || 0), 0);
    const totalParadaMin = (ultimo.paradas || []).reduce((a, p) => a + (p.minutos || 0), 0);
    if (totalPend === 0 && totalParadaMin === 0 && !ultimo.obs) return null;
    return (
      <div style={{ background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:14, padding:"12px 16px" }}>
        <div style={{ fontSize:11, color:"#9a6000", fontWeight:700, letterSpacing:1, textTransform:"uppercase", marginBottom:6 }}>
          📋 Entrega de turno — {ultimo.turno} ({ultimo.operario})
        </div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:8, fontSize:12 }}>
          {totalPend > 0 && <span style={{ background:"white", border:"1px solid #fed7aa", borderRadius:6, padding:"3px 9px", color:"#9a6000", fontWeight:600 }}>⏳ {totalPend} piezas pendientes</span>}
          {totalParadaMin > 0 && <span style={{ background:"white", border:"1px solid #fecaca", borderRadius:6, padding:"3px 9px", color:"#EF4444", fontWeight:600 }}>⏱ {totalParadaMin} min parado</span>}
        </div>
        {ultimo.obs && <div style={{ marginTop:8, fontSize:12, color:"var(--text)" }}>📝 {ultimo.obs}</div>}
      </div>
    );
  })();

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      {bannerEntrega}
      <div style={{ display:"flex", gap:8 }}>
        {[["cargar","➕ CARGAR"],["ver","👁 ÚLTIMOS 2 TURNOS"]].map(([key,lbl]) => (
          <button key={key} onClick={() => setSubTab(key)}
            style={{ flex:1, background:subTab===key?ORANGE:"var(--surface)", border:`1px solid ${subTab===key?ORANGE:"var(--border)"}`, borderRadius:10, padding:"10px 6px", color:subTab===key?"white":"var(--muted)", fontFamily:"'Bebas Neue'", fontSize:13, letterSpacing:1, cursor:"pointer" }}>
            {lbl}
          </button>
        ))}
      </div>

      {subTab==="cargar" && (
        <NuevaCargaView addRegistro={addRegistro} operario={operario} machines={machines} piezas={piezas} motivos={motivos} defaultMaquina={defaultMaquina}
          addDescarte={addDescarte} updateDescarte={updateDescarte} removeDescarte={removeDescarte} descartes={descartes||[]}
          motivosScrap={motivosScrap} motivosPendiente={motivosPendiente} motivosFundicion={motivosFundicion} />
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
