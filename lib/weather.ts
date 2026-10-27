export type City = { id: string; nombre: string; latitud: number; longitud: number }
export type WeatherRecord = { ciudad: string; fecha_hora: string; temperatura_c: number; humedad_pct: number; precipitacion_mm: number }
export type RejectedRecord = { ciudad: string; indice: number; motivo: string; datos: unknown }
export type PipelineResult = { records: WeatherRecord[]; rejected: RejectedRecord[]; input: number; duplicates: number }

export const CITIES: City[] = [
  { id: "barcelona", nombre: "Barcelona", latitud: 41.3874, longitud: 2.1686 },
  { id: "madrid", nombre: "Madrid", latitud: 40.4168, longitud: -3.7038 },
  { id: "sevilla", nombre: "Sevilla", latitud: 37.3891, longitud: -5.9845 },
  { id: "bilbao", nombre: "Bilbao", latitud: 43.263, longitud: -2.935 },
  { id: "valencia", nombre: "Valencia", latitud: 39.4699, longitud: -0.3763 },
]

type Hourly = { time?: unknown; temperature_2m?: unknown; relative_humidity_2m?: unknown; precipitation?: unknown }

export function transformWeather(ciudad: string, payload: unknown): PipelineResult {
  const hourly = (payload as { hourly?: Hourly })?.hourly
  const values = hourly && [hourly.time, hourly.temperature_2m, hourly.relative_humidity_2m, hourly.precipitation]
  if (!values || values.some((v) => !Array.isArray(v))) {
    return { records: [], rejected: [{ ciudad, indice: -1, motivo: "Respuesta sin arrays horarios válidos", datos: payload }], input: 0, duplicates: 0 }
  }
  const [times, temperatures, humidities, precipitation] = values as unknown[][]
  const input = times.length
  if (values.some((v) => (v as unknown[]).length !== input)) {
    return { records: [], rejected: [{ ciudad, indice: -1, motivo: "Los arrays horarios tienen longitudes distintas", datos: { lengths: values.map((v) => (v as unknown[]).length) } }], input, duplicates: 0 }
  }
  const records: WeatherRecord[] = [], rejected: RejectedRecord[] = [], seen = new Set<string>()
  for (let i = 0; i < input; i++) {
    const fecha = typeof times[i] === "string" ? new Date(`${times[i]}Z`) : new Date("")
    const metrics = [temperatures[i], humidities[i], precipitation[i]]
    let reason = !ciudad ? "Ciudad ausente" : Number.isNaN(fecha.getTime()) ? "Fecha UTC inválida" : !metrics.every((n) => typeof n === "number" && Number.isFinite(n)) ? "Medición ausente o no numérica" : ""
    if (!reason && (humidities[i] as number < 0 || humidities[i] as number > 100)) reason = "Humedad fuera de 0–100 %"
    if (!reason && (precipitation[i] as number < 0)) reason = "Precipitación negativa"
    const key = `${ciudad}|${fecha.toISOString()}`
    if (!reason && seen.has(key)) reason = "Duplicado por ciudad y fecha_hora (se conserva la primera fila)"
    if (reason) rejected.push({ ciudad, indice: i, motivo: reason, datos: { fecha_hora: times[i], temperatura_c: temperatures[i], humedad_pct: humidities[i], precipitacion_mm: precipitation[i] } })
    else { seen.add(key); records.push({ ciudad, fecha_hora: fecha.toISOString(), temperatura_c: temperatures[i] as number, humedad_pct: humidities[i] as number, precipitacion_mm: precipitation[i] as number }) }
  }
  return { records, rejected, input, duplicates: rejected.filter((r) => r.motivo.startsWith("Duplicado")).length }
}

export function isRecord(value: unknown): value is WeatherRecord {
  const r = value as WeatherRecord
  return !!r && typeof r.ciudad === "string" && r.ciudad.length > 0 && !Number.isNaN(new Date(r.fecha_hora).getTime()) && [r.temperatura_c, r.humedad_pct, r.precipitacion_mm].every(Number.isFinite) && r.humedad_pct >= 0 && r.humedad_pct <= 100 && r.precipitacion_mm >= 0
}
