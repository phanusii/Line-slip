create unique index if not exists slip_submissions_image_hash_active_unique_idx
on public.slip_submissions(image_hash)
where image_hash is not null
  and metadata_deleted_at is null
  and status <> 'duplicate_slip'::public.payment_status;

