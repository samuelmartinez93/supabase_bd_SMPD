"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { CITIES, type WeatherRecord } from "@/lib/weather"

// Cada ciudad conserva siempre su color (definido en globals.css), aunque cambien los filtros.
export const cityColor = (nombre: string) => `var(--city-${CITIES.find((c) => c.nombre === nombre)?.id ?? "otra"})`
const fmt = (n: number, digits = 1) => n.toLocaleString("es-ES", { maximumFractionDigits: digits })
const DAY = 864e5

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

function niceTicks(min: number, max: number, count = 5) {
  if (min === max) { min -= 1; max += 1 }
  const raw = (max - min) / count, mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag
  const ticks: number[] = []
  for (let v = Math.floor(min / step) * step; v <= Math.ceil(max / step) * step + step / 2; v += step) ticks.push(Number(v.toFixed(6)))
  return ticks
}

export function Legend({ cities }: { cities: string[] }) {
  return (
    <ul className="legend" aria-label="Leyenda">
      {cities.map((c) => <li key={c}><span className="swatch" style={{ background: cityColor(c) }} />{c}</li>)}
    </ul>
  )
}

export function ChartEmpty({ children }: { children: React.ReactNode }) {
  return <p className="chart-empty">{children}</p>
}

/** Línea de temperatura horaria por ciudad, con cruz y tooltip al pasar el cursor. */
export function TemperatureChart({ rows }: { rows: WeatherRecord[] }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const [grain, setGrain] = useState<"auto" | "hora" | "dia">("auto")
  const model = useMemo(() => {
    const stamps = rows.map((r) => Date.parse(r.fecha_hora))
    const rawSpan = stamps.length ? (Math.max(...stamps) - Math.min(...stamps)) / DAY : 0
    // Con muchos días, 24 puntos por día y ciudad se vuelven ilegibles: la media diaria resume sin inventar datos.
    const daily = grain === "dia" || (grain === "auto" && rawSpan > 3)
    const series = CITIES.map((c) => {
      const hourly = rows.filter((r) => r.ciudad === c.nombre).map((r) => ({ t: Date.parse(r.fecha_hora), v: r.temperatura_c }))
      let points = hourly
      if (daily) {
        const days = new Map<number, number[]>()
        hourly.forEach((p) => { const d = p.t - (p.t % DAY); days.set(d, [...(days.get(d) ?? []), p.v]) })
        points = [...days].map(([t, vs]) => ({ t, v: vs.reduce((a, b) => a + b, 0) / vs.length }))
      }
      points.sort((a, b) => a.t - b.t)
      return { city: c.nombre, points, byTime: new Map(points.map((p) => [p.t, p.v])) }
    }).filter((s) => s.points.length)
    const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b)
    const values = series.flatMap((s) => s.points.map((p) => p.v))
    return { series, times, daily, min: Math.min(...values), max: Math.max(...values) }
  }, [rows, grain])

  return (
    <div ref={ref} className="flex flex-col gap-2">
      <div className="chart-toolbar">
        <Legend cities={model.series.map((s) => s.city)} />
        <label className="field field-inline">Granularidad
          <select className="control" value={grain} onChange={(e) => { setGrain(e.target.value as typeof grain); setHover(null) }}>
            <option value="auto">Automática ({model.daily ? "diaria" : "horaria"})</option>
            <option value="hora">Horaria</option>
            <option value="dia">Media diaria</option>
          </select>
        </label>
      </div>
      {model.series.length ? <LineArea model={model} width={width} hover={hover} setHover={setHover} /> : <ChartEmpty>Sin datos: extrae registros o relaja los filtros.</ChartEmpty>}
    </div>
  )
}

type LineModel = { series: { city: string; points: { t: number; v: number }[]; byTime: Map<number, number> }[]; times: number[]; daily: boolean; min: number; max: number }

function LineArea({ model, width, hover, setHover }: { model: LineModel; width: number; hover: number | null; setHover: (i: number | null) => void }) {

  const H = 300, m = { t: 10, r: 14, b: 26, l: 40 }, W = Math.max(width, 280)
  const plotW = W - m.l - m.r, plotH = H - m.t - m.b
  const t0 = model.times[0], t1 = model.times[model.times.length - 1]
  const yTicks = niceTicks(model.min, model.max, 4), y0 = yTicks[0], y1 = yTicks[yTicks.length - 1]
  const x = (t: number) => m.l + (t1 === t0 ? plotW / 2 : ((t - t0) / (t1 - t0)) * plotW)
  const y = (v: number) => m.t + plotH - ((v - y0) / (y1 - y0)) * plotH
  const spanDays = (t1 - t0) / DAY
  const xStep = spanDays <= 2 ? DAY / 6 : Math.ceil(spanDays / 6) * DAY
  const xTicks: number[] = []
  for (let t = Math.ceil(t0 / xStep) * xStep; t <= t1; t += xStep) xTicks.push(t)
  const xLabel = (t: number) => spanDays <= 2 ? new Date(t).toISOString().slice(11, 16) : new Date(t).toLocaleDateString("es-ES", { day: "numeric", month: "short", timeZone: "UTC" })
  // Si falta un punto (p. ej. por un filtro), se corta la línea en vez de unir puntos lejanos.
  const gap = model.daily ? DAY : 36e5
  const path = (pts: { t: number; v: number }[]) => pts.map((p, i) => `${i && p.t - pts[i - 1].t <= gap ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("")

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const box = e.currentTarget.getBoundingClientRect()
    const t = t0 + ((e.clientX - box.left) / box.width) * (t1 - t0)
    let lo = 0, hi = model.times.length - 1
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (model.times[mid] < t) lo = mid; else hi = mid }
    setHover(Math.abs(model.times[lo] - t) <= Math.abs(model.times[hi] - t) ? lo : hi)
  }
  const ht = hover === null ? null : model.times[hover]

  return (
    <div className="chart-wrap">
        <svg width={W} height={H} role="img" aria-label={`Temperatura ${model.daily ? "media diaria" : "horaria"} de ${model.series.map((s) => s.city).join(", ")}: entre ${fmt(model.min)} y ${fmt(model.max)} °C`}>
          {yTicks.map((v) => (
            <g key={v}>
              <line className="grid-line" x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} />
              <text className="axis-label" x={m.l - 6} y={y(v)} dy="0.32em" textAnchor="end">{fmt(v)}</text>
            </g>
          ))}
          {xTicks.map((t) => <text key={t} className="axis-label" x={x(t)} y={H - 6} textAnchor="middle">{xLabel(t)}</text>)}
          {model.series.map((s) => <path key={s.city} d={path(s.points)} fill="none" stroke={cityColor(s.city)} strokeWidth={2} strokeLinejoin="round" />)}
          {ht !== null && (
            <g pointerEvents="none">
              <line className="crosshair" x1={x(ht)} x2={x(ht)} y1={m.t} y2={m.t + plotH} />
              {model.series.map((s) => s.byTime.has(ht) && <circle key={s.city} cx={x(ht)} cy={y(s.byTime.get(ht)!)} r={4.5} fill={cityColor(s.city)} stroke="var(--card)" strokeWidth={2} />)}
            </g>
          )}
          <rect x={m.l} y={m.t} width={plotW} height={plotH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
        {ht !== null && (
          <div className="chart-tooltip" style={{ left: Math.min(Math.max(x(ht), 90), W - 90) }}>
            <b>{model.daily ? `${new Date(ht).toISOString().slice(0, 10)} · media diaria` : `${new Date(ht).toISOString().slice(0, 16).replace("T", " ")} UTC`}</b>
            {model.series.map((s) => s.byTime.has(ht) && (
              <span key={s.city}><i className="swatch" style={{ background: cityColor(s.city) }} />{s.city}<strong>{fmt(s.byTime.get(ht)!)} °C</strong></span>
            ))}
          </div>
        )}
    </div>
  )
}

const METRICS = {
  temperatura_c: { label: "Temperatura media", unit: "°C", agg: "media" },
  precipitacion_mm: { label: "Precipitación total", unit: "mm", agg: "suma" },
  humedad_pct: { label: "Humedad media", unit: "%", agg: "media" },
} as const
type Metric = keyof typeof METRICS

/** Barras por ciudad. Clic en una barra = filtro cruzado por ciudad, como en Power BI. */
export function CityBars({ rows, active, onToggle }: { rows: WeatherRecord[]; active: string[]; onToggle: (city: string) => void }) {
  const [metric, setMetric] = useState<Metric>("temperatura_c")
  const data = CITIES.map((c) => {
    const values = rows.filter((r) => r.ciudad === c.nombre).map((r) => r[metric])
    const sum = values.reduce((a, b) => a + b, 0)
    return { city: c.nombre, n: values.length, value: METRICS[metric].agg === "suma" ? sum : sum / (values.length || 1) }
  }).filter((d) => d.n)
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 0)
  return (
    <div className="flex flex-col gap-3">
      <label className="field">Medida
        <select className="control" value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
          {Object.entries(METRICS).map(([k, m]) => <option key={k} value={k}>{m.label} ({m.unit})</option>)}
        </select>
      </label>
      {!data.length ? <ChartEmpty>Sin datos que comparar.</ChartEmpty> : (
        <ul className="bar-list">
          {data.map((d) => {
            const on = active.includes(d.city), dim = active.length > 0 && !on
            return (
              <li key={d.city}>
                <button type="button" className="bar-row" aria-pressed={on} data-dim={dim || undefined} onClick={() => onToggle(d.city)}
                  title={`${d.city}: ${fmt(d.value)} ${METRICS[metric].unit} (${METRICS[metric].agg} de ${d.n} horas). Clic para ${on ? "quitar" : "aplicar"} el filtro.`}>
                  <span className="bar-label">{d.city}</span>
                  <span className="bar-track"><span className="bar-fill" style={{ width: `${max ? (Math.abs(d.value) / max) * 100 : 0}%`, background: cityColor(d.city) }} /></span>
                  <span className="bar-value">{fmt(d.value)} {METRICS[metric].unit}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <p className="chart-note">{METRICS[metric].agg === "suma" ? "Suma" : "Media"} sobre las horas que cumplen los filtros (excepto el de ciudad). Las ciudades filtradas se marcan con ✓.</p>
    </div>
  )
}

/** Embudo: cuántos registros sobreviven a cada paso del pipeline. */
export function Funnel({ steps }: { steps: { label: string; value: number; hint?: string }[] }) {
  const base = steps[0]?.value || 0
  if (!base) return <ChartEmpty>El embudo aparecerá tras la primera extracción.</ChartEmpty>
  return (
    <ol className="funnel">
      {steps.map((s, i) => (
        <li key={s.label}>
          <div className="funnel-head"><span><span className="funnel-n">{i + 1}</span>{s.label}</span><b>{s.value.toLocaleString("es-ES")}</b></div>
          <div className="bar-track"><span className="bar-fill funnel-fill" style={{ width: `${(s.value / base) * 100}%` }} /></div>
          <small>{fmt((s.value / base) * 100)} % del total{s.hint ? ` · ${s.hint}` : ""}</small>
        </li>
      ))}
    </ol>
  )
}
