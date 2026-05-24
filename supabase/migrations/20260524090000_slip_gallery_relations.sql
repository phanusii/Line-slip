alter table public.slip_submissions
  add column if not exists duplicate_of_slip_id uuid references public.slip_submissions(id) on delete set null,
  add column if not exists replaced_by_slip_id uuid references public.slip_submissions(id) on delete set null;

create index if not exists slip_submissions_payment_target_created_idx
on public.slip_submissions(payment_target_id, created_at desc)
where metadata_deleted_at is null;

create index if not exists slip_submissions_duplicate_of_idx
on public.slip_submissions(duplicate_of_slip_id)
where duplicate_of_slip_id is not null;

create index if not exists slip_submissions_replaced_by_idx
on public.slip_submissions(replaced_by_slip_id)
where replaced_by_slip_id is not null;
