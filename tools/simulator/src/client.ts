// Sends one request body to the ingest API. Never throws: a failure is a result.
export interface SendResult {
  status: number | null; // null when no HTTP response arrived at all
  error?: string;
}

export function createClient(target: string, apiKey: string) {
  const url = `${target.replace(/\/+$/, '')}/v1/events`;
  return async function send(body: string): Promise<SendResult> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      await res.arrayBuffer(); // drain, so the connection can be reused
      return { status: res.status };
    } catch (err) {
      return { status: null, error: (err as Error).message };
    }
  };
}
