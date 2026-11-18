// Normas y criterio de decisión de cada control. PROPUESTA para que Gerencia de Calidad la valide.
// Cada control guarda una copia de esto (campo `metodo`), así los certificados viejos no cambian si acá se edita algo.

export const MARCO = 'IATF 16949 (7.1.5), ISO 9001 (7.1.5) e ISO 10012'
export const TEMP_REF = 20 // °C, temperatura de referencia (ISO 1)

const POR_TIPO = {
  Vernier: {
    norma: 'ISO 13385-1 (equivale a DIN 862): calibres de pie de rey',
    patron: 'Bloques patron ISO 3650 con certificado trazable',
  },
  'Micrómetro': {
    norma: 'ISO 3611 (equivale a DIN 863-1): micrometros de exteriores',
    patron: 'Bloques patron ISO 3650 con certificado trazable',
  },
  'Alesómetro': {
    norma: 'Especificacion del fabricante y VDI/VDE/DGQ 2618 (sin norma de producto ISO; a confirmar por Calidad)',
    patron: 'Anillo patron o bloques patron con certificado trazable',
  },
  'Tapón P-NP': {
    norma: 'ISO 1938-1: calibres limite lisos (PASA / NO PASA)',
    patron: 'Bloques patron ISO 3650 con certificado trazable',
  },
  'Tapón roscado': {
    norma: 'ISO 1502: calibres limite roscados; diametro medio por metodo de las tres varillas',
    patron: 'Varillas calibradas y micrometro con certificado trazable',
  },
}
const OTRO = {
  norma: 'Especificacion del fabricante (a definir por Calidad)',
  patron: 'Patron con certificado trazable',
}

// Texto del criterio de aprobado / desaprobado
const REGLA_ERROR_MAX = 'Aprobado si: error maximo + incertidumbre del patron <= error maximo permitido (regla de decision segun ISO 14253-1).'
const REGLA_ROSCA = 'Aprobado si el diametro medio E (y el exterior D, si tiene limites) esta dentro de los limites del tapon en los lados PASA y NO PASA (ISO 1502).'
const REGLA_MANUAL = 'Resultado cargado por el responsable: el instrumento no tiene error maximo permitido definido.'

// inst: instrumento; opciones: { tipoControl, tolInfo, usaIncert, auto, temperatura }
export function metodoDe(inst, { tipoControl = 'normal', tolInfo = null, usaIncert = true, auto = false, temperatura = '' } = {}) {
  const base = POR_TIPO[inst?.tipo] || OTRO
  let regla
  if (tipoControl === 'rosca') {
    regla = auto
      ? REGLA_ROSCA + (usaIncert ? ' Se considera la incertidumbre de la medicion.' : ' No se considera incertidumbre.')
      : REGLA_MANUAL
  } else {
    regla = tolInfo && auto ? REGLA_ERROR_MAX : REGLA_MANUAL
  }
  return {
    norma: base.norma,
    patronRef: base.patron,
    marco: MARCO,
    regla,
    origenLimite: tolInfo ? tolInfo.origen : '',
    tempRef: TEMP_REF,
    temperatura: temperatura === '' || temperatura == null ? null : Number(temperatura),
  }
}

// Fecha y hora de la medición a partir del timestamp guardado (control.creado)
export function fechaHora(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// Dibuja el bloque "Método y criterio" en un PDF jsPDF; devuelve la nueva y.
export function bloqueMetodoPDF(doc, c, y, M, W) {
  const m = c.metodo
  doc.setTextColor(20, 20, 20)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.text('METODO Y CRITERIO', M, y)
  y += 2
  doc.setDrawColor(150, 150, 150)
  doc.line(M, y, W - M, y)
  y += 5
  doc.setFontSize(9)
  const linea = (k, v) => {
    doc.setFont('helvetica', 'bold')
    doc.text(k + ':', M, y)
    doc.setFont('helvetica', 'normal')
    const lin = doc.splitTextToSize(String(v), W - 2 * M - 34)
    doc.text(lin, M + 34, y)
    y += lin.length * 4.4 + 1
  }
  const cuando = fechaHora(c.creado)
  linea('Medicion realizada', cuando ? `${cuando} hs` : '-')
  if (!m) {
    linea('Norma / criterio', 'Control anterior a la incorporacion de normas: sin datos de norma registrados.')
    return y + 2
  }
  linea('Norma de medicion', m.norma)
  linea('Patron', m.patronRef)
  linea('Marco', m.marco)
  linea('Temperatura', `${m.temperatura != null ? m.temperatura + ' C medida' : 'no registrada'} (referencia ${m.tempRef} C)`)
  if (m.origenLimite) linea('Base del limite', m.origenLimite)
  linea('Criterio de decision', m.regla)
  return y + 2
}
