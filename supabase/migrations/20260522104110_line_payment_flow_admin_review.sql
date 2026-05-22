do $$
begin
  update public.payment_targets p
  set selected_line_user_id = null
  where selected_line_user_id is not null
    and not exists (
      select 1
      from public.line_users u
      where u.id = p.selected_line_user_id
    );

  if not exists (
    select 1
    from pg_constraint
    where conname = 'payment_targets_selected_line_user_fk'
      and conrelid = 'public.payment_targets'::regclass
  ) then
    alter table public.payment_targets
      add constraint payment_targets_selected_line_user_fk
      foreign key (selected_line_user_id)
      references public.line_users(id)
      on delete set null;
  end if;
end;
$$;

insert into public.settings (key, value)
values
  ('line_push_policy', 'quota_aware'),
  ('admin_review_channel', 'dashboard_only'),
  ('admin_review_token_ttl_hours', '24')
on conflict (key) do nothing;
