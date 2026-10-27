# Laboratorio ETL meteorológico

Aplicación didáctica en Next.js que extrae observaciones horarias de Open-Meteo, las transforma y valida, permite filtrarlas/seleccionarlas y las carga desde rutas de servidor en Supabase.

## Inicio

1. Ejecuta `npm install`.
2. Copia `.env.example` a `.env.local` y añade `SUPABASE_URL` y `SUPABASE_SECRET_KEY`. Nunca publiques la clave secreta ni la prefijes como `NEXT_PUBLIC_`.
3. Ejecuta `supabase/migrations/20261027000000_create_mediciones_meteorologicas.sql` en el SQL Editor de Supabase.
4. Inicia con `npm run dev`.

La tabla mantiene RLS activo y no crea políticas públicas. El endpoint queda habilitado para desarrollo local porque el proyecto no incorpora autenticación; protégelo antes de publicarlo.

## Pipeline

Open-Meteo archive (UTC) → arrays paralelos a filas → validación, rechazos y deduplicación (se conserva la primera fila) → filtros, orden y selección → upsert por `(ciudad, fecha_hora)` en lotes de 500 → verificación de claves en destino.

El periodo debe ser histórico y de un máximo de 31 días. La interfaz inicialmente propone septiembre de 2026 como ejercicio, pero debe cambiarse a una fecha disponible. Sin credenciales se pueden comprobar extracción, transformación, limpieza, filtros y selección; la integración con Supabase queda pendiente.
"# supabase_bd_SMPD" 
