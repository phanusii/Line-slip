alter table public.slip_submissions
  add column if not exists verification_provider text,
  add column if not exists provider_check_status text,
  add column if not exists provider_response jsonb,
  add column if not exists provider_checked_at timestamptz,
  add column if not exists provider_reference text;

create index if not exists slip_submissions_provider_reference_idx
  on public.slip_submissions(provider_reference)
  where provider_reference is not null and metadata_deleted_at is null;

create table if not exists public.slipok_usage_logs (
  id uuid primary key default gen_random_uuid(),
  slip_id uuid references public.slip_submissions(id) on delete set null,
  month_key text not null,
  quota_before integer,
  quota_after integer,
  over_quota integer,
  used_delta integer not null default 0,
  provider_status text,
  created_at timestamptz not null default now()
);

alter table public.slipok_usage_logs enable row level security;

drop policy if exists "service_role_slipok_usage_logs_all" on public.slipok_usage_logs;
create policy "service_role_slipok_usage_logs_all"
on public.slipok_usage_logs for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create index if not exists slipok_usage_logs_month_idx
  on public.slipok_usage_logs(month_key, created_at desc);

create index if not exists slipok_usage_logs_slip_idx
  on public.slipok_usage_logs(slip_id)
  where slip_id is not null;

insert into public.settings (key, value)
values
  ('slip_verification_provider', 'manual'),
  ('slipok_api_key', ''),
  ('slipok_branch_id', ''),
  ('slipok_log_enabled', 'true'),
  ('slipok_auto_approve_enabled', 'true'),
  ('slipok_disabled_reason', ''),
  ('slipok_disabled_at', '')
on conflict (key) do nothing;
