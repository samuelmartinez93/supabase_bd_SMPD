create table if not exists public.mediciones_meteorologicas (
  id bigint generated always as identity primary key,
  ciudad text not null,
  fecha_hora timestamptz not null,
  temperatura_c double precision not null,
  humedad_pct double precision not null check (humedad_pct between 0 and 100),
  precipitacion_mm double precision not null check (precipitacion_mm >= 0),
  importado_en timestamptz not null default now(),
  unique (ciudad, fecha_hora)
);
alter table public.mediciones_meteorologicas enable row level security;
revoke all on public.mediciones_meteorologicas from anon, authenticated;
