begin;

create table if not exists public.circuit_monthly_metrics (
  sed_id text not null,
  llave_code text not null,
  period_key text not null,
  compensation numeric(18, 2) not null check (compensation >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  primary key (sed_id, llave_code, period_key),
  constraint circuit_monthly_metrics_llave_fk
    foreign key (sed_id, llave_code) references public.llaves(sed_id, llave_code)
    on update cascade on delete cascade deferrable initially deferred,
  constraint circuit_monthly_metrics_period_fk
    foreign key (period_key) references public.fault_periods(period_key)
    on update cascade on delete restrict deferrable initially deferred
);

create index if not exists circuit_monthly_metrics_period_idx
  on public.circuit_monthly_metrics(period_key);

alter table public.circuit_monthly_metrics enable row level security;
revoke all on table public.circuit_monthly_metrics from public, anon, authenticated;
grant select on table public.circuit_monthly_metrics to authenticated;

drop policy if exists circuit_monthly_metrics_authenticated_select on public.circuit_monthly_metrics;
create policy circuit_monthly_metrics_authenticated_select on public.circuit_monthly_metrics
  for select to authenticated using (auth.uid() is not null);

create or replace function public.geopluz_import_circuit_compensation_period(
  p_period_key text,
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
begin
  if v_user_id is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  if p_period_key !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception using errcode = '22023', message = 'Invalid monthly period'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception using errcode = '22023', message = 'Rows must be a JSON array'; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('geopluz_circuit_compensation:' || p_period_key, 0)) then
    raise exception using errcode = '55P03', message = 'Another operation is using this compensation period';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_rows) as x(sed_id text, llave_code text, period_key text, compensation numeric)
    where nullif(btrim(x.sed_id), '') is null
      or nullif(btrim(x.llave_code), '') is null
      or x.period_key is distinct from p_period_key
      or x.compensation is null
      or x.compensation < 0
  ) then raise exception using errcode = '22023', message = 'Invalid circuit compensation row'; end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as x(sed_id text, llave_code text, period_key text, compensation numeric)
    left join public.llaves l on l.sed_id = x.sed_id and l.llave_code = x.llave_code
    where l.id is null
  ) then raise exception using errcode = '23503', message = 'Unknown circuit in compensation rows'; end if;

  select count(*) into v_existing from public.circuit_monthly_metrics where period_key = p_period_key;
  if v_existing > 0 and not p_replace then
    raise exception using errcode = '23505', message = 'Circuit compensation period already exists';
  end if;
  if p_replace then delete from public.circuit_monthly_metrics where period_key = p_period_key; end if;

  v_start := to_date(p_period_key || '-01', 'YYYY-MM-DD');
  insert into public.fault_periods(period_key, label, start_date, end_date, row_count, created_by)
  values (p_period_key, p_period_key, v_start, (v_start + interval '1 month' - interval '1 day')::date, 0, v_user_id)
  on conflict (period_key) do nothing;

  insert into public.circuit_monthly_metrics(sed_id, llave_code, period_key, compensation, created_by)
  select x.sed_id, x.llave_code, p_period_key, x.compensation, v_user_id
  from jsonb_to_recordset(p_rows) as x(sed_id text, llave_code text, period_key text, compensation numeric);
  get diagnostics v_written = row_count;
  return jsonb_build_object('period_key', p_period_key, 'written', v_written, 'replaced', p_replace, 'previous_rows', v_existing);
end;
$$;

create or replace function public.geopluz_delete_circuit_compensation_period(
  p_period_key text,
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
  if not pg_try_advisory_xact_lock(hashtextextended('geopluz_circuit_compensation:' || p_period_key, 0)) then
    raise exception using errcode = '55P03', message = 'Another operation is using this compensation period';
  end if;
  select count(*) into v_current from public.circuit_monthly_metrics where period_key = p_period_key;
  if v_current <> p_expected_rows then raise exception using errcode = '40001', message = 'Circuit compensation period count changed'; end if;
  delete from public.circuit_monthly_metrics where period_key = p_period_key;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('period_key', p_period_key, 'deleted', v_deleted);
end;
$$;

revoke all on function public.geopluz_import_circuit_compensation_period(text, jsonb, boolean) from public, anon;
revoke all on function public.geopluz_delete_circuit_compensation_period(text, bigint) from public, anon;
grant execute on function public.geopluz_import_circuit_compensation_period(text, jsonb, boolean) to authenticated;
grant execute on function public.geopluz_delete_circuit_compensation_period(text, bigint) to authenticated;

commit;
