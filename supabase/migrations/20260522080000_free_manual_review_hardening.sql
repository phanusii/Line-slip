drop index if exists public.slip_submissions_image_hash_unique_idx;

create index if not exists slip_submissions_image_hash_idx
on public.slip_submissions(image_hash)
where image_hash is not null and metadata_deleted_at is null;
