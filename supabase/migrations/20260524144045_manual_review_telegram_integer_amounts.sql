-- Manual review becomes the only approval path. Telegram/Dashboard review
-- stays active, while OCR/QR auto-approval settings are forced off.
insert into public.settings (key, value, updated_at)
values
  ('auto_verify_from_slip_enabled', 'false', now()),
  ('auto_verify_ocr_enabled', 'false', now()),
  ('auto_verify_requires_unique_amount', 'false', now())
on conflict (key) do update
set
  value = excluded.value,
  updated_at = excluded.updated_at;

-- Remove the old per-person decimal suffix for unpaid/non-final targets.
-- Verified/deleted rows are left untouched to preserve historical audit data.
update public.payment_targets
set amount_due = floor(amount_due)
where status not in ('verified', 'deleted')
  and amount_due <> floor(amount_due);

-- Keep event totals in sync with the normalized pending amounts.
update public.events event_row
set expected_total = coalesce(target_totals.expected_total, 0)
from (
  select
    event_id,
    sum(amount_due) as expected_total
  from public.payment_targets
  where status <> 'deleted'
  group by event_id
) as target_totals
where event_row.id = target_totals.event_id;

update public.events event_row
set expected_total = 0
where not exists (
  select 1
  from public.payment_targets target_row
  where target_row.event_id = event_row.id
    and target_row.status <> 'deleted'
);
