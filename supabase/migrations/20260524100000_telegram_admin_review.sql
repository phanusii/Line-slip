create table if not exists public.telegram_admin_chats (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null unique,
  chat_type text,
  chat_title text,
  admin_email text,
  enabled boolean not null default true,
  connected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.telegram_review_actions (
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

create index if not exists telegram_admin_chats_enabled_idx
on public.telegram_admin_chats(enabled, last_seen_at desc);

create index if not exists telegram_review_actions_slip_idx
on public.telegram_review_actions(slip_id, created_at desc);

create index if not exists telegram_review_actions_active_idx
on public.telegram_review_actions(token_hash, expires_at)
where used_at is null;

alter table public.telegram_admin_chats enable row level security;
alter table public.telegram_review_actions enable row level security;

drop policy if exists "admin service access telegram chats" on public.telegram_admin_chats;
create policy "admin service access telegram chats"
on public.telegram_admin_chats for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "admin service access telegram review actions" on public.telegram_review_actions;
create policy "admin service access telegram review actions"
on public.telegram_review_actions for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

insert into public.settings (key, value)
values ('telegram_webhook_secret', '')
on conflict (key) do nothing;

