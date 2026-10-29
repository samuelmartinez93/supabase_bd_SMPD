# Alumno y curso: Samuel Martínez - DAW 2
# El tiempo en tus ciudades · Pipeline ETL Open-Meteo → Supabase

Práctica DAW 2, dashboard para Big Data: una aplicación web para **ejecutar y entender un pipeline ETL**. Extrae el tiempo horario de cinco ciudades españolas desde la API histórica de Open-Meteo, lo transforma, lo limpia, permite filtrarlo y seleccionarlo, y lo carga en Supabase. Cada fase muestra su estado, sus registros de entrada y salida y su duración real, y su resultado se puede inspeccionar.

**Stack:** Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · shadcn/ui · Leaflet · Supabase.

## Instalación y configuración

1. `npm install`
2. Copia `.env.example` a `.env.local` y rellena:
   - `SUPABASE_URL`: URL del proyecto (Project Settings → Data API).
   - `SUPABASE_SECRET_KEY`: clave secreta (`sb_secret_…`) o `service_role`. **Solo servidor**: nunca con prefijo `NEXT_PUBLIC_` ni en GitHub (`.env*` está en `.gitignore`).
3. En el SQL Editor de Supabase, ejecuta la migración `supabase/migrations/20261027000000_create_mediciones_meteorologicas.sql`.
4. En Vercel, las mismas dos variables van en Settings → Environment Variables.

## Ejecución

| Comando | Para qué |
|---|---|
| `npm run dev` | Servidor de desarrollo en http://localhost:3000 |
| `npm run verify` | Pruebas del pipeline (necesita `npm run dev` en marcha) |
| `npm run typecheck` · `npm run lint` · `npm run build` | Tipos, lint y build de producción |

## Cómo se usa: 3 pasos

1. **Elige ciudades y días.** Marca las ciudades en el mapa (o con los botones) y elige un periodo de hasta 31 días. Se muestra el volumen previsto antes de pulsar «Extraer datos».
2. **Revisa y guarda.** Muestra los contadores, el pipeline fase a fase, un gráfico y las pestañas de inspección. Los filtros son opcionales. Se termina con «Subir N registros a Supabase».
3. **Explora los resultados.** Incluye récords y ejemplos, gráficos, la lectura real de «Datos en Supabase», la pestaña «Cómo funciona (ETL)» y la descarga en CSV.

## El pipeline

| Fase | Qué hace | Código |
|---|---|---|
| **Extracción** | Una petición a `archive-api.open-meteo.com/v1/archive` por ciudad, con `temperature_2m`, `relative_humidity_2m` y `precipitation`, en UTC, °C y mm. Máximo 31 días. Si una ciudad falla, se reintenta solo esa. | `app/api/extract/route.ts` |
| **Transformación** | Convierte los arrays paralelos de `hourly` en una fila por ciudad y hora, sin tocar los valores. Comprueba que los arrays tienen la misma longitud. | `lib/weather.ts` → `toRows` |
| **Limpieza** | Interpreta las fechas como UTC y rechaza, con su motivo: null, vacíos, valores no numéricos o no finitos, humedad fuera de 0–100, precipitación negativa y duplicados por `ciudad + fecha_hora` (se conserva la **primera** fila). **Un null nunca se convierte en 0** y no hay umbrales de temperatura. | `lib/weather.ts` → `cleanRows` |
| **Filtrado y selección** | Orden fijo: válidos → filtros (ciudad, fecha y hora, rangos, «solo con lluvia») → ordenación → selección. La paginación solo afecta a lo que se ve. Solo se suben las filas seleccionadas que siguen cumpliendo los filtros. | `lib/pipeline.ts` |
| **Carga** | Congela una copia del conjunto y su orden. Envía lotes de 500 como máximo, de uno en uno, con *upsert* por `(ciudad, fecha_hora)`. Después verifica en Supabase que cada clave existe y permite reintentar solo los lotes fallidos. | `app/api/supabase/route.ts` · `runUpload` |

La migración crea `mediciones_meteorologicas` con:
- `id` como identidad.
- Restricción `UNIQUE (ciudad, fecha_hora)`.
- `CHECK` de humedad (0–100) y precipitación (≥ 0).
- `importado_en` con valor por defecto `now()`.
- **RLS activado** y sin políticas públicas.

## Cómo se ha construido (ruta seguida)

1. **Base funcional.** Pipeline ETL completo con dashboard, conexión a Supabase y verificación de claves tras la carga.
2. **Identidad visual.** Paleta *Lime Cream → Yale Blue*, fondo degradado y barra superior fija a todo el ancho con el progreso del pipeline.
3. **Simplificación para cualquier usuario.** El dashboard pasa a un asistente de **3 pasos con 3 botones**:
   - Lenguaje llano y una explicación en cada paso.
   - Los filtros y la selección fila a fila quedan como opciones avanzadas.
4. **Mapa interactivo.** Selección de ciudades sobre un mapa:
   - Se usa Leaflet, el motor en el que se basa *leafmap*, que es una librería de Python y no puede usarse en una web.
   - Mapa base de Esri, con OpenStreetMap como reserva si falla.
   - Siluetas de las comunidades autónomas: con color si su ciudad está seleccionada y tenues si no.
5. **Presentación.**
   - Introducción, pie de página y favicon propios.
   - Tipografía Plus Jakarta Sans.
   - Tarjetas de pasos en el contenido y barra superior discreta.
   - Botón flotante de modo claro/noche.
6. **Usabilidad y accesibilidad.**
   - Exportación a CSV.
   - Límite de fechas: el histórico tiene unos 5 días de retraso.
   - Confirmación al empezar de nuevo.
   - Foco y avisos para lectores de pantalla en cada cambio de paso.
   - Estados con icono y texto, nunca solo color.
   - Colores de las ciudades validados para daltonismo.
7. **Toque moderno.**
   - Contenedores de cristal esmerilado (*glassmorphism*) con borde y sombra en relieve.
   - Fondo animado y desenfocado: bandas, manchas y olas que avanzan en diagonal.
   - Si el sistema pide reducir movimiento, la animación se para.
8. **Auditoría contra el enunciado.** Se recuperaron requisitos perdidos al simplificar:
   - Las 5 pestañas de inspección y la vista previa exacta, con la nota sobre `ORDER BY`.
   - Los filtros de ciudad y de fecha y hora.
   - «Vaciar selección» y el aviso de seleccionadas fuera de filtros.
   - Los 5 contadores obligatorios, la duración por fase y el estado por lote.
   - La validación del tamaño de la petición.
   - Además, la lógica se extrajo a funciones puras para probarla.

**Decisión de diseño:** tras extraer, todas las filas válidas quedan seleccionadas, para que el flujo básico sea de 3 clics. Cambiar filtros nunca selecciona filas por sí solo, y al reintentar una ciudad se respeta la selección del resto.

## Seguridad

- La escritura en Supabase solo ocurre en el servidor (`lib/supabase-server.ts` usa `server-only`). La clave secreta nunca llega al navegador.
- El servidor vuelve a validar cada registro, el máximo de 500 por lote y el tamaño de la petición (256 KB).
- No se imprimen credenciales en los logs.

## Resumen de lo construido

- **Interfaz:** asistente de 3 pasos.
  - Mapa con siluetas de las comunidades autónomas.
  - Pipeline visual con estados, contadores y duraciones reales.
  - 5 pestañas de inspección paginadas: vista previa, válidos, transformados, rechazados y JSON por ciudad.
  - Filtros, ordenación y selección.
  - Carga por lotes con informe y reintento.
  - Lectura del destino.
  - Resultados con récords, gráficos y CSV.
  - Modo claro y noche.
- **Servidor:**
  - `/api/extract`: llama a Open-Meteo y valida ciudad y periodo.
  - `/api/supabase`: *upsert* validado y verificación de claves; consulta paginada con filtros y ordenación.
- **Datos:** migración SQL con restricciones y RLS, y `.env.example` sin valores reales.

## Pruebas realizadas

`npm run verify` usa fixtures controlados en `tests/fixtures/` (null, vacíos, fuera de rango, fechas inválidas, duplicados, arrays desiguales), que no se mezclan con las extracciones reales, más una extracción real.

| # | Prueba | Resultado |
|---|---|---|
| 1 | 1 ciudad × 1 día en Open-Meteo real | ✔ 24 registros horarios, de 00:00Z a 23:00Z |
| 2 | Arrays paralelos → filas | ✔ Si los arrays tienen distinta longitud, da error y 0 filas |
| 3 | null sin convertir en 0 | ✔ 9 filas → 2 válidas y 7 rechazadas con su motivo; la temperatura extrema se conserva |
| 4 | Duplicados | ✔ Detectados; se conserva la primera fila |
| 5 | Filtros y orden antes de paginar | ✔ |
| 6 | Selección entre páginas | ✔ |
| 7 | Vista previa = datos enviados | ✔ Mismo orden, lotes ≤ 500, copia congelada |
| 8 | Segunda carga sin duplicados | ⏳ Pendiente (necesita Supabase) |
| 9 | Fallo parcial de carga | ✔ Con servidor simulado · ⏳ contra Supabase real |
| 10 | Build y tipos | ✔ `build`, `typecheck` y `lint` sin errores |
| — | Validación en servidor | ✔ Rechaza humedad del 150 %, más de 500 registros y cuerpos de más de 256 KB |

También se ha revisado la interfaz en el navegador, en escritorio y en móvil, en modo claro y en modo noche.

## Bloqueos y pendientes

- **Integración con Supabase (pruebas 8 y 9 contra la base real).** En local no hay credenciales. Hay que comprobarlo en Vercel o con `.env.local` y ejecutar `VERIFY_SUPABASE=1 npm run verify`. Esta prueba escribe 3 filas de prueba con la ciudad «Prueba verificación» y el año 2000.
- **Sin autenticación.** Los endpoints quedan abiertos, lo que vale para la práctica y para desarrollo. Antes de un uso público hay que protegerlos (Supabase Auth o la protección por contraseña de Vercel).
- **Fechas recientes.** Open-Meteo publica el histórico con unos 5 días de retraso. El periodo inicial (septiembre de 2026) ya está disponible, y la interfaz no deja elegir días más recientes.
- **Dependencias externas del mapa.** El fondo del mapa viene de Esri u OpenStreetMap. Si una red o un bloqueador los impide, el mapa avisa y las ciudades se siguen eligiendo con los botones. Las siluetas de las comunidades autónomas están incluidas en el proyecto (`public/data/ccaa.json`, simplificadas a partir de *click_that_hood*).
- **Rendimiento.** El efecto cristal y el fondo animado son ligeros, pero en equipos muy antiguos podrían ir justos.
