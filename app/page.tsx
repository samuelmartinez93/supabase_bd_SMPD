"use client"

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, BarChart3, BookOpen, Check, CheckCircle2, Circle, Clock, CloudDownload, CloudRain, CloudSun, Database, Download, Droplets, Eraser, Eye, Info, ListChecks, Loader2, MapPin, RefreshCw, RotateCcw, SlidersHorizontal, Snowflake, Sparkles, Sun, TriangleAlert, Upload, XCircle } from "lucide-react"
import { CityBars, Funnel, TemperatureChart, cityColor } from "@/components/charts"
import { CityMap } from "@/components/city-map"
import { Button } from "@/components/ui/button"
import { applyFilters, countActiveFilters, EMPTY_FILTERS, paginate, recordKey as key, runUpload, selectedOutsideFilters, sortRecords, toBatches, uploadSet, type BatchStatus, type Filters, type PostResult, type SortKey } from "@/lib/pipeline"
import { CITIES, cleanRows, toRows, DUPLICATE_REASON, type RawRow, type RejectedRecord, type WeatherRecord } from "@/lib/weather"

type PhaseState = "pendiente" | "curso" | "completada" | "error"
// name: nombre de la fase en el pipeline ETL · short: etiqueta corta para la barra · unit: qué cuentan entrada y salida.
type Phase = { name: string; short: string; note: string; unitIn: string; unitOut: string; state: PhaseState; input: number; output: number; ms?: number }
type View = 0 | 1 | 2
type ResultTab = "resumen" | "graficos" | "destino" | "etl"
type InspectTab = "previa" | "validos" | "transformados" | "rechazados" | "json"
type CityState = "pendiente" | "curso" | "ok" | "error"
type StoredRecord = WeatherRecord & { id: number; importado_en: string }
type DestQuery = { page: number; city: string; from: string; to: string; sort: SortKey | "importado_en"; asc: boolean }
type Report = { kind: "ok" | "err"; text: string }

const AUTHOR = "Samuel Martínez"
const perPage = 20
const initialPhases: Phase[] = [
  { name: "Extracción", short: "Extracción", note: "Descarga de Open-Meteo los datos horarios de cada ciudad, en UTC, °C y mm.", unitIn: "ciudades pedidas", unitOut: "descargadas", state: "pendiente", input: 0, output: 0 },
  { name: "Transformación", short: "Transformación", note: "Convierte los arrays paralelos de «hourly» en una fila por ciudad y hora, sin tocar los valores.", unitIn: "horas recibidas", unitOut: "filas", state: "pendiente", input: 0, output: 0 },
  { name: "Limpieza", short: "Limpieza", note: "Rechaza filas con null, vacíos, valores no numéricos, humedad fuera de 0–100 %, lluvia negativa o duplicadas (conserva la primera). Un null nunca se convierte en 0.", unitIn: "filas", unitOut: "válidas", state: "pendiente", input: 0, output: 0 },
  { name: "Filtrado y selección", short: "Filtrado", note: "Aplica tus filtros y tu orden a los válidos y se queda con los seleccionados. La paginación solo afecta a lo que ves.", unitIn: "válidas", unitOut: "seleccionadas", state: "pendiente", input: 0, output: 0 },
  { name: "Carga", short: "Carga", note: "Upsert en Supabase por ciudad + fecha_hora en lotes de 500 y verificación posterior de que cada clave existe en destino.", unitIn: "enviadas", unitOut: "verificadas", state: "pendiente", input: 0, output: 0 },
]
const STEPS = [
  { label: "Elige ciudades y días", icon: MapPin, desc: "Márcalas en el mapa y pulsa «Extraer datos»." },
  { label: "Revisa y guarda", icon: Upload, desc: "Revisa, filtra si quieres y súbelos a Supabase." },
  { label: "Explora los resultados", icon: Sparkles, desc: "Récords, gráficos y datos en Supabase." },
]
const PRESETS: [string, number][] = [["1 semana", 7], ["2 semanas", 14], ["1 mes", 30]]
const SORT_OPTIONS: [SortKey, string][] = [["fecha_hora", "Fecha y hora"], ["ciudad", "Ciudad"], ["temperatura_c", "Temperatura"], ["humedad_pct", "Humedad"], ["precipitacion_mm", "Precipitación"]]
const RESULT_TABS: [ResultTab, string][] = [["resumen", "Resumen"], ["graficos", "Gráficos"], ["destino", "Datos en Supabase"], ["etl", "Cómo funciona (ETL)"]]
const INSPECT_TABS: [InspectTab, string][] = [["previa", "Vista previa de la carga"], ["validos", "Registros válidos"], ["transformados", "Datos transformados"], ["rechazados", "Rechazados"], ["json", "JSON original"]]
// Pestaña donde se inspecciona el resultado de cada fase del pipeline.
const PHASE_TAB: InspectTab[] = ["json", "transformados", "rechazados", "validos", "previa"]

const fmt = (n: number) => n.toLocaleString("es-ES")
const fmt1 = (n: number) => n.toLocaleString("es-ES", { maximumFractionDigits: 1 })
const fmtMs = (ms: number) => (ms < 1000 ? `${Math.max(ms, 0.1).toFixed(ms < 10 ? 1 : 0)} ms` : `${(ms / 1000).toFixed(1)} s`)
const fmtDate = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
const niceDate = (iso: string) => new Date(iso).toLocaleString("es-ES", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " (UTC)"
const niceDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10)
// Rango que ofrece el histórico de Open-Meteo: desde 1940 hasta hace unos 5 días.
const FIRST_DAY = "1940-01-01"
const ARCHIVE_DELAY_DAYS = 5
const latestAvailableDay = () => addDays(new Date().toISOString().slice(0, 10), -ARCHIVE_DELAY_DAYS)
const noop = () => () => {}
// Título que recibe el foco al llegar a cada paso.
const STEP_HEADINGS = ["mapa-title", "obtenido-title", "resultado-title"]
const cityName = (id: string) => CITIES.find((c) => c.id === id)?.nombre ?? id
const CITY_STATE_LABEL: Record<CityState, string> = { pendiente: "pendiente", curso: "descargando…", ok: "descargada", error: "con error" }

export default function Page() {
  const [view, setView] = useState<View>(0)
  // Paso 1: qué extraer
  const [cities, setCities] = useState(CITIES.map((c) => c.id))
  const [start, setStart] = useState("2026-09-01")
  const [end, setEnd] = useState("2026-09-30")
  const [raw, setRaw] = useState<Record<string, unknown>>({})
  const [transformed, setTransformed] = useState<RawRow[]>([])
  const [records, setRecords] = useState<WeatherRecord[]>([])
  const [rejected, setRejected] = useState<RejectedRecord[]>([])
  const [inputCount, setInputCount] = useState(0)
  const [phases, setPhases] = useState(initialPhases)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [working, setWorking] = useState(false)
  const [cityState, setCityState] = useState<Record<string, CityState>>({})
  const [announce, setAnnounce] = useState("")
  // Paso 2: filtros, orden, selección e inspección
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [sort, setSort] = useState<SortKey>("fecha_hora")
  const [asc, setAsc] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [inspect, setInspect] = useState<InspectTab>("previa")
  const [page, setPage] = useState(0)
  const [jsonCity, setJsonCity] = useState("")
  // Carga y destino
  const [uploading, setUploading] = useState(false)
  const uploadLock = useRef(false)
  const [batches, setBatches] = useState<BatchStatus[]>([])
  const [report, setReport] = useState<Report | null>(null)
  const [failed, setFailed] = useState<WeatherRecord[][]>([])
  const [persisted, setPersisted] = useState<Set<string>>(new Set())
  const [dest, setDest] = useState<{ rows: StoredRecord[]; count: number; total: number } | null>(null)
  const [destQuery, setDestQuery] = useState<DestQuery>({ page: 0, city: "", from: "", to: "", sort: "fecha_hora", asc: false })
  const [destLoading, setDestLoading] = useState(false)
  const [destError, setDestError] = useState("")
  const [destUpdated, setDestUpdated] = useState("")
  const [resultTab, setResultTab] = useState<ResultTab>("resumen")
  const [fc, setFc] = useState<string[]>([]) // ciudades resaltadas en los gráficos de resultados (no afecta a la carga)

  const days = Math.round((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 864e5) + 1
  // Open-Meteo publica el histórico con unos días de retraso. Solo se calcula en el navegador
  // (la página se prerenderiza en el build y allí la fecha sería la del despliegue).
  const lastDay = useSyncExternalStore(noop, latestAvailableDay, () => "")
  const tooRecent = Boolean(lastDay) && end > lastDay
  const ok = cities.length > 0 && days >= 1 && days <= 31 && start >= FIRST_DAY && !tooRecent

  // Orden fijo: válidos → filtros → ordenación (→ paginación solo para mostrar). Se mide la duración real.
  const { rows: filtered, ms: filterMs } = useMemo(() => {
    const t0 = performance.now()
    const rows = sortRecords(applyFilters(records, filters), sort, asc)
    return { rows, ms: performance.now() - t0 }
  }, [records, filters, sort, asc])
  const activeFilters = countActiveFilters(filters)
  // Lo que se subirá: seleccionadas que siguen cumpliendo los filtros, en el orden elegido.
  const toUpload = useMemo(() => uploadSet(filtered, selected), [filtered, selected])
  const outside = useMemo(() => selectedOutsideFilters(selected, filtered), [selected, filtered])
  const pendingUpload = toUpload.filter((r) => !persisted.has(key(r))).length
  const savedNow = toUpload.length - pendingUpload
  const localPending = records.filter((r) => !persisted.has(key(r))).length
  const shown = useMemo(() => toUpload.filter((r) => !fc.length || fc.includes(r.ciudad)), [toUpload, fc])
  const duplicates = rejected.filter((r) => r.motivo === DUPLICATE_REASON).length
  const missingValues = rejected.filter((r) => r.motivo.startsWith("Valor ausente")).length
  const downloadedCities = Object.keys(raw).length
  const displayPhases = phases.map((p, i) => (i === 3 && records.length ? { ...p, state: "completada" as const, input: records.length, output: toUpload.length, ms: filterMs } : p))
  const phasesDone = displayPhases.filter((p) => p.state === "completada").length
  const reachable = (v: number) => v === 0 || records.length > 0

  function go(v: View) {
    if (!reachable(v)) return
    show(v)
  }
  // Cambia de paso, lo anuncia a lectores de pantalla y lleva el foco a su título.
  function show(v: View, message = `Paso ${v + 1} de 3: ${STEPS[v].label}.`) {
    setView(v)
    setAnnounce(message)
    window.scrollTo({ top: 0, behavior: "smooth" })
    requestAnimationFrame(() => document.getElementById(STEP_HEADINGS[v])?.focus({ preventScroll: true }))
  }
  function showInspect(t: InspectTab) {
    setInspect(t); setPage(0)
    if (view !== 1) setView(1)
    requestAnimationFrame(() => document.getElementById("inspeccion")?.scrollIntoView({ behavior: "smooth", block: "start" }))
  }
  // Cada fase del pipeline se inspecciona en su pestaña (antes de extraer, solo hay configuración).
  function openPhase(i: number) {
    if (!records.length && !Object.keys(errors).length) return go(0)
    showInspect(PHASE_TAB[i])
  }
  function toggleCity(id: string) {
    setCities((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]))
  }
  function toggleChartCity(city: string) {
    setFc((v) => (v.includes(city) ? v.filter((x) => x !== city) : [...v, city]))
  }
  function setFilter<K extends keyof Filters>(k: K, v: Filters[K]) {
    setFilters((f) => ({ ...f, [k]: v }))
    setPage(0)
  }

  // Altura real de la barra fija, para que anclajes y bloques sticky no queden tapados.
  const topbar = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!topbar.current) return
    const ro = new ResizeObserver(([e]) => document.documentElement.style.setProperty("--topbar-h", `${Math.ceil(e.target.getBoundingClientRect().height)}px`))
    ro.observe(topbar.current)
    return () => ro.disconnect()
  }, [])

  const phase = (n: number, update: Partial<Phase>) => setPhases((v) => v.map((p, i) => (i === n ? { ...p, ...update } : p)))

  async function checkPersisted(rows: WeatherRecord[]) {
    if (!rows.length) return setPersisted(new Set())
    const dates = rows.map((r) => r.fecha_hora.slice(0, 10)).sort()
    const params = new URLSearchParams({ mode: "keys", cities: [...new Set(rows.map((r) => r.ciudad))].join(","), start: dates[0], end: dates[dates.length - 1] })
    try {
      const res = await fetch(`/api/supabase?${params}`, { cache: "no-store" })
      const body = await res.json()
      if (res.ok) setPersisted(new Set(body.keys as string[]))
    } catch { /* sin conexión: todo se muestra como pendiente */ }
  }

  // merge = true reintenta solo las ciudades indicadas y conserva lo ya extraído del resto.
  // Se recalcula todo a partir de los JSON originales: reintentar nunca duplica filas.
  async function extract(only = cities, merge = false) {
    if (!ok || !only.length || working) return
    setWorking(true)
    setReport(null)
    setPhases((v) => (merge ? v : initialPhases).map((p, i) => (i === 0 ? { ...p, state: "curso" } : i < 4 ? { ...p, state: "pendiente", ms: undefined } : p)))
    const states: Record<string, CityState> = merge ? { ...cityState } : {}
    only.forEach((id) => (states[id] = "pendiente"))
    setCityState({ ...states })
    const began = performance.now()
    const nextRaw: Record<string, unknown> = merge ? { ...raw } : {}
    const errs: Record<string, string> = merge ? { ...errors } : {}
    for (const cityId of only) {
      states[cityId] = "curso"; setCityState({ ...states })
      delete errs[cityId]
      delete nextRaw[cityId]
      try {
        const res = await fetch("/api/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cityId, start, end }) })
        const body = await res.json()
        if (res.ok) nextRaw[cityId] = body.raw
        else errs[cityId] = body.error ?? `Error HTTP ${res.status}`
      } catch { errs[cityId] = "No se pudo conectar con el servidor." }
      states[cityId] = cityId in nextRaw ? "ok" : "error"; setCityState({ ...states })
    }
    const extractMs = performance.now() - began

    // Transformación (arrays → filas) y limpieza (validación), medidas por separado.
    let t0 = performance.now(), input = 0
    const rows: RawRow[] = [], structural: RejectedRecord[] = []
    for (const c of CITIES) {
      if (!(c.id in nextRaw)) continue
      const t = toRows(c.nombre, nextRaw[c.id])
      input += t.input
      rows.push(...t.rows)
      if (t.error) structural.push(t.error)
    }
    const transformMs = performance.now() - t0
    t0 = performance.now()
    const clean = cleanRows(rows)
    const cleanMs = performance.now() - t0
    const bad = [...structural, ...clean.rejected]

    setRaw(nextRaw); setTransformed(rows); setRecords(clean.records); setRejected(bad); setErrors(errs); setInputCount(input); setPage(0)
    if (!jsonCity || !(jsonCity in nextRaw)) setJsonCity(Object.keys(nextRaw)[0] ?? "")
    // Selección inicial: todas las válidas de las ciudades recién extraídas. Al reintentar se conserva
    // lo que ya habías seleccionado o quitado. Cambiar filtros nunca selecciona nada por sí solo.
    const fresh = new Set(only.map(cityName))
    setSelected((s) => {
      const n = merge ? new Set([...s].filter((k) => !fresh.has(k.split("|")[0]))) : new Set<string>()
      clean.records.forEach((r) => fresh.has(r.ciudad) && n.add(key(r)))
      return n
    })
    const okCities = Object.keys(nextRaw).length, requested = okCities + Object.keys(errs).length
    phase(0, { state: Object.keys(errs).length ? "error" : "completada", input: requested, output: okCities, ms: extractMs })
    phase(1, { state: structural.length ? "error" : "completada", input, output: rows.length, ms: transformMs })
    phase(2, { state: "completada", input: rows.length, output: clean.records.length, ms: cleanMs })
    await checkPersisted(clean.records)
    setWorking(false)
    // `show` directo: `go` comprobaría `records` del render anterior (aún vacío).
    if (clean.records.length) show(1, `Extracción completada: ${fmt(clean.records.length)} registros válidos de ${okCities} ${okCities === 1 ? "ciudad" : "ciudades"}. Paso 2 de 3: revisa y guarda.`)
    else setAnnounce("No se ha podido extraer ninguna ciudad. Revisa los avisos.")
  }

  function toggle(r: WeatherRecord) {
    setSelected((s) => { const n = new Set(s); if (n.has(key(r))) n.delete(key(r)); else n.add(key(r)); return n })
  }
  function toggleMany(rows: WeatherRecord[]) {
    setSelected((s) => { const n = new Set(s), every = rows.every((r) => n.has(key(r))); rows.forEach((r) => (every ? n.delete(key(r)) : n.add(key(r)))); return n })
  }
  function selectAllFiltered() {
    setSelected((s) => new Set([...s, ...filtered.map(key)]))
  }
  function resetFilters() {
    setFilters(EMPTY_FILTERS); setPage(0)
  }
  function restart() {
    const question = report?.kind === "ok"
      ? "¿Empezar de nuevo? Lo guardado en Supabase se queda, pero se borrará lo que ves ahora en pantalla."
      : "¿Empezar de nuevo? Se borrarán los datos extraídos, que todavía no están guardados."
    if (!window.confirm(question)) return
    setRaw({}); setTransformed([]); setRecords([]); setRejected([]); setErrors({}); setInputCount(0); setPhases(initialPhases); setCityState({})
    setSelected(new Set()); resetFilters(); setReport(null); setFailed([]); setBatches([]); setFc([]); setResultTab("resumen"); setInspect("previa")
    go(0)
  }
  function saveFile(content: string, name: string, type: string) {
    const a = document.createElement("a")
    a.href = URL.createObjectURL(new Blob([content], { type }))
    a.download = name
    a.click()
    URL.revokeObjectURL(a.href)
  }
  // CSV estándar (coma y punto decimal) para Python/pandas; el BOM hace que Excel respete las tildes.
  function downloadCsv() {
    const header = "ciudad,fecha_hora,temperatura_c,humedad_pct,precipitacion_mm"
    const lines = toUpload.map((r) => [r.ciudad, r.fecha_hora, r.temperatura_c, r.humedad_pct, r.precipitacion_mm].join(","))
    saveFile(`﻿${header}\n${lines.join("\n")}\n`, `tiempo_${start}_${end}.csv`, "text/csv;charset=utf-8")
  }
  function downloadJson(cityId?: string) {
    const data = cityId ? raw[cityId] : raw
    saveFile(JSON.stringify(data, null, 2), cityId ? `open-meteo_${cityId}_${start}_${end}.json` : `open-meteo_${start}_${end}.json`, "application/json")
  }

  async function postBatch(batch: WeatherRecord[]): Promise<PostResult> {
    const res = await fetch("/api/supabase", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ records: batch }) })
    const body = await res.json().catch(() => ({}))
    return res.ok ? { ok: true, verified: body.verified, missing: body.missing ?? [] } : { ok: false, error: body.error ?? `Error HTTP ${res.status}` }
  }
  async function send(toSend: WeatherRecord[][]) {
    // Cerrojo síncrono: evita dos cargas a la vez aunque se pulse dos veces muy rápido.
    if (uploadLock.current) return
    uploadLock.current = true
    setUploading(true)
    setReport(null)
    const total = toSend.flat().length
    phase(4, { state: "curso", input: total, output: 0, ms: undefined })
    const t0 = performance.now()
    const r = await runUpload(toSend, postBatch, setBatches)
    const failedRows = r.failed.flat().length
    setPersisted((s) => new Set([...s, ...r.stored]))
    setFailed(r.failed)
    setReport(r.failed.length
      ? { kind: "err", text: `Carga parcial: ${fmt(r.verified)} de ${fmt(total)} registros verificados en Supabase; ${fmt(failedRows)} fallidos en ${r.failed.length} lote(s). Motivo: ${[...new Set(r.messages)].join(" · ")}` }
      : { kind: "ok", text: `Carga completa: ${fmt(r.verified)} de ${fmt(total)} registros verificados en Supabase. Los que ya existían se han actualizado sin duplicarse (Supabase no indica cuántos eran nuevos y cuántos actualizados).` })
    phase(4, { state: r.failed.length ? "error" : "completada", input: total, output: r.verified, ms: performance.now() - t0 })
    uploadLock.current = false
    setUploading(false)
    void loadDest()
  }
  function upload() {
    // Se congela una copia del conjunto seleccionado y su orden: cambiar filtros después no altera esta carga.
    const snapshot = [...toUpload]
    if (snapshot.length) void send(toBatches(snapshot))
  }

  async function loadDest(patch: Partial<DestQuery> = {}) {
    const q = { ...destQuery, ...patch }
    setDestQuery(q)
    setDestLoading(true)
    setDestError("")
    const params = new URLSearchParams({ page: String(q.page), size: String(perPage), sort: q.sort, dir: q.asc ? "asc" : "desc" })
    if (q.city) params.set("city", q.city)
    if (q.from) params.set("start", q.from)
    if (q.to) params.set("end", q.to)
    try {
      const res = await fetch(`/api/supabase?${params}`, { cache: "no-store" })
      const body = await res.json()
      if (res.ok) { setDest(body); setDestUpdated(new Date().toLocaleTimeString("es-ES")) }
      else setDestError(body.error ?? "No se pudo leer Supabase.")
    } catch { setDestError("No se pudo conectar con el servidor.") }
    setDestLoading(false)
  }
  // Lectura inicial del destino para que el contador de persistidos sea real desde el principio.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadDest() }, [])

  const numberField = (k: "minT" | "maxT" | "minH" | "maxH" | "minP" | "maxP", label: string) => (
    <label className="field">{label}<input className="control" type="number" inputMode="decimal" value={filters[k]} onChange={(e) => setFilter(k, e.target.value)} /></label>
  )
  const retryNotices = Object.entries(errors).map(([id, e]) => (
    <Notice kind="err" key={id}>
      No se ha podido extraer <b>{cityName(id)}</b>: {e}{" "}<button className="link-button" disabled={working} onClick={() => extract([id], true)}>Reintentar solo esta ciudad</button>
    </Notice>
  ))
  const inspectCount: Record<InspectTab, number | undefined> = { previa: toUpload.length, validos: filtered.length, transformados: transformed.length, rechazados: rejected.length, json: downloadedCities }
  const inspectTotal = inspect === "previa" ? toUpload.length : inspect === "validos" ? filtered.length : inspect === "transformados" ? transformed.length : rejected.length

  return (
    <>
    {/* ── Barra superior fija y fina: marca + progreso del pipeline, discreto ── */}
    <header ref={topbar} className="topbar">
      <div className="topbar-row">
        <div className="brand">
          <span className="brand-mark"><CloudSun size={18} aria-hidden /></span>
          <b>El tiempo en tus ciudades</b>
        </div>
        <ol className="progress-mini" aria-label="Pipeline ETL">
          {displayPhases.map((p, i) => (
            <li key={p.name}>
              <button type="button" className="mini-phase" data-state={p.state} title={`${p.name} · ${PHASE_LABEL[p.state]}: ${phaseText(p)}. ${p.note}`} onClick={() => openPhase(i)}>
                <PhaseIcon state={p.state} />
                <span className="mini-phase-label">{p.short}</span>
                <span className="sr-only"> · {PHASE_LABEL[p.state]} · {phaseText(p)}</span>
              </button>
            </li>
          ))}
        </ol>
        <span className="topbar-step">Paso {view + 1} de 3</span>
      </div>
      <div className="topbar-progress" role="progressbar" aria-label="Fases del pipeline completadas" aria-valuemin={0} aria-valuemax={5} aria-valuenow={phasesDone}>
        <span style={{ width: `${(phasesDone / 5) * 100}%` }} />
      </div>
    </header>

    <main className="app-container">
      {/* Avisos para lectores de pantalla: cambios de paso y fin de la extracción */}
      <p className="sr-only" aria-live="polite" role="status">{announce}</p>
      {/* ── Introducción: qué es la página y para qué sirve (solo al empezar) ── */}
      {view === 0 && (
        <section className="intro" aria-labelledby="intro-title">
          <p className="eyebrow">Datos meteorológicos abiertos · España</p>
          <h1 id="intro-title">Consulta el tiempo de cinco ciudades y guárdalo en tu base de datos</h1>
          <p>
            Descarga la temperatura, la humedad y la lluvia de cada hora, comprueba que los datos estén bien
            y guárdalos en Supabase. Sin conocimientos técnicos: solo tres pasos.
          </p>
        </section>
      )}

      {/* ── Los 3 pasos: qué hace cada uno y en cuál estás ── */}
      <ol className="steps" aria-label="Pasos">
        {STEPS.map((s, i) => {
          const state = i === view ? "current" : (i === 0 && records.length) || (i === 1 && report?.kind === "ok") ? "done" : "todo"
          const Icon = s.icon
          return (
            <li key={s.label}>
              <button type="button" className="step-card" data-state={state} aria-current={state === "current" ? "step" : undefined} disabled={!reachable(i)} onClick={() => go(i as View)}>
                <span className="step-num">{state === "done" ? <Check size={18} aria-hidden /> : <Icon size={18} aria-hidden />}</span>
                <span className="step-text">
                  <small>Paso {i + 1}{state === "current" ? " · estás aquí" : state === "done" ? " · hecho" : ""}</small>
                  <b>{s.label}</b>
                  <span>{s.desc}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ol>

      {/* ── Paso 1: configuración de la extracción ── */}
      {view === 0 && (
        <div className="wizard wizard-choose">
          <section className="app-panel map-panel" aria-labelledby="mapa-title">
            <div className="panel-head">
              <h2 id="mapa-title" className="panel-title" tabIndex={-1}><MapPin size={18} className="panel-icon" aria-hidden />¿De qué ciudades quieres el tiempo?</h2>
              <p className="panel-hint">Pulsa una ciudad del mapa para añadirla o quitarla. Solo están disponibles estas cinco.</p>
            </div>
            <CityMap selected={cities} onToggle={toggleCity} />
            <div className="chip-group mt-3" role="group" aria-label="Ciudades">
              {CITIES.map((c) => (
                <button key={c.id} type="button" className="chip" aria-pressed={cities.includes(c.id)} onClick={() => toggleCity(c.id)}>
                  <span className="swatch" style={{ background: cityColor(c.nombre) }} aria-hidden /><Check className="check" aria-hidden />{c.nombre}
                </button>
              ))}
              <button type="button" className="link-button text-sm" onClick={() => setCities(cities.length === CITIES.length ? [] : CITIES.map((c) => c.id))}>
                {cities.length === CITIES.length ? "Quitar todas" : "Marcar todas"}
              </button>
            </div>
          </section>

          <section className="app-panel choose-panel" aria-labelledby="dias-title">
            <div className="panel-head">
              <h2 id="dias-title" className="panel-title"><Clock size={18} className="panel-icon" aria-hidden />¿Qué días?</h2>
              <p className="panel-hint">Hasta 31 días seguidos (fechas en UTC). Elige un atajo o pon las fechas.</p>
            </div>
            <div className="flex flex-col gap-4">
              <div className="chip-group">
                {PRESETS.map(([label, n]) => (
                  <button key={label} type="button" className="chip" aria-pressed={days === n} onClick={() => setStart(addDays(end, -(n - 1)))}><Check className="check" aria-hidden />{label}</button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="field">Fecha inicial<input className="control" type="date" value={start} min={FIRST_DAY} max={lastDay || undefined} onChange={(e) => setStart(e.target.value)} /></label>
                <label className="field">Fecha final<input className="control" type="date" value={end} min={FIRST_DAY} max={lastDay || undefined} onChange={(e) => setEnd(e.target.value)} /></label>
              </div>
              <div className="summary-box" role={ok ? undefined : "alert"}>
                {ok ? (
                  <p>Volumen previsto: <b>{fmt(cities.length * days * 24)} registros</b> ({cities.length} {cities.length === 1 ? "ciudad" : "ciudades"} × {days} {days === 1 ? "día" : "días"} × 24 horas) de <b>{cities.map(cityName).join(", ")}</b>, del {niceDay(start)} al {niceDay(end)}.</p>
                ) : (
                  <p>
                    {!cities.length ? "Elige al menos una ciudad en el mapa."
                      : tooRecent ? `Open-Meteo publica el histórico con unos ${ARCHIVE_DELAY_DAYS} días de retraso: elige fechas hasta el ${niceDay(lastDay)} como mucho.`
                      : start < FIRST_DAY ? "El histórico empieza el 1 de enero de 1940."
                      : days > 31 ? `El periodo tiene ${days} días: el máximo por extracción es 31.`
                      : "La fecha final debe ser igual o posterior a la inicial."}
                  </p>
                )}
              </div>
              <Button size="lg" className="big-btn" disabled={!ok || working} onClick={() => extract()}>
                {working ? <Loader2 className="animate-spin" /> : <CloudDownload />}{working ? "Extrayendo…" : "Extraer datos"}
              </Button>
              {Object.keys(cityState).length > 0 && <CityProgress states={cityState} />}
              {retryNotices}
              <div className="explain">
                <b><Info size={15} aria-hidden />¿Qué pasará al pulsar?</b>
                <ol>
                  <li>Pedimos los datos horarios a <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a>.</li>
                  <li>Los convertimos en filas y apartamos los incompletos o repetidos.</li>
                  <li>Te enseñamos lo obtenido antes de subir nada a Supabase.</li>
                </ol>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* ── Paso 2: pipeline, filtros, inspección y carga ── */}
      {view === 1 && (
        <div className="wizard wizard-review">
          <div className="flex min-w-0 flex-col gap-4">
            <section className="app-panel" aria-labelledby="obtenido-title">
              <div className="panel-head">
                <h2 id="obtenido-title" className="panel-title" tabIndex={-1}><Sparkles size={18} className="panel-icon" aria-hidden />Esto es lo que hemos obtenido</h2>
              </div>
              <p className="story">
                Hemos extraído <b>{fmt(inputCount)} horas</b> de {downloadedCities} {downloadedCities === 1 ? "ciudad" : "ciudades"}.{" "}
                {rejected.length
                  ? <>Se han rechazado <b>{fmt(rejected.length)}</b> por calidad ({fmt(missingValues)} con valores ausentes, {fmt(duplicates)} duplicadas).{" "}</>
                  : <>Ninguna se ha rechazado por calidad. </>}
                Hay <b>{fmt(records.length)} registros válidos</b>{activeFilters ? <>, de los que <b>{fmt(filtered.length)}</b> cumplen tus filtros</> : null} y <b>{fmt(toUpload.length)}</b> están seleccionados para cargar.
              </p>
              <dl className="stats stats-5">
                <Stat label="Total extraído" value={fmt(inputCount)} color="var(--bondi)" />
                <Stat label="Válidos" value={fmt(records.length)} color="var(--emerald)" />
                <Stat label="Rechazados" value={fmt(rejected.length)} color={rejected.length ? "var(--red-700)" : "var(--border-strong)"} />
                <Stat label="Coinciden con los filtros" value={fmt(filtered.length)} color="var(--cerulean)" />
                <Stat label="Seleccionados para cargar" value={fmt(toUpload.length)} color="var(--yale)" />
              </dl>
              <PipelineStrip phases={displayPhases} onInspect={(i) => showInspect(PHASE_TAB[i])} />
              {retryNotices}
            </section>

            <Panel title="Temperatura de los registros seleccionados" unit="°C · UTC" hint="Pasa el cursor por encima para ver el valor de cada momento.">
              <TemperatureChart rows={toUpload} />
            </Panel>

            <details className="app-panel advanced" open={activeFilters > 0 || undefined}>
              <summary>
                <span><SlidersHorizontal size={16} aria-hidden /> Filtrar, ordenar y seleccionar <small>(opcional)</small></span>
                <small className="text-muted-foreground">{activeFilters ? `${activeFilters} filtro(s) activo(s) · ` : ""}{fmt(filtered.length)} de {fmt(records.length)} válidos coinciden</small>
              </summary>
              <div className="advanced-body">
                <fieldset className="adv-group">
                  <legend>Ciudades <small>(sin marcar = todas)</small></legend>
                  <div className="chip-group">
                    {[...new Set(records.map((r) => r.ciudad))].map((c) => (
                      <button key={c} type="button" className="chip" aria-pressed={filters.cities.includes(c)}
                        onClick={() => setFilter("cities", filters.cities.includes(c) ? filters.cities.filter((x) => x !== c) : [...filters.cities, c])}>
                        <span className="swatch" style={{ background: cityColor(c) }} aria-hidden /><Check className="check" aria-hidden />{c}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <div className="adv-filters">
                  <label className="field">Desde (fecha y hora UTC)<input className="control" type="datetime-local" value={filters.from} onChange={(e) => setFilter("from", e.target.value)} /></label>
                  <label className="field">Hasta (fecha y hora UTC)<input className="control" type="datetime-local" value={filters.to} onChange={(e) => setFilter("to", e.target.value)} /></label>
                  {numberField("minT", "Temp. mín. (°C)")}
                  {numberField("maxT", "Temp. máx. (°C)")}
                  {numberField("minH", "Humedad mín. (%)")}
                  {numberField("maxH", "Humedad máx. (%)")}
                  {numberField("minP", "Precip. mín. (mm)")}
                  {numberField("maxP", "Precip. máx. (mm)")}
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="chip w-fit"><input type="checkbox" checked={filters.rain} onChange={(e) => setFilter("rain", e.target.checked)} />Solo registros con lluvia (&gt; 0 mm)</label>
                  <label className="field">Ordenar por
                    <select className="control" value={sort} onChange={(e) => { setSort(e.target.value as SortKey); setPage(0) }}>
                      {SORT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </label>
                  <Button variant="outline" onClick={() => { setAsc(!asc); setPage(0) }} aria-label={`Orden ${asc ? "ascendente" : "descendente"}; cambiar`}>{asc ? <ArrowUp /> : <ArrowDown />}{asc ? "Ascendente" : "Descendente"}</Button>
                  <Button variant="outline" disabled={!activeFilters} onClick={resetFilters}><RotateCcw />Restablecer filtros</Button>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="outline" disabled={!filtered.length} onClick={selectAllFiltered}><ListChecks />Seleccionar los {fmt(filtered.length)} que cumplen los filtros</Button>
                  <Button variant="outline" disabled={!selected.size} onClick={() => setSelected(new Set())}><Eraser />Vaciar selección</Button>
                  <Button variant="ghost" onClick={() => showInspect("validos")}><Eye />Elegir fila a fila</Button>
                </div>
                {outside > 0 && <Notice kind="warn">{fmt(outside)} {outside === 1 ? "registro seleccionado queda" : "registros seleccionados quedan"} fuera de los filtros actuales y no se {outside === 1 ? "subirá" : "subirán"}.</Notice>}
              </div>
            </details>

            <section id="inspeccion" className="app-panel" aria-labelledby="inspeccion-title">
              <div className="panel-head">
                <h2 id="inspeccion-title" className="panel-title"><Eye size={18} className="panel-icon" aria-hidden />Inspeccionar los datos</h2>
                <p className="panel-hint">El resultado de cada fase. Las tablas se paginan de {perPage} en {perPage}: la paginación solo cambia lo que ves, no lo que se sube.</p>
              </div>
              <div className="tabs" role="tablist" aria-label="Resultados de cada fase">
                {INSPECT_TABS.map(([id, label]) => (
                  <button key={id} id={`itab-${id}`} role="tab" aria-selected={inspect === id} aria-controls="inspect-panel" className="tab" onClick={() => { setInspect(id); setPage(0) }}>
                    {label}{inspectCount[id] !== undefined && <span className="count">{fmt(inspectCount[id]!)}</span>}
                  </button>
                ))}
              </div>
              <div id="inspect-panel" role="tabpanel" aria-labelledby={`itab-${inspect}`}>
                {inspect === "previa" && (
                  <>
                    <Notice kind="info">
                      Este es el conjunto <b>exacto</b> que se enviará a Supabase, en el orden elegido ({SORT_OPTIONS.find(([v]) => v === sort)?.[1].toLowerCase()}, {asc ? "ascendente" : "descendente"}).
                      Ojo: una base de datos no conserva el orden de inserción; para leer los datos ordenados hay que usar <code>ORDER BY</code> en la consulta.
                    </Notice>
                    <PreviewTable rows={paginate(toUpload, page, perPage)} offset={page * perPage} persisted={persisted} empty="No hay registros seleccionados que cumplan los filtros." />
                  </>
                )}
                {inspect === "validos" && (
                  <>
                    <p className="table-note">Registros válidos que cumplen los filtros ({fmt(filtered.length)} de {fmt(records.length)}), ya ordenados. Marca o desmarca filas; la selección se mantiene al cambiar de página.</p>
                    <LocalTable rows={paginate(filtered, page, perPage)} selected={selected} persisted={persisted} toggle={toggle}
                      togglePage={() => toggleMany(paginate(filtered, page, perPage))} empty="Ningún registro válido cumple los filtros." />
                  </>
                )}
                {inspect === "transformados" && (
                  <>
                    <p className="table-note">Filas tal como salen de la transformación (una por ciudad y hora), antes de limpiar. Los valores no se han modificado: un <span className="null-value">null</span> sigue siendo null.</p>
                    <RawTable rows={paginate(transformed, page, perPage)} />
                  </>
                )}
                {inspect === "rechazados" && (
                  <>
                    <p className="table-note">Descartes por calidad, con su motivo. Son distintos de los registros que solo quedan fuera por tus filtros (esos siguen siendo válidos).</p>
                    <RejectTable rows={paginate(rejected, page, perPage)} />
                  </>
                )}
                {inspect === "json" && (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="field">Ciudad
                        <select className="control" value={jsonCity} onChange={(e) => setJsonCity(e.target.value)}>
                          {Object.keys(raw).map((id) => <option key={id} value={id}>{cityName(id)}</option>)}
                        </select>
                      </label>
                      <Button variant="outline" disabled={!jsonCity} onClick={() => downloadJson(jsonCity)}><Download />Descargar JSON de {cityName(jsonCity)}</Button>
                      <Button variant="outline" disabled={!downloadedCities} onClick={() => downloadJson()}><Download />Descargar todos</Button>
                    </div>
                    <pre className="json-view">{jsonCity && raw[jsonCity] ? JSON.stringify(raw[jsonCity], null, 2) : "Sin respuesta original para esta ciudad."}</pre>
                  </div>
                )}
                {inspect !== "json" && <Pager page={page} total={inspectTotal} set={setPage} />}
              </div>
            </section>
          </div>

          <aside className="app-panel save-panel" aria-labelledby="guardar-title">
            <div className="sticky-block flex flex-col gap-4">
              <div className="panel-head mb-0">
                <h2 id="guardar-title" className="panel-title"><Database size={18} className="panel-icon" aria-hidden />Carga en Supabase</h2>
                <p className="panel-hint">Supabase es la base de datos en la nube. La escritura se hace solo desde el servidor.</p>
              </div>
              <p className="save-count"><b>{fmt(toUpload.length)}</b> registros seleccionados{savedNow > 0 && <small>{fmt(savedNow)} ya estaban en Supabase y se actualizarán</small>}</p>
              <Button size="lg" className="big-btn" disabled={!toUpload.length || uploading} onClick={upload}>
                {uploading ? <Loader2 className="animate-spin" /> : <Upload />}{uploading ? "Subiendo…" : `Subir ${fmt(toUpload.length)} registros a Supabase`}
              </Button>
              <Button variant="outline" size="lg" disabled={!toUpload.length} onClick={() => showInspect("previa")}><Eye />Ver vista previa de la carga</Button>
              {batches.length > 0 && <BatchList batches={batches} />}
              {failed.length > 0 && <Button variant="outline" size="lg" disabled={uploading} onClick={() => send(failed)}><RefreshCw />Reintentar {failed.length} lote(s) fallido(s)</Button>}
              {report && <Notice kind={report.kind}>{report.text}</Notice>}
              {!toUpload.length && <Notice kind="info">No hay registros seleccionados que cumplan los filtros.</Notice>}
              {report?.kind === "ok"
                ? <Button size="lg" className="big-btn" onClick={() => go(2)}>Ver resultados<ArrowRight /></Button>
                : <button type="button" className="link-button text-sm" onClick={() => go(2)}>Ver resultados sin subir</button>}
              <button type="button" className="back-link" onClick={() => go(0)}><ArrowLeft size={15} aria-hidden />Cambiar ciudades o días</button>

              <div className="upsert-explain">
                <b><Info size={15} aria-hidden />¿Por qué no se duplican los datos?</b>
                <p>
                  Cada medición se identifica por <b>ciudad + fecha_hora</b> (restricción única). Al guardar hacemos un <i>upsert</i>
                  (<i>update</i> + <i>insert</i>): si esa combinación ya existe, se actualiza; si no, se añade.
                </p>
                <dl className="upsert-example" aria-label="Ejemplo">
                  <div><dt>1.ª vez</dt><dd>Madrid · 1 sept 12:00 → <b>se añade</b></dd></div>
                  <div><dt>2.ª vez</dt><dd>Madrid · 1 sept 12:00 → <b>se actualiza</b></dd></div>
                </dl>
                <p className="text-xs">Se envía en lotes de 500 como máximo, uno tras otro. Al terminar cada lote se consulta Supabase para verificar que todas sus claves existen.</p>
              </div>
            </div>
          </aside>
        </div>
      )}

      {/* ── Paso 3: resultados ── */}
      {view === 2 && (
        <div className="flex flex-col gap-4">
          <section className={`result-hero ${report?.kind === "ok" ? "ok" : ""}`}>
            {report?.kind === "ok" ? <CheckCircle2 size={28} aria-hidden /> : <Info size={28} aria-hidden />}
            <div>
              <h2 id="resultado-title" tabIndex={-1}>{report?.kind === "ok" ? "¡Todo listo!" : "Tus datos (todavía sin subir)"}</h2>
              <p>
                {fmt(toUpload.length)} registros de {[...new Set(toUpload.map((r) => r.ciudad))].join(", ") || "ninguna ciudad"}
                {toUpload.length > 0 && <> entre el {niceDay(toUpload.reduce((m, r) => (r.fecha_hora < m ? r.fecha_hora : m), toUpload[0].fecha_hora).slice(0, 10))} y el {niceDay(toUpload.reduce((m, r) => (r.fecha_hora > m ? r.fecha_hora : m), toUpload[0].fecha_hora).slice(0, 10))}</>}.
                {report?.kind === "ok" ? " Están verificados en Supabase." : " Vuelve al paso 2 para subirlos."}
              </p>
            </div>
            <div className="result-actions">
              <Button disabled={!toUpload.length} onClick={downloadCsv} title="Archivo para abrir con Excel, Python (pandas) o cualquier hoja de cálculo"><Download />Descargar CSV</Button>
              <Button variant="outline" onClick={restart}><RotateCcw />Empezar de nuevo</Button>
            </div>
          </section>

          <div className="tabs result-tabs" role="tablist" aria-label="Resultados">
            {RESULT_TABS.map(([id, label]) => (
              <button key={id} id={`tab-${id}`} role="tab" aria-selected={resultTab === id} aria-controls="result-panel" className="tab"
                onClick={() => { setResultTab(id); if (id === "destino") void loadDest() }}>
                {id === "destino" && <Database size={15} aria-hidden />}{label}{id === "destino" && dest && <span className="count">{fmt(dest.total)}</span>}
              </button>
            ))}
          </div>

          <div id="result-panel" role="tabpanel" aria-labelledby={`tab-${resultTab}`}>
            {resultTab === "resumen" && <Summary rows={toUpload} />}
            {resultTab === "graficos" && (
              <div className="charts-grid">
                <Panel title="Temperatura de cada ciudad" unit="°C · UTC" className="charts-wide" hint="Pasa el cursor por encima para ver el valor de cada momento.">
                  <TemperatureChart rows={shown} />
                </Panel>
                <Panel title="Comparativa entre ciudades" hint="Pulsa una barra para ver solo esa ciudad en el gráfico de temperatura.">
                  <CityBars rows={toUpload} active={fc} onToggle={toggleChartCity} />
                </Panel>
                <Panel title="Embudo de registros" hint="Cuántos quedan después de cada fase.">
                  <Funnel steps={[
                    { label: "Total extraído", value: inputCount },
                    { label: "Válidos", value: records.length, hint: `${fmt(rejected.length)} rechazados` },
                    { label: "Coinciden con los filtros", value: filtered.length },
                    { label: "Seleccionados para cargar", value: toUpload.length },
                    { label: "Persistidos en Supabase", value: savedNow, hint: `${fmt(pendingUpload)} pendientes` },
                  ]} />
                </Panel>
              </div>
            )}
            {resultTab === "destino" && (
              <section className="app-panel">
                <div className="panel-head">
                  <h2 className="panel-title"><Database size={18} className="panel-icon" aria-hidden />Datos en Supabase</h2>
                  <p className="panel-hint">Lectura real de la tabla <code>mediciones_meteorologicas</code>. Incluye también lo cargado en otras ocasiones.</p>
                </div>
                <DestinationView dest={dest} q={destQuery} loading={destLoading} error={destError} updated={destUpdated} localPending={localPending} load={loadDest} />
              </section>
            )}
            {resultTab === "etl" && (
              <div className="flex flex-col gap-4">
                <section className="app-panel">
                  <div className="panel-head">
                    <h2 className="panel-title"><BarChart3 size={18} className="panel-icon" aria-hidden />Cómo se han procesado los datos</h2>
                    <p className="panel-hint">En Big Data se llama proceso <b>ETL</b>: <i>Extract</i> (extraer), <i>Transform</i> (transformar) y <i>Load</i> (cargar). Estados, contadores y duraciones son los reales de esta sesión.</p>
                  </div>
                  <ol className="process">
                    {displayPhases.map((p, i) => (
                      <li key={p.name} data-state={p.state}>
                        <PhaseIcon state={p.state} />
                        <div><b>{i + 1}. {p.name}</b> <span className="badge">{PHASE_LABEL[p.state]}</span><p>{p.note}</p></div>
                        <span className="process-io">{phaseText(p)}{p.ms !== undefined && <small>{fmtMs(p.ms)}</small>}</span>
                      </li>
                    ))}
                  </ol>
                  <Button variant="outline" className="mt-3 w-fit" onClick={() => showInspect("previa")}><Eye />Inspeccionar el resultado de cada fase</Button>
                </section>
                <section className="app-panel">
                  <div className="panel-head"><h2 className="panel-title"><BookOpen size={18} className="panel-icon" aria-hidden />¿Qué significa cada dato?</h2></div>
                  <dl className="glossary">
                    <div><dt>ciudad</dt><dd>Dónde se ha medido. Usamos el centro de cada ciudad.</dd></div>
                    <div><dt>fecha_hora (UTC)</dt><dd>Momento de la medición en hora universal. En España suma 2 horas en verano y 1 en invierno.</dd></div>
                    <div><dt>temperatura_c (°C)</dt><dd>Temperatura del aire a 2 metros del suelo.</dd></div>
                    <div><dt>humedad_pct (%)</dt><dd>Humedad relativa: 100 % es el máximo posible.</dd></div>
                    <div><dt>precipitacion_mm (mm)</dt><dd>Agua caída durante esa hora. 1 mm equivale a 1 litro por metro cuadrado.</dd></div>
                  </dl>
                </section>
              </div>
            )}
          </div>
        </div>
      )}
    </main>

    <footer className="site-footer">
      <div className="brand">
        <span className="brand-mark"><CloudSun size={18} aria-hidden /></span>
        <div><b>El tiempo en tus ciudades</b><small>© {new Date().getFullYear()} {AUTHOR}</small></div>
      </div>
      <p>
        Datos de <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a> ·
        Mapa de <a href="https://leafletjs.com/" target="_blank" rel="noreferrer">Leaflet</a> con Esri y OpenStreetMap ·
        Guardado en <a href="https://supabase.com/" target="_blank" rel="noreferrer">Supabase</a>
      </p>
    </footer>
    </>
  )
}

function phaseText(p: Phase) {
  if (p.state === "pendiente") return "Pendiente"
  if (p.state === "curso") return p.input ? `${fmt(p.input)} ${p.unitIn} · en curso…` : "En curso…"
  return `${fmt(p.input)} ${p.unitIn} → ${fmt(p.output)} ${p.unitOut}`
}

/** Pipeline completo: estado (icono + texto), entrada → salida, explicación, duración real e inspección. */
function PipelineStrip({ phases, onInspect }: { phases: Phase[]; onInspect: (i: number) => void }) {
  return (
    <ol className="pipeline-strip" aria-label="Pipeline ETL: Extracción, Transformación, Limpieza, Filtrado y selección, Carga">
      {phases.map((p, i) => (
        <li key={p.name} className="phase-card" data-state={p.state}>
          <div className="phase-card-head">
            <PhaseIcon state={p.state} />
            <b>{i + 1}. {p.name}</b>
          </div>
          <span className="phase-card-state">{PHASE_LABEL[p.state]}{p.ms !== undefined && <> · {fmtMs(p.ms)}</>}</span>
          <dl className="phase-card-io">
            <div><dt>Entrada</dt><dd>{fmt(p.input)} <small>{p.unitIn}</small></dd></div>
            <div><dt>Salida</dt><dd>{fmt(p.output)} <small>{p.unitOut}</small></dd></div>
          </dl>
          <p>{p.note}</p>
          <button type="button" className="link-button text-xs" onClick={() => onInspect(i)}>Inspeccionar</button>
        </li>
      ))}
    </ol>
  )
}

/** Ciudades procesadas y pendientes durante la extracción (estado real de cada petición). */
function CityProgress({ states }: { states: Record<string, CityState> }) {
  const entries = Object.entries(states)
  const done = entries.filter(([, s]) => s === "ok" || s === "error").length
  return (
    <div className="city-progress" role="status" aria-live="polite">
      <div className="dl-progress" role="progressbar" aria-label="Ciudades procesadas" aria-valuemin={0} aria-valuemax={entries.length} aria-valuenow={done}>
        <span style={{ width: `${(done / entries.length) * 100}%` }} />
        <small>{done} de {entries.length} ciudades procesadas · {entries.length - done} pendientes</small>
      </div>
      <ul>
        {entries.map(([id, s]) => (
          <li key={id} data-state={s}>
            {s === "ok" ? <CheckCircle2 size={14} aria-hidden /> : s === "error" ? <XCircle size={14} aria-hidden /> : s === "curso" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Circle size={14} aria-hidden />}
            {cityName(id)} <small>{CITY_STATE_LABEL[s]}</small>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Estado real de cada lote de la carga. */
function BatchList({ batches }: { batches: BatchStatus[] }) {
  const label = { pendiente: "Pendiente", curso: "Enviando…", ok: "Verificado", error: "Con errores" }
  return (
    <ol className="batches" aria-label="Estado de los lotes">
      {batches.map((b) => (
        <li key={b.n} data-state={b.state}>
          {b.state === "ok" ? <CheckCircle2 size={14} aria-hidden /> : b.state === "error" ? <XCircle size={14} aria-hidden /> : b.state === "curso" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Circle size={14} aria-hidden />}
          <span>Lote {b.n} · {fmt(b.size)} registros</span>
          <b>{label[b.state]}{b.state === "ok" || (b.state === "error" && b.verified) ? ` (${fmt(b.verified)})` : ""}</b>
          {b.message && <small>{b.message}</small>}
        </li>
      ))}
    </ol>
  )
}

/** Vista previa de la carga: el conjunto exacto y en el orden en que se enviará. */
function PreviewTable({ rows, offset, persisted, empty }: { rows: WeatherRecord[]; offset: number; persisted: Set<string>; empty: string }) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col" className="num">N.º</th><th scope="col">Ciudad</th><th scope="col">Fecha y hora (UTC)</th>
            <th scope="col" className="num">Temp. (°C)</th><th scope="col" className="num">Humedad (%)</th><th scope="col" className="num">Precip. (mm)</th><th scope="col">Estado</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={key(r)}>
              <td className="num mono">{fmt(offset + i + 1)}</td>
              <td className="font-semibold"><span className="swatch mr-2" style={{ background: cityColor(r.ciudad) }} aria-hidden />{r.ciudad}</td>
              <td className="mono">{fmtDate(r.fecha_hora)}</td>
              <td className="num">{fmt(r.temperatura_c)}</td>
              <td className="num">{fmt(r.humedad_pct)}</td>
              <td className="num">{fmt(r.precipitacion_mm)}</td>
              <td><StorageBadge stored={persisted.has(key(r))} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="empty-state">{empty}</p>}
    </div>
  )
}

/** Datos transformados: valores tal cual, sin validar (null y vacíos se ven como tales). */
function RawTable({ rows }: { rows: RawRow[] }) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Ciudad</th><th scope="col" className="num">Índice</th><th scope="col">fecha_hora (texto original, UTC)</th>
            <th scope="col" className="num">Temp. (°C)</th><th scope="col" className="num">Humedad (%)</th><th scope="col" className="num">Precip. (mm)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.ciudad}-${r.indice}`}>
              <td className="font-semibold">{r.ciudad}</td>
              <td className="num">{r.indice}</td>
              <td className="mono">{showRaw(r.fecha_hora)}</td>
              <td className="num">{showRaw(r.temperatura_c)}</td>
              <td className="num">{showRaw(r.humedad_pct)}</td>
              <td className="num">{showRaw(r.precipitacion_mm)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="empty-state">Sin datos transformados todavía.</p>}
    </div>
  )
}

function showRaw(v: unknown) {
  if (v === null) return <span className="null-value">null</span>
  if (v === undefined) return <span className="null-value">ausente</span>
  if (v === "") return <span className="null-value">«» vacío</span>
  return typeof v === "number" ? fmt(v) : String(v)
}

/** Resumen en lenguaje llano: récords y ejemplos concretos sacados de los datos. */
function Summary({ rows }: { rows: WeatherRecord[] }) {
  if (!rows.length) return <section className="app-panel"><p className="empty-state">No hay datos que resumir.</p></section>
  const by = (f: (a: WeatherRecord, b: WeatherRecord) => boolean) => rows.reduce((m, r) => (f(r, m) ? r : m), rows[0])
  const hottest = by((a, b) => a.temperatura_c > b.temperatura_c)
  const coldest = by((a, b) => a.temperatura_c < b.temperatura_c)
  const wettest = by((a, b) => a.precipitacion_mm > b.precipitacion_mm)
  const perCity = CITIES.map((c) => {
    const rs = rows.filter((r) => r.ciudad === c.nombre)
    if (!rs.length) return null
    const temps = rs.map((r) => r.temperatura_c)
    return {
      city: c.nombre, n: rs.length,
      avg: temps.reduce((a, b) => a + b, 0) / rs.length, max: Math.max(...temps), min: Math.min(...temps),
      rain: rs.reduce((a, r) => a + r.precipitacion_mm, 0), rainyHours: rs.filter((r) => r.precipitacion_mm > 0).length,
      hum: rs.reduce((a, r) => a + r.humedad_pct, 0) / rs.length,
    }
  }).filter((x) => x !== null)
  const rainiest = perCity.reduce((m, c) => (c.rain > m.rain ? c : m), perCity[0])
  const warmest = perCity.reduce((m, c) => (c.avg > m.avg ? c : m), perCity[0])

  return (
    <div className="flex flex-col gap-4">
      <div className="highlights">
        <Highlight icon={<Sun aria-hidden />} tone="warm" title="El momento más caluroso" value={`${fmt1(hottest.temperatura_c)} °C`} text={`${hottest.ciudad}, ${niceDate(hottest.fecha_hora)}`} />
        <Highlight icon={<Snowflake aria-hidden />} tone="cold" title="El momento más fresco" value={`${fmt1(coldest.temperatura_c)} °C`} text={`${coldest.ciudad}, ${niceDate(coldest.fecha_hora)}`} />
        <Highlight icon={<CloudRain aria-hidden />} tone="rain" title="La hora más lluviosa" value={wettest.precipitacion_mm > 0 ? `${fmt1(wettest.precipitacion_mm)} mm` : "Sin lluvia"}
          text={wettest.precipitacion_mm > 0 ? `${wettest.ciudad}, ${niceDate(wettest.fecha_hora)}` : "No ha llovido en ninguna ciudad en estas fechas."} />
        <Highlight icon={<Droplets aria-hidden />} tone="green" title="La ciudad donde más llovió" value={rainiest.rain > 0 ? rainiest.city : "—"}
          text={rainiest.rain > 0 ? `${fmt1(rainiest.rain)} litros por m² en total, repartidos en ${rainiest.rainyHours} horas.` : "Ninguna ciudad registró lluvia."} />
      </div>

      <section className="app-panel">
        <div className="panel-head">
          <h2 className="panel-title"><BarChart3 size={18} className="panel-icon" aria-hidden />Ciudad por ciudad</h2>
          <p className="panel-hint">La más cálida de media ha sido <b>{warmest.city}</b> ({fmt1(warmest.avg)} °C).</p>
        </div>
        <div className="table-wrap mt-0">
          <table className="data-table">
            <thead><tr><th scope="col">Ciudad</th><th scope="col" className="num">Temp. media</th><th scope="col" className="num">Máxima</th><th scope="col" className="num">Mínima</th><th scope="col" className="num">Lluvia total</th><th scope="col" className="num">Humedad media</th><th scope="col" className="num">Horas</th></tr></thead>
            <tbody>
              {perCity.map((c) => (
                <tr key={c.city}>
                  <td className="font-semibold"><span className="swatch mr-2" style={{ background: cityColor(c.city) }} aria-hidden />{c.city}</td>
                  <td className="num">{fmt1(c.avg)} °C</td><td className="num">{fmt1(c.max)} °C</td><td className="num">{fmt1(c.min)} °C</td>
                  <td className="num">{fmt1(c.rain)} mm</td><td className="num">{fmt1(c.hum)} %</td><td className="num">{fmt(c.n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="app-panel">
        <div className="panel-head">
          <h2 className="panel-title"><BookOpen size={18} className="panel-icon" aria-hidden />Ejemplos de mediciones</h2>
          <p className="panel-hint">Algunas filas reales de las que has obtenido, una por ciudad.</p>
        </div>
        <SampleTable rows={perCity.map((c) => rows.find((r) => r.ciudad === c.city && r.fecha_hora.slice(11, 13) === "12") ?? rows.find((r) => r.ciudad === c.city)!)} />
      </section>
    </div>
  )
}

function Highlight({ icon, tone, title, value, text }: { icon: React.ReactNode; tone: string; title: string; value: string; text: string }) {
  return (
    <div className="highlight" data-tone={tone}>
      <span className="highlight-icon">{icon}</span>
      <div><small>{title}</small><b>{value}</b><p>{text}</p></div>
    </div>
  )
}

function Panel({ title, unit, hint, className = "", children }: { title: string; unit?: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <section className={`app-panel chart-panel ${className}`} aria-label={title}>
      <div className="panel-head">
        <h2 className="panel-title"><BarChart3 size={16} className="panel-icon" aria-hidden />{title}{unit && <span className="panel-unit">{unit}</span>}</h2>
        {hint && <p className="panel-hint">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="kpi" style={{ "--kpi-color": color } as React.CSSProperties}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

const NOTICE_ICONS = { ok: CheckCircle2, err: XCircle, warn: TriangleAlert, info: Info }
function Notice({ kind, children }: { kind: keyof typeof NOTICE_ICONS; children: React.ReactNode }) {
  const Icon = NOTICE_ICONS[kind]
  return <div className={`notice ${kind}`} role={kind === "err" ? "alert" : "status"}><Icon size={16} aria-hidden /><span>{children}</span></div>
}

const PHASE_LABEL: Record<PhaseState, string> = { pendiente: "pendiente", curso: "en curso", completada: "completada", error: "con errores" }
function PhaseIcon({ state }: { state: PhaseState }) {
  if (state === "completada") return <CheckCircle2 className="phase-icon" aria-hidden />
  if (state === "error") return <XCircle className="phase-icon" aria-hidden />
  if (state === "curso") return <Loader2 className="phase-icon animate-spin" aria-hidden />
  return <Circle className="phase-icon" aria-hidden />
}

function StorageBadge({ stored }: { stored: boolean }) {
  return stored
    ? <span className="badge ok"><Database size={12} aria-hidden />Guardada</span>
    : <span className="badge warn"><Clock size={12} aria-hidden />Sin guardar</span>
}

function SampleTable({ rows }: { rows: WeatherRecord[] }) {
  return (
    <div className="table-wrap mt-0">
      <table className="data-table">
        <thead><tr><th scope="col">Ciudad</th><th scope="col">Fecha y hora</th><th scope="col" className="num">Temperatura</th><th scope="col" className="num">Humedad</th><th scope="col" className="num">Lluvia</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={key(r)}>
              <td className="font-semibold"><span className="swatch mr-2" style={{ background: cityColor(r.ciudad) }} aria-hidden />{r.ciudad}</td>
              <td>{niceDate(r.fecha_hora)}</td>
              <td className="num">{fmt1(r.temperatura_c)} °C</td>
              <td className="num">{fmt(r.humedad_pct)} %</td>
              <td className="num">{fmt1(r.precipitacion_mm)} mm</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="empty-state">Todavía no hay datos.</p>}
    </div>
  )
}

function LocalTable({ rows, selected, persisted, toggle, togglePage, empty }: { rows: WeatherRecord[]; selected: Set<string>; persisted: Set<string>; toggle: (r: WeatherRecord) => void; togglePage: () => void; empty: string }) {
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(key(r)))
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col" className="w-10"><input type="checkbox" aria-label="Marcar las filas de esta página" checked={allOnPage} disabled={!rows.length} onChange={togglePage} /></th>
            <th scope="col">Ciudad</th><th scope="col">Fecha y hora (UTC)</th>
            <th scope="col" className="num">Temp. (°C)</th><th scope="col" className="num">Humedad (%)</th><th scope="col" className="num">Lluvia (mm)</th>
            <th scope="col">Estado</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={key(r)} aria-selected={selected.has(key(r))}>
              <td><input type="checkbox" aria-label={`Marcar ${r.ciudad} ${fmtDate(r.fecha_hora)}`} checked={selected.has(key(r))} onChange={() => toggle(r)} /></td>
              <td className="font-semibold">{r.ciudad}</td>
              <td className="mono">{fmtDate(r.fecha_hora)}</td>
              <td className="num">{fmt(r.temperatura_c)}</td>
              <td className="num">{fmt(r.humedad_pct)}</td>
              <td className="num">{fmt(r.precipitacion_mm)}</td>
              <td><StorageBadge stored={persisted.has(key(r))} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="empty-state">{empty}</p>}
    </div>
  )
}

function RejectTable({ rows }: { rows: RejectedRecord[] }) {
  const show = showRaw
  return (
    <div className="table-wrap mt-0">
      <table className="data-table">
        <thead><tr><th scope="col">Ciudad</th><th scope="col" className="num">Posición</th><th scope="col">Fecha original</th><th scope="col" className="num">Temp.</th><th scope="col" className="num">Humedad</th><th scope="col" className="num">Lluvia</th><th scope="col">Motivo</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const d = (r.datos ?? {}) as Record<string, unknown>
            return (
              <tr key={`${r.ciudad}-${r.indice}`}>
                <td className="font-semibold">{r.ciudad}</td>
                <td className="num">{r.indice >= 0 ? r.indice : "—"}</td>
                <td className="mono">{r.indice >= 0 ? show(d.fecha_hora) : "—"}</td>
                <td className="num">{r.indice >= 0 ? show(d.temperatura_c) : "—"}</td>
                <td className="num">{r.indice >= 0 ? show(d.humedad_pct) : "—"}</td>
                <td className="num">{r.indice >= 0 ? show(d.precipitacion_mm) : "—"}</td>
                <td><span className="badge err"><XCircle size={12} aria-hidden />{r.motivo}</span></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {!rows.length && <p className="empty-state">No se ha apartado ninguna medición.</p>}
    </div>
  )
}

function Pager({ page, total, set }: { page: number; total: number; set: (n: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / perPage))
  return (
    <nav className="pager" aria-label="Paginación">
      <span>{fmt(total ? page * perPage + 1 : 0)}–{fmt(Math.min((page + 1) * perPage, total))} de {fmt(total)} · página {page + 1} de {pages}</span>
      <span className="flex gap-2">
        <Button size="sm" variant="outline" disabled={!page} onClick={() => set(page - 1)}>Anterior</Button>
        <Button size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => set(page + 1)}>Siguiente</Button>
      </span>
    </nav>
  )
}

function DestinationView({ dest, q, loading, error, updated, localPending, load }: {
  dest: { rows: StoredRecord[]; count: number; total: number } | null; q: DestQuery; loading: boolean; error: string; updated: string; localPending: number; load: (patch?: Partial<DestQuery>) => Promise<void>
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>Leyenda:</span><StorageBadge stored /><span>leído ahora de la tabla</span>
        <span aria-hidden>·</span><StorageBadge stored={false} /><span>{fmt(localPending)} registros extraídos que no están en Supabase (pendientes de subir)</span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-[1.2fr_1fr_1fr_1.2fr_auto_auto] lg:items-end">
        <label className="field">Ciudad
          <select className="control" value={q.city} onChange={(e) => load({ city: e.target.value, page: 0 })}>
            <option value="">Todas</option>
            {CITIES.map((c) => <option key={c.id} value={c.nombre}>{c.nombre}</option>)}
          </select>
        </label>
        <label className="field">Desde<input className="control" type="date" value={q.from} onChange={(e) => load({ from: e.target.value, page: 0 })} /></label>
        <label className="field">Hasta<input className="control" type="date" value={q.to} onChange={(e) => load({ to: e.target.value, page: 0 })} /></label>
        <label className="field">Ordenar por
          <select className="control" value={q.sort} onChange={(e) => load({ sort: e.target.value as DestQuery["sort"], page: 0 })}>
            {SORT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            <option value="importado_en">Fecha de guardado</option>
          </select>
        </label>
        <Button variant="outline" size="lg" onClick={() => load({ asc: !q.asc, page: 0 })}>{q.asc ? <ArrowUp /> : <ArrowDown />}{q.asc ? "Ascendente" : "Descendente"}</Button>
        <Button size="lg" className="px-4" disabled={loading} onClick={() => load()}><RefreshCw className={loading ? "animate-spin" : ""} />Actualizar</Button>
      </div>
      <p className="m-0 text-sm text-muted-foreground" aria-live="polite">
        {loading ? "Consultando Supabase…" : dest ? `${fmt(dest.count)} de ${fmt(dest.total)} mediciones guardadas · actualizado a las ${updated}` : ""}
      </p>
      {error && <Notice kind="err">{error}</Notice>}
      {dest && (
        <div>
          <div className="table-wrap mt-0">
            <table className="data-table">
              <thead><tr><th scope="col" className="num">ID</th><th scope="col">Ciudad</th><th scope="col">Fecha y hora (UTC)</th><th scope="col" className="num">Temp. (°C)</th><th scope="col" className="num">Humedad (%)</th><th scope="col" className="num">Lluvia (mm)</th><th scope="col">Guardado (UTC)</th></tr></thead>
              <tbody>
                {dest.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="num mono">{r.id}</td>
                    <td className="font-semibold">{r.ciudad}</td>
                    <td className="mono">{fmtDate(r.fecha_hora)}</td>
                    <td className="num">{fmt(r.temperatura_c)}</td>
                    <td className="num">{fmt(r.humedad_pct)}</td>
                    <td className="num">{fmt(r.precipitacion_mm)}</td>
                    <td className="mono">{fmtDate(r.importado_en)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!dest.rows.length && <p className="empty-state">No hay mediciones guardadas que cumplan estos filtros.</p>}
          </div>
          <Pager page={q.page} total={dest.count} set={(p) => load({ page: p })} />
        </div>
      )}
    </div>
  )
}
