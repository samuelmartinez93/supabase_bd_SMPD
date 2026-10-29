/**
 * Verificación del pipeline ETL (puntos 1-9 de la práctica; el 10 es `npm run build` + `npm run typecheck`).
 *
 *   npm run verify            → pruebas con fixtures + extracción real (necesita `npm run dev` en marcha)
 *
 * Los fixtures de tests/fixtures/ son datos controlados para provocar null y duplicados;
 * nunca se mezclan con las extracciones reales de Open-Meteo.
 * Sin credenciales de Supabase, las pruebas de integración de la carga se marcan como PENDIENTES (no como superadas).
 */
import { readFileSync } from "node:fs"
import { cleanRows, toRows, transformWeather, DUPLICATE_REASON, type WeatherRecord } from "../lib/weather.ts"
import { applyFilters, EMPTY_FILTERS, paginate, recordKey, runUpload, selectedOutsideFilters, sortRecords, toBatches, uploadSet, type PostResult } from "../lib/pipeline.ts"

const BASE = process.env.BASE_URL ?? "http://localhost:3000"
const results: { n: string; name: string; status: "OK" | "FALLO" | "PENDIENTE"; detail: string }[] = []
function check(n: string, name: string, cond: boolean, detail: string) { results.push({ n, name, status: cond ? "OK" : "FALLO", detail }) }
function pending(n: string, name: string, detail: string) { results.push({ n, name, status: "PENDIENTE", detail }) }
const fixture = (f: string) => JSON.parse(readFileSync(new URL(`../tests/fixtures/${f}`, import.meta.url), "utf8"))

// Datos sintéticos para filtros/selección/carga: generados aquí, nunca enviados a Open-Meteo ni a Supabase.
const synthetic: WeatherRecord[] = Array.from({ length: 60 }, (_, i) => ({
  ciudad: i % 2 ? "Madrid" : "Sevilla",
  fecha_hora: new Date(Date.UTC(2026, 8, 1, i % 24, 0) + Math.floor(i / 24) * 864e5).toISOString(),
  temperatura_c: 10 + ((i * 7) % 25), humedad_pct: 30 + (i % 60), precipitacion_mm: i % 5 === 0 ? 1.5 : 0,
}))

// ── 1. Extracción real: una ciudad durante un día → 24 registros horarios en UTC ──
try {
  const res = await fetch(`${BASE}/api/extract`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cityId: "madrid", start: "2026-09-01", end: "2026-09-01" }) })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error)
  const r = transformWeather("Madrid", body.raw)
  const utc = body.raw.utc_offset_seconds === 0 && r.records.every((x, h) => x.fecha_hora === `2026-09-01T${String(h).padStart(2, "0")}:00:00.000Z`)
  check("1", "Extracción de 1 ciudad × 1 día = 24 registros UTC", r.input === 24 && r.records.length + r.rejected.length === 24 && utc,
    `Open-Meteo real: ${r.input} horas, ${r.records.length} válidas, ${r.rejected.length} rechazadas, utc_offset_seconds=${body.raw.utc_offset_seconds}, horas 00:00Z…23:00Z ${utc ? "correctas" : "INCORRECTAS"}`)
  // Validación del servidor: periodo > 31 días.
  const long = await fetch(`${BASE}/api/extract`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cityId: "madrid", start: "2026-08-01", end: "2026-09-15" }) })
  check("1b", "El servidor rechaza periodos de más de 31 días", long.status === 400, `HTTP ${long.status}`)
} catch (e) {
  check("1", "Extracción de 1 ciudad × 1 día = 24 registros UTC", false, `No se pudo extraer (¿está «npm run dev» en marcha?): ${(e as Error).message}`)
}

// ── 2. Transformación de arrays paralelos ──
{
  const t = toRows("Bilbao", fixture("open-meteo-duplicados.json"))
  const ok = t.rows.length === 5 && t.rows[2].fecha_hora === "2026-09-01T01:00" && t.rows[2].temperatura_c === 99.9 && t.rows[2].humedad_pct === 10 && t.rows[2].precipitacion_mm === 5
  const bad = toRows("Bilbao", fixture("open-meteo-arrays-desiguales.json"))
  check("2", "Transformación de arrays paralelos a filas", ok && !!bad.error && bad.rows.length === 0,
    `5 posiciones → 5 filas con hourly.*[i] alineados; arrays de longitud distinta → error «${bad.error?.motivo}» y 0 filas`)
}

// ── 3. null, vacío y no numérico nunca se convierten en 0 ──
{
  const t = toRows("Barcelona", fixture("open-meteo-nulos.json"))
  const c = cleanRows(t.rows)
  const noZeroFromNull = !c.records.some((r) => r.temperatura_c === 0 || r.humedad_pct === 0)
  const motivos = c.rejected.map((r) => `#${r.indice}: ${r.motivo}`)
  const extremeKept = c.records.some((r) => r.temperatura_c === -38.5)
  check("3", "Tratamiento de null sin convertirlo en cero", c.records.length === 2 && c.rejected.length === 7 && noZeroFromNull && extremeKept,
    `9 filas → 2 válidas, 7 rechazadas con motivo; ningún 0 inventado; temperatura extrema −38,5 °C conservada. ${motivos.join(" | ")}`)
}

// ── 4. Duplicados por ciudad y fecha_hora: se conserva la primera ──
{
  const r = transformWeather("Bilbao", fixture("open-meteo-duplicados.json"))
  const firstKept = r.records.find((x) => x.fecha_hora === "2026-09-01T01:00:00.000Z")?.temperatura_c === 17.5
  check("4", "Detección de duplicados", r.records.length === 3 && r.duplicates === 2 && firstKept && r.rejected.every((x) => x.motivo === DUPLICATE_REASON),
    `5 filas → 3 válidas y 2 duplicadas rechazadas; se conserva la primera aparición (01:00 → 17,5 °C, no 99,9 °C)`)
}

// ── 5. Filtros y ordenación antes de paginar ──
{
  const filtered = sortRecords(applyFilters(synthetic, { ...EMPTY_FILTERS, minT: "20" }), "temperatura_c", false)
  const page1 = paginate(filtered, 0, 20)
  const globalTop = [...synthetic].filter((r) => r.temperatura_c >= 20).map((r) => r.temperatura_c).sort((a, b) => b - a).slice(0, 20)
  const unsortedFirstPage = paginate(synthetic, 0, 20).filter((r) => r.temperatura_c >= 20)
  check("5", "Filtros y ordenación antes de paginar", page1.map((r) => r.temperatura_c).join() === globalTop.join() && filtered.every((r) => r.temperatura_c >= 20) && unsortedFirstPage.length < 20,
    `Página 1 = los 20 valores más altos de TODO el conjunto filtrado (${filtered.length} filas), no de la primera página sin ordenar`)
}

// ── 6. Selección entre varias páginas ──
{
  const filtered = sortRecords(applyFilters(synthetic, { ...EMPTY_FILTERS, cities: ["Madrid"] }), "fecha_hora", true)
  let selected = new Set(filtered.map(recordKey)) // «Seleccionar todos los que cumplen los filtros»
  const p2 = paginate(filtered, 1, 20)
  selected = new Set([...selected].filter((k) => k !== recordKey(p2[0]))) // se desmarca una fila de la página 2
  const sel = uploadSet(filtered, selected)
  const outside = selectedOutsideFilters(new Set([...selected, recordKey(synthetic[0])]), filtered) // Sevilla queda fuera del filtro
  check("6", "Selección de filas entre varias páginas", filtered.length === 30 && sel.length === 29 && paginate(sel, 0, 20).length === 20 && outside === 1,
    `${filtered.length} filtradas en 2 páginas → seleccionar todas y desmarcar 1 de la página 2 = ${sel.length}; una seleccionada fuera de filtros se cuenta (${outside}) y no se sube`)
}

// ── 7. La vista previa coincide con lo enviado ──
{
  const big: WeatherRecord[] = Array.from({ length: 1234 }, (_, i) => ({ ciudad: ["Madrid", "Sevilla", "Bilbao"][i % 3], fecha_hora: new Date(Date.UTC(2026, 8, 1) + i * 36e5).toISOString(), temperatura_c: 15 + (i % 17), humedad_pct: 50, precipitacion_mm: 0 }))
  const filters = { ...EMPTY_FILTERS, minT: "18" }
  const preview = uploadSet(sortRecords(applyFilters(big, filters), "temperatura_c", false), new Set(big.map(recordKey)))
  const snapshot = [...preview]
  const batches = toBatches(snapshot)
  // Cambiar los filtros después de congelar la copia no altera la carga en curso.
  const later = uploadSet(sortRecords(applyFilters(big, { ...filters, minT: "30" }), "temperatura_c", false), new Set(big.map(recordKey)))
  const sent = batches.flat()
  const same = sent.length === preview.length && sent.every((r, i) => recordKey(r) === recordKey(preview[i]))
  check("7", "Coincidencia entre vista previa y datos enviados", same && batches.every((b) => b.length <= 500) && later.length !== sent.length,
    `${preview.length} filas en ${batches.length} lotes (${batches.map((b) => b.length).join(" + ")}), mismo contenido y orden; filtros cambiados después → la carga congelada no cambia`)
}

// ── 9. Fallo parcial de carga (servidor simulado: el lote 2 falla) ──
{
  const rows = synthetic.concat(synthetic.map((r) => ({ ...r, ciudad: "Valencia" }))).slice(0, 120)
  const batches = toBatches(rows, 50)
  let call = 0
  const flaky = async (b: WeatherRecord[]): Promise<PostResult> => (++call === 2 ? { ok: false, error: "Error simulado de red" } : { ok: true, verified: b.length, missing: [] })
  const states: string[] = []
  const r1 = await runUpload(batches, flaky, (s) => states.push(s.map((x) => x.state).join(",")))
  const retry = await runUpload(r1.failed, async (b) => ({ ok: true, verified: b.length, missing: [] }))
  const final = states[states.length - 1]
  check("9", "Gestión de un fallo parcial de carga", r1.verified === 70 && r1.failed.length === 1 && r1.failed[0].length === 50 && final === "ok,error,ok" && retry.verified === 50 && retry.failed.length === 0,
    `3 lotes (50+50+20): lote 2 falla → informe ${r1.verified} verificados / 50 fallidos, estados finales [${final}], los lotes 1 y 3 se conservan; reintento solo del fallido → ${retry.verified} verificados`)
}

// ── Seguridad: validación en servidor (no necesita credenciales: se rechaza antes de tocar Supabase) ──
try {
  const post = (body: string) => fetch(`${BASE}/api/supabase`, { method: "POST", headers: { "Content-Type": "application/json" }, body })
  const invalid = await post(JSON.stringify({ records: [{ ciudad: "Madrid", fecha_hora: "2026-09-01T00:00:00.000Z", temperatura_c: 20, humedad_pct: 150, precipitacion_mm: 0 }] }))
  const tooMany = await post(JSON.stringify({ records: Array.from({ length: 501 }, () => synthetic[0]) }))
  const huge = await post(JSON.stringify({ records: [], relleno: "x".repeat(300 * 1024) }))
  check("S", "Validación en servidor de registros y tamaño", invalid.status === 400 && tooMany.status === 400 && huge.status === 413,
    `humedad 150 % → ${invalid.status}; 501 registros → ${tooMany.status}; cuerpo de 300 KB → ${huge.status}`)
} catch (e) { check("S", "Validación en servidor de registros y tamaño", false, (e as Error).message) }

// ── 8. Segunda carga sin duplicados (integración real con Supabase) ──
try {
  const probe = await fetch(`${BASE}/api/supabase?page=0&size=1`)
  if (probe.status !== 503 && process.env.VERIFY_SUPABASE !== "1") {
    pending("8", "Segunda carga sin duplicados", "Supabase responde, pero esta prueba escribe 3 filas de prueba en la tabla real: ejecútala con VERIFY_SUPABASE=1 npm run verify.")
  } else if (probe.status === 503) {
    pending("8", "Segunda carga sin duplicados", `Sin credenciales de Supabase en este entorno (${(await probe.json()).error}). La lógica está implementada (upsert onConflict «ciudad,fecha_hora» + restricción UNIQUE); hay que comprobarla en Vercel o con .env.local.`)
    pending("9b", "Fallo parcial contra Supabase real", "Probado con servidor simulado (punto 9); falta la prueba contra la base real.")
  } else {
    const rows: WeatherRecord[] = [0, 1, 2].map((h) => ({ ciudad: "Prueba verificación", fecha_hora: `2000-01-01T0${h}:00:00.000Z`, temperatura_c: 10 + h, humedad_pct: 50, precipitacion_mm: 0 }))
    const send = () => fetch(`${BASE}/api/supabase`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ records: rows }) }).then((r) => r.json())
    const a = await send(), b = await send()
    const count = await fetch(`${BASE}/api/supabase?city=${encodeURIComponent("Prueba verificación")}&start=2000-01-01&end=2000-01-01`).then((r) => r.json())
    check("8", "Segunda carga sin duplicados", a.verified === 3 && b.verified === 3 && count.count === 3,
      `2 cargas de las mismas 3 filas → ${count.count} filas en destino (ciudad «Prueba verificación», año 2000; bórralas cuando quieras)`)
  }
} catch (e) { check("8", "Segunda carga sin duplicados", false, (e as Error).message) }

// ── Informe ──
for (const r of results) console.log(`${r.status === "OK" ? "✔" : r.status === "PENDIENTE" ? "…" : "✘"} [${r.n}] ${r.name}: ${r.status}\n    ${r.detail}`)
const failedTests = results.filter((r) => r.status === "FALLO").length
console.log(`\n${results.filter((r) => r.status === "OK").length} OK · ${failedTests} fallos · ${results.filter((r) => r.status === "PENDIENTE").length} pendientes (punto 10: npm run build y npm run typecheck)`)
process.exit(failedTests ? 1 : 0)
