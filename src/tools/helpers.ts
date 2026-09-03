// Shared plumbing for every tool handler: consistent JSON result shape,
// stderr logging, and a try/catch boundary so a bad API response, a network
// failure, or a bug in one handler turns into a clean MCP error response
// instead of crashing the server process.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { KekaApiError } from "../kekaClient.js";
import { DateRangeError } from "../dateRange.js";

export function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function formatError(err: unknown): string {
  if (err instanceof DateRangeError) return `Invalid request: ${err.message}`;
  if (err instanceof KekaApiError) return err.message;
  if (err instanceof Error) return `Unexpected error: ${err.message}`;
  return `Unexpected error: ${String(err)}`;
}

/**
 * Wraps a tool handler so it can never throw: logs the call and outcome to
 * stderr, and converts any thrown error into a clean isError result.
 */
export function safeHandler<TArgs>(
  toolName: string,
  fn: (args: TArgs) => Promise<CallToolResult>
): (args: TArgs) => Promise<CallToolResult> {
  return async (args: TArgs) => {
    console.error(`[tool] ${toolName} called with ${JSON.stringify(args)}`);
    try {
      const result = await fn(args);
      console.error(`[tool] ${toolName} succeeded`);
      return result;
    } catch (err) {
      const message = formatError(err);
      console.error(`[tool] ${toolName} failed: ${message}`);
      return errorResult(message);
    }
  };
}

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 100;

export function clampPageSize(pageSize?: number): number {
  if (!pageSize || pageSize <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(pageSize), MAX_PAGE_SIZE);
}
