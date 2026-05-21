insert into public.events (name, slug, promptpay_id, expected_total)
values ('ค่าทริปตัวอย่าง', 'demo-trip', '0812345678', 1500)
on conflict (slug) do nothing;

insert into public.payment_targets (event_id, display_name, amount_due)
select e.id, v.display_name, v.amount_due
from public.events e
cross join (
  values
    ('สมชาย', 500.00::numeric),
    ('สมหญิง', 500.00::numeric),
    ('มานะ', 500.00::numeric)
) as v(display_name, amount_due)
where e.slug = 'demo-trip'
on conflict (event_id, display_name) do nothing;
