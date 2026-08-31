begin;

grant delete on table public.fallas to authenticated;

drop policy if exists geopluz_authenticated_delete on public.fallas;
create policy geopluz_authenticated_delete
  on public.fallas
  for delete
  to authenticated
  using (true);

commit;
