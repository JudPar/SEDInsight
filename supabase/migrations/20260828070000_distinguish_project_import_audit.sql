begin;

-- Incremental lifecycle change. The initial lifecycle migration is already
-- deployed, so this file only broadens audit semantics and replaces the
-- existing finalization function without recreating tables or policies.

alter table public.project_operation_audit
  drop constraint project_operation_audit_operation_check;

alter table public.project_operation_audit
  add constraint project_operation_audit_operation_check
  check (operation in ('import', 'replace', 'delete'));

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
  v_operation text;
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
  v_operation := case
    when v_old_seds = 0 and v_old_llaves = 0 and v_old_fallas = 0 then 'import'
    else 'replace'
  end;
  select count(*) into v_supply_before from public.suministros_coordenadas;

  delete from public.fallas;
  delete from public.llaves;
  delete from public.seds;

  insert into public.seds(id, name, sed_coord, created_at)
  select id, name, sed_coord, coalesce(source_created_at, now())
  from public.project_staging_seds where import_id = p_import_id;

  -- Numeric source IDs remain metadata only. Existing defaults generate IDs.
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
    v_operation, v_user_id,
    jsonb_build_object('seds', v_old_seds, 'llaves', v_old_llaves, 'fallas', v_old_fallas),
    jsonb_build_object('seds', v_new_seds, 'llaves', v_new_llaves, 'fallas', v_new_fallas),
    v_import.project_id, p_import_id
  );

  delete from public.project_imports where import_id = p_import_id;
  return jsonb_build_object(
    'success', true,
    'operation', v_operation,
    'seds', v_new_seds,
    'llaves', v_new_llaves,
    'fallas', v_new_fallas
  );
end;
$$;

revoke all on function public.geopluz_replace_current_project(uuid, bigint, bigint, bigint) from public, anon;
grant execute on function public.geopluz_replace_current_project(uuid, bigint, bigint, bigint) to authenticated;

commit;
