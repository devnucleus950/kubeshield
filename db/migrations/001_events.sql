-- The events table: one row per security event, one column per field in
-- section 6.2 of docs/phase1.md. Everything later phases query is a real column.

CREATE TABLE events (
  event_id        uuid        PRIMARY KEY,           -- assigned by ingest; makes retries safe
  occurred_at     timestamptz NOT NULL,              -- when it happened on the node
  received_at     timestamptz NOT NULL DEFAULT now(),-- when the API accepted it
  rule            text        NOT NULL,
  priority        text        NOT NULL,              -- stored as given
  priority_rank   smallint    NOT NULL,              -- 0 = Emergency ... 7 = Debug
  output          text        NOT NULL,
  tags            text[]      NOT NULL DEFAULT '{}',
  hostname        text,
  namespace       text,
  pod             text,
  container_id    text,
  container_name  text,
  image           text,
  proc_name       text,
  proc_cmdline    text,
  proc_pid        integer,
  proc_ppid       integer,
  user_name       text,
  file_path       text,
  remote_ip       text,
  remote_port     integer,
  raw             jsonb       NOT NULL               -- never lose the original
);

-- The lookups Phase 3 (correlation) and Phase 4 (dashboard) use.
CREATE INDEX events_occurred_at_idx ON events (occurred_at DESC);
CREATE INDEX events_container_idx   ON events (container_id, occurred_at);
CREATE INDEX events_pod_idx         ON events (namespace, pod, occurred_at);
CREATE INDEX events_tags_gin_idx    ON events USING GIN (tags);
