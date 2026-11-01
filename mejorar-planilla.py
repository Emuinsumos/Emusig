#!/usr/bin/env python3
# Mejora la planilla de calidad del operario en App.jsx. Todo o nada, idempotente.
import sys, hashlib
ruta = sys.argv[1] if len(sys.argv) > 1 else "src/App.jsx"
src = open(ruta, encoding="utf-8", newline="").read()
if "function aNumero(" in src:
    print("Ya estaba aplicado. No hice nada."); sys.exit(0)
crlf = "\r\n" in src
if crlf: src = src.replace("\r\n", "\n")

NUEVA = r'''function CalidadColumna({ plantilla, registros, setRegistro, operario, maquina, onCerrar }) {
  const registroActivo = registros.find(r => r.plantillaId === plantilla.id && r.maquina === maquina && r.operario === operario?.numero && r.estado === "en_progreso");
  const filas = registroActivo?.filas || [];
  const numeroInicial = registroActivo?.numeroInicial || "";
  const numeroFinal   = registroActivo?.numeroFinal || "";
  const [abiertaIdx, setAbiertaIdx] = useState(null);
  const [buscar, setBuscar]         = useState("");
  const piezaAbiertaRef = useRef(null);

  // Al abrir una pieza la lleva a la vista: con muchas piezas cargadas, el operario
  // perdía de vista la que estaba llenando y tenía que scrollear a mano.
  useEffect(() => {
    if (abiertaIdx !== null && piezaAbiertaRef.current) piezaAbiertaRef.current.scrollIntoView({ behavior:"smooth", block:"start" });
  }, [abiertaIdx]);

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
  const quitarFila = (idxFila) => {
    if (!window.confirm(`¿Quitar la pieza N° ${filas[idxFila]?.numeroPieza}? Se pierden sus medidas.`)) return;
    guardar({ filas: filas.filter((_,i)=>i!==idxFila) });
    setAbiertaIdx(null);
  };

  // Estado de cada pieza: cuántas medidas están fuera de tolerancia y cuántas faltan cargar.
  const estadoFila = (fila, idx) => {
    const aplicables = plantilla.campos.filter(c => aplicaEnPosicion(c, idx+1));
    const evs = aplicables.map(c => evaluarMedida(c, fila.valores[c.id]));
    const fuera = evs.filter(e => e.fuera).length;
    const faltan = evs.filter(e => !e.tieneValor).length;
    return { aplicables, fuera, faltan, completa: aplicables.length>0 && faltan===0 };
  };
  const resumen = filas.reduce((a, f, i) => {
    const e = estadoFila(f, i);
    if (e.fuera) a.fuera++;
    if (e.faltan) a.incompletas++;
    return a;
  }, { fuera:0, incompletas:0 });

  const puedeEnviar = filas.length>0 && !!numeroInicial && !!numeroFinal;
  const enviar = () => {
    if (!registroActivo || !puedeEnviar) return;
    // Antes de enviar muestra un resumen: una vez enviada la planilla el operario ya no la puede editar.
    const lineas = ["¿Enviar la planilla a Calidad?", "", `• ${filas.length} pieza${filas.length===1?"":"s"} · N° ${numeroInicial} a ${numeroFinal}`];
    if (resumen.fuera) lineas.push(`• ⚠ ${resumen.fuera} pieza${resumen.fuera===1?"":"s"} con medidas fuera de tolerancia`);
    if (resumen.incompletas) lineas.push(`• ${resumen.incompletas} pieza${resumen.incompletas===1?"":"s"} con medidas sin cargar`);
    lineas.push("", "Después de enviarla no la podés editar.");
    if (!window.confirm(lineas.join("\n"))) return;
    setRegistro({ ...registroActivo, estado:"enviado", enviadoAt:new Date().toISOString() });
    onCerrar();
  };

  // Enter pasa al campo siguiente de la misma pieza (el teclado del celular muestra "Siguiente").
  const irSiguiente = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const tarjeta = e.currentTarget.closest("[data-cal-pieza]");
    const campos = tarjeta ? Array.from(tarjeta.querySelectorAll("input[data-cal-campo]")) : [];
    const i = campos.indexOf(e.currentTarget);
    if (i >= 0 && i < campos.length-1) campos[i+1].focus(); else e.currentTarget.blur();
  };
  const fmtDif = (n) => String(+Number(n).toFixed(4));

  const buscarIdx = buscar.trim() ? filas.findIndex(f => String(f.numeroPieza) === buscar.trim()) : -1;

  // Medidas numéricas controladas al 100% de las piezas: acá sí tiene sentido
  // mostrar un mini gráfico de variación a lo largo de la tanda.
  const camposConGrafico = plantilla.campos.filter(c => c.tipo==="numero" && c.critica);

  const inputBase = { width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 12px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:14, fontWeight:700, outline:"none" };

  return (
    <div style={{ flex:"1 0 min(340px, 100%)", maxWidth:520, minWidth:0, display:"flex", flexDirection:"column", gap:10 }}>
      <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:14, padding:"12px 14px", display:"flex", flexDirection:"column", gap:8 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, color:"#7C3AED", letterSpacing:1 }}>{plantilla.nombre}</div>
            <div style={{ fontSize:11, color:"var(--muted)" }}>{plantilla.piezaCodigo}</div>
          </div>
          <button onClick={onCerrar} style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"5px 10px", color:"var(--muted)", cursor:"pointer", fontSize:12 }}>✕</button>
        </div>
        {filas.length > 0 && (
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
            <span style={{ fontSize:11, fontWeight:700, padding:"3px 9px", borderRadius:99, background:"var(--surface2)", color:"var(--text)" }}>{filas.length} pieza{filas.length===1?"":"s"}</span>
            {resumen.fuera > 0 && <span style={{ fontSize:11, fontWeight:700, padding:"3px 9px", borderRadius:99, background:"#FEF2F2", color:"#B91C1C" }}>⚠ {resumen.fuera} fuera de tolerancia</span>}
            {resumen.incompletas > 0 && <span style={{ fontSize:11, fontWeight:700, padding:"3px 9px", borderRadius:99, background:"#fff7ed", color:"#9a6000" }}>{resumen.incompletas} sin completar</span>}
            {resumen.fuera === 0 && resumen.incompletas === 0 && <span style={{ fontSize:11, fontWeight:700, padding:"3px 9px", borderRadius:99, background:"#E7F5EF", color:"#166534" }}>✓ todo dentro de tolerancia</span>}
          </div>
        )}
      </div>

      <div style={{ background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:12, padding:"12px 14px" }}>
        <label style={{ fontSize:11, color:"#9a6000", fontWeight:700, display:"block", marginBottom:4 }}>N° de pieza inicial (al arrancar el turno)</label>
        <input value={numeroInicial} onChange={e=>setNumeroInicial(e.target.value)} placeholder="ej: 540" inputMode="numeric" disabled={filas.length>0}
          style={{ width:"100%", background: filas.length>0 ? "var(--surface2)" : "white", border:"1px solid #fed7aa", borderRadius:8, padding:"10px 12px", color:"var(--text)", fontFamily:"'JetBrains Mono'", fontSize:16, fontWeight:700, outline:"none" }} />
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
        const { aplicables: camposAplicables, fuera: cantFuera, faltan, completa: todasCargadas } = estadoFila(fila, idx);
        const algunaFuera = cantFuera > 0;

        if (!abierta) {
          return (
            <button key={idx} onClick={()=>setAbiertaIdx(idx)}
              style={{ background:"var(--surface)", border:`1px solid ${algunaFuera?"#EF444466":"var(--border)"}`, borderRadius:12, padding:"12px 14px", display:"flex", justifyContent:"space-between", alignItems:"center", cursor:"pointer", textAlign:"left" }}>
              <span style={{ fontFamily:"'Bebas Neue'", fontSize:14, color:"var(--text)", letterSpacing:1 }}>PIEZA N° {fila.numeroPieza}</span>
              <span style={{ display:"flex", alignItems:"center", gap:6 }}>
                {algunaFuera && <span style={{ fontSize:11, color:"#EF4444", fontWeight:700 }}>⚠ fuera de tolerancia</span>}
                {!algunaFuera && faltan>0 && <span style={{ fontSize:11, color:"#9a6000", fontWeight:700 }}>faltan {faltan}</span>}
                {!algunaFuera && todasCargadas && <span style={{ fontSize:11, color:"#16a34a", fontWeight:700 }}>✓</span>}
                <span style={{ color:"var(--muted)", fontSize:13 }}>▾</span>
              </span>
            </button>
          );
        }

        return (
          <div key={idx} ref={piezaAbiertaRef} data-cal-pieza="1" style={{ background:"var(--surface)", border:`1px solid ${algunaFuera?"#EF444466":"var(--border)"}`, borderRadius:14, padding:"14px 16px", display:"flex", flexDirection:"column", gap:12, scrollMarginTop:12 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:10 }}>
              <button onClick={()=>setAbiertaIdx(null)} style={{ background:"none", border:"none", padding:0, cursor:"pointer", display:"flex", alignItems:"center", gap:6 }}>
                <span style={{ fontFamily:"'Bebas Neue'", fontSize:16, color:"var(--text)", letterSpacing:1 }}>PIEZA N° {fila.numeroPieza}</span>
                <span style={{ color:"var(--muted)", fontSize:13 }}>▴ minimizar</span>
              </button>
              <button onClick={()=>quitarFila(idx)} style={{ background:"none", border:"none", color:"#EF4444", cursor:"pointer", fontSize:12, flexShrink:0 }}>Quitar</button>
            </div>
            {faltan > 0 && <div style={{ fontSize:11.5, color:"#9a6000", fontWeight:600, marginTop:-6 }}>Faltan cargar {faltan} medida{faltan===1?"":"s"}</div>}
            {camposAplicables.map(campo => {
              const val = fila.valores[campo.id];
              const ev = evaluarMedida(campo, val);
              const { dentro, fuera } = ev;
              return (
                <div key={campo.id}>
                  <label style={{ fontSize:12, color:"var(--muted)", display:"block", marginBottom:5 }}>
                    <b style={{ color:"var(--text)" }}>{campo.label}</b> {campo.tipo!=="tapon" && <span style={{ color:"#9AA7AE" }}>· nom. {campo.nominal!==""?campo.nominal:"—"} · [{campo.tolMin} a {campo.tolMax}]</span>}
                  </label>
                  {campo.tipo === "tapon" ? (
                    <div style={{ display:"flex", gap:8 }}>
                      <button onClick={()=>setValor(idx, campo.id, "OK")}
                        style={{ flex:1, padding:"14px", borderRadius:10, border:`2px solid ${val==="OK"?"#16a34a":"var(--border)"}`, background: val==="OK"?"#16a34a":"var(--surface2)", color: val==="OK"?"white":"var(--muted)", fontWeight:700, fontSize:15, cursor:"pointer" }}>OK</button>
                      <button onClick={()=>setValor(idx, campo.id, "NOK")}
                        style={{ flex:1, padding:"14px", borderRadius:10, border:`2px solid ${val==="NOK"?"#EF4444":"var(--border)"}`, background: val==="NOK"?"#EF4444":"var(--surface2)", color: val==="NOK"?"white":"var(--muted)", fontWeight:700, fontSize:15, cursor:"pointer" }}>NO OK</button>
                    </div>
                  ) : (
                    <>
                      <input data-cal-campo="1" value={val ?? ""} onChange={e=>setValor(idx, campo.id, e.target.value.replace(",", "."))} onKeyDown={irSiguiente} inputMode="decimal" enterKeyHint="next"
                        style={{ ...inputBase, textAlign:"left", padding:"13px 14px", fontSize:17,
                          background: dentro ? "#E7F5EF" : fuera ? "#FEF2F2" : "var(--surface2)",
                          border:`2px solid ${dentro ? "#16a34a" : fuera ? "#EF4444" : "var(--border)"}`,
                          color: dentro ? "#166534" : fuera ? "#B91C1C" : "var(--text)" }} />
                      {fuera && (
                        <div style={{ fontSize:12, color:"#B91C1C", fontWeight:700, marginTop:5 }}>
                          {ev.alto
                            ? `▲ Fuera de tolerancia: pasa ${fmtDif(aNumero(val) - Number(campo.tolMax))} del máximo (${campo.tolMax})`
                            : `▼ Fuera de tolerancia: le faltan ${fmtDif(Number(campo.tolMin) - aNumero(val))} para el mínimo (${campo.tolMin})`}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
            <div>
              <label style={{ fontSize:12, color:"var(--muted)", display:"block", marginBottom:5 }}>Comentario</label>
              <input data-cal-campo="1" value={fila.comentario||""} onChange={e=>setComentario(idx, e.target.value)} onKeyDown={irSiguiente} placeholder="Observación (opcional)"
                style={{ ...inputBase, fontFamily:"'DM Sans'", fontWeight:400, fontSize:14 }} />
            </div>
            {idx === filas.length-1 && (
              <button onClick={agregarFila}
                style={{ background:"#7C3AED", border:"none", borderRadius:12, padding:"15px", fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:1, color:"white", cursor:"pointer" }}>SIGUIENTE PIEZA ▶</button>
            )}
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
          style={{ ...inputBase, fontSize:16 }} />
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
'''

def una_vez(txt, s):
    if txt.count(s) != 1:
        print("ERROR: no encuentro un ancla esperada (el archivo cambió). No toqué nada:\n  " + s[:70]); sys.exit(1)

# 1) reemplazo de CalidadColumna
a = src.find("function CalidadColumna(")
b = src.find("\nfunction PuestoView(")
if a < 0 or b < a: print("ERROR: no encuentro CalidadColumna. No toqué nada."); sys.exit(1)
viejo = src[a:b]
if hashlib.sha256(viejo.encode()).hexdigest() != "7fddb4bec385295853370500599414fe0e562a16b664b7db9d8b96a2387043e3":
    print("ERROR: CalidadColumna fue modificada a mano; el parche no aplica. No toqué nada."); sys.exit(1)
out = src[:a] + NUEVA.rstrip("\n") + "\n" + src[b:]

# 2) helper + evaluarMedida + parseFloat con coma
reemplazos = [
 ("function calcularCpk(campo, filas) {\n  const valores = filas.map(f => parseFloat(f.valores[campo.id]))",
  "function aNumero(v) { return parseFloat(String(v ?? \"\").replace(\",\", \".\")); }\n\nfunction calcularCpk(campo, filas) {\n  const valores = filas.map(f => aNumero(f.valores[campo.id]))"),
 ("val: parseFloat(f.valores[campo.id]) }))", "val: aNumero(f.valores[campo.id]) }))"),
 ("  const num = parseFloat(val);\n  const tieneValor = val !== \"\" && val != null && !isNaN(num);\n  const dentro = tieneValor && num >= campo.tolMin && num <= campo.tolMax;\n  return { tieneValor, dentro, fuera: tieneValor && !dentro };",
  "  const num = aNumero(val);\n  const tieneValor = val !== \"\" && val != null && !isNaN(num);\n  const dentro = tieneValor && num >= campo.tolMin && num <= campo.tolMax;\n  return { tieneValor, dentro, fuera: tieneValor && !dentro, alto: tieneValor && num > campo.tolMax, bajo: tieneValor && num < campo.tolMin };"),
 ("const puntos = (r.filas||[]).map(f=>parseFloat(f.valores[c.id]))", "const puntos = (r.filas||[]).map(f=>aNumero(f.valores[c.id]))"),
]
for o, n in reemplazos:
    una_vez(out, o); out = out.replace(o, n)
if crlf: out = out.replace("\n", "\r\n")
open(ruta, "w", encoding="utf-8", newline="").write(out)
print("Listo: planilla del operario mejorada.")
