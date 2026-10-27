"use client"

import { useEffect, useMemo, useState } from "react"
import { ArrowDown, ArrowUp, BarChart3, Check, CheckCircle2, ChevronRight, Circle, Clock, CloudRain, Database, Download, Eye, Info, Loader2, Play, RefreshCw, RotateCcw, SlidersHorizontal, TriangleAlert, Upload, XCircle } from "lucide-react"
import { CityBars, Funnel, TemperatureChart, cityColor } from "@/components/charts"
import { Button } from "@/components/ui/button"
import { CITIES, transformWeather, type RejectedRecord, type WeatherRecord } from "@/lib/weather"

type PhaseState = "pendiente" | "curso" | "completada" | "error"
type Phase = { name: string; note: string; state: PhaseState; input: number; output: number; ms?: number }
type Tab = "datos" | "previa" | "rechazados" | "json" | "destino"
type SortKey = keyof WeatherRecord
type StoredRecord = WeatherRecord & { id: number; importado_en: string }
type DestQuery = { page: number; city: string; from: string; to: string; sort: SortKey | "importado_en"; asc: boolean }
type Report = { kind: "ok" | "err"; text: string }

const perPage = 20
const initialPhases: Phase[] = [
  { name: "Extracción", note: "Descarga horaria desde Open-Meteo en UTC.", state: "pendiente", input: 0, output: 0 },
  { name: "Transformación", note: "Convierte los arrays paralelos de «hourly» en filas.", state: "pendiente", input: 0, output: 0 },
  { name: "Limpieza", note: "Rechaza null, rangos imposibles y duplicados (conserva la primera fila).", state: "pendiente", input: 0, output: 0 },
  { name: "Filtrado y selección", note: "Filtra y ordena antes de paginar; la selección persiste entre páginas.", state: "pendiente", input: 0, output: 0 },
  { name: "Carga", note: "Upsert en servidor en lotes ≤ 500 sobre la clave ciudad + fecha_hora.", state: "pendiente", input: 0, output: 0 },
]
const SORT_OPTIONS: [SortKey, string][] = [["fecha_hora", "Fecha y hora"], ["ciudad", "Ciudad"], ["temperatura_c", "Temperatura"], ["humedad_pct", "Humedad"], ["precipitacion_mm", "Precipitación"]]
const TABS: [Tab, string][] = [["datos", "Transformados y válidos"], ["previa", "Vista previa de carga"], ["rechazados", "Rechazados"], ["json", "JSON original"], ["destino", "Datos en Supabase"]]

const key = (r: Pick<WeatherRecord, "ciudad" | "fecha_hora">) => `${r.ciudad}|${r.fecha_hora}`
const num = (s: string) => (s === "" ? undefined : Number(s))
const fmt = (n: number) => n.toLocaleString("es-ES")
const fmtDate = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`

export default function Page() {
  // Extracción
  const [cities, setCities] = useState(CITIES.map((c) => c.id))
  const [start, setStart] = useState("2026-09-01")
  const [end, setEnd] = useState("2026-09-30")
  const [raw, setRaw] = useState<Record<string, unknown>>({})
  const [records, setRecords] = useState<WeatherRecord[]>([])
  const [rejected, setRejected] = useState<RejectedRecord[]>([])
  const [inputCount, setInputCount] = useState(0)
  const [phases, setPhases] = useState(initialPhases)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [working, setWorking] = useState(false)
  // Filtrado, orden y selección
  const [tab, setTab] = useState<Tab>("datos")
  const [previewSeen, setPreviewSeen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)
  const [fc, setFc] = useState<string[]>([])
  const [rain, setRain] = useState(false)
  const [minT, setMinT] = useState(""), [maxT, setMaxT] = useState("")
  const [minH, setMinH] = useState(""), [maxH, setMaxH] = useState("")
  const [minP, setMinP] = useState(""), [maxP, setMaxP] = useState("")
  const [from, setFrom] = useState(""), [to, setTo] = useState("")
  const [sort, setSort] = useState<SortKey>("fecha_hora")
  const [asc, setAsc] = useState(true)
  // Carga y destino
  const [uploading, setUploading] = useState(false)
  const [report, setReport] = useState<Report | null>(null)
  const [failed, setFailed] = useState<WeatherRecord[][]>([])
  const [persisted, setPersisted] = useState<Set<string>>(new Set())
  const [dest, setDest] = useState<{ rows: StoredRecord[]; count: number; total: number } | null>(null)
  const [destQuery, setDestQuery] = useState<DestQuery>({ page: 0, city: "", from: "", to: "", sort: "fecha_hora", asc: false })
  const [destLoading, setDestLoading] = useState(false)
  const [destError, setDestError] = useState("")
  const [destUpdated, setDestUpdated] = useState("")

  const days = Math.round((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 864e5) + 1
  const ok = cities.length > 0 && days >= 1 && days <= 31

  // Todos los filtros salvo la ciudad: así el gráfico por ciudad puede resaltar sin hacer desaparecer las demás.
  const filteredAnyCity = useMemo(() => records.filter((r) => {
    const d = r.fecha_hora.slice(0, 10)
    return (!from || d >= from) && (!to || d <= to)
      && (num(minT) === undefined || r.temperatura_c >= Number(minT)) && (num(maxT) === undefined || r.temperatura_c <= Number(maxT))
      && (num(minH) === undefined || r.humedad_pct >= Number(minH)) && (num(maxH) === undefined || r.humedad_pct <= Number(maxH))
      && (num(minP) === undefined || r.precipitacion_mm >= Number(minP)) && (num(maxP) === undefined || r.precipitacion_mm <= Number(maxP))
      && (!rain || r.precipitacion_mm > 0)
  }), [records, from, to, minT, maxT, minH, maxH, minP, maxP, rain])
  // Orden fijo: filtrar → ordenar → (después) paginar.
  const filtered = useMemo(() => filteredAnyCity.filter((r) => !fc.length || fc.includes(r.ciudad))
    .sort((a, b) => (a[sort] < b[sort] ? -1 : a[sort] > b[sort] ? 1 : 0) * (asc ? 1 : -1)), [filteredAnyCity, fc, sort, asc])
  const activeFilters = [fc.length > 0, from, to, minT, maxT, minH, maxH, minP, maxP, rain].filter(Boolean).length
  const selectedFiltered = useMemo(() => filtered.filter((r) => selected.has(key(r))), [filtered, selected])
  const visible = tab === "previa" ? selectedFiltered : filtered
  const paged = visible.slice(page * perPage, page * perPage + perPage)
  const pendingSelected = selectedFiltered.filter((r) => !persisted.has(key(r))).length
  const localPending = records.filter((r) => !persisted.has(key(r))).length
  const duplicates = rejected.filter((r) => r.motivo.startsWith("Duplicado")).length
  const nulls = rejected.filter((r) => r.motivo.startsWith("Valor null")).length
  const displayPhases = phases.map((p, i) => (i === 3 && records.length ? { ...p, state: "completada" as const, input: filtered.length, output: selectedFiltered.length } : p))

  // Guía de pasos: el primero sin completar es "el paso actual".
  const steps = [
    { label: "Extraer", target: "extraccion", done: records.length > 0, todo: "Elige ciudades y un periodo (máx. 31 días) y pulsa «Extraer datos»." },
    { label: "Revisar calidad", target: "pipeline", done: records.length > 0, todo: "Comprueba en el pipeline cuántos registros se han rechazado y por qué." },
    { label: "Filtrar y seleccionar", target: "segmentacion", done: selectedFiltered.length > 0, todo: "Acota los datos con la segmentación y selecciona las filas que quieres subir." },
    { label: "Revisar vista previa", target: "inspeccion", done: previewSeen && selectedFiltered.length > 0, todo: "Abre «Vista previa de carga»: es exactamente lo que se enviará." },
    { label: "Cargar y verificar", target: "carga", done: selectedFiltered.length > 0 && pendingSelected === 0, todo: "Pulsa «Subir» y comprueba el resultado en «Datos en Supabase»." },
  ]
  const current = steps.findIndex((s) => !s.done)
  function goTo(i: number) {
    if (i === 3) { setTab("previa"); setPage(0); setPreviewSeen(true) }
    document.getElementById(steps[i].target)?.scrollIntoView({ behavior: "smooth", block: "start" })
  }
  function toggleCityFilter(city: string) {
    setFc((v) => (v.includes(city) ? v.filter((x) => x !== city) : [...v, city]))
    setPage(0)
  }

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

  // merge = true reintenta solo las ciudades indicadas y conserva el resto de lo ya extraído.
  async function extract(only = cities, merge = false) {
    if (!ok || !only.length || working) return
    setWorking(true)
    setPhases((v) => (merge ? v : initialPhases).map((p, i) => (i === 0 ? { ...p, state: "curso" } : i < 4 ? { ...p, state: "pendiente" } : p)))
    const began = performance.now()
    const nextRaw: Record<string, unknown> = merge ? { ...raw } : {}
    const errs: Record<string, string> = merge ? { ...errors } : {}
    for (const cityId of only) {
      delete errs[cityId]
      delete nextRaw[cityId]
      try {
        const res = await fetch("/api/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cityId, start, end }) })
        const body = await res.json()
        if (res.ok) nextRaw[cityId] = body.raw
        else errs[cityId] = body.error ?? `Error HTTP ${res.status}`
      } catch { errs[cityId] = "No se pudo conectar con el servidor." }
    }
    const extractMs = performance.now() - began
    const t0 = performance.now()
    let input = 0
    const good: WeatherRecord[] = [], bad: RejectedRecord[] = []
    for (const c of CITIES) {
      if (!(c.id in nextRaw)) continue
      const r = transformWeather(c.nombre, nextRaw[c.id])
      input += r.input
      good.push(...r.records)
      bad.push(...r.rejected)
    }
    const transformMs = performance.now() - t0
    const rows = good.length + bad.filter((r) => r.indice >= 0).length
    setRaw(nextRaw); setRecords(good); setRejected(bad); setErrors(errs); setInputCount(input); setPage(0)
    if (!merge) setSelected(new Set())
    const okCities = Object.keys(nextRaw).length
    phase(0, { state: Object.keys(errs).length ? "error" : "completada", input: okCities + Object.keys(errs).length, output: okCities, ms: extractMs })
    phase(1, { state: "completada", input, output: rows, ms: transformMs })
    phase(2, { state: "completada", input: rows, output: good.length })
    await checkPersisted(good)
    setWorking(false)
  }

  function toggle(r: WeatherRecord) {
    setSelected((s) => { const n = new Set(s); if (n.has(key(r))) n.delete(key(r)); else n.add(key(r)); return n })
  }
  function toggleMany(rows: WeatherRecord[]) {
    setSelected((s) => { const n = new Set(s), every = rows.every((r) => n.has(key(r))); rows.forEach((r) => (every ? n.delete(key(r)) : n.add(key(r)))); return n })
  }
  function resetFilters() {
    setFc([]); setRain(false); setMinT(""); setMaxT(""); setMinH(""); setMaxH(""); setMinP(""); setMaxP(""); setFrom(""); setTo(""); setPage(0)
  }
  function download() {
    const a = document.createElement("a")
    a.href = URL.createObjectURL(new Blob([JSON.stringify(raw, null, 2)], { type: "application/json" }))
    a.download = "open-meteo-original.json"
    a.click()
    URL.revokeObjectURL(a.href)
  }

  async function send(batches: WeatherRecord[][]) {
    setUploading(true)
    setReport(null)
    let verified = 0
    const failedNow: WeatherRecord[][] = [], messages: string[] = [], stored: string[] = []
    for (const batch of batches) {
      try {
        const res = await fetch("/api/supabase", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ records: batch }) })
        const body = await res.json()
        if (!res.ok) { failedNow.push(batch); messages.push(body.error ?? `Error HTTP ${res.status}`); continue }
        const missing = new Set<string>(body.missing ?? [])
        verified += body.verified
        batch.forEach((r) => !missing.has(key(r)) && stored.push(key(r)))
        if (missing.size) { failedNow.push(batch.filter((r) => missing.has(key(r)))); messages.push(`${missing.size} registros no se encontraron al verificar`) }
      } catch { failedNow.push(batch); messages.push("No se pudo conectar con el servidor") }
    }
    const total = batches.flat().length, failedRows = failedNow.flat().length
    setPersisted((s) => new Set([...s, ...stored]))
    setFailed(failedNow)
    setReport(failedNow.length
      ? { kind: "err", text: `Carga parcial: ${fmt(verified)} de ${fmt(total)} registros verificados en Supabase. ${failedNow.length} lote(s) fallido(s) con ${fmt(failedRows)} registros. Motivo: ${[...new Set(messages)].join(" · ")}` }
      : { kind: "ok", text: `Carga completa: ${fmt(verified)} de ${fmt(total)} registros verificados en Supabase. Los que ya existían se actualizaron sin duplicarse.` })
    phase(4, { state: failedNow.length ? "error" : "completada", input: total, output: verified })
    setUploading(false)
    void loadDest()
  }
  async function upload() {
    // Se congela la selección en el momento del clic: es exactamente lo que muestra la vista previa.
    const snapshot = [...selectedFiltered]
    if (!snapshot.length || uploading) return
    phase(4, { state: "curso", input: snapshot.length, output: 0 })
    await send(Array.from({ length: Math.ceil(snapshot.length / 500) }, (_, i) => snapshot.slice(i * 500, i * 500 + 500)))
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

  const numberField = (v: string, set: (s: string) => void, label: string) => (
    <label className="field">{label}<input className="control" type="number" inputMode="decimal" value={v} onChange={(e) => { set(e.target.value); setPage(0) }} /></label>
  )

  return (
    <main className="app-container dash">
      {/* ── Cabecera + guía de pasos (12 col) ── */}
      <header className="app-hero dash-12">
        <div className="hero-top">
          <div>
            <p className="eyebrow">Práctica Big Data · ETL · Open-Meteo → Supabase</p>
            <h1>Laboratorio meteorológico</h1>
            <p className="hero-sub"><CloudRain size={15} aria-hidden />Datos horarios reales en UTC. Sigue los pasos en orden; cada bloque indica qué hace y qué puedes hacer en él.</p>
          </div>
          <div className="next-step" role="status">
            <span className="eyebrow">{current === -1 ? "Flujo completado" : `Siguiente paso · ${current + 1} de ${steps.length}`}</span>
            <p>{current === -1 ? "Carga verificada. Consulta «Datos en Supabase» o repite con otro periodo." : steps[current].todo}</p>
            <button type="button" className="next-step-btn" onClick={() => goTo(current === -1 ? 3 : current)}>
              {current === -1 ? "Ver datos" : `Ir a «${steps[current].label}»`}<ChevronRight size={16} aria-hidden />
            </button>
          </div>
        </div>
        <ol className="stepper" aria-label="Pasos del flujo">
          {steps.map((s, i) => {
            const state = s.done ? "done" : i === current ? "current" : "todo"
            return (
              <li key={s.label}>
                <button type="button" className="step-btn" data-state={state} aria-current={state === "current" ? "step" : undefined} onClick={() => goTo(i)}>
                  <span className="step-dot">{s.done ? <Check size={14} aria-hidden /> : i + 1}</span>
                  <span className="step-text"><b>{s.label}</b><small>{s.done ? "Hecho" : state === "current" ? "Estás aquí" : "Pendiente"}</small></span>
                </button>
              </li>
            )
          })}
        </ol>
      </header>

      {/* ── Contadores (6 × 2 col) ── */}
      <Kpi label="Horas extraídas" value={fmt(inputCount)} color="var(--blue-500)" hint={records.length ? `${Object.keys(raw).length} ciudad(es)` : "Sin extracción todavía"} />
      <Kpi label="Válidas" value={fmt(records.length)} color="var(--green-500)" hint="Tras transformación y limpieza" />
      <Kpi label="Rechazadas" value={fmt(rejected.length)} color="var(--red-700)" hint={`${fmt(nulls)} con null · ${fmt(duplicates)} duplicadas`} />
      <Kpi label="Seleccionadas" value={fmt(selectedFiltered.length)} color="var(--sky-300)" hint={`de ${fmt(filtered.length)} que cumplen filtros`} />
      <Kpi label="Pendientes de subir" icon={<Clock size={14} aria-hidden />} value={fmt(localPending)} color="var(--amber-500)" hint={`${fmt(pendingSelected)} de ellas seleccionadas`} />
      <Kpi label="Persistidas en Supabase" icon={<Database size={14} aria-hidden />} value={dest ? fmt(dest.total) : "—"} color="var(--navy-800)" hint={destError ? "No se pudo leer el destino" : dest ? `Leído a las ${destUpdated}` : "Leyendo…"} />

      {/* ── Paso 1 (4 col) + Paso 2 (8 col) ── */}
      <Section id="extraccion" step={1} title="Extracción" className="dash-4" hint="Qué datos descargar de Open-Meteo.">
        <div className="flex flex-col gap-4">
          <fieldset className="m-0 border-0 p-0">
            <legend className="field mb-1.5">Ciudades</legend>
            <div className="chip-group">
              {CITIES.map((c) => (
                <label key={c.id} className="chip">
                  <input type="checkbox" checked={cities.includes(c.id)} onChange={() => setCities((v) => (v.includes(c.id) ? v.filter((x) => x !== c.id) : [...v, c.id]))} />
                  {c.nombre}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <label className="field">Inicio (UTC)<input className="control" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
            <label className="field">Fin (UTC)<input className="control" type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
          </div>
          <p className="m-0 text-sm text-muted-foreground">Volumen previsto: <b className="text-foreground">{ok ? fmt(cities.length * days * 24) : "—"}</b> registros ({ok ? `${cities.length} ciudad(es) × ${days} día(s) × 24 h` : "revisa los parámetros"}).</p>
          <Button size="lg" className="w-full" disabled={!ok || working} onClick={() => extract()}>
            {working ? <Loader2 className="animate-spin" /> : <Play />}{working ? "Extrayendo…" : records.length ? "Volver a extraer" : "Extraer datos"}
          </Button>
        </div>
        {!ok && <Notice kind="err">Selecciona al menos una ciudad y un periodo de entre 1 y 31 días.</Notice>}
        {Object.entries(errors).map(([id, e]) => (
          <Notice kind="err" key={id}>
            <b>{CITIES.find((c) => c.id === id)?.nombre}:</b> {e}{" "}<button className="link-button" disabled={working} onClick={() => extract([id], true)}>Reintentar esta ciudad</button>
          </Notice>
        ))}
      </Section>

      <Section id="pipeline" step={2} title="Pipeline y calidad" className="dash-8" hint="Estado de cada fase con registros de entrada y salida.">
        <ol className="pipeline">
          {displayPhases.map((p, i) => (
            <li key={p.name} className="phase" data-state={p.state}>
              <PhaseBadge state={p.state} />
              <h3><span>{i + 1}.</span>{p.name}</h3>
              <p>{p.note}</p>
              <dl>
                <div><dt>Entrada</dt><dd>{fmt(p.input)}</dd></div>
                <div><dt>Salida</dt><dd>{fmt(p.output)}</dd></div>
              </dl>
              {p.ms !== undefined && <small className="text-xs text-subtle">{p.ms.toFixed(0)} ms</small>}
            </li>
          ))}
        </ol>
        {rejected.length > 0 && (
          <Notice kind="warn">
            {fmt(rejected.length)} registros rechazados ({fmt(nulls)} con null, {fmt(duplicates)} duplicados).{" "}
            <button className="link-button" onClick={() => { setTab("rechazados"); setPage(0); document.getElementById("inspeccion")?.scrollIntoView({ behavior: "smooth" }) }}>Ver motivos</button>
          </Notice>
        )}
      </Section>

      {/* ── Paso 3: segmentación (4 col, 2 filas) + análisis (8 col) ── */}
      <Section id="segmentacion" step={3} title="Segmentación de datos" className="dash-4 dash-tall" hint="Afecta a gráficos, contadores y tabla.">
        <div className="flex flex-col gap-4">
          <div className="filter-summary">
            <span className={activeFilters ? "badge info" : "badge"}><SlidersHorizontal size={12} aria-hidden />{activeFilters ? `${activeFilters} filtro(s) activo(s)` : "Sin filtros"}</span>
            <span className="text-sm text-muted-foreground"><b className="text-foreground">{fmt(filtered.length)}</b> de {fmt(records.length)} registros</span>
          </div>
          <FilterGroup title="Ciudad" hint="Sin marcar = todas. También puedes hacer clic en las barras del gráfico.">
            <div className="chip-group">
              {CITIES.map((c) => {
                const on = fc.includes(c.nombre)
                return (
                  <button key={c.id} type="button" className="chip" aria-pressed={on} onClick={() => toggleCityFilter(c.nombre)}>
                    <span className="swatch" style={{ background: cityColor(c.nombre) }} aria-hidden /><Check className="check" aria-hidden />{c.nombre}
                  </button>
                )
              })}
            </div>
          </FilterGroup>
          <FilterGroup title="Periodo (UTC)">
            <div className="grid grid-cols-2 gap-3">
              <label className="field">Desde<input className="control" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0) }} /></label>
              <label className="field">Hasta<input className="control" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(0) }} /></label>
            </div>
          </FilterGroup>
          <FilterGroup title="Rangos de medida">
            <div className="grid grid-cols-2 gap-3">
              {numberField(minT, setMinT, "Temp. mín. °C")}
              {numberField(maxT, setMaxT, "Temp. máx. °C")}
              {numberField(minH, setMinH, "Humedad mín. %")}
              {numberField(maxH, setMaxH, "Humedad máx. %")}
              {numberField(minP, setMinP, "Precip. mín. mm")}
              {numberField(maxP, setMaxP, "Precip. máx. mm")}
            </div>
            <label className="chip mt-3 w-fit"><input type="checkbox" checked={rain} onChange={(e) => { setRain(e.target.checked); setPage(0) }} />Solo horas con lluvia</label>
          </FilterGroup>
          <FilterGroup title="Ordenación de la tabla">
            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <label className="field">Ordenar por
                <select className="control" value={sort} onChange={(e) => { setSort(e.target.value as SortKey); setPage(0) }}>
                  {SORT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <Button variant="outline" size="lg" onClick={() => { setAsc(!asc); setPage(0) }} aria-label={`Orden ${asc ? "ascendente" : "descendente"}; cambiar`}>
                {asc ? <ArrowUp /> : <ArrowDown />}{asc ? "Asc." : "Desc."}
              </Button>
            </div>
          </FilterGroup>
          <FilterGroup title="Selección para la carga">
            <div className="flex flex-col gap-2">
              <Button variant="outline" disabled={!filtered.length} onClick={() => toggleMany(filtered)}>
                {filtered.length && filtered.every((r) => selected.has(key(r))) ? "Quitar" : "Seleccionar"} las {fmt(filtered.length)} filtradas
              </Button>
              <Button variant="outline" disabled={!selected.size} onClick={() => setSelected(new Set())}>Vaciar selección</Button>
            </div>
            {selected.size > selectedFiltered.length && (
              <Notice kind="warn">{fmt(selected.size - selectedFiltered.length)} seleccionados quedan fuera de los filtros y no se subirán.</Notice>
            )}
          </FilterGroup>
          <Button variant="outline" disabled={!activeFilters} onClick={resetFilters}><RotateCcw />Restablecer filtros</Button>
        </div>
      </Section>

      <Panel title="Evolución de la temperatura" unit="°C · UTC" className="dash-8" hint="Pasa el cursor para ver los valores de cada hora.">
        <TemperatureChart rows={filtered} />
      </Panel>
      <Panel title="Comparativa por ciudad" className="dash-4 dash-half" hint="Clic en una barra para filtrar.">
        <CityBars rows={filteredAnyCity} active={fc} onToggle={toggleCityFilter} />
      </Panel>
      <Panel title="Embudo de registros" className="dash-4 dash-half" hint="Cuántos sobreviven a cada paso.">
        <Funnel steps={[
          { label: "Horas extraídas", value: inputCount },
          { label: "Válidas", value: records.length, hint: `${fmt(rejected.length)} rechazadas` },
          { label: "Cumplen filtros", value: filtered.length },
          { label: "Seleccionadas", value: selectedFiltered.length },
          { label: "Ya en Supabase", value: selectedFiltered.length - pendingSelected, hint: `${fmt(pendingSelected)} pendientes` },
        ]} />
      </Panel>

      {/* ── Paso 4 (8 col) + Paso 5 (4 col) ── */}
      <Section id="inspeccion" step={4} title="Inspección de datos" className="dash-8" hint="Tabla paginada; la selección se mantiene entre páginas.">
        <div className="tabs" role="tablist" aria-label="Vistas de datos">
          {TABS.map(([id, label]) => {
            const count = id === "datos" ? filtered.length : id === "previa" ? selectedFiltered.length : id === "rechazados" ? rejected.length : id === "destino" ? dest?.total : undefined
            return (
              <button key={id} id={`tab-${id}`} role="tab" aria-selected={tab === id} aria-controls="tab-panel" className="tab"
                onClick={() => { setTab(id); setPage(0); if (id === "previa") setPreviewSeen(true); if (id === "destino") void loadDest() }}>
                {id === "destino" && <Database size={15} aria-hidden />}{label}{count !== undefined && <span className="count">{fmt(count)}</span>}
              </button>
            )
          })}
        </div>
        <div id="tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {(tab === "datos" || tab === "previa") && (
            <>
              {tab === "previa" && <Notice kind="info">Conjunto exacto que se enviará, en este orden. La base de datos no garantiza el orden de inserción: consulta siempre con ORDER BY.</Notice>}
              <LocalTable rows={paged} selected={selected} persisted={persisted} toggle={toggle} togglePage={() => toggleMany(paged)}
                empty={tab === "previa" ? "No hay filas seleccionadas que cumplan los filtros." : records.length ? "Ningún registro cumple los filtros." : "Extrae datos para empezar (paso 1)."} />
              <Pager page={page} total={visible.length} set={setPage} />
            </>
          )}
          {tab === "rechazados" && (
            <>
              <Notice kind="info">Los null se rechazan y se muestran tal cual: nunca se convierten en 0.</Notice>
              <RejectTable rows={rejected.slice(page * perPage, page * perPage + perPage)} />
              <Pager page={page} total={rejected.length} set={setPage} />
            </>
          )}
          {tab === "json" && (
            <>
              <Button variant="outline" className="mt-4" disabled={!Object.keys(raw).length} onClick={download}><Download />Descargar JSON</Button>
              <pre className="json-view">{Object.keys(raw).length ? JSON.stringify(raw, null, 2) : "Sin respuesta original todavía."}</pre>
            </>
          )}
          {tab === "destino" && (
            <DestinationView dest={dest} q={destQuery} loading={destLoading} error={destError} updated={destUpdated} localPending={localPending} load={loadDest} />
          )}
        </div>
      </Section>

      <Section id="carga" step={5} title="Carga en Supabase" className="dash-4 upload-panel" hint="Escritura solo en servidor; congela la selección.">
        <div className="sticky-block flex flex-col gap-4">
          <dl className="mini-stats">
            <div><dt>Seleccionadas</dt><dd>{fmt(selectedFiltered.length)}</dd></div>
            <div><dt><Clock size={12} aria-hidden />Pendientes</dt><dd>{fmt(pendingSelected)}</dd></div>
            <div><dt><Database size={12} aria-hidden />Ya en Supabase</dt><dd>{fmt(selectedFiltered.length - pendingSelected)}</dd></div>
            <div><dt>Lotes de 500</dt><dd>{fmt(Math.ceil(selectedFiltered.length / 500))}</dd></div>
          </dl>
          <p className="m-0 text-sm text-muted-foreground">Los registros que ya existen se actualizan por la clave ciudad + fecha_hora: una segunda carga no crea duplicados.</p>
          <Button variant="outline" size="lg" disabled={!selectedFiltered.length} onClick={() => goTo(3)}><Eye />Revisar vista previa</Button>
          <Button size="lg" disabled={!selectedFiltered.length || uploading} onClick={upload}>
            {uploading ? <Loader2 className="animate-spin" /> : <Upload />}Subir {fmt(selectedFiltered.length)} registros
          </Button>
          {failed.length > 0 && (
            <Button variant="outline" size="lg" disabled={uploading} onClick={() => send(failed)}><RefreshCw />Reintentar {failed.length} lote(s) fallido(s)</Button>
          )}
          {!selectedFiltered.length && <Notice kind="info">Selecciona filas en el paso 3 o en la tabla para activar la carga.</Notice>}
          {report && <Notice kind={report.kind}>{report.text}</Notice>}
        </div>
      </Section>
    </main>
  )
}

function Section({ id, step, title, hint, className = "", children }: { id: string; step: number; title: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <section id={id} className={`app-panel ${className}`} aria-labelledby={`${id}-title`}>
      <div className="panel-head">
        <h2 id={`${id}-title`} className="panel-title"><span className="step">{step}</span>{title}</h2>
        {hint && <p className="panel-hint">{hint}</p>}
      </div>
      {children}
    </section>
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

function FilterGroup({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="filter-group">
      <legend>{title}</legend>
      {hint && <p className="panel-hint mb-2 text-xs">{hint}</p>}
      {children}
    </fieldset>
  )
}

function Kpi({ label, value, hint, color, icon }: { label: string; value: string; hint: string; color: string; icon?: React.ReactNode }) {
  return (
    <div className="kpi dash-2" style={{ "--kpi-color": color } as React.CSSProperties}>
      <dt>{icon}{label}</dt>
      <dd>{value}</dd>
      <small>{hint}</small>
    </div>
  )
}

const NOTICE_ICONS = { ok: CheckCircle2, err: XCircle, warn: TriangleAlert, info: Info }
function Notice({ kind, children }: { kind: keyof typeof NOTICE_ICONS; children: React.ReactNode }) {
  const Icon = NOTICE_ICONS[kind]
  return <div className={`notice ${kind}`} role={kind === "err" ? "alert" : "status"}><Icon size={16} aria-hidden /><span>{children}</span></div>
}

function PhaseBadge({ state }: { state: PhaseState }) {
  if (state === "completada") return <span className="badge ok"><CheckCircle2 size={13} aria-hidden />Completada</span>
  if (state === "error") return <span className="badge err"><XCircle size={13} aria-hidden />Con errores</span>
  if (state === "curso") return <span className="badge info"><Loader2 size={13} className="animate-spin" aria-hidden />En curso</span>
  return <span className="badge"><Circle size={13} aria-hidden />Pendiente</span>
}

function StorageBadge({ stored }: { stored: boolean }) {
  return stored
    ? <span className="badge ok"><Database size={12} aria-hidden />En Supabase</span>
    : <span className="badge warn"><Clock size={12} aria-hidden />Local · pendiente</span>
}

function LocalTable({ rows, selected, persisted, toggle, togglePage, empty }: { rows: WeatherRecord[]; selected: Set<string>; persisted: Set<string>; toggle: (r: WeatherRecord) => void; togglePage: () => void; empty: string }) {
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(key(r)))
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col" className="w-10"><input type="checkbox" aria-label="Seleccionar las filas de esta página" checked={allOnPage} disabled={!rows.length} onChange={togglePage} /></th>
            <th scope="col">Ciudad</th><th scope="col">Fecha y hora (UTC)</th>
            <th scope="col" className="num">Temp. (°C)</th><th scope="col" className="num">Humedad (%)</th><th scope="col" className="num">Precip. (mm)</th>
            <th scope="col">Estado</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={key(r)} aria-selected={selected.has(key(r))}>
              <td><input type="checkbox" aria-label={`Seleccionar ${r.ciudad} ${fmtDate(r.fecha_hora)}`} checked={selected.has(key(r))} onChange={() => toggle(r)} /></td>
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
  const show = (v: unknown) => (v === null || v === undefined ? <span className="null-value">null</span> : String(v))
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead><tr><th scope="col">Ciudad</th><th scope="col" className="num">Índice</th><th scope="col">Fecha original</th><th scope="col" className="num">Temp.</th><th scope="col" className="num">Humedad</th><th scope="col" className="num">Precip.</th><th scope="col">Motivo</th></tr></thead>
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
      {!rows.length && <p className="empty-state">No hay registros rechazados.</p>}
    </div>
  )
}

function Pager({ page, total, set }: { page: number; total: number; set: (n: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / perPage))
  return (
    <nav className="pager" aria-label="Paginación">
      <span>Mostrando {fmt(total ? page * perPage + 1 : 0)}–{fmt(Math.min((page + 1) * perPage, total))} de {fmt(total)} · página {page + 1} de {pages}</span>
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
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>Leyenda:</span><StorageBadge stored /><span>leído ahora de la tabla</span>
        <span aria-hidden>·</span><StorageBadge stored={false} /><span>{fmt(localPending)} registros extraídos que no aparecen aquí hasta subirlos</span>
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
            <option value="importado_en">Fecha de importación</option>
          </select>
        </label>
        <Button variant="outline" size="lg" onClick={() => load({ asc: !q.asc, page: 0 })}>{q.asc ? <ArrowUp /> : <ArrowDown />}{q.asc ? "Ascendente" : "Descendente"}</Button>
        <Button size="lg" className="px-4" disabled={loading} onClick={() => load()}><RefreshCw className={loading ? "animate-spin" : ""} />Actualizar</Button>
      </div>
      <p className="m-0 text-sm text-muted-foreground" aria-live="polite">
        {loading ? "Consultando Supabase…" : dest ? `${fmt(dest.count)} registros coinciden de ${fmt(dest.total)} persistidos · actualizado a las ${updated}` : ""}
      </p>
      {error && <Notice kind="err">{error}</Notice>}
      {dest && (
        <div>
          <div className="table-wrap mt-0">
            <table className="data-table">
              <thead><tr><th scope="col" className="num">ID</th><th scope="col">Ciudad</th><th scope="col">Fecha y hora (UTC)</th><th scope="col" className="num">Temp. (°C)</th><th scope="col" className="num">Humedad (%)</th><th scope="col" className="num">Precip. (mm)</th><th scope="col">Importado (UTC)</th><th scope="col">Estado</th></tr></thead>
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
                    <td><StorageBadge stored /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!dest.rows.length && <p className="empty-state">No hay registros persistidos que cumplan estos filtros.</p>}
          </div>
          <Pager page={q.page} total={dest.count} set={(p) => load({ page: p })} />
        </div>
      )}
    </div>
  )
}
