export type City = { id: string; nombre: string; latitud: number; longitud: number }
export type WeatherRecord = { ciudad: string; fecha_hora: string; temperatura_c: number; humedad_pct: number; precipitacion_mm: number }
export type RejectedRecord = { ciudad: string; indice: number; motivo: string; datos: unknown }
/** Fila tras la transformación y antes de la limpieza: conserva los valores tal cual llegaron (null, cadenas…). */
export type RawRow = { ciudad: string; indice: number; fecha_hora: unknown; temperatura_c: unknown; humedad_pct: unknown; precipitacion_mm: unknown }
export type TransformResult = { rows: RawRow[]; input: number; error?: RejectedRecord }
export type CleanResult = { records: WeatherRecord[]; rejected: RejectedRecord[]; duplicates: number }
export type PipelineResult = CleanResult & { input: number }

export const CITIES: City[] = [
  { id: "barcelona", nombre: "Barcelona", latitud: 41.3874, longitud: 2.1686 },
  { id: "madrid", nombre: "Madrid", latitud: 40.4168, longitud: -3.7038 },
  { id: "sevilla", nombre: "Sevilla", latitud: 37.3891, longitud: -5.9845 },
  { id: "bilbao", nombre: "Bilbao", latitud: 43.263, longitud: -2.935 },
  { id: "valencia", nombre: "Valencia", latitud: 39.4699, longitud: -0.3763 },
]

const METRIC_NAMES = ["temperatura_c", "humedad_pct", "precipitacion_mm"] as const
export const DUPLICATE_REASON = "Duplicado por ciudad y fecha_hora (se conserva la primera fila)"

type Hourly = { time?: unknown; temperature_2m?: unknown; relative_humidity_2m?: unknown; precipitation?: unknown }

/**
 * Transformación: la API devuelve arrays paralelos (hourly.time[i], hourly.temperature_2m[i]…).
 * Se convierten en una fila por ciudad y hora SIN validar ni modificar los valores.
 */
export function toRows(ciudad: string, payload: unknown): TransformResult {
  const hourly = (payload as { hourly?: Hourly })?.hourly
  const values = hourly && [hourly.time, hourly.temperature_2m, hourly.relative_humidity_2m, hourly.precipitation]
  if (!values || values.some((v) => !Array.isArray(v))) {
    return { rows: [], input: 0, error: { ciudad, indice: -1, motivo: "Respuesta sin arrays horarios válidos", datos: payload } }
  }
  const [times, temperatures, humidities, precipitation] = values as unknown[][]
  const input = times.length
  // Los arrays deben tener la misma longitud: si no, no se puede saber qué valor corresponde a qué hora.
  if (values.some((v) => (v as unknown[]).length !== input)) {
    return { rows: [], input, error: { ciudad, indice: -1, motivo: "Los arrays horarios tienen longitudes distintas", datos: { lengths: values.map((v) => (v as unknown[]).length) } } }
  }
  const rows = times.map((t, i) => ({ ciudad, indice: i, fecha_hora: t, temperatura_c: temperatures[i], humedad_pct: humidities[i], precipitacion_mm: precipitation[i] }))
  return { rows, input }
}

/** Fecha de Open-Meteo con timezone=UTC ("2026-09-01T00:00", sin zona): se interpreta explícitamente como UTC. */
function parseUtc(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value) ? new Date(`${value}Z`) : new Date(NaN)
}

/**
 * Limpieza: valida cada fila y separa válidas y rechazadas con su motivo.
 * Un null, una cadena vacía o un valor ausente se rechaza; nunca se convierte en 0.
 * Las temperaturas no se filtran por umbrales (no hay un rango «imposible» claro).
 * Duplicados por ciudad + fecha_hora: se conserva la PRIMERA fila y se rechazan las siguientes.
 */
export function cleanRows(rows: RawRow[]): CleanResult {
  const records: WeatherRecord[] = [], rejected: RejectedRecord[] = [], seen = new Set<string>()
  for (const row of rows) {
    const fecha = parseUtc(row.fecha_hora)
    const metrics = [row.temperatura_c, row.humedad_pct, row.precipitacion_mm]
    const missing = METRIC_NAMES.filter((_, k) => metrics[k] === null || metrics[k] === undefined || metrics[k] === "")
    let reason = !row.ciudad ? "Ciudad ausente"
      : Number.isNaN(fecha.getTime()) ? "Fecha UTC inválida"
      : missing.length ? `Valor ausente (null o vacío) en ${missing.join(", ")}: no se convierte a 0`
      : !metrics.every((n) => typeof n === "number" && Number.isFinite(n)) ? "Medición no numérica o no finita"
      : ""
    if (!reason && ((row.humedad_pct as number) < 0 || (row.humedad_pct as number) > 100)) reason = "Humedad fuera de 0–100 %"
    if (!reason && (row.precipitacion_mm as number) < 0) reason = "Precipitación negativa"
    const key = reason ? "" : `${row.ciudad}|${fecha.toISOString()}`
    if (!reason && seen.has(key)) reason = DUPLICATE_REASON
    if (reason) {
      rejected.push({ ciudad: row.ciudad, indice: row.indice, motivo: reason, datos: { fecha_hora: row.fecha_hora, temperatura_c: row.temperatura_c, humedad_pct: row.humedad_pct, precipitacion_mm: row.precipitacion_mm } })
    } else {
      seen.add(key)
      records.push({ ciudad: row.ciudad, fecha_hora: fecha.toISOString(), temperatura_c: row.temperatura_c as number, humedad_pct: row.humedad_pct as number, precipitacion_mm: row.precipitacion_mm as number })
    }
  }
  return { records, rejected, duplicates: rejected.filter((r) => r.motivo === DUPLICATE_REASON).length }
}

/** Transformación + limpieza de la respuesta de una ciudad. */
export function transformWeather(ciudad: string, payload: unknown): PipelineResult {
  const t = toRows(ciudad, payload)
  if (t.error) return { records: [], rejected: [t.error], duplicates: 0, input: t.input }
  return { ...cleanRows(t.rows), input: t.input }
}

/** Validación en servidor de cada registro recibido antes de escribir en Supabase. */
export function isRecord(value: unknown): value is WeatherRecord {
  const r = value as WeatherRecord
  return !!r && typeof r.ciudad === "string" && r.ciudad.length > 0 && r.ciudad.length <= 100
    && typeof r.fecha_hora === "string" && !Number.isNaN(new Date(r.fecha_hora).getTime())
    && [r.temperatura_c, r.humedad_pct, r.precipitacion_mm].every((n) => typeof n === "number" && Number.isFinite(n))
    && r.humedad_pct >= 0 && r.humedad_pct <= 100 && r.precipitacion_mm >= 0
}
