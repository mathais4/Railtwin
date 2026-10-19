-- RailTwin schema. Times are stored as minutes since midnight (double precision),
-- matching the engine, so no conversion is needed on the hot path.

create table if not exists networks (
  id          text primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists stations (
  network_id  text not null references networks(id) on delete cascade,
  id          text not null,
  name        text not null,
  platforms   integer not null check (platforms > 0),
  x           double precision not null,
  y           double precision not null,
  min_dwell   double precision,
  turnaround  double precision,
  ord         integer not null default 0,
  primary key (network_id, id)
);

create table if not exists segments (
  network_id    text not null references networks(id) on delete cascade,
  id            text not null,
  from_station  text not null,
  to_station    text not null,
  run_time      double precision not null check (run_time > 0),
  tracks        smallint not null check (tracks in (1, 2)),
  headway       double precision not null check (headway >= 0),
  ord           integer not null default 0,
  primary key (network_id, id),
  foreign key (network_id, from_station) references stations(network_id, id),
  foreign key (network_id, to_station) references stations(network_id, id)
);

create table if not exists scenarios (
  id           text primary key,
  network_id   text not null references networks(id),
  name         text not null,
  description  text not null default '',
  incidents    jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists trains (
  scenario_id      text not null references scenarios(id) on delete cascade,
  id               text not null,
  name             text not null,
  kind             text not null,
  priority         integer not null,
  passengers       integer not null default 0,
  run_time_factor  double precision,
  route            jsonb,
  primary key (scenario_id, id)
);

create table if not exists train_stops (
  scenario_id  text not null,
  train_id     text not null,
  seq          integer not null,
  station_id   text not null,
  sched_arr    double precision,
  sched_dep    double precision,
  platform     integer,
  primary key (scenario_id, train_id, seq),
  foreign key (scenario_id, train_id) references trains(scenario_id, id) on delete cascade
);

create table if not exists connections (
  scenario_id   text not null references scenarios(id) on delete cascade,
  id            text not null,
  station_id    text not null,
  from_train    text not null,
  to_train      text not null,
  min_transfer  double precision not null,
  max_hold      double precision not null,
  passengers    integer not null,
  miss_penalty  double precision,
  ord           integer not null default 0,
  primary key (scenario_id, id)
);

-- Real or synthetic "what actually happened" times, used for replay scoring.
create table if not exists observed_stop_times (
  scenario_id  text not null references scenarios(id) on delete cascade,
  train_id     text not null,
  seq          integer not null,
  arr          double precision,
  dep          double precision,
  source       text not null default 'import',
  primary key (scenario_id, train_id, seq)
);

create table if not exists runs (
  id              bigserial primary key,
  scenario_id     text not null references scenarios(id) on delete cascade,
  label           text not null,
  policy          jsonb not null,
  kpis            jsonb not null,
  engine_version  text not null,
  runtime_ms      double precision not null,
  created_at      timestamptz not null default now()
);
create index if not exists runs_scenario_created_idx on runs (scenario_id, created_at desc);

create table if not exists run_stop_times (
  run_id      bigint not null references runs(id) on delete cascade,
  train_id    text not null,
  seq         integer not null,
  station_id  text not null,
  arr         double precision,
  dep         double precision,
  platform    integer,
  arr_delay   double precision,
  primary key (run_id, train_id, seq)
);

create table if not exists run_knock_on (
  run_id      bigint not null references runs(id) on delete cascade,
  from_train  text not null,
  to_train    text not null,
  minutes     double precision not null,
  primary key (run_id, from_train, to_train)
);

-- "Which trains were worst hit across all runs of a scenario?" is a common question.
create index if not exists run_stop_times_delay_idx on run_stop_times (run_id, arr_delay desc);
