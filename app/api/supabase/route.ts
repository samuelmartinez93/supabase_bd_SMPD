import { isRecord, type WeatherRecord } from "@/lib/weather"
import { supabaseServer } from "@/lib/supabase-server"

export const runtime = "nodejs"
const table = "mediciones_meteorologicas"

export async function GET(request: Request) {
  try {
    const url = new URL(request.url), page = Math.max(0, Number(url.searchParams.get("page") || 0)), size = Math.min(100, Math.max(1, Number(url.searchParams.get("size") || 20)))
    let query = supabaseServer().from(table).select("id,ciudad,fecha_hora,temperatura_c,humedad_pct,precipitacion_mm,importado_en", { count: "exact" })
    const city = url.searchParams.get("city"), start = url.searchParams.get("start"), end = url.searchParams.get("end")
    if (city) query = query.eq("ciudad", city)
    if (start) query = query.gte("fecha_hora", `${start}T00:00:00Z`)
    if (end) query = query.lte("fecha_hora", `${end}T23:59:59Z`)
    const { data, error, count } = await query.order("fecha_hora", { ascending: false }).range(page * size, page * size + size - 1)
    if (error) throw error
    return Response.json({ rows: data, count })
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Error de Supabase" }, { status: 503 }) }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { records?: unknown } | null
  if (!Array.isArray(body?.records) || body.records.length < 1 || body.records.length > 500 || !body.records.every(isRecord)) return Response.json({ error: "Lote inválido: se admiten hasta 500 registros válidos." }, { status: 400 })
  const records = body.records as WeatherRecord[]
  try {
    const db = supabaseServer()
    const { error } = await db.from(table).upsert(records, { onConflict: "ciudad,fecha_hora" })
    if (error) throw error
    const cities = [...new Set(records.map((r) => r.ciudad))]
    const { data, error: verificationError } = await db.from(table).select("ciudad,fecha_hora").in("ciudad", cities).in("fecha_hora", records.map((r) => r.fecha_hora))
    if (verificationError) throw verificationError
    const keys = new Set((data ?? []).map((r) => `${r.ciudad}|${r.fecha_hora}`))
    return Response.json({ processed: records.length, verified: records.filter((r) => keys.has(`${r.ciudad}|${r.fecha_hora}`)).length })
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Error de Supabase" }, { status: 503 }) }
}
