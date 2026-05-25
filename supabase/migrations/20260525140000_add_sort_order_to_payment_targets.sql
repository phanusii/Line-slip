-- Add sort_order to preserve the insertion order of payment targets within each event.
-- Rows inserted in a bulk insert share the same created_at, so ordering by created_at
-- alone is non-deterministic. sort_order is set explicitly at insert time.

alter table public.payment_targets
  add column sort_order integer not null default 0;

-- Backfill existing rows: assign order based on created_at, breaking ties with id
with ordered as (
  select
    id,
    row_number() over (
      partition by event_id
      order by created_at, id
    ) - 1 as rn
  from public.payment_targets
)
update public.payment_targets
set sort_order = ordered.rn
from ordered
where payment_targets.id = ordered.id;

-- Index for fast ordered fetches per event
create index payment_targets_event_sort_idx
  on public.payment_targets (event_id, sort_order);
