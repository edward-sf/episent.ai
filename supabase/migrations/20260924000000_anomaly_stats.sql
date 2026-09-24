-- Per (region, disease category) statistics for anomaly scoring; src/shared/anomaly.ts turns
-- these rows into scores and statuses.
-- Week k covers (p_as_of - 7(k+1) days, p_as_of - 7k days]: week 0 is the current window,
-- week 1 is a guard band (ignored), weeks 2..13 are the 12-week baseline. A baseline week
-- counts only if it lies entirely after the region's first report; within those weeks a
-- category with no reports counts as 0. Intervals are in seconds so they match the
-- epoch-based week bucketing regardless of session time zone.
create function public.anomaly_stats(
  p_geohash text default null,
  p_as_of   timestamptz default now()
)
returns table (
  geohash          text,
  disease_category text,
  current_cases    integer,
  baseline_median  double precision,
  baseline_mad     double precision,
  baseline_weeks   integer,
  as_of            timestamptz
)
language sql
stable
set search_path = ''
as $$
  with first_seen as (
    select c.geohash, min(c.event_timestamp) as first_ts
    from public.case_reports c
    where p_geohash is null or c.geohash = p_geohash
    group by c.geohash
  ),
  weekly as (
    select
      c.geohash,
      c.disease_category,
      floor(extract(epoch from (p_as_of - c.event_timestamp)) / 604800)::integer as week_ago,
      sum(c.case_count)::integer as cases
    from public.case_reports c
    where (p_geohash is null or c.geohash = p_geohash)
      and c.event_timestamp > p_as_of - make_interval(secs => 604800 * 14)
      and c.event_timestamp <= p_as_of
    group by 1, 2, 3
  ),
  scored as (
    select distinct w.geohash, w.disease_category
    from weekly w
  ),
  baseline as (
    select s.geohash, s.disease_category, coalesce(w.cases, 0) as cases
    from scored s
    join first_seen f on f.geohash = s.geohash
    cross join generate_series(2, 13) as k(week_ago)
    left join weekly w
      on w.geohash = s.geohash
     and w.disease_category = s.disease_category
     and w.week_ago = k.week_ago
    where p_as_of - make_interval(secs => 604800 * (k.week_ago + 1)) >= f.first_ts
  ),
  medians as (
    select
      b.geohash,
      b.disease_category,
      percentile_cont(0.5) within group (order by b.cases) as median,
      count(*)::integer as weeks
    from baseline b
    group by b.geohash, b.disease_category
  ),
  mads as (
    select
      b.geohash,
      b.disease_category,
      percentile_cont(0.5) within group (order by abs(b.cases - m.median)) as mad
    from baseline b
    join medians m on m.geohash = b.geohash and m.disease_category = b.disease_category
    group by b.geohash, b.disease_category
  )
  select
    s.geohash,
    s.disease_category,
    coalesce(cur.cases, 0),
    m.median,
    d.mad,
    coalesce(m.weeks, 0),
    p_as_of
  from scored s
  left join weekly cur
    on cur.geohash = s.geohash
   and cur.disease_category = s.disease_category
   and cur.week_ago = 0
  left join medians m on m.geohash = s.geohash and m.disease_category = s.disease_category
  left join mads d on d.geohash = s.geohash and d.disease_category = s.disease_category
  order by s.geohash, s.disease_category;
$$;

revoke execute on function public.anomaly_stats(text, timestamptz) from public, anon, authenticated;
