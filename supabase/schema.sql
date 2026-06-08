create table if not exists public.tracks (
  id text primary key,
  started_at timestamptz not null,
  stopped_at timestamptz,
  point_count integer not null,
  distance_meters numeric,
  points jsonb not null,
  client jsonb not null default '{}'::jsonb,
  inserted_at timestamptz not null default now()
);

alter table public.tracks enable row level security;

create index if not exists tracks_started_at_idx on public.tracks (started_at desc);
create index if not exists tracks_inserted_at_idx on public.tracks (inserted_at desc);

-- Recommended setup:
-- Keep SUPABASE_SERVICE_ROLE_KEY only in Vercel Environment Variables.
-- The service role key bypasses RLS from the serverless API function, so no public insert policy is needed.
--
-- If you intentionally use SUPABASE_ANON_KEY instead, create a narrow insert policy:
--
-- create policy "Allow anonymous track inserts"
-- on public.tracks
-- for insert
-- to anon
-- with check (
--   jsonb_typeof(points) = 'array'
--   and jsonb_array_length(points) between 1 and 50000
-- );
