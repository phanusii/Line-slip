alter table public.slip_submissions
  add column if not exists auto_check_status text,
  add column if not exists auto_check_reasons jsonb not null default '[]'::jsonb,
  add column if not exists auto_checked_at timestamptz,
  add column if not exists ocr_result jsonb;

create index if not exists slip_submissions_auto_check_status_idx
on public.slip_submissions(event_id, auto_check_status)
where metadata_deleted_at is null;

insert into public.settings (key, value)
values
  ('auto_verify_from_slip_enabled', 'false'),
  ('auto_verify_window_hours', '24'),
  ('auto_verify_requires_unique_amount', 'true'),
  ('auto_verify_ocr_enabled', 'false'),
  ('auto_verify_ocr_min_confidence', '45')
on conflict (key) do nothing;
