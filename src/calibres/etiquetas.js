// Códigos de barras (Code 128) y hoja de etiquetas en PDF
import JsBarcode from 'jsbarcode'

// Devuelve { url, w, h } con el código de barras como imagen PNG, o null si el texto no se puede codificar
export function barcodeImg(texto) {
  try {
    const canvas = document.createElement('canvas')
    JsBarcode(canvas, String(texto), {
      format: 'CODE128', displayValue: false, margin: 0, width: 3, height: 90,
    })
    return { url: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height }
  } catch (e) {
    console.warn('código no codificable', texto, e)
    return null
  }
}

// Hoja A4 con etiquetas de 63 x 33 mm (3 columnas x 8 filas). Una etiqueta por instrumento.
export async function etiquetasPDF(items) {
  if (!items.length) return
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const COLS = 3, ROWS = 8, W = 63, H = 33
  const mx = (210 - COLS * W) / 2
  const my = (297 - ROWS * H) / 2
  const porHoja = COLS * ROWS

  items.forEach((it, n) => {
    if (n > 0 && n % porHoja === 0) doc.addPage()
    const k = n % porHoja
    const x = mx + (k % COLS) * W
    const y = my + Math.floor(k / COLS) * H

    doc.setDrawColor(190, 190, 190)
    doc.setLineWidth(0.15)
    doc.rect(x, y, W, H)

    doc.setTextColor(30, 142, 62)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(6)
    doc.text('EMU S.A.I.C. - INSTRUMENTO DE MEDICION', x + W / 2, y + 4, { align: 'center' })

    const img = barcodeImg(it.codigo)
    if (img) {
      const maxW = W - 8
      const maxH = 13
      const esc = Math.min(maxW / img.w, maxH / img.h)
      const bw = img.w * esc
      const bh = img.h * esc
      doc.addImage(img.url, 'PNG', x + (W - bw) / 2, y + 6, bw, bh)
    } else {
      doc.setTextColor(200, 30, 30)
      doc.setFontSize(6)
      doc.text('(codigo no valido para barras)', x + W / 2, y + 13, { align: 'center' })
    }

    doc.setTextColor(20, 20, 20)
    doc.setFont('courier', 'bold')
    doc.setFontSize(12)
    doc.text(String(it.codigo), x + W / 2, y + 24, { align: 'center' })

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    const tipo = it.tipo === 'Otro' ? it.tipoOtro || 'Otro' : it.tipo
    doc.text(`${tipo} - ${it.modalidad || ''}`, x + W / 2, y + 28, { align: 'center' })
    if (it.marca || it.nroFab) {
      doc.setFontSize(6)
      doc.text([it.marca, it.nroFab && `N ${it.nroFab}`].filter(Boolean).join('  '), x + W / 2, y + 31, { align: 'center' })
    }
  })

  doc.save(items.length === 1 ? `etiqueta_${items[0].codigo}.pdf` : 'etiquetas_instrumentos.pdf')
}
