-- Speed up the first LIFF payment screen and status/slip lookups.
-- These indexes match the hot paths used when users open Rich Menu links.

create index if not exists events_open_created_idx
  on public.events (created_at desc)
  where is_open = true and archived_at is null;

create index if not exists payment_targets_event_visible_sort_idx
  on public.payment_targets (event_id, sort_order, created_at)
  where status <> 'deleted';

create index if not exists payment_targets_selected_line_user_updated_idx
  on public.payment_targets (selected_line_user_id, updated_at desc)
  where selected_line_user_id is not null and status <> 'deleted';
