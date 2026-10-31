-- AR artworks: database schema, Storage buckets and RLS policies.
-- Run once in the Supabase SQL editor. Safe to re-run.

-- ---------------------------------------------------------------------------
-- Admins
-- ---------------------------------------------------------------------------
-- Only users listed here may write. Add an admin after creating the user in
-- Authentication > Users:
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'you@example.com';

create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;

drop policy if exists "Admins can read their own row" on public.admins;
create policy "Admins can read their own row"
  on public.admins for select
  to authenticated
  using (user_id = auth.uid());

-- security definer so policies can check admin status without exposing the table.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Artworks
-- ---------------------------------------------------------------------------

create table if not exists public.artworks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200),
  marker_path text not null,          -- object name in bucket "markers"
  target_path text not null,          -- object name in bucket "targets" (.mind)
  video_path text not null,           -- object name in bucket "videos"
  marker_width integer not null check (marker_width > 0),
  marker_height integer not null check (marker_height > 0),
  loop boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists artworks_set_updated_at on public.artworks;
create trigger artworks_set_updated_at
  before update on public.artworks
  for each row execute function public.set_updated_at();

alter table public.artworks enable row level security;

drop policy if exists "Public can read active artworks" on public.artworks;
create policy "Public can read active artworks"
  on public.artworks for select
  to anon, authenticated
  using (active);

drop policy if exists "Admins can read all artworks" on public.artworks;
create policy "Admins can read all artworks"
  on public.artworks for select
  to authenticated
  using (public.is_admin());

drop policy if exists "Admins can insert artworks" on public.artworks;
create policy "Admins can insert artworks"
  on public.artworks for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists "Admins can update artworks" on public.artworks;
create policy "Admins can update artworks"
  on public.artworks for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Admins can delete artworks" on public.artworks;
create policy "Admins can delete artworks"
  on public.artworks for delete
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------
-- Buckets are private: files are served through short-lived signed URLs,
-- which the policies below only allow for files of active artworks.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('markers', 'markers', false, 10485760,  array['image/jpeg', 'image/png']),
  ('targets', 'targets', false, 10485760,  array['application/octet-stream']),
  ('videos',  'videos',  false, 52428800,  array['video/mp4'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public can read files of active artworks" on storage.objects;
create policy "Public can read files of active artworks"
  on storage.objects for select
  to anon, authenticated
  using (
    bucket_id in ('markers', 'targets', 'videos')
    and exists (
      select 1
      from public.artworks a
      where a.active
        and (
             (bucket_id = 'markers' and a.marker_path = name)
          or (bucket_id = 'targets' and a.target_path = name)
          or (bucket_id = 'videos'  and a.video_path  = name)
        )
    )
  );

drop policy if exists "Admins can read all AR files" on storage.objects;
create policy "Admins can read all AR files"
  on storage.objects for select
  to authenticated
  using (bucket_id in ('markers', 'targets', 'videos') and public.is_admin());

drop policy if exists "Admins can upload AR files" on storage.objects;
create policy "Admins can upload AR files"
  on storage.objects for insert
  to authenticated
  with check (bucket_id in ('markers', 'targets', 'videos') and public.is_admin());

drop policy if exists "Admins can update AR files" on storage.objects;
create policy "Admins can update AR files"
  on storage.objects for update
  to authenticated
  using (bucket_id in ('markers', 'targets', 'videos') and public.is_admin())
  with check (bucket_id in ('markers', 'targets', 'videos') and public.is_admin());

drop policy if exists "Admins can delete AR files" on storage.objects;
create policy "Admins can delete AR files"
  on storage.objects for delete
  to authenticated
  using (bucket_id in ('markers', 'targets', 'videos') and public.is_admin());
