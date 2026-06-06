alter table public.events
  add column if not exists amount_mode text not null default 'fixed';

alter table public.events
  drop constraint if exists events_amount_mode_check;

alter table public.events
  add constraint events_amount_mode_check
  check (amount_mode in ('fixed', 'payer_entered'));

alter table public.payment_targets
  alter column amount_due drop not null,
  add column if not exists amount_entered_at timestamptz,
  add column if not exists amount_locked_at timestamptz;

alter table public.payment_targets
  drop constraint if exists payment_targets_amount_due_positive;

alter table public.payment_targets
  add constraint payment_targets_amount_due_positive
  check (amount_due is null or amount_due > 0);

create table if not exists public.slipok_quota_guard (
  id text primary key check (id = 'slipok'),
  lease_token uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.slipok_quota_guard enable row level security;

drop policy if exists "service_role_slipok_quota_guard_all"
  on public.slipok_quota_guard;

create policy "service_role_slipok_quota_guard_all"
on public.slipok_quota_guard for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

insert into public.slipok_quota_guard (id)
values ('slipok')
on conflict (id) do nothing;
