import type pg from 'pg';

// Dev-only helper behind GET /v1/events: the latest stored events.
export async function latestEvents(pool: pg.Pool, limit: number): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT event_id, occurred_at, received_at, rule, priority, priority_rank, namespace, pod,
            container_id, container_name, image, proc_name, proc_cmdline, proc_pid, proc_ppid,
            user_name, file_path, remote_ip, remote_port, tags
       FROM events
      ORDER BY occurred_at DESC, event_id
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}
