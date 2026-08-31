begin;

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

  delete from public.fallas where id is not null;
  delete from public.llaves where id is not null;
  delete from public.seds where id is not null;

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

commit;
