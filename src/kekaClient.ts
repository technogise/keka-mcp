// Thin HTTP wrapper around Keka's REST API: base URL + auth header
// injection, error normalization, and a generic pagination helper.

import type { TokenManager } from "./auth.js";

export class KekaApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = "KekaApiError";
  }
}

/** Shape shared by every paginated Keka list endpoint used here. */
export interface KekaPagedResponse<T> {
  succeeded?: boolean;
  message?: string | null;
  errors?: string[] | null;
  data: T[];
  pageNumber: number;
  pageSize: number;
  totalPages: number;
  totalRecords: number;
  firstPage?: string | null;
  lastPage?: string | null;
  nextPage?: string | null;
  previousPage?: string | null;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export class KekaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: TokenManager,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async get<T>(path: string, query: QueryParams = {}): Promise<T> {
    const token = await this.tokens.getValidToken();
    const url = new URL(this.baseUrl.replace(/\/+$/, "") + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
    } catch (err) {
      throw new KekaApiError(0, `Network error calling Keka API (${path}): ${(err as Error).message}`);
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (!res.ok) {
      throw new KekaApiError(res.status, buildErrorMessage(res, path, json, text), json);
    }

    return json as T;
  }
}

function buildErrorMessage(res: Response, path: string, json: unknown, rawText: string): string {
  const detail = extractErrorDetail(json) ?? (rawText || res.statusText);
  const label =
    res.status === 401
      ? "Unauthorized - the access token was rejected (check credentials/scope)"
      : res.status === 403
        ? "Forbidden - authenticated but not permitted to call this endpoint"
        : res.status === 429
          ? "Rate limited by Keka - back off and retry later"
          : `HTTP ${res.status}`;
  return `Keka API error calling ${path}: ${label}. ${detail}`;
}

function extractErrorDetail(json: unknown): string | undefined {
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (typeof obj.message === "string" && obj.message) return obj.message;
    if (Array.isArray(obj.errors) && obj.errors.length > 0) return obj.errors.join("; ");
  }
  return undefined;
}

export interface PaginationResult<T> {
  data: T[];
  pagesFetched: number;
  totalRecords: number;
}

/**
 * Loops pageNumber = 1, 2, 3, ... calling fetchPage until every page has
 * been consumed, and returns the combined result set. Callers never see
 * individual pages.
 *
 * Stops when either:
 *  - pageNumber has passed the API-reported totalPages, or
 *  - a page comes back with zero rows (safety net in case totalPages is
 *    missing/unreliable on some response),
 * whichever happens first. maxPages is a hard runaway guard.
 */
export async function paginateAll<T>(
  fetchPage: (pageNumber: number, pageSize: number) => Promise<KekaPagedResponse<T>>,
  pageSize: number,
  maxPages = 1000
): Promise<PaginationResult<T>> {
  const all: T[] = [];
  let pageNumber = 1;
  let totalPages = 1;
  let totalRecords = 0;

  for (;;) {
    const page = await fetchPage(pageNumber, pageSize);
    const rows = Array.isArray(page.data) ? page.data : [];
    all.push(...rows);
    totalRecords = typeof page.totalRecords === "number" ? page.totalRecords : all.length;
    totalPages = typeof page.totalPages === "number" && page.totalPages > 0 ? page.totalPages : pageNumber;

    if (rows.length === 0) break;
    if (pageNumber >= totalPages) break;
    if (pageNumber >= maxPages) {
      console.error(`[kekaClient] paginateAll hit the maxPages safety cap (${maxPages}); stopping early.`);
      break;
    }
    pageNumber += 1;
  }

  return { data: all, pagesFetched: pageNumber, totalRecords };
}
