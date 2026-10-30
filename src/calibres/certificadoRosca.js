// Certificado PDF del control de un tapón roscado (jsPDF, se carga al pedirlo)
const fmt = (iso) => (iso ? iso.split('-').reverse().join('/') : '-')
const n4 = (v) => (v === null || v === undefined || Number.isNaN(v) ? '-' : Number(v).toFixed(4))
const n5 = (v) => (v === null || v === undefined || Number.isNaN(v) ? '-' : Number(v).toFixed(5))

export async function certificadoRoscaPDF(c, inst) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const W = 210
  const M = 15
  let y = 18

  doc.setFillColor(30, 142, 62)
  doc.rect(0, 0, W, 30, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.text('EMU S.A.I.C.', M, y)
  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  doc.text('Control de instrumentos de medicion', M, y + 6)
  doc.setFont('helvetica', 'bold')
  doc.text(`Certificado N° ${String(c.id || '').slice(-6).toUpperCase() || '-'}`, W - M, y, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.text(`Fecha de control: ${fmt(c.fecha)}`, W - M, y + 6, { align: 'right' })

  y = 42
  doc.setTextColor(20, 20, 20)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.text('CERTIFICADO DE CONTROL - TAPON ROSCADO', W / 2, y, { align: 'center' })

  y += 10
  doc.setFontSize(10)
  const filas = [
    ['Codigo', c.codigo, 'Rosca', c.rosca || inst?.rosca || '-'],
    ['Marca', c.marca ?? inst?.marca ?? '-', 'N° de fabricacion', c.nroFab ?? inst?.nroFab ?? '-'],
    ['Paso (mm)', String(c.paso ?? inst?.paso ?? '-'), 'Angulo de flanco (grados)', String(c.angulo ?? inst?.angulo ?? '60')],
    ['A cargo de', c.aCargo ?? inst?.aCargo ?? '-', 'Incertidumbre (mm)', n5(c.incertidumbre)],
  ]
  filas.forEach((f) => {
    doc.setFont('helvetica', 'bold'); doc.text(f[0] + ':', M, y)
    doc.setFont('helvetica', 'normal'); doc.text(String(f[1]), M + 32, y)
    doc.setFont('helvetica', 'bold'); doc.text(f[2] + ':', 105, y)
    doc.setFont('helvetica', 'normal'); doc.text(String(f[3]), 105 + 46, y)
    y += 7
  })

  y += 4
  const cols = [M, M + 24, M + 48, M + 72, M + 98, M + 124, M + 150]
  const head = ['Lado', 'Alambre', 'Cota M', 'Diam. medio E', 'Minimo', 'Maximo', 'Resultado']
  doc.setFillColor(22, 107, 47)
  doc.rect(M, y, W - 2 * M, 8, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8.5)
  head.forEach((h, i) => doc.text(h, cols[i] + 1.5, y + 5.5))
  y += 8
  doc.setTextColor(20, 20, 20)
  doc.setFont('courier', 'normal')
  doc.setFontSize(9)
  ;[['PASA', c.lados?.pasa], ['NO PASA', c.lados?.nopasa]].forEach(([nombre, l], i) => {
    if (i % 2 === 0) { doc.setFillColor(242, 243, 244); doc.rect(M, y, W - 2 * M, 8, 'F') }
    const ok = l?.ok
    const vals = [nombre, n4(l?.alambre), n4(l?.cota), n5(l?.E), n4(l?.min), n4(l?.max), ok === true ? 'CUMPLE' : ok === false ? 'NO CUMPLE' : '-']
    vals.forEach((v, k) => doc.text(String(v), cols[k] + 1.5, y + 5.5))
    y += 8
  })
  doc.setDrawColor(150, 150, 150)
  doc.rect(M, y - 16, W - 2 * M, 16)

  y += 8
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text('Diametro medio por el metodo de las tres varillas: E = M - d (1 + 1/sen(a/2)) + (P/2) cot(a/2)', M, y)
  y += 6
  if (c.resultadoAuto) {
    doc.text('Criterio: E - incertidumbre >= minimo y E + incertidumbre <= maximo, en ambos lados.', M, y)
  } else {
    doc.text('Resultado cargado manualmente (faltan limites o datos para decidir).', M, y)
  }
  y += 10
  const aprobado = c.resultado === 'Aprobado'
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.setTextColor(aprobado ? 20 : 200, aprobado ? 140 : 30, aprobado ? 70 : 30)
  doc.text(`RESULTADO: ${String(c.resultado || '').toUpperCase()}`, M, y)
  doc.setTextColor(20, 20, 20)
  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  y += 9
  if (aprobado && c.proximoVencimiento) { doc.text(`Proximo control antes del: ${fmt(c.proximoVencimiento)}`, M, y); y += 6 }
  if (c.observaciones) {
    const lineas = doc.splitTextToSize(`Observaciones: ${c.observaciones}`, W - 2 * M)
    doc.text(lineas, M, y)
    y += lineas.length * 5
  }

  y = Math.max(y + 25, 245)
  doc.setDrawColor(60, 60, 60)
  doc.line(M, y, M + 70, y)
  doc.line(W - M - 70, y, W - M, y)
  doc.setFontSize(9)
  doc.text(`Realizo: ${c.responsable || ''}`, M, y + 5)
  doc.text('Aprobo - Gerencia de Calidad', W - M - 70, y + 5)
  doc.setFontSize(8)
  doc.setTextColor(120, 120, 120)
  doc.text(`Emitido el ${fmt(new Date().toISOString().slice(0, 10))}`, M, 287)
  doc.save(`certificado_rosca_${c.codigo}_${c.fecha}.pdf`)
}
