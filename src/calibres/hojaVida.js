// Hoja de vida de un instrumento: ficha, todos sus controles, normas usadas y tendencia (jsPDF, se carga al pedir el PDF)
import { fechaHora } from './normas.js'
import { seriesTendencia, lecturaTendencia } from './tendencia.js'

const fmt = (iso) => (iso ? iso.split('-').reverse().join('/') : '-')
const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const n5 = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '-' : Number(v).toFixed(5))
const lim = (a, b) => (num(a) !== null && num(b) !== null ? `${num(a)} a ${num(b)} mm` : 'sin cargar')

export async function hojaVidaPDF(inst, hist, estadoTxt) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const W = 210
  const H = 297
  const M = 12
  const ANCHO = W - 2 * M
  const hoy = new Date().toISOString().slice(0, 10)
  const rosca = inst.tipo === 'Tapón roscado'
  const tipo = inst.tipo === 'Otro' ? inst.tipoOtro || 'Otro' : inst.tipo
  let y = 0

  const cabecera = (primera) => {
    doc.setFillColor(30, 142, 62)
    doc.rect(0, 0, W, primera ? 26 : 14, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFont('helvetica', 'bold')
    if (primera) {
      doc.setFontSize(16)
      doc.text('EMU S.A.I.C.', M, 12)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(10)
      doc.text('Control de instrumentos de medición', M, 19)
      doc.setFont('helvetica', 'bold')
      doc.text('HOJA DE VIDA DEL INSTRUMENTO', W - M, 12, { align: 'right' })
      doc.setFont('helvetica', 'normal')
      doc.text(`Emitida: ${fmt(hoy)}`, W - M, 19, { align: 'right' })
    } else {
      doc.setFontSize(10)
      doc.text(`EMU S.A.I.C. · Hoja de vida ${inst.codigo}`, M, 9)
    }
    doc.setTextColor(20, 20, 20)
  }
  const hay = (alto) => {
    if (y + alto > H - 16) {
      doc.addPage()
      cabecera(false)
      y = 22
    }
  }
  const titulo = (txt) => {
    hay(14)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(22, 107, 47)
    doc.text(txt, M, y)
    doc.setDrawColor(22, 107, 47)
    doc.line(M, y + 1.5, W - M, y + 1.5)
    doc.setTextColor(20, 20, 20)
    y += 7
  }

  cabecera(true)
  y = 36
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text(`${inst.codigo}`, M, y)
  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  doc.text(`${tipo}${inst.modalidad && !rosca ? ' · ' + inst.modalidad : ''}`, M, y + 6)
  const bad = /RECHAZ|VENCIDO|BAJA/.test(estadoTxt)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.setTextColor(bad ? 198 : 30, bad ? 40 : 142, bad ? 40 : 62)
  doc.text(`Estado: ${estadoTxt}`, W - M, y, { align: 'right' })
  doc.setTextColor(20, 20, 20)
  y += 14

  // ---------- 1. ficha ----------
  titulo('1. Datos del instrumento')
  const ficha = [
    ['Marca', inst.marca || '-', 'N° de fabricación', inst.nroFab || '-'],
    ['Apreciación (mm)', String(inst.apreciacion || '-'), 'Rango máximo (mm)', String(inst.rango || '-')],
    ['Máquina', inst.maquina || 'sin asignar', 'A cargo de', inst.aCargo || '-'],
    ['Frecuencia (meses)', String(inst.frecMeses || '-'), 'Última revisión', fmt(inst.ultimaRevision)],
    ['Vencimiento', fmt(inst.vencimiento), 'Tolerancia propia (mm)', inst.tolerancia ? String(inst.tolerancia) : '-'],
  ]
  if (rosca) {
    ficha.push(['Rosca', inst.rosca || '-', 'Paso / ángulo', `${inst.paso || '-'} mm / ${inst.angulo || 60}°`])
    ficha.push(['E lado PASA', lim(inst.pasaMin, inst.pasaMax), 'E lado NO PASA', lim(inst.nopasaMin, inst.nopasaMax)])
    if (num(inst.pasaExtMin) !== null || num(inst.nopasaExtMin) !== null) {
      ficha.push(['D ext. PASA', lim(inst.pasaExtMin, inst.pasaExtMax), 'D ext. NO PASA', lim(inst.nopasaExtMin, inst.nopasaExtMax)])
    }
  }
  doc.setFontSize(9)
  ficha.forEach((f) => {
    hay(6)
    doc.setFont('helvetica', 'bold'); doc.text(f[0] + ':', M, y)
    doc.setFont('helvetica', 'normal'); doc.text(String(f[1]), M + 34, y)
    doc.setFont('helvetica', 'bold'); doc.text(f[2] + ':', 108, y)
    doc.setFont('helvetica', 'normal'); doc.text(String(f[3]), 108 + 38, y)
    y += 6
  })
  y += 3

  // ---------- 2. resumen ----------
  titulo('2. Resumen de controles')
  const aprob = hist.filter((c) => c.resultado === 'Aprobado').length
  const rech = hist.filter((c) => c.resultado === 'Rechazado').length
  doc.setFontSize(9)
  doc.setFont('helvetica', 'normal')
  const resumen = hist.length
    ? `Controles registrados: ${hist.length}   |   Aprobados: ${aprob}   |   Rechazados: ${rech}   |   Primero: ${fmt(hist[0].fecha)}   |   Último: ${fmt(hist[hist.length - 1].fecha)}`
    : 'Este instrumento todavía no tiene controles registrados.'
  doc.text(doc.splitTextToSize(resumen, ANCHO), M, y)
  y += 7
  const normas = [...new Set(hist.map((c) => c.metodo && c.metodo.norma).filter(Boolean))]
  hay(10)
  doc.setFont('helvetica', 'bold')
  doc.text('Normas aplicadas en los controles:', M, y)
  y += 5
  doc.setFont('helvetica', 'normal')
  if (!normas.length) {
    doc.text(hist.length ? 'Los controles son anteriores a la incorporación del registro de normas.' : '-', M, y)
    y += 5
  }
  normas.forEach((n) => {
    const lin = doc.splitTextToSize(`- ${n}`, ANCHO)
    hay(lin.length * 4.5)
    doc.text(lin, M, y)
    y += lin.length * 4.5
  })
  y += 4

  // ---------- 3. controles ----------
  titulo('3. Controles realizados (del más antiguo al más reciente)')
  const cols = [
    { t: 'Fecha y hora', w: 27 },
    { t: 'Resultado', w: 19 },
    { t: 'Patrón', w: 22 },
    { t: 'Incert.', w: 15 },
    { t: 'Medición', w: 33 },
    { t: 'Tolerancia', w: 17 },
    { t: 'Norma', w: 33 },
    { t: 'Responsable', w: 20 },
  ]
  let xs = M
  cols.forEach((c) => { c.x = xs; xs += c.w })
  const encabezado = () => {
    doc.setFillColor(22, 107, 47)
    doc.rect(M, y - 4.5, ANCHO, 6.5, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7.5)
    cols.forEach((c) => doc.text(c.t, c.x + 1, y))
    doc.setTextColor(20, 20, 20)
    y += 5
  }
  hay(20)
  y += 1
  encabezado()
  doc.setFontSize(7)
  hist.forEach((c, i) => {
    const m = c.metodo
    const norma = m && m.norma ? m.norma.split(':')[0] : '-'
    let medicion
    let tol = '-'
    if (c.tipoControl === 'rosca' && c.lados) {
      medicion = [`E PASA ${n5(c.lados.pasa && c.lados.pasa.E)}`, `E NO PASA ${n5(c.lados.nopasa && c.lados.nopasa.E)}`]
      tol = 'por límites'
    } else {
      medicion = [c.errorMax != null ? `Error máx. ${n5(c.errorMax)}` : '-']
      if (c.tolerancia != null) tol = String(c.tolerancia)
    }
    const cel = [
      [c.creado ? fechaHora(c.creado) : fmt(c.fecha)],
      [String(c.resultado || '-')],
      doc.splitTextToSize(String(c.galga || '-'), cols[2].w - 2).slice(0, 2),
      [c.incertidumbre != null ? String(c.incertidumbre) : '-'],
      medicion,
      [tol],
      doc.splitTextToSize(norma, cols[6].w - 2).slice(0, 3),
      doc.splitTextToSize(String(c.responsable || '-'), cols[7].w - 2).slice(0, 2),
    ]
    const lineas = Math.max(...cel.map((x) => x.length))
    const alto = lineas * 3.4 + 2.2
    if (y + alto > H - 16) {
      doc.addPage()
      cabecera(false)
      y = 24
      encabezado()
      doc.setFontSize(7)
    }
    if (i % 2 === 0) {
      doc.setFillColor(242, 243, 244)
      doc.rect(M, y - 3.2, ANCHO, alto, 'F')
    }
    cel.forEach((lin, k) => {
      if (k === 1) {
        const ok = c.resultado === 'Aprobado'
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(ok ? 20 : 198, ok ? 140 : 40, ok ? 70 : 40)
      } else {
        doc.setFont('helvetica', 'normal')
        doc.setTextColor(20, 20, 20)
      }
      doc.text(lin, cols[k].x + 1, y)
    })
    doc.setTextColor(20, 20, 20)
    y += alto
  })
  if (!hist.length) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.text('Sin controles registrados.', M, y + 2)
    y += 6
  }
  y += 3

  // observaciones
  const conObs = hist.filter((c) => c.observaciones)
  if (conObs.length) {
    titulo('Observaciones registradas')
    doc.setFontSize(8.5)
    doc.setFont('helvetica', 'normal')
    conObs.forEach((c) => {
      const lin = doc.splitTextToSize(`${fmt(c.fecha)}: ${c.observaciones}`, ANCHO)
      hay(lin.length * 4.3)
      doc.text(lin, M, y)
      y += lin.length * 4.3 + 1
    })
    y += 3
  }

  // ---------- 4. tendencia ----------
  titulo('4. Tendencia')
  const series = seriesTendencia(hist)
  if (!series.length) {
    doc.setFontSize(9)
    doc.setFont('helvetica', 'normal')
    doc.text('No hay mediciones numéricas para graficar.', M, y)
    y += 6
  }
  series.forEach((s) => {
    const alto = 62
    hay(alto)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.text(s.nombre, M, y)
    y += 3
    if (s.pts.length < 2) {
      doc.setFont('helvetica', 'normal')
      doc.text('Se necesitan al menos 2 controles para ver la tendencia.', M, y + 5)
      y += 12
      return
    }
    grafico(doc, s, M + 14, y + 2, ANCHO - 18, 36)
    y += 44
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(95, 112, 102)
    doc.text(s.limTxt, M, y)
    y += 4.5
    doc.setTextColor(20, 20, 20)
    lecturaTendencia(s).forEach((t) => {
      hay(5)
      doc.text(`- ${t}`, M, y)
      y += 4.5
    })
    y += 5
  })
  doc.setFontSize(7.5)
  doc.setTextColor(95, 112, 102)
  const nota = doc.splitTextToSize('La lectura de tendencia es indicativa: resume los controles registrados y no reemplaza el criterio de Calidad.', ANCHO)
  hay(nota.length * 4)
  doc.text(nota, M, y)

  // pie con numeración
  const total = doc.getNumberOfPages()
  for (let p = 1; p <= total; p++) {
    doc.setPage(p)
    doc.setFontSize(7.5)
    doc.setTextColor(120, 120, 120)
    doc.text(`Emitida el ${fmt(hoy)} · Hoja de vida ${inst.codigo}`, M, H - 8)
    doc.text(`Pág. ${p} de ${total}`, W - M, H - 8, { align: 'right' })
  }

  doc.save(`hoja_de_vida_${String(inst.codigo).replace(/[^\w-]+/g, '_')}.pdf`)
}

// Gráfico de líneas con puntos y líneas de límite, dibujado con primitivas del PDF
function grafico(doc, s, x0, y0, w, h) {
  const vals = s.pts.map((p) => p.v)
  let lo = Math.min(...vals, ...s.lineas)
  let hi = Math.max(...vals, ...s.lineas)
  if (hi === lo) { hi += 0.001; lo -= 0.001 }
  const pad = (hi - lo) * 0.12
  lo -= pad
  hi += pad
  const n = s.pts.length
  const X = (i) => x0 + (i * w) / (n - 1)
  const Y = (v) => y0 + ((hi - v) / (hi - lo)) * h

  doc.setDrawColor(190, 190, 190)
  doc.setLineWidth(0.2)
  doc.rect(x0, y0, w, h)
  doc.setFontSize(7)
  doc.setTextColor(95, 112, 102)
  s.lineas.forEach((v) => {
    doc.setDrawColor(198, 40, 40)
    doc.setLineDashPattern([1.5, 1], 0)
    doc.line(x0, Y(v), x0 + w, Y(v))
    doc.setLineDashPattern([], 0)
    doc.text(Number(v).toFixed(4), x0 - 1.5, Y(v) + 1, { align: 'right' })
  })
  doc.setDrawColor(22, 107, 47)
  doc.setLineWidth(0.5)
  for (let i = 1; i < n; i++) doc.line(X(i - 1), Y(s.pts[i - 1].v), X(i), Y(s.pts[i].v))
  s.pts.forEach((p, i) => {
    doc.setFillColor(p.ok ? 30 : 198, p.ok ? 142 : 40, p.ok ? 62 : 40)
    doc.circle(X(i), Y(p.v), 0.9, 'F')
  })
  doc.setTextColor(95, 112, 102)
  doc.text(fmt(s.pts[0].fecha), x0, y0 + h + 4)
  doc.text(fmt(s.pts[n - 1].fecha), x0 + w, y0 + h + 4, { align: 'right' })
  doc.text(`Último: ${Number(s.pts[n - 1].v).toFixed(5)}`, x0 + w / 2, y0 + h + 4, { align: 'center' })
  doc.setLineWidth(0.2)
  doc.setTextColor(20, 20, 20)
}
