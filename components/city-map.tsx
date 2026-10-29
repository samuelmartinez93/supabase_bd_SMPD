"use client"

import { useEffect, useRef, useState } from "react"
import type { Map as LeafletMap, Marker, Path } from "leaflet"
import "leaflet/dist/leaflet.css"
import { CITIES } from "@/lib/weather"
import { cityColor } from "@/components/charts"

// Mapas base sin clave de API. Si uno falla (caído o bloqueado por un bloqueador de anuncios), se prueba el siguiente.
const BASEMAPS = [
  { url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", attribution: 'Mapa &copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, &copy; OpenStreetMap' },
  { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
]
const FAILS_BEFORE_SWITCH = 4
// Siluetas simplificadas de las comunidades autónomas (public/data/ccaa.json, ~65 KB).
const REGIONS_URL = "/data/ccaa.json"
// Código de comunidad autónoma (INE) → ciudad disponible en ella.
const CITY_OF_REGION: Record<string, string> = { "09": "barcelona", "13": "madrid", "01": "sevilla", "16": "bilbao", "10": "valencia" }

const pin = (nombre: string, on: boolean) =>
  `<span class="city-pin" data-on="${on}" style="--pin:${cityColor(nombre)}"><span class="city-pin-dot">${on ? "✓" : ""}</span><span class="city-pin-label">${nombre}</span></span>`

type Status = "cargando" | "ok" | "sin-fondo" | "error"

/** Mapa de España con las ciudades disponibles; clic en una ciudad o en su comunidad = añadirla o quitarla. */
export function CityMap({ selected, onToggle }: { selected: string[]; onToggle: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<LeafletMap | null>(null)
  const markers = useRef(new Map<string, Marker>())
  const regions = useRef(new Map<string, Path>())
  const toggle = useRef(onToggle)
  const latest = useRef(selected)
  const [status, setStatus] = useState<Status>("cargando")
  useEffect(() => { toggle.current = onToggle; latest.current = selected })

  // Leaflet necesita `window`: se carga solo en el navegador.
  useEffect(() => {
    let cancelled = false
    const pins = markers.current
    const areas = regions.current
    let resize: ResizeObserver | undefined
    import("leaflet").then((L) => {
      if (cancelled || !box.current || map.current) return
      const m = L.map(box.current, { zoomControl: true, scrollWheelZoom: false })
      // Capa base con reserva: tras varios fallos de carga se cambia al siguiente proveedor.
      const addBasemap = (i: number) => {
        if (i >= BASEMAPS.length) return setStatus("sin-fondo")
        let fails = 0
        const layer = L.tileLayer(BASEMAPS[i].url, { attribution: BASEMAPS[i].attribution, maxZoom: 10, minZoom: 4 })
        layer.on("tileload", () => setStatus("ok"))
        layer.on("tileerror", () => {
          if (++fails !== FAILS_BEFORE_SWITCH) return
          m.removeLayer(layer)
          addBasemap(i + 1)
        })
        layer.addTo(m)
      }
      addBasemap(0)
      // Comunidades autónomas: la de cada ciudad se colorea al seleccionarla y queda tenue si no.
      fetch(REGIONS_URL).then((r) => r.json()).then((geo) => {
        if (cancelled) return
        L.geoJSON(geo, {
          style: { weight: 1 },
          onEachFeature: (feature, layer) => {
            const cityId = CITY_OF_REGION[feature.properties.cod]
            const path = layer as Path
            // La clase se fija antes de añadir la capa: Leaflet la aplica al crear el <path>.
            path.options.className = cityId ? `region region-city region-${cityId}` : "region"
            path.options.interactive = Boolean(cityId)
            if (!cityId) return
            path.bindTooltip(`${feature.properties.nombre} · ${CITIES.find((c) => c.id === cityId)?.nombre}`, { sticky: true, direction: "top" })
            path.on("click", () => toggle.current(cityId))
            areas.set(cityId, path)
          },
        }).addTo(m)
        for (const [id, path] of areas) path.getElement()?.classList.toggle("is-on", latest.current.includes(id))
      }).catch(() => { /* sin siluetas: el mapa sigue funcionando con las chinchetas */ })
      for (const c of CITIES) {
        const marker = L.marker([c.latitud, c.longitud], {
          icon: L.divIcon({ className: "city-pin-wrap", html: pin(c.nombre, latest.current.includes(c.id)), iconSize: [0, 0] }),
          keyboard: true,
          title: c.nombre,
        }).addTo(m)
        marker.on("click", () => toggle.current(c.id))
        pins.set(c.id, marker)
      }
      const fit = () => m.fitBounds(L.latLngBounds(CITIES.map((c) => [c.latitud, c.longitud])), { paddingTopLeft: [24, 32], paddingBottomRight: [Math.min(110, m.getSize().x * 0.2), 32] }) // a la derecha cabe el nombre
      fit()
      // Si el contenedor cambia de tamaño (o se pintó antes de tener tamaño), Leaflet debe recalcular.
      resize = new ResizeObserver(() => { m.invalidateSize(); fit() })
      resize.observe(box.current)
      map.current = m
    }).catch(() => !cancelled && setStatus("error"))
    return () => {
      cancelled = true
      resize?.disconnect()
      map.current?.remove()
      map.current = null
      pins.clear()
      areas.clear()
    }
  }, [])

  // Actualiza el aspecto de cada chincheta al cambiar la selección.
  useEffect(() => {
    void import("leaflet").then((L) => {
      for (const c of CITIES) {
        regions.current.get(c.id)?.getElement()?.classList.toggle("is-on", selected.includes(c.id))
        markers.current.get(c.id)?.setIcon(L.divIcon({ className: "city-pin-wrap", html: pin(c.nombre, selected.includes(c.id)), iconSize: [0, 0] }))
      }
    })
  }, [selected])

  return (
    <div className="city-map-wrap">
      <div ref={box} className="city-map" role="application" aria-label="Mapa de ciudades disponibles. Pulsa una ciudad para añadirla o quitarla." />
      {status === "cargando" && <p className="city-map-msg">Cargando mapa…</p>}
      {(status === "sin-fondo" || status === "error") && (
        <p className="city-map-msg" role="status">
          {status === "error" ? "No se ha podido cargar el mapa." : "No se ha podido cargar el fondo del mapa."} Puede que lo bloquee un bloqueador de anuncios o la red.
          Puedes elegir las ciudades igualmente con los botones de abajo.
        </p>
      )}
    </div>
  )
}
