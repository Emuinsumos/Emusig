// Listado PDF de los instrumentos de una máquina, con vencimiento y estado (jsPDF, se carga al pedir el PDF)
const fmt = (iso) => (iso ? iso.split('-').reverse().join('/') : '-')

// filas: [{ codigo, tipo, modalidad, nroFab, aCargo, vencimiento, estado, clase }]
export async function listadoMaquinaPDF(titulo, filas, fechaTxt) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const W = 210
  const H = 297
  const M = 12
  const cols = [
    { t: 'Código', x: M, w: 28 },
    { t: 'Tipo', x: M + 28, w: 40 },
    { t: 'N° fabricación', x: M + 68, w: 30 },
    { t: 'A cargo de', x: M + 98, w: 30 },
    { t: 'Vencimiento', x: M + 128, w: 24 },
    { t: 'Estado', x: M + 152, w: 34 },
  ]
  const color = { ok: [30, 142, 62], warn: [183, 121, 31], bad: [198, 40, 40], na: [95, 112, 102] }
  const cortar = (txt, w) => {
    const s = String(txt ?? '-') || '-'
    return doc.splitTextToSize(s, w - 2)[0]
  }

  const cabecera = () => {
    doc.setFillColor(30, 142, 62)
    doc.rect(0, 0, W, 24, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(16)
    doc.text('EMU S.A.I.C.', M, 12)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.text('Control de instrumentos de medición', M, 18)
    doc.setFont('helvetica', 'bold')
    doc.text(titulo, W - M, 12, { align: 'right' })
    doc.setFont('helvetica', 'normal')
    doc.text(`Emitido: ${fechaTxt}`, W - M, 18, { align: 'right' })
  }
  const encabezadoTabla = (y) => {
    doc.setFillColor(22, 107, 47)
    doc.rect(M, y - 5, W - 2 * M, 7, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    cols.forEach((c) => doc.text(c.t, c.x + 1, y))
  }

  cabecera()
  let y = 34
  doc.setTextColor(20, 20, 20)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.text(`Instrumentos - ${titulo}`, M, y)
  y += 7

  const cuenta = (...cl) => filas.filter((f) => cl.includes(f.clase)).length
  const vigentes = filas.filter((f) => f.vigente).length
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(`Total: ${filas.length}   |   Vigentes: ${vigentes}   |   No vigentes (vencidos, rechazados o sin fecha): ${filas.length - vigentes}   |   Vencen en 7 días o menos: ${filas.filter((f) => f.porVencer).length}`, M, y)
  y += 9
  encabezadoTabla(y)
  y += 7

  filas.forEach((f, i) => {
    if (y > H - 22) {
      doc.addPage()
      cabecera()
      y = 36
      encabezadoTabla(y)
      y += 7
    }
    if (i % 2 === 0) {
      doc.setFillColor(245, 248, 246)
      doc.rect(M, y - 4.5, W - 2 * M, 7, 'F')
    }
    doc.setTextColor(20, 20, 20)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.text(cortar(f.codigo, cols[0].w), cols[0].x + 1, y)
    doc.setFont('helvetica', 'normal')
    doc.text(cortar(`${f.tipo} ${f.modalidad ? '· ' + f.modalidad : ''}`, cols[1].w), cols[1].x + 1, y)
    doc.text(cortar(f.nroFab || '-', cols[2].w), cols[2].x + 1, y)
    doc.text(cortar(f.aCargo || '-', cols[3].w), cols[3].x + 1, y)
    doc.text(fmt(f.vencimiento), cols[4].x + 1, y)
    const c = color[f.clase] || color.na
    doc.setTextColor(c[0], c[1], c[2])
    doc.setFont('helvetica', 'bold')
    doc.text(cortar(f.estado, cols[5].w), cols[5].x + 1, y)
    y += 7
  })

  if (!filas.length) {
    doc.setTextColor(95, 112, 102)
    doc.setFont('helvetica', 'normal')
    doc.text('No hay instrumentos asignados a esta máquina.', M, y + 4)
  }

  // pie con numeración
  const n = doc.getNumberOfPages()
  for (let p = 1; p <= n; p++) {
    doc.setPage(p)
    doc.setTextColor(95, 112, 102)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.text('Vigente = no vencido y no rechazado. El estado corresponde a la fecha de emisión.', M, H - 8)
    doc.text(`Página ${p} de ${n}`, W - M, H - 8, { align: 'right' })
  }

  const limpio = titulo.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')
  doc.save(`instrumentos_${limpio}_${fechaTxt.split('/').reverse().join('-')}.pdf`)
}
