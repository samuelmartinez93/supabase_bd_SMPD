import { CITIES } from "@/lib/weather"

export const runtime = "nodejs"
export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { cityId?: string; start?: string; end?: string } | null
  const city = CITIES.find((c) => c.id === body?.cityId)
  if (!city || !body?.start || !body.end) return Response.json({ error: "Parámetros de extracción no válidos." }, { status: 400 })
  const start = new Date(`${body.start}T00:00:00Z`), end = new Date(`${body.end}T00:00:00Z`)
  const days = (end.getTime() - start.getTime()) / 86_400_000 + 1
  if (Number.isNaN(start.getTime()) || days < 1 || days > 31) return Response.json({ error: "El periodo debe tener entre 1 y 31 días." }, { status: 400 })
  const url = new URL("https://archive-api.open-meteo.com/v1/archive")
  url.search = new URLSearchParams({ latitude: String(city.latitud), longitude: String(city.longitud), start_date: body.start, end_date: body.end, hourly: "temperature_2m,relative_humidity_2m,precipitation", timezone: "UTC", temperature_unit: "celsius", precipitation_unit: "mm" }).toString()
  try {
    const response = await fetch(url, { cache: "no-store" })
    if (!response.ok) return Response.json({ error: `Open-Meteo respondió ${response.status}.` }, { status: 502 })
    return Response.json({ city, raw: await response.json() })
  } catch { return Response.json({ error: "No fue posible conectar con Open-Meteo." }, { status: 502 }) }
}
