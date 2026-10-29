import { isRecord, type WeatherRecord } from "@/lib/weather"
import { supabaseServer } from "@/lib/supabase-server"

export const runtime = "nodejs"
const table = "mediciones_meteorologicas"
const sortable = ["fecha_hora", "ciudad", "temperatura_c", "humedad_pct", "precipitacion_mm", "importado_en"]
// PostgREST devuelve timestamptz como "…+00:00"; el cliente usa ISO "…Z". Normalizamos para comparar claves.
const iso = (value: string) => new Date(value).toISOString()
const recordKey = (r: { ciudad: string; fecha_hora: string }) => `${r.ciudad}|${iso(r.fecha_hora)}`

export async function GET(request: Request) {
  try {
    const url = new URL(request.url), db = supabaseServer()
    const start = url.searchParams.get("start"), end = url.searchParams.get("end")

    // Modo "keys": devuelve qué claves ciudad|fecha_hora ya existen para distinguir datos locales pendientes de persistidos.
    if (url.searchParams.get("mode") === "keys") {
      const cities = (url.searchParams.get("cities") ?? "").split(",").filter(Boolean)
      if (!cities.length || !start || !end) return Response.json({ keys: [] })
      const keys: string[] = []
      for (let from = 0; ; from += 1000) {
        const { data, error } = await db.from(table).select("ciudad,fecha_hora").in("ciudad", cities).gte("fecha_hora", `${start}T00:00:00Z`).lte("fecha_hora", `${end}T23:59:59Z`).order("id").range(from, from + 999)
        if (error) throw error
        keys.push(...(data ?? []).map(recordKey))
        if (!data || data.length < 1000) break
      }
      return Response.json({ keys })
    }

    const page = Math.max(0, Number(url.searchParams.get("page") || 0)), size = Math.min(100, Math.max(1, Number(url.searchParams.get("size") || 20)))
    const sort = sortable.includes(url.searchParams.get("sort") ?? "") ? url.searchParams.get("sort")! : "fecha_hora"
    const ascending = url.searchParams.get("dir") === "asc"
    let query = db.from(table).select("id,ciudad,fecha_hora,temperatura_c,humedad_pct,precipitacion_mm,importado_en", { count: "exact" })
    const city = url.searchParams.get("city")
    if (city) query = query.eq("ciudad", city)
    if (start) query = query.gte("fecha_hora", `${start}T00:00:00Z`)
    if (end) query = query.lte("fecha_hora", `${end}T23:59:59Z`)
    // Filtros y orden se aplican en la base de datos antes de paginar; "id" desempata para que las páginas sean estables.
    const { data, error, count } = await query.order(sort, { ascending }).order("id", { ascending: true }).range(page * size, page * size + size - 1)
    if (error) throw error
    const { count: total, error: totalError } = await db.from(table).select("id", { count: "exact", head: true })
    if (totalError) throw totalError
    return Response.json({ rows: (data ?? []).map((r) => ({ ...r, fecha_hora: iso(r.fecha_hora), importado_en: iso(r.importado_en) })), count: count ?? 0, total: total ?? 0 })
  } catch (e) { return Response.json({ error: errorMessage(e) }, { status: 503 }) }
}

// 500 registros ocupan ~70 KB en JSON: 256 KB da margen y corta peticiones abusivas antes de parsearlas.
const MAX_BODY_BYTES = 256 * 1024

export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (declared > MAX_BODY_BYTES) return Response.json({ error: "Petición demasiado grande." }, { status: 413 })
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return Response.json({ error: "Petición demasiado grande." }, { status: 413 })
  let body: { records?: unknown } | null = null
  try { body = JSON.parse(text) } catch { /* cuerpo no JSON: se rechaza abajo */ }
  if (!Array.isArray(body?.records) || body.records.length < 1 || body.records.length > 500 || !body.records.every(isRecord)) return Response.json({ error: "Lote inválido: se admiten hasta 500 registros válidos." }, { status: 400 })
  const records = body.records as WeatherRecord[]
  try {
    const db = supabaseServer()
    const { error } = await db.from(table).upsert(records, { onConflict: "ciudad,fecha_hora" })
    if (error) throw error
    const cities = [...new Set(records.map((r) => r.ciudad))]
    const { data, error: verificationError } = await db.from(table).select("ciudad,fecha_hora").in("ciudad", cities).in("fecha_hora", records.map((r) => r.fecha_hora))
    if (verificationError) throw verificationError
    const keys = new Set((data ?? []).map(recordKey))
    const missing = records.map(recordKey).filter((k) => !keys.has(k))
    return Response.json({ processed: records.length, verified: records.length - missing.length, missing })
  } catch (e) { return Response.json({ error: errorMessage(e) }, { status: 503 }) }
}

function errorMessage(e: unknown) {
  if (e instanceof Error) return e.message
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message)
  return "Error de Supabase"
}
