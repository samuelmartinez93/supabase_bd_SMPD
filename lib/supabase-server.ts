import "server-only"
import { createClient } from "@supabase/supabase-js"

export function supabaseServer() {
  // La URL del proyecto es pública; admitimos el nombre estándar de los
  // quickstarts de Supabase para facilitar la configuración existente.
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Faltan la URL de Supabase o SUPABASE_SECRET_KEY en el servidor.")
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}
