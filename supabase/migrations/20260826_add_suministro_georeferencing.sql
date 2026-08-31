begin;

create table if not exists public.suministros_coordenadas (
  suministro text primary key,
  latitud double precision not null,
  longitud double precision not null,
  source text not null default 'MAESTRO',
  updated_at timestamp with time zone not null default now(),
  constraint suministros_coordenadas_latitud_check
    check (latitud between -90 and 90),
  constraint suministros_coordenadas_longitud_check
    check (longitud between -180 and 180),
  constraint suministros_coordenadas_source_check
    check (source in ('MAESTRO', 'OPERATIVO', 'VALIDADO'))
);

alter table public.fallas
  add column if not exists coord_source text,
  add column if not exists coord_lookup_suministro text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.fallas'::regclass
      and conname = 'fallas_coord_source_check'
  ) then
    alter table public.fallas
      add constraint fallas_coord_source_check
      check (coord_source in ('ORIGINAL', 'SUMINISTRO_LOOKUP', 'MANUAL'));
  end if;
end
$$;

alter table public.suministros_coordenadas enable row level security;

revoke all on table public.suministros_coordenadas from public;
revoke all on table public.suministros_coordenadas from anon;
revoke all on table public.suministros_coordenadas from authenticated;
grant select on table public.suministros_coordenadas to authenticated;

drop policy if exists geopluz_authenticated_select on public.suministros_coordenadas;
create policy geopluz_authenticated_select
  on public.suministros_coordenadas
  for select
  to authenticated
  using (true);

commit;
