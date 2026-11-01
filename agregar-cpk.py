#!/usr/bin/env python3
# Agrega la pestaña CPK (con fechas desde/hasta) a Calidad. Todo o nada, idempotente.
import sys
ruta = sys.argv[1] if len(sys.argv) > 1 else "src/App.jsx"
src = open(ruta, encoding="utf-8", newline="").read()
if "function CalidadCpkView(" in src:
    print("Ya estaba aplicado. No hice nada."); sys.exit(0)
crlf = "\r\n" in src
if crlf: src = src.replace("\r\n", "\n")
NUEVO = r'''// ── Calidad → CPK: capacidad de proceso por pieza / máquina / cota y rango de fechas ──
// Los registros que el SIG tiene en memoria son solo los últimos 60 días, así que
// esta pantalla pide a Firebase lo que necesita según el "Desde" elegido.
function cpkNum(v) { return parseFloat(String(v ?? "").replace(",", ".")); }
function cpkFechaLocal(d) { const z = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`; }
function cpkHaceDias(n) { const d = new Date(); d.setDate(d.getDate() - n); return cpkFechaLocal(d); }
function cpkEstado(v) {
  if (v == null) return { txt: "Sin datos", color: "#9AA7AE", bg: "var(--surface2)" };
  if (v >= 1.67) return { txt: "Muy capaz (≥ 1,67)", color: "#166534", bg: "#E7F5EF" };
  if (v >= 1.33) return { txt: "Capaz (≥ 1,33)", color: "#166534", bg: "#E7F5EF" };
  if (v >= 1.0)  return { txt: "Condicional (1,00 a 1,33)", color: "#9a6000", bg: "#fff7ed" };
  return { txt: "No capaz (< 1,00)", color: "#B91C1C", bg: "#FEF2F2" };
}
const cpkFmt = (v, d=2) => v == null ? "—" : v === Infinity ? "∞" : Number(v).toFixed(d).replace(".", ",");

// Estadística de una serie de valores contra los límites. Cpk con σ global (igual que el resto
// del SIG); Cpk corto plazo con σ estimada del rango móvil (MR̄ / 1,128).
function cpkCalcular(valores, lsl, usl) {
  const n = valores.length;
  if (n < 2) return null;
  const media = valores.reduce((a,v)=>a+v,0) / n;
  const sigma = Math.sqrt(valores.reduce((a,v)=>a+(v-media)**2,0) / (n-1));
  let mr = 0; for (let i=1;i<n;i++) mr += Math.abs(valores[i]-valores[i-1]);
  const sigmaCp = (mr/(n-1)) / 1.128;
  const tieneL = Number.isFinite(lsl), tieneU = Number.isFinite(usl);
  const calc = (s) => {
    if (s === 0) return { cp: tieneL&&tieneU ? Infinity : null, cpk: Infinity };
    const cpu = tieneU ? (usl-media)/(3*s) : Infinity, cpl = tieneL ? (media-lsl)/(3*s) : Infinity;
    return { cp: tieneL&&tieneU ? (usl-lsl)/(6*s) : null, cpk: Math.min(cpu, cpl) };
  };
  const g = calc(sigma), c = calc(sigmaCp);
  const fuera = valores.filter(v => (tieneL && v<lsl) || (tieneU && v>usl)).length;
  return { n, media, sigma, sigmaCp, cp: g.cp, cpk: g.cpk, cpkCorto: c.cpk, fuera, min: Math.min(...valores), max: Math.max(...valores) };
}

function CpkGraficoCorrida({ puntos, lsl, usl, st }) {
  const W = 640, H = 230, pl = 46, pr = 12, pt = 12, pb = 26;
  const vals = puntos.map(p => p.v);
  const lo = Math.min(...vals, Number.isFinite(lsl)?lsl:Infinity, st.media-3*st.sigma);
  const hi = Math.max(...vals, Number.isFinite(usl)?usl:-Infinity, st.media+3*st.sigma);
  const pad = (hi-lo)*0.06 || 1, mn = lo-pad, mx = hi+pad;
  const x = (i) => pl + (puntos.length===1 ? 0 : i/(puntos.length-1)) * (W-pl-pr);
  const y = (v) => pt + (1-(v-mn)/(mx-mn)) * (H-pt-pb);
  const path = puntos.map((p,i)=>`${i?"L":"M"}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const ticks = [0,1,2,3,4].map(k => mn + (mx-mn)*k/4);
  const linea = (v, color, etq, dash) => Number.isFinite(v) && (
    <g key={etq}>
      <line x1={pl} x2={W-pr} y1={y(v)} y2={y(v)} stroke={color} strokeWidth={1.4} strokeDasharray={dash} />
      <text x={W-pr-2} y={y(v)-3} textAnchor="end" fontSize={10} fontWeight={700} fill={color}>{etq}</text>
    </g>
  );
  const r = puntos.length > 150 ? 1.6 : puntos.length > 60 ? 2.4 : 3.4;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display:"block" }} role="img" aria-label="Gráfico de corrida">
      {Number.isFinite(lsl)&&Number.isFinite(usl) && <rect x={pl} y={y(usl)} width={W-pl-pr} height={y(lsl)-y(usl)} fill="#16a34a" opacity={0.07} />}
      {ticks.map((t,i)=>(<g key={i}><line x1={pl} x2={W-pr} y1={y(t)} y2={y(t)} stroke="#e5e7eb" strokeWidth={0.8}/><text x={pl-5} y={y(t)+3} textAnchor="end" fontSize={10} fill="#6b7280">{t.toFixed(3)}</text></g>))}
      {linea(usl, "#EF4444", `LSE ${usl}`, "")}
      {linea(lsl, "#EF4444", `LIE ${lsl}`, "")}
      {linea(st.media, "#2563eb", `media ${st.media.toFixed(3)}`, "")}
      {linea(st.media+3*st.sigma, "#9AA7AE", "+3σ", "5 4")}
      {linea(st.media-3*st.sigma, "#9AA7AE", "−3σ", "5 4")}
      <path d={path} fill="none" stroke="#7C3AED" strokeWidth={1} opacity={0.55} />
      {puntos.map((p,i)=>{
        const fuera = (Number.isFinite(lsl)&&p.v<lsl) || (Number.isFinite(usl)&&p.v>usl);
        return <circle key={i} cx={x(i)} cy={y(p.v)} r={fuera ? r+1.2 : r} fill={fuera?"#EF4444":"#16a34a"} stroke="#fff" strokeWidth={0.6}><title>{`Pieza ${p.pieza||"—"} · ${p.maquina} · ${p.fecha}: ${p.v}`}</title></circle>;
      })}
      <text x={pl} y={H-8} fontSize={10} fill="#6b7280">{puntos[0].fecha}</text>
      <text x={W-pr} y={H-8} textAnchor="end" fontSize={10} fill="#6b7280">{puntos[puntos.length-1].fecha}</text>
      <text x={(pl+W-pr)/2} y={H-8} textAnchor="middle" fontSize={10} fill="#6b7280">{puntos.length} piezas en orden cronológico</text>
    </svg>
  );
}

function CpkHistograma({ valores, lsl, usl, st }) {
  const W = 640, H = 190, pl = 30, pr = 12, pt = 12, pb = 24;
  const lo = Math.min(st.min, Number.isFinite(lsl)?lsl:Infinity), hi = Math.max(st.max, Number.isFinite(usl)?usl:-Infinity);
  const rango = (hi-lo) || 1, mn = lo-rango*0.05, mx = hi+rango*0.05;
  const nb = Math.max(6, Math.min(16, Math.round(Math.sqrt(valores.length)*1.4)));
  const bw = (mx-mn)/nb, cuentas = new Array(nb).fill(0);
  valores.forEach(v => { cuentas[Math.min(nb-1, Math.floor((v-mn)/bw))]++; });
  const normal = (v) => st.sigma>0 ? valores.length*bw*Math.exp(-0.5*((v-st.media)/st.sigma)**2)/(st.sigma*Math.sqrt(2*Math.PI)) : 0;
  const curva = Array.from({length:61},(_,k)=>mn+(mx-mn)*k/60);
  const ymax = Math.max(...cuentas, ...curva.map(normal))*1.1 || 1;
  const x = (v) => pl + (v-mn)/(mx-mn)*(W-pl-pr), y = (c) => pt + (1-c/ymax)*(H-pt-pb);
  const marca = (v, color, etq) => Number.isFinite(v) && (<g key={etq}><line x1={x(v)} x2={x(v)} y1={pt} y2={H-pb} stroke={color} strokeWidth={1.6}/><text x={x(v)+(etq==="LIE"?-3:3)} y={pt+9} textAnchor={etq==="LIE"?"end":"start"} fontSize={10} fontWeight={700} fill={color}>{etq}</text></g>);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display:"block" }} role="img" aria-label="Histograma">
      <line x1={pl} x2={W-pr} y1={H-pb} y2={H-pb} stroke="#9AA7AE" />
      {cuentas.map((c,i)=>{
        const centro = mn+bw*(i+0.5), fuera = (Number.isFinite(lsl)&&centro<lsl)||(Number.isFinite(usl)&&centro>usl);
        return <rect key={i} x={x(mn+bw*i)+1} y={y(c)} width={Math.max(1,x(mn+bw*(i+1))-x(mn+bw*i)-2)} height={H-pb-y(c)} fill={fuera?"#EF4444":"#7C3AED"} opacity={0.55}><title>{`${(mn+bw*i).toFixed(3)} a ${(mn+bw*(i+1)).toFixed(3)}: ${c} pieza(s)`}</title></rect>;
      })}
      <path d={curva.map((v,k)=>`${k?"L":"M"}${x(v).toFixed(1)} ${y(normal(v)).toFixed(1)}`).join(" ")} fill="none" stroke="#2563eb" strokeWidth={1.6} />
      {marca(lsl, "#EF4444", "LIE")}{marca(usl, "#EF4444", "LSE")}
      <line x1={x(st.media)} x2={x(st.media)} y1={pt} y2={H-pb} stroke="#2563eb" strokeWidth={1} strokeDasharray="4 3" />
      <text x={pl} y={H-8} fontSize={10} fill="#6b7280">{mn.toFixed(3)}</text>
      <text x={W-pr} y={H-8} textAnchor="end" fontSize={10} fill="#6b7280">{mx.toFixed(3)}</text>
      <text x={(pl+W-pr)/2} y={H-8} textAnchor="middle" fontSize={10} fill="#6b7280">curva azul: distribución normal teórica con la media y σ medidas</text>
    </svg>
  );
}

function CalidadCpkView({ plantillas, registros }) {
  const [plantillaId, setPlantillaId] = useState("");
  const [campoId, setCampoId]         = useState("");
  const [maquina, setMaquina]         = useState("");
  const [desde, setDesde]             = useState(cpkHaceDias(30));
  const [hasta, setHasta]             = useState(cpkFechaLocal(new Date()));
  const [datos, setDatos]             = useState(null);
  const [cargando, setCargando]       = useState(false);
  const [errCarga, setErrCarga]       = useState("");

  // Trae de Firebase los registros desde la fecha elegida. Si falla, usa lo que el SIG ya tenía cargado.
  useEffect(() => {
    let vivo = true;
    setCargando(true); setErrCarga("");
    const d0 = desde ? new Date(desde + "T00:00:00") : null;
    if (d0) d0.setDate(d0.getDate() - 1); // createdAt es anterior o igual a enviadoAt
    const inicio = d0 ? d0.toISOString() : "";
    get(query(ref(_db, "calidadRegistros"), orderByChild("createdAt"), startAt(inicio)))
      .then(snap => { if (vivo) { const v = snap.val() || {}; setDatos(Object.values(v)); setCargando(false); } })
      .catch(() => { if (vivo) { setDatos(registros || []); setErrCarga("No pude consultar el historial completo; muestro solo lo que ya estaba cargado (últimos 60 días)."); setCargando(false); } });
    return () => { vivo = false; };
  }, [desde]);

  const fuente = datos || registros || [];
  const fechaDe = (r) => (r.enviadoAt || r.createdAt || "");
  const enRango = (r) => {
    if (r.estado !== "enviado") return false;
    const f = cpkFechaLocal(new Date(fechaDe(r) || 0));
    return (!desde || f >= desde) && (!hasta || f <= hasta);
  };
  const plantilla = plantillas.find(p => p.id === plantillaId);
  const camposNum = (plantilla?.campos || []).filter(c => c.tipo === "numero" && Number.isFinite(cpkNum(c.tolMin)) && Number.isFinite(cpkNum(c.tolMax)))
    .sort((a,b) => (b.critica?1:0) - (a.critica?1:0));
  const campo = camposNum.find(c => c.id === campoId);

  const delRango = plantilla ? fuente.filter(r => r.plantillaId === plantilla.id && enRango(r)).sort((a,b) => fechaDe(a).localeCompare(fechaDe(b))) : [];
  const maquinas = [...new Set(delRango.map(r => r.maquina))].sort();
  const lsl = campo ? cpkNum(campo.tolMin) : NaN, usl = campo ? cpkNum(campo.tolMax) : NaN;

  const serie = (reg) => {
    const out = [];
    reg.forEach(r => (r.filas || []).forEach(f => {
      const v = cpkNum(f.valores?.[campo.id]);
      if (!isNaN(v)) out.push({ v, pieza: f.numeroPieza, maquina: r.maquina, fecha: cpkFechaLocal(new Date(fechaDe(r) || 0)) });
    }));
    return out;
  };
  const puntos = campo ? serie(maquina ? delRango.filter(r => r.maquina === maquina) : delRango) : [];
  const valores = puntos.map(p => p.v);
  const st = campo ? cpkCalcular(valores, lsl, usl) : null;
  const estado = cpkEstado(st ? st.cpk : null);
  const porMaquina = campo && !maquina ? maquinas.map(m => ({ m, st: cpkCalcular(serie(delRango.filter(r => r.maquina === m)).map(p => p.v), lsl, usl) })).filter(x => x.st) : [];

  const atajo = (dias) => { setDesde(dias == null ? "" : cpkHaceDias(dias)); setHasta(cpkFechaLocal(new Date())); };
  const sel = { width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"10px 12px", color:"var(--text)", fontFamily:"'DM Sans'", fontSize:14, outline:"none" };
  const lab = { fontSize:10, color:"var(--muted)", fontWeight:700, textTransform:"uppercase", letterSpacing:1, display:"block", marginBottom:4 };
  const chip = (act) => ({ background: act ? "#7C3AED" : "var(--surface)", color: act ? "white" : "var(--muted)", border:`1px solid ${act ? "#7C3AED" : "var(--border)"}`, borderRadius:99, padding:"6px 12px", fontSize:12, fontWeight:600, cursor:"pointer" });
  const card = { background:"var(--surface)", border:"1px solid var(--border)", borderRadius:14, padding:"14px 16px" };

  const descargarPdf = () => {
    if (!st || !campo) return;
    const doc = new jsPDF({ unit:"mm", format:"a4" });
    const mx = 15, W = 180; let y = 20;
    doc.setFont("helvetica","bold"); doc.setFontSize(14); doc.text("INFORME DE CAPACIDAD DE PROCESO (CPK)", mx, y); y += 7;
    doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(80);
    doc.text(`Pieza: ${plantilla.piezaCodigo} — ${plantilla.nombre}`, mx, y); y += 5;
    doc.text(`Cota: ${campo.label}   Nominal: ${campo.nominal ?? "—"}   LIE: ${lsl}   LSE: ${usl}`, mx, y); y += 5;
    doc.text(`Máquina: ${maquina || "todas"}   Período: ${desde || "inicio"} a ${hasta || "hoy"}`, mx, y); y += 5;
    doc.text(`Emitido: ${new Date().toLocaleString("es-AR")}`, mx, y); y += 8;
    doc.setTextColor(0); doc.setFont("helvetica","bold"); doc.setFontSize(12);
    doc.text(`Cpk = ${cpkFmt(st.cpk)}   —   ${estado.txt}`, mx, y); y += 7;
    doc.setFont("helvetica","normal"); doc.setFontSize(10);
    [`Piezas medidas: ${st.n}      Fuera de tolerancia: ${st.fuera}`,
     `Media: ${st.media.toFixed(4)}      Desvío estándar (σ): ${st.sigma.toFixed(4)}`,
     `Cp: ${cpkFmt(st.cp)}      Cpk corto plazo (rango móvil): ${cpkFmt(st.cpkCorto)}`,
     `Mínimo: ${st.min}      Máximo: ${st.max}`].forEach(t => { doc.text(t, mx, y); y += 5.5; });
    if (st.n < 30) { doc.setTextColor(180,83,9); doc.text("Atención: menos de 30 piezas; el índice es poco confiable.", mx, y); doc.setTextColor(0); y += 6; }
    y += 2;
    const ch = 70, vmin = Math.min(...valores, lsl, st.media-3*st.sigma), vmax = Math.max(...valores, usl, st.media+3*st.sigma);
    const rg = (vmax-vmin)||1, py = (v) => y + ch - ((v-vmin)/rg)*ch, px = (i) => mx + (valores.length===1?0:i/(valores.length-1))*W;
    doc.setFillColor(231,245,239); doc.rect(mx, py(usl), W, py(lsl)-py(usl), "F");
    doc.setDrawColor(239,68,68); doc.setLineWidth(0.4); doc.line(mx, py(usl), mx+W, py(usl)); doc.line(mx, py(lsl), mx+W, py(lsl));
    doc.setDrawColor(37,99,235); doc.line(mx, py(st.media), mx+W, py(st.media));
    doc.setFontSize(8); doc.setTextColor(239,68,68); doc.text(`LSE ${usl}`, mx+W, py(usl)-1, { align:"right" }); doc.text(`LIE ${lsl}`, mx+W, py(lsl)+3, { align:"right" });
    doc.setDrawColor(124,58,237); doc.setLineWidth(0.2);
    for (let i=0;i<valores.length-1;i++) doc.line(px(i), py(valores[i]), px(i+1), py(valores[i+1]));
    valores.forEach((v,i) => { const f = v<lsl||v>usl; doc.setFillColor(...(f?[220,38,38]:[22,163,74])); doc.circle(px(i), py(v), 0.6, "F"); });
    y += ch + 8; doc.setTextColor(90); doc.setFontSize(8);
    doc.text("Cpk con σ global de todas las piezas del período. Verde = dentro de tolerancia; rojo = fuera.", mx, y);
    doc.save(`SGI_cpk_${plantilla.piezaCodigo}_${campo.label.replace(/[^a-z0-9]+/gi,"_")}_${hasta || "hoy"}.pdf`);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <div style={{ ...card, display:"flex", flexDirection:"column", gap:12 }}>
        <div>
          <label style={lab}>Pieza</label>
          <select value={plantillaId} onChange={e=>{ setPlantillaId(e.target.value); setCampoId(""); setMaquina(""); }} style={sel}>
            <option value="">Elegí una pieza…</option>
            {plantillas.map(p => <option key={p.id} value={p.id}>{p.piezaCodigo} · {p.nombre}</option>)}
          </select>
        </div>
        {plantilla && (
          <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
            <div style={{ flex:"1 1 200px", minWidth:0 }}>
              <label style={lab}>Cota</label>
              <select value={campoId} onChange={e=>setCampoId(e.target.value)} style={sel}>
                <option value="">Elegí una cota…</option>
                {camposNum.map(c => <option key={c.id} value={c.id}>{c.label}{c.critica ? " ★" : ""}</option>)}
              </select>
            </div>
            <div style={{ flex:"1 1 160px", minWidth:0 }}>
              <label style={lab}>Máquina</label>
              <select value={maquina} onChange={e=>setMaquina(e.target.value)} style={sel}>
                <option value="">Todas las máquinas</option>
                {maquinas.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
        )}
        <div>
          <label style={lab}>Período</label>
          <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginBottom:8 }}>
            <input type="date" value={desde} max={hasta || undefined} onChange={e=>setDesde(e.target.value)} style={{ ...sel, flex:"1 1 140px", width:"auto" }} aria-label="Desde" />
            <input type="date" value={hasta} min={desde || undefined} onChange={e=>setHasta(e.target.value)} style={{ ...sel, flex:"1 1 140px", width:"auto" }} aria-label="Hasta" />
          </div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
            {[["7 días",7],["30 días",30],["90 días",90],["1 año",365],["Todo",null]].map(([t,d]) => (
              <button key={t} onClick={()=>atajo(d)} style={chip(d==null ? !desde : desde===cpkHaceDias(d) && hasta===cpkFechaLocal(new Date()))}>{t}</button>
            ))}
          </div>
        </div>
        {errCarga && <div style={{ fontSize:12, color:"#9a6000" }}>{errCarga}</div>}
      </div>

      {!plantilla && <div style={{ ...card, textAlign:"center", color:"var(--muted)", fontSize:13 }}>Elegí una pieza y una cota para ver su capacidad de proceso.</div>}
      {plantilla && camposNum.length === 0 && <div style={{ ...card, textAlign:"center", color:"var(--muted)", fontSize:13 }}>Esta pieza no tiene cotas numéricas con tolerancia mínima y máxima.</div>}
      {plantilla && campo && cargando && <div style={{ ...card, textAlign:"center", color:"var(--muted)", fontSize:13 }}>Cargando historial…</div>}
      {plantilla && campo && !cargando && !st && <div style={{ ...card, textAlign:"center", color:"var(--muted)", fontSize:13 }}>Hacen falta al menos 2 piezas medidas en este período{maquina ? " y esta máquina" : ""}. Probá ampliando las fechas.</div>}

      {plantilla && campo && !cargando && st && (<>
        <div style={{ ...card, background: estado.bg, border:`1px solid ${estado.color}55`, display:"flex", alignItems:"center", gap:16, flexWrap:"wrap" }}>
          <div>
            <div style={{ fontSize:10, fontWeight:700, letterSpacing:1, color: estado.color }}>CPK · {campo.label.toUpperCase()}</div>
            <div style={{ fontFamily:"'Bebas Neue'", fontSize:54, lineHeight:1, color: estado.color }}>{cpkFmt(st.cpk)}</div>
          </div>
          <div style={{ flex:1, minWidth:160 }}>
            <div style={{ fontWeight:700, color: estado.color, fontSize:15 }}>{estado.txt}</div>
            <div style={{ fontSize:12, color:"var(--muted)", marginTop:2 }}>{st.n} piezas · {maquina || "todas las máquinas"} · {desde || "inicio"} a {hasta || "hoy"}</div>
            {st.n < 30 && <div style={{ fontSize:12, color:"#9a6000", fontWeight:600, marginTop:4 }}>⚠ Menos de 30 piezas: tomalo como orientativo.</div>}
          </div>
          <button onClick={descargarPdf} style={{ background:"#7C3AED", color:"white", border:"none", borderRadius:10, padding:"10px 14px", fontWeight:700, fontSize:12, cursor:"pointer" }}>⬇ PDF</button>
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(110px, 1fr))", gap:8 }}>
          {[["Cp", cpkFmt(st.cp)], ["Cpk corto plazo", cpkFmt(st.cpkCorto)], ["Media", st.media.toFixed(4)], ["σ (desvío)", st.sigma.toFixed(4)], ["Mín / Máx", `${st.min} / ${st.max}`], ["Fuera de tol.", `${st.fuera} (${(st.fuera/st.n*100).toFixed(1).replace(".", ",")}%)`]].map(([t,v]) => (
            <div key={t} style={{ ...card, padding:"10px 12px" }}>
              <div style={{ fontSize:10, color:"var(--muted)", fontWeight:700, textTransform:"uppercase", letterSpacing:0.5 }}>{t}</div>
              <div style={{ fontFamily:"'JetBrains Mono'", fontSize:14, fontWeight:700, color:"var(--text)", marginTop:2 }}>{v}</div>
            </div>
          ))}
        </div>

        <div style={card}>
          <div style={{ ...lab, marginBottom:8 }}>Evolución de la medida (cada punto es una pieza)</div>
          <CpkGraficoCorrida puntos={puntos} lsl={lsl} usl={usl} st={st} />
        </div>
        <div style={card}>
          <div style={{ ...lab, marginBottom:8 }}>Distribución de las medidas</div>
          <CpkHistograma valores={valores} lsl={lsl} usl={usl} st={st} />
        </div>

        {porMaquina.length > 1 && (
          <div style={card}>
            <div style={{ ...lab, marginBottom:8 }}>Comparación por máquina</div>
            {porMaquina.sort((a,b) => (a.st.cpk===Infinity?99:a.st.cpk) - (b.st.cpk===Infinity?99:b.st.cpk)).map(({ m, st:s }) => {
              const e = cpkEstado(s.cpk), ancho = Math.max(2, Math.min(100, (s.cpk===Infinity ? 2 : s.cpk) / 2 * 100));
              return (
                <button key={m} onClick={()=>setMaquina(m)} style={{ display:"block", width:"100%", background:"none", border:"none", padding:"6px 0", cursor:"pointer", textAlign:"left" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, color:"var(--text)" }}>
                    <span style={{ fontWeight:600 }}>{m} <span style={{ color:"var(--muted)", fontWeight:400 }}>· {s.n} piezas</span></span>
                    <span style={{ fontWeight:700, color:e.color }}>{cpkFmt(s.cpk)}</span>
                  </div>
                  <div style={{ background:"var(--surface2)", borderRadius:99, height:7, marginTop:3, overflow:"hidden" }}><div style={{ width:`${ancho}%`, height:"100%", background:e.color }} /></div>
                </button>
              );
            })}
            <div style={{ fontSize:11, color:"var(--muted)", marginTop:6 }}>Tocá una máquina para ver solo la suya.</div>
          </div>
        )}

        <div style={{ fontSize:11, color:"var(--muted)", lineHeight:1.5 }}>
          Cpk = el menor entre (LSE − media) y (media − LIE), dividido 3σ. Con σ global de todas las piezas del período (igual que el resto del SIG). "Cpk corto plazo" estima σ con el rango móvil entre piezas consecutivas: si es bastante mayor que el Cpk, el proceso se está moviendo en el tiempo.
        </div>
      </>)}
    </div>
  );
}

'''
reemplazos = [
 ("function CalidadStatsView(", NUEVO + "function CalidadStatsView("),
 ('["stats","📊 ESTADÍSTICAS"],', '["stats","📊 ESTADÍSTICAS"],["cpk","📈 CPK"],'),
 ('        {mainTab==="stats"      && <CalidadStatsView registros={registros} plantillas={plantillas} />}',
  '        {mainTab==="stats"      && <CalidadStatsView registros={registros} plantillas={plantillas} />}\n        {mainTab==="cpk"        && <CalidadCpkView registros={registros} plantillas={plantillas} />}'),
]
out = src
for o, n in reemplazos:
    if out.count(o) != 1:
        print("ERROR: no encuentro un ancla (el archivo cambió). No toqué nada:\n  " + o[:70]); sys.exit(1)
    out = out.replace(o, n)
if crlf: out = out.replace("\n", "\r\n")
open(ruta, "w", encoding="utf-8", newline="").write(out)
print("Listo: pestaña CPK agregada en Calidad.")
