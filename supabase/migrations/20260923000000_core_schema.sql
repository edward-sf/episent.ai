create table public.case_reports (
  id               uuid primary key default gen_random_uuid(),
  received_at      timestamptz not null default now(),
  event_timestamp  timestamptz not null,
  lat              double precision not null,
  lon              double precision not null,
  geohash          text not null,
  disease_category text not null,
  case_count       integer not null check (case_count > 0),
  age_band         text,
  symptom_codes    text[],
  raw_payload      jsonb not null
);

create index case_reports_geohash_event_idx on public.case_reports (geohash, event_timestamp);
create index case_reports_geohash_received_idx on public.case_reports (geohash, received_at);

create table public.regions_index (
  geohash            text primary key,
  last_aggregated_at timestamptz,
  latest_window_end  date
);

-- Workers use the secret key, which bypasses RLS; no policies means no anon/authenticated access.
alter table public.case_reports enable row level security;
alter table public.regions_index enable row level security;

create function public.register_region() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.regions_index (geohash) values (new.geohash)
  on conflict (geohash) do nothing;
  return new;
end;
$$;

create trigger case_reports_register_region
after insert on public.case_reports
for each row execute function public.register_region();

create function public.dirty_regions(max_regions integer)
returns table (geohash text, checked_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select r.geohash, now() as checked_at
  from public.regions_index r
  where r.last_aggregated_at is null
     or exists (
       select 1
       from public.case_reports c
       where c.geohash = r.geohash
         and c.received_at > r.last_aggregated_at
     )
  order by r.last_aggregated_at asc nulls first, r.geohash
  limit max_regions;
$$;

revoke execute on function public.dirty_regions(integer) from public, anon, authenticated;
revoke execute on function public.register_region() from public, anon, authenticated;
