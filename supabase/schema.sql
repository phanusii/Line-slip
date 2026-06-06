create extension if not exists pgcrypto;

create type public.payment_status as enum (
  'unpaid',
  'pending_slip',
  'verified',
  'manual_review',
  'amount_mismatch',
  'duplicate_slip',
  'rejected',
  'deleted'
);

create type public.admin_role as enum ('admin', 'viewer');

create table public.events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  amount_mode text not null default 'fixed' check (amount_mode in ('fixed', 'payer_entered')),
  promptpay_id text,
  promptpay_type text not null default 'phone' check (promptpay_type in ('phone', 'national_id', 'ewallet')),
  expected_total numeric(12, 2) not null default 0,
  is_open boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payment_targets (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  display_name text not null,
  amount_due numeric(12, 2) check (amount_due is null or amount_due > 0),
  amount_entered_at timestamptz,
  amount_locked_at timestamptz,
  note text,
  status public.payment_status not null default 'unpaid',
  sort_order integer not null default 0,
  selected_line_user_id uuid,
  paid_slip_submission_id uuid,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, display_name)
);

create table public.line_users (
  id uuid primary key default gen_random_uuid(),
  line_user_id text not null unique,
  display_name text,
  picture_url text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table public.slip_submissions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete set null,
  payment_target_id uuid references public.payment_targets(id) on delete set null,
  line_user_id uuid references public.line_users(id) on delete set null,
  line_message_id text,
  storage_bucket text not null default 'slips',
  storage_path text,
  original_filename text,
  file_size bigint not null default 0,
  mime_type text,
  image_hash text,
  slip_ref text,
  duplicate_of_slip_id uuid references public.slip_submissions(id) on delete set null,
  replaced_by_slip_id uuid references public.slip_submissions(id) on delete set null,
  amount_expected numeric(12, 2),
  amount_detected numeric(12, 2),
  transfer_datetime timestamptz,
  status public.payment_status not null default 'manual_review',
  rejection_reason text,
  auto_check_status text,
  auto_check_reasons jsonb not null default '[]'::jsonb,
  auto_checked_at timestamptz,
  ocr_result jsonb,
  verification_provider text,
  provider_check_status text,
  provider_response jsonb,
  provider_checked_at timestamptz,
  provider_reference text,
  file_deleted_at timestamptz,
  metadata_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.admin_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  role public.admin_role not null default 'viewer',
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_email text,
  actor_role public.admin_role,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  event_id uuid references public.events(id) on delete set null,
  before_data jsonb,
  after_data jsonb,
  reason text,
  created_at timestamptz not null default now()
);

alter table public.payment_targets
  add constraint payment_targets_paid_slip_fk
  foreign key (paid_slip_submission_id)
  references public.slip_submissions(id)
  on delete set null;

alter table public.payment_targets
  add constraint payment_targets_selected_line_user_fk
  foreign key (selected_line_user_id)
  references public.line_users(id)
  on delete set null;

create index events_slug_idx on public.events(slug);
create index events_open_created_idx on public.events(created_at desc)
  where is_open = true and archived_at is null;
create index payment_targets_event_status_idx on public.payment_targets(event_id, status);
create index payment_targets_event_visible_sort_idx on public.payment_targets(event_id, sort_order, created_at)
  where status <> 'deleted';
create index payment_targets_selected_line_user_updated_idx on public.payment_targets(selected_line_user_id, updated_at desc)
  where selected_line_user_id is not null and status <> 'deleted';
create index slip_submissions_event_status_idx on public.slip_submissions(event_id, status);
create index slip_submissions_storage_path_idx on public.slip_submissions(storage_path) where storage_path is not null;
create index slip_submissions_image_hash_idx on public.slip_submissions(image_hash) where image_hash is not null and metadata_deleted_at is null;
create unique index slip_submissions_image_hash_active_unique_idx on public.slip_submissions(image_hash) where image_hash is not null and metadata_deleted_at is null and status <> 'duplicate_slip'::public.payment_status;
create unique index slip_submissions_slip_ref_unique_idx on public.slip_submissions(slip_ref) where slip_ref is not null and metadata_deleted_at is null;
create index slip_submissions_auto_check_status_idx on public.slip_submissions(event_id, auto_check_status) where metadata_deleted_at is null;
create index slip_submissions_payment_target_created_idx on public.slip_submissions(payment_target_id, created_at desc) where metadata_deleted_at is null;
create index slip_submissions_duplicate_of_idx on public.slip_submissions(duplicate_of_slip_id) where duplicate_of_slip_id is not null;
create index slip_submissions_replaced_by_idx on public.slip_submissions(replaced_by_slip_id) where replaced_by_slip_id is not null;
create index slip_submissions_provider_reference_idx on public.slip_submissions(provider_reference) where provider_reference is not null and metadata_deleted_at is null;

create table public.slipok_usage_logs (
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

create index slipok_usage_logs_month_idx on public.slipok_usage_logs(month_key, created_at desc);
create index slipok_usage_logs_slip_idx on public.slipok_usage_logs(slip_id) where slip_id is not null;

create table public.slipok_quota_guard (
  id text primary key check (id = 'slipok'),
  lease_token uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.slipok_quota_guard (id)
values ('slipok')
on conflict (id) do nothing;
create index audit_logs_event_created_idx on public.audit_logs(event_id, created_at desc);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger touch_events_updated_at
before update on public.events
for each row execute function public.touch_updated_at();

create trigger touch_payment_targets_updated_at
before update on public.payment_targets
for each row execute function public.touch_updated_at();

create trigger touch_slip_submissions_updated_at
before update on public.slip_submissions
for each row execute function public.touch_updated_at();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('slips', 'slips', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = false,
    file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

alter table public.events enable row level security;
alter table public.payment_targets enable row level security;
alter table public.line_users enable row level security;
alter table public.slip_submissions enable row level security;
alter table public.slipok_usage_logs enable row level security;
alter table public.slipok_quota_guard enable row level security;
alter table public.admin_users enable row level security;
alter table public.audit_logs enable row level security;

create policy "admin service access events"
on public.events for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "admin service access payment targets"
on public.payment_targets for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "admin service access line users"
on public.line_users for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "admin service access slips"
on public.slip_submissions for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "service_role_slipok_usage_logs_all"
on public.slipok_usage_logs for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "service_role_slipok_quota_guard_all"
on public.slipok_quota_guard for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "admin service access admin users"
on public.admin_users for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "admin service access audit logs"
on public.audit_logs for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "service role storage access"
on storage.objects for all
using (bucket_id = 'slips' and auth.role() = 'service_role')
with check (bucket_id = 'slips' and auth.role() = 'service_role');

create table public.settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.settings enable row level security;

create policy "admin service access settings"
on public.settings for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

insert into public.settings (key, value)
values
  ('line_push_policy', 'quota_aware'),
  ('admin_review_channel', 'dashboard_only'),
  ('telegram_webhook_secret', ''),
  ('admin_review_token_ttl_hours', '24'),
  ('auto_verify_from_slip_enabled', 'false'),
  ('auto_verify_window_hours', '24'),
  ('auto_verify_requires_unique_amount', 'true'),
  ('auto_verify_ocr_enabled', 'false'),
  ('auto_verify_ocr_min_confidence', '45'),
  ('slip_verification_provider', 'manual'),
  ('slipok_api_key', ''),
  ('slipok_branch_id', ''),
  ('slipok_log_enabled', 'true'),
  ('slipok_auto_approve_enabled', 'true'),
  ('slipok_disabled_reason', ''),
  ('slipok_disabled_at', '')
on conflict (key) do nothing;

-- Returns actual PostgreSQL database size in bytes (accurate, includes indexes and TOAST)
create or replace function public.get_db_size()
returns bigint
language sql
security definer
set search_path = public
as $$
  select pg_database_size(current_database());
$$;

grant execute on function public.get_db_size() to service_role;
