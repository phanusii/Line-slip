alter table public.events
  add column if not exists promptpay_type text not null default 'phone';

alter table public.events
  drop constraint if exists events_promptpay_type_check;

alter table public.events
  add constraint events_promptpay_type_check
  check (promptpay_type in ('phone', 'national_id', 'ewallet'));

update public.events
set promptpay_type = 'national_id'
where promptpay_id is not null
  and regexp_replace(promptpay_id, '[^0-9]', '', 'g') ~ '^[0-9]{13}$'
  and regexp_replace(promptpay_id, '[^0-9]', '', 'g') !~ '^0[689][0-9]{8}$';
