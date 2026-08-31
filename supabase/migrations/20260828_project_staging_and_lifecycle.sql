begin;

-- GEOPLUZ project lifecycle. Only public.seds, public.llaves and public.fallas
-- are project data. public.suministros_coordenadas is deliberately never written.

grant delete on table public.seds, public.llaves, public.fallas to authenticated;

drop policy if exists geopluz_authenticated_delete on public.seds;
create policy geopluz_authenticated_delete
  on public.seds for delete to authenticated using (true);

drop policy if exists geopluz_authenticated_delete on public.llaves;
create policy geopluz_authenticated_delete
  on public.llaves for delete to authenticated using (true);

drop policy if exists geopluz_authenticated_delete on public.fallas;
create policy geopluz_authenticated_delete
  on public.fallas for delete to authenticated using (true);

create table public.project_imports (
  import_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  project_id text not null,
  project_name text not null,
  checksum text,
  expected_seds bigint not null check (expected_seds >= 0),
  expected_llaves bigint not null check (expected_llaves >= 0),
  expected_fallas bigint not null check (expected_fallas >= 0),
  status text not null default 'loading' check (status in ('loading', 'ready', 'failed')),
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  unique (import_id, owner_id)
);

create table public.project_staging_seds (
  import_id uuid not null,
  owner_id uuid not null,
  id text not null,
  name text,
  sed_coord jsonb,
  source_created_at timestamptz,
  primary key (import_id, id),
  foreign key (import_id, owner_id) references public.project_imports(import_id, owner_id) on delete cascade,
  check (sed_coord is null or (jsonb_typeof(sed_coord) = 'array' and jsonb_array_length(sed_coord) >= 2))
);

create table public.project_staging_llaves (
  import_id uuid not null,
  owner_id uuid not null,
  source_id bigint,
  sed_id text not null,
  llave_code text not null,
  name text,
  lines_data jsonb not null default '[]'::jsonb,
  source_created_at timestamptz,
  primary key (import_id, sed_id, llave_code),
  foreign key (import_id, owner_id) references public.project_imports(import_id, owner_id) on delete cascade,
  foreign key (import_id, sed_id) references public.project_staging_seds(import_id, id) on delete cascade,
  check (jsonb_typeof(lines_data) = 'array')
);

create table public.project_staging_fallas (
  import_id uuid not null,
  owner_id uuid not null,
  record_ref text not null,
  source_id bigint,
  relation jsonb not null,
  sed_id text,
  llave_code text,
  sed_llave text,
  ticket text,
  suministro text,
  falla_real text,
  causa text,
  nota text,
  odm text,
  zona text,
  set_alimentador text,
  hora_inicio text,
  latitud double precision,
  longitud double precision,
  link_croquis text,
  fotos jsonb not null default '[]'::jsonb,
  coord_source text,
  coord_lookup_suministro text,
  source_created_at timestamptz,
  primary key (import_id, record_ref),
  foreign key (import_id, owner_id) references public.project_imports(import_id, owner_id) on delete cascade,
  check (jsonb_typeof(relation) = 'object'),
  check (jsonb_typeof(fotos) = 'array'),
  check ((latitud is null and longitud is null) or (latitud between -90 and 90 and longitud between -180 and 180)),
  check (coord_source is null or coord_source in ('ORIGINAL', 'SUMINISTRO_LOOKUP', 'MANUAL'))
);

create index project_imports_created_at_idx on public.project_imports(created_at);
create index project_staging_llaves_import_idx on public.project_staging_llaves(import_id);
create index project_staging_fallas_import_idx on public.project_staging_fallas(import_id);

create table public.project_operation_audit (
  audit_id bigint generated always as identity primary key,
  operation text not null check (operation in ('replace', 'delete')),
  user_id uuid not null,
  occurred_at timestamptz not null default now(),
  old_counts jsonb not null,
  new_counts jsonb not null,
  project_id text,
  import_id uuid
);

alter table public.project_imports enable row level security;
alter table public.project_staging_seds enable row level security;
alter table public.project_staging_llaves enable row level security;
alter table public.project_staging_fallas enable row level security;
alter table public.project_operation_audit enable row level security;

revoke all on table public.project_imports, public.project_staging_seds, public.project_staging_llaves, public.project_staging_fallas, public.project_operation_audit from public, anon, authenticated;
grant select, insert, delete on table public.project_imports, public.project_staging_seds, public.project_staging_llaves, public.project_staging_fallas to authenticated;
grant select on table public.project_operation_audit to authenticated;

create policy project_imports_owner_select on public.project_imports for select to authenticated using (owner_id = auth.uid());
create policy project_imports_owner_insert on public.project_imports for insert to authenticated with check (owner_id = auth.uid());
create policy project_imports_owner_delete on public.project_imports for delete to authenticated using (owner_id = auth.uid());

create policy project_staging_seds_owner_select on public.project_staging_seds for select to authenticated using (owner_id = auth.uid());
create policy project_staging_seds_owner_insert on public.project_staging_seds for insert to authenticated with check (owner_id = auth.uid());
create policy project_staging_seds_owner_delete on public.project_staging_seds for delete to authenticated using (owner_id = auth.uid());

create policy project_staging_llaves_owner_select on public.project_staging_llaves for select to authenticated using (owner_id = auth.uid());
create policy project_staging_llaves_owner_insert on public.project_staging_llaves for insert to authenticated with check (owner_id = auth.uid());
create policy project_staging_llaves_owner_delete on public.project_staging_llaves for delete to authenticated using (owner_id = auth.uid());

create policy project_staging_fallas_owner_select on public.project_staging_fallas for select to authenticated using (owner_id = auth.uid());
create policy project_staging_fallas_owner_insert on public.project_staging_fallas for insert to authenticated with check (owner_id = auth.uid());
create policy project_staging_fallas_owner_delete on public.project_staging_fallas for delete to authenticated using (owner_id = auth.uid());

create policy project_operation_audit_owner_select on public.project_operation_audit for select to authenticated using (user_id = auth.uid());

create or replace function public.geopluz_validate_project_staging(p_import_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_import public.project_imports%rowtype;
  v_seds bigint;
  v_llaves bigint;
  v_fallas bigint;
  v_error text;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  select * into v_import
  from public.project_imports
  where import_id = p_import_id and owner_id = v_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Staging import not found';
  end if;

  select count(*) into v_seds from public.project_staging_seds where import_id = p_import_id and owner_id = v_user_id;
  select count(*) into v_llaves from public.project_staging_llaves where import_id = p_import_id and owner_id = v_user_id;
  select count(*) into v_fallas from public.project_staging_fallas where import_id = p_import_id and owner_id = v_user_id;

  if v_seds <> v_import.expected_seds or v_llaves <> v_import.expected_llaves or v_fallas <> v_import.expected_fallas then
    v_error := 'Staging counts do not match the project manifest';
  elsif exists (
    select 1 from public.project_staging_llaves
    where import_id = p_import_id and jsonb_typeof(lines_data) <> 'array'
  ) then
    v_error := 'Invalid lines_data in staging';
  elsif exists (
    select 1
    from public.project_staging_fallas f
    where f.import_id = p_import_id
      and (
        coalesce(f.relation ->> 'status', '') not in ('resolved', 'unresolved')
        or (
          f.relation ->> 'status' = 'resolved'
          and not exists (
            select 1 from public.project_staging_llaves l
            where l.import_id = f.import_id and l.sed_id = f.sed_id and l.llave_code = f.llave_code
          )
        )
      )
  ) then
    v_error := 'Invalid declared relations in staging';
  end if;

  if v_error is not null then
    update public.project_imports set status = 'failed', validated_at = now() where import_id = p_import_id;
    return jsonb_build_object('valid', false, 'error', v_error, 'seds', v_seds, 'llaves', v_llaves, 'fallas', v_fallas);
  end if;

  update public.project_imports set status = 'ready', validated_at = now() where import_id = p_import_id;
  return jsonb_build_object('valid', true, 'status', 'ready', 'seds', v_seds, 'llaves', v_llaves, 'fallas', v_fallas);
end;
$$;

create or replace function public.geopluz_discard_project_staging(p_import_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  v_deleted bigint;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  delete from public.project_imports where import_id = p_import_id and owner_id = auth.uid();
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

create or replace function public.geopluz_replace_current_project(
  p_import_id uuid,
  p_expected_current_seds bigint,
  p_expected_current_llaves bigint,
  p_expected_current_fallas bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_import public.project_imports%rowtype;
  v_validation jsonb;
  v_old_seds bigint;
  v_old_llaves bigint;
  v_old_fallas bigint;
  v_new_seds bigint;
  v_new_llaves bigint;
  v_new_fallas bigint;
  v_supply_before bigint;
  v_supply_after bigint;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if not pg_try_advisory_xact_lock(7142, 20260828) then
    raise exception using errcode = '55P03', message = 'Another project operation is in progress';
  end if;
  lock table public.seds, public.llaves, public.fallas in share row exclusive mode nowait;

  select * into v_import
  from public.project_imports
  where import_id = p_import_id and owner_id = v_user_id
  for update;
  if not found or v_import.status <> 'ready' then
    raise exception using errcode = 'P0001', message = 'Staging is not ready for replacement';
  end if;

  v_validation := public.geopluz_validate_project_staging(p_import_id);
  if coalesce((v_validation ->> 'valid')::boolean, false) is not true then
    raise exception using errcode = 'P0001', message = 'Staging validation failed';
  end if;

  select count(*) into v_old_seds from public.seds;
  select count(*) into v_old_llaves from public.llaves;
  select count(*) into v_old_fallas from public.fallas;
  if v_old_seds <> p_expected_current_seds or v_old_llaves <> p_expected_current_llaves or v_old_fallas <> p_expected_current_fallas then
    raise exception using errcode = '40001', message = 'Current project counts changed; confirmation must be repeated';
  end if;
  select count(*) into v_supply_before from public.suministros_coordenadas;

  delete from public.fallas;
  delete from public.llaves;
  delete from public.seds;

  insert into public.seds(id, name, sed_coord, created_at)
  select id, name, sed_coord, coalesce(source_created_at, now())
  from public.project_staging_seds where import_id = p_import_id;

  -- Numeric source IDs are metadata only. Omitting id lets each existing default
  -- advance its sequence; sequences are never moved backwards during rollback.
  insert into public.llaves(sed_id, llave_code, name, lines_data, created_at)
  select sed_id, llave_code, name, lines_data, coalesce(source_created_at, now())
  from public.project_staging_llaves where import_id = p_import_id;

  insert into public.fallas(
    sed_id, llave_code, sed_llave, ticket, suministro, falla_real, causa, nota, odm, zona,
    set_alimentador, hora_inicio, latitud, longitud, link_croquis, fotos,
    coord_source, coord_lookup_suministro, created_at
  )
  select
    sed_id, llave_code, sed_llave, ticket, suministro, falla_real, causa, nota, odm, zona,
    set_alimentador, hora_inicio, latitud, longitud, link_croquis, fotos,
    coord_source, coord_lookup_suministro, coalesce(source_created_at, now())
  from public.project_staging_fallas where import_id = p_import_id;

  select count(*) into v_new_seds from public.seds;
  select count(*) into v_new_llaves from public.llaves;
  select count(*) into v_new_fallas from public.fallas;
  if v_new_seds <> v_import.expected_seds or v_new_llaves <> v_import.expected_llaves or v_new_fallas <> v_import.expected_fallas then
    raise exception using errcode = 'P0001', message = 'Replacement count verification failed';
  end if;

  select count(*) into v_supply_after from public.suministros_coordenadas;
  if v_supply_after <> v_supply_before then
    raise exception using errcode = 'P0001', message = 'Global supply master verification failed';
  end if;

  insert into public.project_operation_audit(operation, user_id, old_counts, new_counts, project_id, import_id)
  values (
    'replace', v_user_id,
    jsonb_build_object('seds', v_old_seds, 'llaves', v_old_llaves, 'fallas', v_old_fallas),
    jsonb_build_object('seds', v_new_seds, 'llaves', v_new_llaves, 'fallas', v_new_fallas),
    v_import.project_id, p_import_id
  );

  delete from public.project_imports where import_id = p_import_id;
  return jsonb_build_object('success', true, 'seds', v_new_seds, 'llaves', v_new_llaves, 'fallas', v_new_fallas);
end;
$$;

create or replace function public.geopluz_delete_current_project(
  p_expected_current_seds bigint,
  p_expected_current_llaves bigint,
  p_expected_current_fallas bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_old_seds bigint;
  v_old_llaves bigint;
  v_old_fallas bigint;
  v_supply_before bigint;
  v_supply_after bigint;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if not pg_try_advisory_xact_lock(7142, 20260828) then
    raise exception using errcode = '55P03', message = 'Another project operation is in progress';
  end if;
  lock table public.seds, public.llaves, public.fallas in share row exclusive mode nowait;

  select count(*) into v_old_seds from public.seds;
  select count(*) into v_old_llaves from public.llaves;
  select count(*) into v_old_fallas from public.fallas;
  if v_old_seds <> p_expected_current_seds or v_old_llaves <> p_expected_current_llaves or v_old_fallas <> p_expected_current_fallas then
    raise exception using errcode = '40001', message = 'Current project counts changed; confirmation must be repeated';
  end if;
  select count(*) into v_supply_before from public.suministros_coordenadas;

  delete from public.fallas;
  delete from public.llaves;
  delete from public.seds;

  if exists (select 1 from public.seds) or exists (select 1 from public.llaves) or exists (select 1 from public.fallas) then
    raise exception using errcode = 'P0001', message = 'Project deletion verification failed';
  end if;

  select count(*) into v_supply_after from public.suministros_coordenadas;
  if v_supply_after <> v_supply_before then
    raise exception using errcode = 'P0001', message = 'Global supply master verification failed';
  end if;

  insert into public.project_operation_audit(operation, user_id, old_counts, new_counts, project_id)
  values (
    'delete', v_user_id,
    jsonb_build_object('seds', v_old_seds, 'llaves', v_old_llaves, 'fallas', v_old_fallas),
    jsonb_build_object('seds', 0, 'llaves', 0, 'fallas', 0),
    null
  );

  return jsonb_build_object('success', true, 'seds', 0, 'llaves', 0, 'fallas', 0);
end;
$$;

revoke all on function public.geopluz_validate_project_staging(uuid) from public, anon;
revoke all on function public.geopluz_discard_project_staging(uuid) from public, anon;
revoke all on function public.geopluz_replace_current_project(uuid, bigint, bigint, bigint) from public, anon;
revoke all on function public.geopluz_delete_current_project(bigint, bigint, bigint) from public, anon;

grant execute on function public.geopluz_validate_project_staging(uuid) to authenticated;
grant execute on function public.geopluz_discard_project_staging(uuid) to authenticated;
grant execute on function public.geopluz_replace_current_project(uuid, bigint, bigint, bigint) to authenticated;
grant execute on function public.geopluz_delete_current_project(bigint, bigint, bigint) to authenticated;

commit;
