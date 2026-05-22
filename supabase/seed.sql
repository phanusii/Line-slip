-- Seed initial admin user.
-- Generate password_hash with: node -e "const {scryptSync,randomBytes}=require('crypto');const s=randomBytes(16).toString('base64url');console.log('scrypt$'+s+'$'+scryptSync('YOUR_PASSWORD',s,64).toString('base64url'))"
-- Then replace the placeholder hash below with the output.
insert into public.admin_users (email, role, password_hash)
values ('admin@example.com', 'admin', 'REPLACE_WITH_SCRYPT_HASH')
on conflict (email) do nothing;

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
