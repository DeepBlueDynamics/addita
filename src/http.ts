export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly detail?: unknown[],
    readonly rawError?: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

/** fetch + JSON with a hard timeout and readable errors. */
export async function requestJson<T = any>(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs: number },
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs);
  try {
    const res = await fetch(url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let data: any = undefined;
    try {
      data = raw ? JSON.parse(raw) : undefined;
    } catch {
      data = raw;
    }
    if (!res.ok) {
      const msg = typeof data === "object" && data?.error ? String(data.error) : raw.slice(0, 300);
      const code = typeof data === "object" && typeof data?.code === "string" ? data.code : undefined;
      const detail = typeof data === "object" && Array.isArray(data?.detail) ? data.detail : undefined;
      const headers: Record<string, string> = {};
      for (const h of ["allow", "retry-after", "www-authenticate"]) {
        const v = res.headers.get(h);
        if (v) headers[h] = v;
      }
      throw new HttpError(
        `${res.status} from ${url}: ${msg}`,
        res.status,
        code,
        detail,
        msg || `HTTP ${res.status}`,
        Object.keys(headers).length ? headers : undefined,
      );
    }
    return data as T;
  } catch (e: any) {
    if (e instanceof HttpError) throw e;
    if (e?.name === "AbortError") throw new HttpError(`timed out after ${init.timeoutMs} ms: ${url}`);
    throw new HttpError(`cannot reach ${url}: ${e?.cause?.code ?? e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
}
