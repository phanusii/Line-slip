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
  promptpay_id text,
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
  amount_due numeric(12, 2) not null,
  note text,
  status public.payment_status not null default 'unpaid',
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

create table public.telegram_admin_chats (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null unique,
  chat_type text,
  chat_title text,
  admin_email text,
  enabled boolean not null default true,
  connected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table public.telegram_review_actions (
  id uuid primary key default gen_random_uuid(),
  slip_id uuid not null references public.slip_submissions(id) on delete cascade,
  action text not null check (action in ('verified', 'rejected')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_chat_id text,
  used_by text,
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
create index payment_targets_event_status_idx on public.payment_targets(event_id, status);
create index slip_submissions_event_status_idx on public.slip_submissions(event_id, status);
create index slip_submissions_storage_path_idx on public.slip_submissions(storage_path) where storage_path is not null;
create index slip_submissions_image_hash_idx on public.slip_submissions(image_hash) where image_hash is not null and metadata_deleted_at is null;
create unique index slip_submissions_image_hash_active_unique_idx on public.slip_submissions(image_hash) where image_hash is not null and metadata_deleted_at is null and status <> 'duplicate_slip'::public.payment_status;
create unique index slip_submissions_slip_ref_unique_idx on public.slip_submissions(slip_ref) where slip_ref is not null and metadata_deleted_at is null;
create index slip_submissions_auto_check_status_idx on public.slip_submissions(event_id, auto_check_status) where metadata_deleted_at is null;
create index slip_submissions_payment_target_created_idx on public.slip_submissions(payment_target_id, created_at desc) where metadata_deleted_at is null;
create index slip_submissions_duplicate_of_idx on public.slip_submissions(duplicate_of_slip_id) where duplicate_of_slip_id is not null;
create index slip_submissions_replaced_by_idx on public.slip_submissions(replaced_by_slip_id) where replaced_by_slip_id is not null;
create index audit_logs_event_created_idx on public.audit_logs(event_id, created_at desc);
create index telegram_admin_chats_enabled_idx on public.telegram_admin_chats(enabled, last_seen_at desc);
create index telegram_review_actions_slip_idx on public.telegram_review_actions(slip_id, created_at desc);
create index telegram_review_actions_active_idx on public.telegram_review_actions(token_hash, expires_at) where used_at is null;

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
alter table public.admin_users enable row level security;
alter table public.audit_logs enable row level security;
alter table public.telegram_admin_chats enable row level security;
alter table public.telegram_review_actions enable row level security;

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

create policy "admin service access admin users"
on public.admin_users for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "admin service access audit logs"
on public.audit_logs for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "admin service access telegram chats"
on public.telegram_admin_chats for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "admin service access telegram review actions"
on public.telegram_review_actions for all
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
  ('auto_verify_ocr_enabled', 'false')
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
