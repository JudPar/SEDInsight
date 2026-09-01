begin;

-- Additive monthly-fault architecture. Existing network rows and the global
-- public.suministros_coordenadas master are deliberately never modified.

create table if not exists public.fault_periods (
  period_key text primary key check (period_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  label text not null,
  start_date date not null,
  end_date date not null,
  row_count bigint not null default 0 check (row_count >= 0),
  created_at timestamptz not null default now(),
  created_by uuid not null,
  check (start_date = date_trunc('month', start_date)::date),
  check (end_date = (start_date + interval '1 month' - interval '1 day')::date)
);

alter table public.fallas add column if not exists period_key text;
alter table public.fallas add column if not exists source_record_id text;
alter table public.project_staging_fallas add column if not exists period_key text;
alter table public.project_staging_fallas add column if not exists source_record_id text;

do $$ begin
  alter table public.fallas
    add constraint fallas_period_key_fk foreign key (period_key)
    references public.fault_periods(period_key) on update cascade on delete restrict;
exception when duplicate_object then null;
end $$;

create index if not exists fallas_period_sed_idx on public.fallas(period_key, sed_id);
create index if not exists fallas_period_sed_llave_idx on public.fallas(period_key, sed_id, llave_code);
create unique index if not exists fallas_period_source_record_uidx
  on public.fallas(period_key, source_record_id)
  where period_key is not null and source_record_id is not null;

create table if not exists public.geopluz_work_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 160),
  description text not null default '',
  sed_ids text[] not null default '{}',
  period_keys text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id),
  check (array_position(sed_ids, null) is null),
  check (array_position(period_keys, null) is null)
);

create or replace function public.geopluz_sync_fault_period_row_count()
returns trigger language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if tg_op in ('DELETE', 'UPDATE') and old.period_key is not null then
    update public.fault_periods
      set row_count = greatest(0, row_count - 1)
      where period_key = old.period_key;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.period_key is not null then
    update public.fault_periods
      set row_count = row_count + 1
      where period_key = new.period_key;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists geopluz_sync_fault_period_row_count on public.fallas;
create trigger geopluz_sync_fault_period_row_count
after insert or delete or update of period_key on public.fallas
for each row execute function public.geopluz_sync_fault_period_row_count();

create or replace function public.geopluz_touch_work_project_updated_at()
returns trigger language plpgsql set search_path = pg_catalog
as $$ begin new.updated_at := now(); return new; end; $$;

drop trigger if exists geopluz_touch_work_project_updated_at on public.geopluz_work_projects;
create trigger geopluz_touch_work_project_updated_at
before update on public.geopluz_work_projects
for each row execute function public.geopluz_touch_work_project_updated_at();

revoke all on function public.geopluz_sync_fault_period_row_count() from public, anon, authenticated;
revoke all on function public.geopluz_touch_work_project_updated_at() from public, anon, authenticated;

alter table public.fault_periods enable row level security;
alter table public.geopluz_work_projects enable row level security;

revoke all on table public.fault_periods, public.geopluz_work_projects from public, anon, authenticated;
grant select on table public.fault_periods to authenticated;
grant select, insert, update, delete on table public.geopluz_work_projects to authenticated;

drop policy if exists fault_periods_authenticated_select on public.fault_periods;
create policy fault_periods_authenticated_select on public.fault_periods
  for select to authenticated using (true);

drop policy if exists work_projects_owner_select on public.geopluz_work_projects;
drop policy if exists work_projects_owner_insert on public.geopluz_work_projects;
drop policy if exists work_projects_owner_update on public.geopluz_work_projects;
drop policy if exists work_projects_owner_delete on public.geopluz_work_projects;
create policy work_projects_owner_select on public.geopluz_work_projects for select to authenticated using (owner_id = auth.uid());
create policy work_projects_owner_insert on public.geopluz_work_projects for insert to authenticated with check (owner_id = auth.uid());
create policy work_projects_owner_update on public.geopluz_work_projects for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy work_projects_owner_delete on public.geopluz_work_projects for delete to authenticated using (owner_id = auth.uid());

create or replace function public.geopluz_import_fault_period(
  p_period_key text,
  p_label text,
  p_rows jsonb,
  p_replace boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_start date;
  v_expected bigint;
  v_inserted bigint;
  v_existing bigint;
begin
  if v_user_id is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  if p_period_key !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception using errcode = '22023', message = 'Invalid monthly period'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception using errcode = '22023', message = 'Monthly rows must be a JSON array'; end if;
  if not pg_try_advisory_xact_lock(7142, 20260828) then
    raise exception using errcode = '55P03', message = 'Another GEOPLUZ data operation is in progress';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('geopluz_fault_period:' || p_period_key, 0)) then
    raise exception using errcode = '55P03', message = 'Another operation is using this period';
  end if;

  select count(*) into v_expected from jsonb_array_elements(p_rows);
  if v_expected = 0 then raise exception using errcode = '22023', message = 'The monthly period has no accepted rows'; end if;
  if exists (
    select 1 from jsonb_to_recordset(p_rows) as x(sed_id text)
    left join public.seds s on s.id = x.sed_id where s.id is null
  ) then raise exception using errcode = '23503', message = 'Monthly rows contain SED outside the permanent network'; end if;

  select count(*) into v_existing from public.fallas where period_key = p_period_key;
  if (exists (select 1 from public.fault_periods where period_key = p_period_key) or v_existing > 0) and not p_replace then
    raise exception using errcode = '23505', message = 'Fault period already exists';
  end if;

  if p_replace then delete from public.fallas where period_key = p_period_key; end if;
  v_start := to_date(p_period_key || '-01', 'YYYY-MM-DD');
  insert into public.fault_periods(period_key, label, start_date, end_date, row_count, created_by)
  values (p_period_key, coalesce(nullif(btrim(p_label), ''), p_period_key), v_start, (v_start + interval '1 month' - interval '1 day')::date, 0, v_user_id)
  on conflict (period_key) do update set label = excluded.label, start_date = excluded.start_date, end_date = excluded.end_date, row_count = 0, created_at = now(), created_by = v_user_id;

  insert into public.fallas(
    period_key, source_record_id, sed_id, llave_code, sed_llave, ticket, suministro,
    falla_real, causa, nota, odm, zona, set_alimentador, hora_inicio, latitud,
    longitud, link_croquis, fotos, coord_source, coord_lookup_suministro, created_at
  )
  select p_period_key, x.source_record_id, x.sed_id, x.llave_code, x.sed_llave, x.ticket,
    x.suministro, x.falla_real, x.causa, x.nota, x.odm, x.zona, x.set_alimentador,
    x.hora_inicio, x.latitud, x.longitud, x.link_croquis, coalesce(x.fotos, '[]'::jsonb),
    x.coord_source, x.coord_lookup_suministro, coalesce(x.source_created_at, now())
  from jsonb_to_recordset(p_rows) as x(
    source_record_id text, sed_id text, llave_code text, sed_llave text, ticket text,
    suministro text, falla_real text, causa text, nota text, odm text, zona text,
    set_alimentador text, hora_inicio text, latitud double precision, longitud double precision,
    link_croquis text, fotos jsonb, coord_source text, coord_lookup_suministro text,
    source_created_at timestamptz
  );
  get diagnostics v_inserted = row_count;
  if v_inserted <> v_expected then raise exception using errcode = 'P0001', message = 'Monthly import count mismatch'; end if;
  update public.fault_periods set row_count = v_inserted where period_key = p_period_key;
  return jsonb_build_object('period_key', p_period_key, 'inserted', v_inserted, 'replaced', p_replace, 'previous_rows', v_existing);
end;
$$;

create or replace function public.geopluz_delete_fault_period(p_period_key text, p_expected_rows bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_user_id uuid := auth.uid(); v_current bigint; v_deleted bigint;
begin
  if v_user_id is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  if not pg_try_advisory_xact_lock(7142, 20260828) then
    raise exception using errcode = '55P03', message = 'Another GEOPLUZ data operation is in progress';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('geopluz_fault_period:' || p_period_key, 0)) then
    raise exception using errcode = '55P03', message = 'Another operation is using this period';
  end if;
  select count(*) into v_current from public.fallas where period_key = p_period_key;
  if v_current <> p_expected_rows then raise exception using errcode = '40001', message = 'Period count changed; confirmation must be repeated'; end if;
  delete from public.fallas where period_key = p_period_key;
  get diagnostics v_deleted = row_count;
  delete from public.fault_periods where period_key = p_period_key;
  return jsonb_build_object('period_key', p_period_key, 'deleted', v_deleted);
end;
$$;

-- Preserve monthly identity during the existing complete GEOPLUZ_PROJECT
-- staging/finalization flow. The operation remains one transaction and keeps
-- the global supply master protected by before/after verification.
create or replace function public.geopluz_replace_current_project(
  p_import_id uuid,
  p_expected_current_seds bigint,
  p_expected_current_llaves bigint,
  p_expected_current_fallas bigint
) returns jsonb
language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_import public.project_imports%rowtype;
  v_validation jsonb;
  v_operation text;
  v_old_seds bigint; v_old_llaves bigint; v_old_fallas bigint;
  v_new_seds bigint; v_new_llaves bigint; v_new_fallas bigint;
  v_supply_before bigint; v_supply_after bigint;
begin
  if v_user_id is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  if not pg_try_advisory_xact_lock(7142, 20260828) then raise exception using errcode = '55P03', message = 'Another project operation is in progress'; end if;
  lock table public.seds, public.llaves, public.fallas, public.fault_periods in share row exclusive mode nowait;
  select * into v_import from public.project_imports where import_id = p_import_id and owner_id = v_user_id for update;
  if not found or v_import.status <> 'ready' then raise exception using errcode = 'P0001', message = 'Staging is not ready for replacement'; end if;
  v_validation := public.geopluz_validate_project_staging(p_import_id);
  if coalesce((v_validation ->> 'valid')::boolean, false) is not true then raise exception using errcode = 'P0001', message = 'Staging validation failed'; end if;

  select count(*) into v_old_seds from public.seds;
  select count(*) into v_old_llaves from public.llaves;
  select count(*) into v_old_fallas from public.fallas;
  if v_old_seds <> p_expected_current_seds or v_old_llaves <> p_expected_current_llaves or v_old_fallas <> p_expected_current_fallas then
    raise exception using errcode = '40001', message = 'Current project counts changed; confirmation must be repeated';
  end if;
  v_operation := case when v_old_seds = 0 and v_old_llaves = 0 and v_old_fallas = 0 then 'import' else 'replace' end;
  select count(*) into v_supply_before from public.suministros_coordenadas;

  delete from public.fallas where id is not null;
  delete from public.fault_periods where period_key is not null;
  delete from public.llaves where id is not null;
  delete from public.seds where id is not null;

  insert into public.seds(id, name, sed_coord, created_at)
  select id, name, sed_coord, coalesce(source_created_at, now()) from public.project_staging_seds where import_id = p_import_id;
  insert into public.llaves(sed_id, llave_code, name, lines_data, created_at)
  select sed_id, llave_code, name, lines_data, coalesce(source_created_at, now()) from public.project_staging_llaves where import_id = p_import_id;
  insert into public.fault_periods(period_key, label, start_date, end_date, row_count, created_by)
  select period_key, period_key, to_date(period_key || '-01', 'YYYY-MM-DD'),
    (to_date(period_key || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date,
    0, v_user_id
  from public.project_staging_fallas
  where import_id = p_import_id and period_key is not null
  group by period_key;
  insert into public.fallas(
    period_key, source_record_id, sed_id, llave_code, sed_llave, ticket, suministro,
    falla_real, causa, nota, odm, zona, set_alimentador, hora_inicio, latitud,
    longitud, link_croquis, fotos, coord_source, coord_lookup_suministro, created_at
  ) select
    period_key, source_record_id, sed_id, llave_code, sed_llave, ticket, suministro,
    falla_real, causa, nota, odm, zona, set_alimentador, hora_inicio, latitud,
    longitud, link_croquis, fotos, coord_source, coord_lookup_suministro,
    coalesce(source_created_at, now())
  from public.project_staging_fallas where import_id = p_import_id;

  update public.fault_periods p
  set row_count = counts.row_count
  from (
    select period_key, count(*)::bigint as row_count
    from public.fallas where period_key is not null group by period_key
  ) counts
  where p.period_key = counts.period_key;

  select count(*) into v_new_seds from public.seds;
  select count(*) into v_new_llaves from public.llaves;
  select count(*) into v_new_fallas from public.fallas;
  if v_new_seds <> v_import.expected_seds or v_new_llaves <> v_import.expected_llaves or v_new_fallas <> v_import.expected_fallas then
    raise exception using errcode = 'P0001', message = 'Replacement count verification failed';
  end if;
  select count(*) into v_supply_after from public.suministros_coordenadas;
  if v_supply_after <> v_supply_before then raise exception using errcode = 'P0001', message = 'Global supply master verification failed'; end if;
  insert into public.project_operation_audit(operation, user_id, old_counts, new_counts, project_id, import_id)
  values (v_operation, v_user_id,
    jsonb_build_object('seds', v_old_seds, 'llaves', v_old_llaves, 'fallas', v_old_fallas),
    jsonb_build_object('seds', v_new_seds, 'llaves', v_new_llaves, 'fallas', v_new_fallas),
    v_import.project_id, p_import_id);
  delete from public.project_imports where import_id = p_import_id;
  return jsonb_build_object('success', true, 'operation', v_operation, 'seds', v_new_seds, 'llaves', v_new_llaves, 'fallas', v_new_fallas);
end;
$$;

create or replace function public.geopluz_delete_current_project(
  p_expected_current_seds bigint,
  p_expected_current_llaves bigint,
  p_expected_current_fallas bigint
) returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_old_seds bigint; v_old_llaves bigint; v_old_fallas bigint;
  v_supply_before bigint; v_supply_after bigint;
begin
  if v_user_id is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  if not pg_try_advisory_xact_lock(7142, 20260828) then raise exception using errcode = '55P03', message = 'Another project operation is in progress'; end if;
  lock table public.seds, public.llaves, public.fallas, public.fault_periods in share row exclusive mode nowait;
  select count(*) into v_old_seds from public.seds;
  select count(*) into v_old_llaves from public.llaves;
  select count(*) into v_old_fallas from public.fallas;
  if v_old_seds <> p_expected_current_seds or v_old_llaves <> p_expected_current_llaves or v_old_fallas <> p_expected_current_fallas then
    raise exception using errcode = '40001', message = 'Current project counts changed; confirmation must be repeated';
  end if;
  select count(*) into v_supply_before from public.suministros_coordenadas;
  delete from public.fallas where id is not null;
  delete from public.fault_periods where period_key is not null;
  delete from public.llaves where id is not null;
  delete from public.seds where id is not null;
  if exists (select 1 from public.seds) or exists (select 1 from public.llaves) or exists (select 1 from public.fallas) or exists (select 1 from public.fault_periods) then
    raise exception using errcode = 'P0001', message = 'Project deletion verification failed';
  end if;
  select count(*) into v_supply_after from public.suministros_coordenadas;
  if v_supply_after <> v_supply_before then raise exception using errcode = 'P0001', message = 'Global supply master verification failed'; end if;
  insert into public.project_operation_audit(operation, user_id, old_counts, new_counts, project_id)
  values ('delete', v_user_id,
    jsonb_build_object('seds', v_old_seds, 'llaves', v_old_llaves, 'fallas', v_old_fallas),
    jsonb_build_object('seds', 0, 'llaves', 0, 'fallas', 0), null);
  return jsonb_build_object('success', true, 'seds', 0, 'llaves', 0, 'fallas', 0);
end;
$$;

revoke all on function public.geopluz_import_fault_period(text, text, jsonb, boolean) from public, anon;
revoke all on function public.geopluz_delete_fault_period(text, bigint) from public, anon;
grant execute on function public.geopluz_import_fault_period(text, text, jsonb, boolean) to authenticated;
grant execute on function public.geopluz_delete_fault_period(text, bigint) to authenticated;
revoke all on function public.geopluz_replace_current_project(uuid, bigint, bigint, bigint) from public, anon;
grant execute on function public.geopluz_replace_current_project(uuid, bigint, bigint, bigint) to authenticated;
revoke all on function public.geopluz_delete_current_project(bigint, bigint, bigint) from public, anon;
grant execute on function public.geopluz_delete_current_project(bigint, bigint, bigint) to authenticated;

-- Existing fallas remain with period_key null. Assigning them to a real month requires
-- an explicit user-approved backfill after their source month has been confirmed.

commit;
