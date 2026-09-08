begin;

alter table public.circuit_monthly_metrics
  add column if not exists period_end_key text;

alter table public.circuit_monthly_metrics
  drop constraint if exists circuit_monthly_metrics_period_end_check;
alter table public.circuit_monthly_metrics
  add constraint circuit_monthly_metrics_period_end_check check (
    period_end_key is null or case
      when period_key ~ '^\d{4}-(0[1-9]|1[0-2])$'
       and period_end_key ~ '^\d{4}-(0[1-9]|1[0-2])$'
      then to_date(period_end_key || '-01', 'YYYY-MM-DD') between
        to_date(period_key || '-01', 'YYYY-MM-DD') and
        (to_date(period_key || '-01', 'YYYY-MM-DD') + interval '1 month')::date
      else false
    end
  );

create index if not exists circuit_monthly_metrics_period_range_idx
  on public.circuit_monthly_metrics(period_key, period_end_key);

create or replace function public.geopluz_import_circuit_compensation_range(
  p_period_start_key text,
  p_period_end_key text,
  p_rows jsonb,
  p_replace boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing bigint;
  v_written bigint;
  v_start date;
  v_end date;
begin
  if v_user_id is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  if p_period_start_key !~ '^\d{4}-(0[1-9]|1[0-2])$' or p_period_end_key !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception using errcode = '22023', message = 'Invalid compensation period';
  end if;
  v_start := to_date(p_period_start_key || '-01', 'YYYY-MM-DD');
  v_end := to_date(p_period_end_key || '-01', 'YYYY-MM-DD');
  if v_end < v_start or v_end > v_start + interval '1 month' then
    raise exception using errcode = '22023', message = 'Compensation period must cover one or two consecutive months';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception using errcode = '22023', message = 'Rows must be a JSON array'; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('geopluz_circuit_compensation:' || p_period_start_key || ':' || p_period_end_key, 0)) then
    raise exception using errcode = '55P03', message = 'Another operation is using this compensation period';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_rows) as x(sed_id text, llave_code text, period_key text, period_end_key text, compensation numeric)
    where nullif(btrim(x.sed_id), '') is null or nullif(btrim(x.llave_code), '') is null
      or x.period_key is distinct from p_period_start_key or x.period_end_key is distinct from p_period_end_key
      or x.compensation is null or x.compensation < 0
  ) then raise exception using errcode = '22023', message = 'Invalid circuit compensation row'; end if;
  if exists (
    select 1 from jsonb_to_recordset(p_rows) as x(sed_id text, llave_code text)
    left join public.llaves l on l.sed_id = x.sed_id and l.llave_code = x.llave_code where l.id is null
  ) then raise exception using errcode = '23503', message = 'Unknown circuit in compensation rows'; end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as x(sed_id text, llave_code text)
    join public.circuit_monthly_metrics m on m.sed_id = x.sed_id and m.llave_code = x.llave_code
    where m.period_key <= p_period_end_key and coalesce(m.period_end_key, m.period_key) >= p_period_start_key
      and not (m.period_key = p_period_start_key and coalesce(m.period_end_key, m.period_key) = p_period_end_key)
  ) then raise exception using errcode = '23505', message = 'Overlapping circuit compensation period'; end if;

  select count(*) into v_existing
  from public.circuit_monthly_metrics m
  where m.period_key = p_period_start_key and coalesce(m.period_end_key, m.period_key) = p_period_end_key
    and exists (select 1 from jsonb_to_recordset(p_rows) as x(sed_id text, llave_code text) where x.sed_id = m.sed_id and x.llave_code = m.llave_code);
  if v_existing > 0 and not p_replace then raise exception using errcode = '23505', message = 'Circuit compensation period already exists'; end if;
  if p_replace then
    delete from public.circuit_monthly_metrics m
    where m.period_key = p_period_start_key and coalesce(m.period_end_key, m.period_key) = p_period_end_key
      and exists (select 1 from jsonb_to_recordset(p_rows) as x(sed_id text, llave_code text) where x.sed_id = m.sed_id and x.llave_code = m.llave_code);
  end if;

  insert into public.fault_periods(period_key, label, start_date, end_date, row_count, created_by)
  values (p_period_start_key, p_period_start_key, v_start, (v_start + interval '1 month' - interval '1 day')::date, 0, v_user_id)
  on conflict (period_key) do nothing;

  insert into public.circuit_monthly_metrics(sed_id, llave_code, period_key, period_end_key, compensation, created_by)
  select x.sed_id, x.llave_code, p_period_start_key, p_period_end_key, x.compensation, v_user_id
  from jsonb_to_recordset(p_rows) as x(sed_id text, llave_code text, compensation numeric);
  get diagnostics v_written = row_count;
  return jsonb_build_object('period_start_key', p_period_start_key, 'period_end_key', p_period_end_key, 'written', v_written, 'replaced', p_replace, 'previous_rows', v_existing);
end;
$$;

create or replace function public.geopluz_delete_circuit_compensation_range(
  p_period_start_key text,
  p_period_end_key text,
  p_expected_rows bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_current bigint;
  v_deleted bigint;
begin
  if v_user_id is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('geopluz_circuit_compensation:' || p_period_start_key || ':' || p_period_end_key, 0)) then
    raise exception using errcode = '55P03', message = 'Another operation is using this compensation period';
  end if;
  select count(*) into v_current from public.circuit_monthly_metrics
  where period_key = p_period_start_key and coalesce(period_end_key, period_key) = p_period_end_key;
  if v_current <> p_expected_rows then raise exception using errcode = '40001', message = 'Circuit compensation period count changed'; end if;
  delete from public.circuit_monthly_metrics
  where period_key = p_period_start_key and coalesce(period_end_key, period_key) = p_period_end_key;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('period_start_key', p_period_start_key, 'period_end_key', p_period_end_key, 'deleted', v_deleted);
end;
$$;

revoke all on function public.geopluz_import_circuit_compensation_range(text, text, jsonb, boolean) from public, anon;
revoke all on function public.geopluz_delete_circuit_compensation_range(text, text, bigint) from public, anon;
grant execute on function public.geopluz_import_circuit_compensation_range(text, text, jsonb, boolean) to authenticated;
grant execute on function public.geopluz_delete_circuit_compensation_range(text, text, bigint) to authenticated;

commit;
