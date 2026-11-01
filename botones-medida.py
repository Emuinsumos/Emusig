#!/usr/bin/env python3
# Agrega botones − / + (0,001 / 0,01 / 0,1) debajo de cada medida de la planilla del operario.
# Requiere haber aplicado antes mejorar-planilla.py. Todo o nada, idempotente.
import sys
ruta = sys.argv[1] if len(sys.argv) > 1 else "src/App.jsx"
src = open(ruta, encoding="utf-8", newline="").read()
if "const ajustar = (idx, campo, dir)" in src:
    print("Ya estaba aplicado. No hice nada."); sys.exit(0)
if "const piezaAbiertaRef = useRef(null);" not in src:
    print("ERROR: primero aplicá mejorar-planilla.py. No toqué nada."); sys.exit(1)
crlf = "\r\n" in src
if crlf: src = src.replace("\r\n", "\n")

ESTADO = '''const piezaAbiertaRef = useRef(null);
  // Paso de los botones − / + (se acuerda del último que usó el operario en este celular).
  const [paso, setPaso] = useState(() => { try { const p = localStorage.getItem("cal_paso"); return ["0.001","0.01","0.1"].includes(p) ? p : "0.01"; } catch { return "0.01"; } });
  const elegirPaso = (p) => { setPaso(p); try { localStorage.setItem("cal_paso", p); } catch {} };
'''
AJUSTAR = '''  const fmtDif = (n) => String(+Number(n).toFixed(4));
  // Sube o baja la medida de a un paso (vacía: arranca desde el nominal). Redondea para evitar 10.0200000001.
  const ajustar = (idx, campo, dir) => {
    const actual = filas[idx]?.valores?.[campo.id];
    let base = aNumero(actual);
    if (isNaN(base)) base = aNumero(campo.nominal);
    if (isNaN(base)) base = 0;
    const dec = Math.max((paso.split(".")[1] || "").length, (String(actual ?? "").split(".")[1] || "").length);
    setValor(idx, campo.id, (base + dir * Number(paso)).toFixed(dec));
  };
'''
BOTONES = '''                      <div style={{ display:"flex", gap:6, marginTop:6, alignItems:"stretch" }}>
                        <button type="button" onClick={()=>ajustar(idx, campo, -1)} aria-label={`Bajar ${paso.replace(".", ",")}`}
                          style={{ flex:"1 1 0", minHeight:48, borderRadius:10, border:"1px solid var(--border)", background:"var(--surface2)", color:"var(--text)", fontSize:24, fontWeight:700, cursor:"pointer" }}>−</button>
                        <button type="button" onClick={()=>ajustar(idx, campo, 1)} aria-label={`Subir ${paso.replace(".", ",")}`}
                          style={{ flex:"1 1 0", minHeight:48, borderRadius:10, border:"1px solid var(--border)", background:"var(--surface2)", color:"var(--text)", fontSize:24, fontWeight:700, cursor:"pointer" }}>+</button>
                        {[["0.001","0,001"],["0.01","0,01"],["0.1","0,1"]].map(([v,t]) => (
                          <button type="button" key={v} onClick={()=>elegirPaso(v)}
                            style={{ flex:"0 0 auto", minWidth:52, borderRadius:10, border:`1px solid ${paso===v ? "#7C3AED" : "var(--border)"}`, background: paso===v ? "#7C3AED" : "var(--surface)", color: paso===v ? "white" : "var(--muted)", fontSize:12, fontWeight:700, cursor:"pointer" }}>{t}</button>
                        ))}
                      </div>
'''
reemplazos = [
 ("const piezaAbiertaRef = useRef(null);\n", ESTADO),
 ("  const fmtDif = (n) => String(+Number(n).toFixed(4));\n", AJUSTAR),
 ("                      {fuera && (\n", BOTONES + "                      {fuera && (\n"),
]
out = src
for o, n in reemplazos:
    if out.count(o) != 1:
        print("ERROR: no encuentro un ancla (el archivo cambió). No toqué nada:\n  " + o[:70]); sys.exit(1)
    out = out.replace(o, n)
if crlf: out = out.replace("\n", "\r\n")
open(ruta, "w", encoding="utf-8", newline="").write(out)
print("Listo: botones − / + agregados a la planilla.")
