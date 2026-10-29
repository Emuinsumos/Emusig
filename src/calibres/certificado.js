// Certificado PDF de un control de instrumento (jsPDF, se carga recién al pedir el PDF)
const fmt = (iso) => (iso ? iso.split('-').reverse().join('/') : '-')
const n5 = (v) => (v === null || v === undefined || Number.isNaN(v) ? '-' : Number(v).toFixed(5))

export async function certificadoPDF(c, inst) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const W = 210
  const M = 15
  let y = 18

  // snapshot guardado en el control; si no está, datos actuales del instrumento
  const tipo = c.tipoTexto || (inst ? (inst.tipo === 'Otro' ? inst.tipoOtro : inst.tipo) : '-')
  const modalidad = c.modalidad || inst?.modalidad || '-'
  const marca = c.marca ?? inst?.marca ?? '-'
  const nroFab = c.nroFab ?? inst?.nroFab ?? '-'
  const apreciacion = c.apreciacion ?? inst?.apreciacion ?? '-'
  const aCargo = c.aCargo ?? inst?.aCargo ?? '-'

  // encabezado
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
  doc.setFontSize(10)
  doc.text(`Certificado N° ${String(c.id || '').slice(-6).toUpperCase() || '-'}`, W - M, y, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.text(`Fecha de control: ${fmt(c.fecha)}`, W - M, y + 6, { align: 'right' })

  y = 42
  doc.setTextColor(20, 20, 20)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.text('CERTIFICADO DE CONTROL', W / 2, y, { align: 'center' })

  // datos del instrumento
  y += 10
  doc.setFontSize(10)
  const filas = [
    ['Codigo', c.codigo, 'Tipo', `${tipo} (${modalidad})`],
    ['Marca', marca || '-', 'N° de fabricacion', nroFab || '-'],
    ['Apreciacion (mm)', String(apreciacion || '-'), 'A cargo de', aCargo || '-'],
    ['Galga / patron', c.galga || '-', 'Incertidumbre del patron', n5(c.incertidumbre)],
  ]
  filas.forEach((f) => {
    doc.setFont('helvetica', 'bold'); doc.text(f[0] + ':', M, y)
    doc.setFont('helvetica', 'normal'); doc.text(String(f[1]), M + 36, y)
    doc.setFont('helvetica', 'bold'); doc.text(f[2] + ':', 105, y)
    doc.setFont('helvetica', 'normal'); doc.text(String(f[3]), 105 + 40, y)
    y += 7
  })

  // tabla de mediciones
  y += 4
  const cols = [M, M + 20, M + 70, M + 120, W - M]
  const head = ['N°', 'Valor real (mm)', 'Valor hallado (mm)', 'Error (mm)']
  doc.setFillColor(22, 107, 47)
  doc.rect(M, y, W - 2 * M, 8, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  head.forEach((h, i) => doc.text(h, cols[i] + 2, y + 5.5))
  y += 8
  doc.setTextColor(20, 20, 20)
  doc.setFont('courier', 'normal')
  const puntos = c.puntos || []
  puntos.forEach((p, i) => {
    const err = p.hallado - p.real
    if (i % 2 === 0) { doc.setFillColor(242, 243, 244); doc.rect(M, y, W - 2 * M, 7, 'F') }
    doc.text(String(i + 1), cols[0] + 2, y + 5)
    doc.text(n5(p.real), cols[1] + 2, y + 5)
    doc.text(n5(p.hallado), cols[2] + 2, y + 5)
    doc.text((err > 0 ? '+' : '') + n5(err), cols[3] + 2, y + 5)
    y += 7
  })
  doc.setDrawColor(150, 150, 150)
  doc.rect(M, y - 7 * puntos.length - 8, W - 2 * M, 7 * puntos.length + 8)

  // criterio y resultado
  y += 8
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  const maxE = c.errorMax ?? puntos.reduce((m, p) => Math.max(m, Math.abs(p.hallado - p.real)), 0)
  doc.text(`Error maximo: ${n5(maxE)} mm`, M, y)
  y += 6
  if (c.tolerancia !== null && c.tolerancia !== undefined) {
    doc.text(`Tolerancia aplicada: ${n5(c.tolerancia)} mm`, M, y)
    y += 6
    doc.text('Criterio: error maximo + incertidumbre del patron <= tolerancia', M, y)
    y += 6
  } else {
    doc.text('Resultado cargado manualmente (sin tolerancia definida).', M, y)
    y += 6
  }

  y += 4
  const aprobado = c.resultado === 'Aprobado'
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.setTextColor(aprobado ? 20 : 200, aprobado ? 140 : 30, aprobado ? 70 : 30)
  doc.text(`RESULTADO: ${String(c.resultado || '').toUpperCase()}`, M, y)
  doc.setTextColor(20, 20, 20)
  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  y += 9
  if (aprobado && c.proximoVencimiento) {
    doc.text(`Proximo control antes del: ${fmt(c.proximoVencimiento)}`, M, y)
    y += 6
  }
  if (c.observaciones) {
    const lineas = doc.splitTextToSize(`Observaciones: ${c.observaciones}`, W - 2 * M)
    doc.text(lineas, M, y)
    y += lineas.length * 5
  }

  // firmas
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

  doc.save(`certificado_${c.codigo}_${c.fecha}.pdf`)
}
