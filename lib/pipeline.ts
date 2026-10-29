import type { WeatherRecord } from "./weather"

/**
 * Lógica pura de la fase «Filtrado y selección» y de la carga por lotes.
 * Orden fijo: datos válidos → filtros → ordenación → selección → carga.
 * La paginación solo recorta lo que se ve: nunca decide qué se sube.
 */

export type SortKey = keyof WeatherRecord
export type Filters = {
  cities: string[] // vacío = todas
  from: string // "YYYY-MM-DDTHH:mm" en UTC (input datetime-local), vacío = sin límite
  to: string
  minT: string; maxT: string
  minH: string; maxH: string
  minP: string; maxP: string
  rain: boolean // «Solo registros con lluvia»: precipitación > 0
}
export const EMPTY_FILTERS: Filters = { cities: [], from: "", to: "", minT: "", maxT: "", minH: "", maxH: "", minP: "", maxP: "", rain: false }
export const BATCH_SIZE = 500

export const recordKey = (r: Pick<WeatherRecord, "ciudad" | "fecha_hora">) => `${r.ciudad}|${r.fecha_hora}`
const bound = (s: string) => (s.trim() === "" ? undefined : Number(s))
/** Convierte "YYYY-MM-DDTHH:mm" (UTC) en el ISO que usan los registros, para comparar como texto. */
const utc = (s: string) => `${s.length === 10 ? `${s}T00:00` : s}:00.000Z`

export function countActiveFilters(f: Filters) {
  return [f.cities.length > 0, f.from, f.to, f.minT, f.maxT, f.minH, f.maxH, f.minP, f.maxP, f.rain].filter(Boolean).length
}

export function applyFilters(records: WeatherRecord[], f: Filters): WeatherRecord[] {
  const [minT, maxT, minH, maxH, minP, maxP] = [f.minT, f.maxT, f.minH, f.maxH, f.minP, f.maxP].map(bound)
  const from = f.from && utc(f.from), to = f.to && utc(f.to)
  return records.filter((r) =>
    (!f.cities.length || f.cities.includes(r.ciudad))
    && (!from || r.fecha_hora >= from) && (!to || r.fecha_hora <= to)
    && (minT === undefined || r.temperatura_c >= minT) && (maxT === undefined || r.temperatura_c <= maxT)
    && (minH === undefined || r.humedad_pct >= minH) && (maxH === undefined || r.humedad_pct <= maxH)
    && (minP === undefined || r.precipitacion_mm >= minP) && (maxP === undefined || r.precipitacion_mm <= maxP)
    && (!f.rain || r.precipitacion_mm > 0))
}

/** Ordenación estable sobre una copia (no altera el array de entrada). */
export function sortRecords(rows: WeatherRecord[], key: SortKey, asc: boolean): WeatherRecord[] {
  return rows.map((r, i) => [r, i] as const)
    .sort(([a, i], [b, j]) => {
      const c = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0
      return c ? (asc ? c : -c) : i - j // a igualdad, se respeta el orden original
    })
    .map(([r]) => r)
}

export function paginate<T>(rows: T[], page: number, size: number): T[] {
  return rows.slice(page * size, page * size + size)
}

/** Conjunto exacto que se subirá: filas filtradas y ordenadas que además están seleccionadas. */
export function uploadSet(filteredSorted: WeatherRecord[], selected: Set<string>): WeatherRecord[] {
  return filteredSorted.filter((r) => selected.has(recordKey(r)))
}

/** Seleccionadas que ya no cumplen los filtros actuales (no se subirán). */
export function selectedOutsideFilters(selected: Set<string>, filtered: WeatherRecord[]) {
  const visible = new Set(filtered.map(recordKey))
  let n = 0
  for (const k of selected) if (!visible.has(k)) n++
  return n
}

export function toBatches<T>(rows: T[], size = BATCH_SIZE): T[][] {
  return Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, i * size + size))
}

export type BatchState = "pendiente" | "curso" | "ok" | "error"
export type BatchStatus = { n: number; size: number; state: BatchState; verified: number; message?: string }
export type PostResult = { ok: true; verified: number; missing: string[] } | { ok: false; error: string }
export type UploadReport = { total: number; verified: number; failed: WeatherRecord[][]; stored: string[]; messages: string[] }

/**
 * Envía los lotes uno a uno (nunca en paralelo) e informa del estado real de cada uno.
 * Si un lote falla se sigue con los demás: los anteriores conservan su estado y los fallidos
 * (o las filas que no aparecen al verificar) quedan listos para reintentar.
 */
export async function runUpload(batches: WeatherRecord[][], post: (batch: WeatherRecord[]) => Promise<PostResult>, onStatus?: (s: BatchStatus[]) => void): Promise<UploadReport> {
  const status: BatchStatus[] = batches.map((b, i) => ({ n: i + 1, size: b.length, state: "pendiente", verified: 0 }))
  const emit = () => onStatus?.(status.map((s) => ({ ...s })))
  const report: UploadReport = { total: batches.flat().length, verified: 0, failed: [], stored: [], messages: [] }
  emit()
  for (const [i, batch] of batches.entries()) {
    status[i].state = "curso"; emit()
    const res = await post(batch).catch((): PostResult => ({ ok: false, error: "No se pudo conectar con el servidor" }))
    if (!res.ok) {
      Object.assign(status[i], { state: "error", message: res.error })
      report.failed.push(batch); report.messages.push(res.error)
    } else {
      const missing = new Set(res.missing)
      report.verified += res.verified
      batch.forEach((r) => !missing.has(recordKey(r)) && report.stored.push(recordKey(r)))
      if (missing.size) {
        const msg = `${missing.size} registros no aparecen al verificar en destino`
        Object.assign(status[i], { state: "error", verified: res.verified, message: msg })
        report.failed.push(batch.filter((r) => missing.has(recordKey(r)))); report.messages.push(msg)
      } else Object.assign(status[i], { state: "ok", verified: res.verified })
    }
    emit()
  }
  return report
}
