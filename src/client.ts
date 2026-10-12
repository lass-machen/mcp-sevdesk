import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./generated/sevdesk-api.js";

const BASE_URL = "https://my.sevdesk.de/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY_LENGTH = 2_000;

type FetchFunction = (input: Request, init?: RequestInit) => Promise<Response>;

export interface SevdeskClientOptions {
  /** Overrides the fetch implementation, e.g. for offline tests. */
  fetch?: FetchFunction;
  /** Aborts requests that take longer than this, including reading the body (default 30s). */
  timeoutMs?: number;
}

/** The sevdesk API answered with a status outside of 2xx. */
export class SevdeskApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`sevdesk API request failed with status ${status}${body ? `: ${body}` : ""}`);
    this.name = "SevdeskApiError";
  }
}

/** The sevdesk API could not be reached, did not answer in time or sent an unreadable response. */
export class SevdeskRequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SevdeskRequestError";
  }
}

function truncate(text: string): string {
  return text.length > MAX_ERROR_BODY_LENGTH ? `${text.slice(0, MAX_ERROR_BODY_LENGTH)}... (truncated)` : text;
}

/**
 * Passes the body through unchanged, but replaces errors raised while reading
 * it (timeout, dropped connection) with descriptive ones. Streaming keeps the
 * memory use of large responses unchanged.
 */
function withMappedBodyErrors(response: Response, mapError: (error: unknown) => Error): Response {
  const source = response.body;
  if (!source) {
    return response;
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  // highWaterMark 0: the source is only locked once someone actually reads
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reader ??= source.getReader();
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          controller.error(mapError(error));
        }
      },
      cancel(reason) {
        return reader ? reader.cancel(reason) : source.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
  try {
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    // The Response constructor rejects some status lines that fetch accepts; keep the original then
    return response;
  }
}

export function createSevdeskClient(apiToken: string, options: SevdeskClientOptions = {}) {
  const baseFetch: FetchFunction = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function describeFailure(timeout: AbortSignal, error: unknown): SevdeskRequestError {
    // Only report a timeout if our own timeout signal fired
    if (timeout.aborted && error instanceof Error && error.name === "TimeoutError") {
      return new SevdeskRequestError(`sevdesk API request timed out after ${timeoutMs} ms`, { cause: error });
    }
    const message = error instanceof Error ? error.message : String(error);
    // Node's fetch reports network failures as "fetch failed" with the reason in cause.code
    const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
    const detail = typeof code === "string" ? `${message} (${code})` : message;
    return new SevdeskRequestError(`sevdesk API request failed: ${detail}`, { cause: error });
  }

  const errorHandling: Middleware = {
    /**
     * Every non-2xx status becomes a SevdeskApiError. Otherwise openapi-fetch
     * reports an error response with an empty body as `error: ""` or
     * `error: undefined`, which the `if (error)` checks in the tool handlers
     * treat as success.
     */
    async onResponse({ response }) {
      if (!response.ok) {
        throw new SevdeskApiError(response.status, truncate(await response.text()));
      }
      return undefined;
    },
  };

  const client = createClient<paths>({
    baseUrl: BASE_URL,
    headers: {
      Authorization: apiToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    // Abort requests that hang, including while the body is read, so they cannot block a tool call indefinitely
    fetch: async (input: Request, init?: RequestInit) => {
      const timeout = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await baseFetch(input, { ...init, signal: AbortSignal.any([input.signal, timeout]) });
      } catch (error) {
        throw describeFailure(timeout, error);
      }
      return withMappedBodyErrors(response, (error) => describeFailure(timeout, error));
    },
  });

  client.use(errorHandling);

  return client;
}

export type SevdeskClient = ReturnType<typeof createSevdeskClient>;
