// Tendencia de un instrumento: datos para el gráfico del historial y de la hoja de vida (sin dependencias).

// Controles de un instrumento, del más viejo al más nuevo
export function controlesDe(inst, controles) {
  return Object.entries(controles || {})
    .map(([id, v]) => ({ ...v, id }))
    .filter((x) => x.instrumentoId === inst.id)
    .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '') || (a.creado || 0) - (b.creado || 0))
}

const esNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))

// Series a graficar. Cada serie: { clave, nombre, pts: [{ fecha, v, ok }], lineas: [límites], limTxt }
//  - instrumentos comunes: error máximo de cada control contra la tolerancia
//  - tapones roscados: diámetro medio E de cada lado contra sus límites mínimo y máximo
export function seriesTendencia(hist) {
  const out = []
  const normales = hist.filter((c) => c.tipoControl !== 'rosca' && esNum(c.errorMax))
  if (normales.length) {
    const ult = [...normales].reverse().find((c) => esNum(c.tolerancia))
    out.push({
      clave: 'error',
      nombre: 'Error máximo de cada control (mm)',
      pts: normales.map((c) => ({ fecha: c.fecha, v: Number(c.errorMax), ok: c.resultado === 'Aprobado' })),
      lineas: ult ? [Number(ult.tolerancia)] : [],
      limTxt: ult ? `Tolerancia aplicada en el último control: ${Number(ult.tolerancia)} mm` : 'Sin tolerancia definida en los controles',
    })
  }
  const rosca = hist.filter((c) => c.tipoControl === 'rosca' && c.lados)
  ;[['pasa', 'Diámetro medio E, lado PASA (mm)'], ['nopasa', 'Diámetro medio E, lado NO PASA (mm)']].forEach(([k, nombre]) => {
    const cs = rosca.filter((c) => c.lados[k] && esNum(c.lados[k].E))
    if (!cs.length) return
    const u = cs[cs.length - 1].lados[k]
    const lineas = [u.min, u.max].filter(esNum).map(Number)
    out.push({
      clave: `rosca-${k}`,
      nombre,
      pts: cs.map((c) => ({ fecha: c.fecha, v: Number(c.lados[k].E), ok: c.lados[k].okE !== false })),
      lineas,
      limTxt: lineas.length === 2 ? `Límites del tapón: ${lineas[0]} a ${lineas[1]} mm` : 'Sin límites cargados',
    })
  })
  return out
}

// Lectura en palabras (indicativa) de una serie
export function lecturaTendencia(s) {
  const n = s.pts.length
  if (n < 2) return ['Con un solo control todavía no hay tendencia.']
  const msgs = []
  const ult = s.pts[n - 1].v
  if (s.clave === 'error' && s.lineas.length && s.lineas[0] > 0) {
    const pct = (ult / s.lineas[0]) * 100
    msgs.push(`El último error es ${pct.toFixed(0)}% de la tolerancia.`)
    if (pct >= 80) msgs.push('Está cerca del límite de tolerancia.')
    if (n >= 3 && s.pts[n - 3].v < s.pts[n - 2].v && s.pts[n - 2].v < ult) msgs.push('El error viene creciendo en los últimos 3 controles.')
  }
  if (s.clave.startsWith('rosca') && s.lineas.length === 2) {
    const [mn, mx] = s.lineas
    if (mx > mn) {
      const pos = ((ult - mn) / (mx - mn)) * 100
      if (pos <= 10 || pos >= 90) msgs.push('El último valor está pegado a un límite del tapón.')
      if (n >= 3) {
        const a = s.pts[n - 3].v
        const b = s.pts[n - 2].v
        if ((a < b && b < ult) || (a > b && b > ult)) msgs.push('El valor se viene moviendo en un solo sentido en los últimos 3 controles.')
      }
    }
  }
  if (!msgs.length) msgs.push('Sin señales de deriva en los controles registrados.')
  return msgs
}
