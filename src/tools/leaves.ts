import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KekaClient, paginateAll, type KekaPagedResponse } from "../kekaClient.js";
import { assertValidDateRange } from "../dateRange.js";
import { clampPageSize, jsonResult, safeHandler } from "./helpers.js";

// Keka's documented response shape for /time/leaverequests returns `status`
// as an integer 0-4, with no label mapping given anywhere in the docs (unlike
// timesheet status, no enum names were ever provided for this one) - so
// unlike timeEntries.ts, this does NOT add a guessed statusLabel. The raw
// `status` value from the API is preserved unmodified; if you need to know
// what a given value means, check with Keka or a sandbox response with a
// range of different requests (approved, pending, rejected, ...).
interface LeaveDuration {
  unit?: number;
  duration?: number;
  durationString?: string;
  [key: string]: unknown;
}

interface LeaveSelection {
  leaveTypeIdentifier?: string;
  leaveTypeName?: string;
  count?: number;
  duration?: LeaveDuration;
  [key: string]: unknown;
}

interface LeaveRequest {
  id: string;
  employeeIdentifier?: string | null;
  employeeNumber?: string | null;
  fromDate?: string;
  toDate?: string;
  fromSession?: number;
  toSession?: number;
  requestedOn?: string;
  note?: string | null;
  cancelRejectReason?: string | null;
  status: number;
  selection?: LeaveSelection[];
  lastActionTakenOn?: string | null;
  [key: string]: unknown;
}

export function registerLeaveTools(server: McpServer, client: KekaClient): void {
  server.registerTool(
    "get_leaves",
    {
      title: "Get leave requests",
      description:
        "Fetch leave requests across the organization from Keka for a date range. Automatically pages " +
        "through the entire result set and returns it combined. The 'from'..'to' range cannot exceed 60 " +
        "days (validated before calling Keka; defaults to the last 30 days if both are omitted). Each " +
        "request's numeric `status` field (0-4) is preserved as returned by the API - Keka's docs don't " +
        "publish a label mapping for it, so no guessed label is added (unlike timesheet status).",
      inputSchema: {
        from: z
          .string()
          .optional()
          .describe("Start date (e.g. 2026-06-01). Defaults to 30 days before 'to' if omitted."),
        to: z.string().optional().describe("End date (e.g. 2026-06-30). Defaults to today if omitted."),
        employeeIds: z.string().optional().describe("Comma-separated Keka employee IDs to filter by."),
        pageSize: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe("Page size used internally per request to Keka (max 200, default 100)."),
      },
    },
    safeHandler("get_leaves", async ({ from, to, employeeIds, pageSize }) => {
      assertValidDateRange(from, to);
      const size = clampPageSize(pageSize);
      const { data, pagesFetched, totalRecords } = await paginateAll<LeaveRequest>(
        (pageNumber, ps) =>
          client.get<KekaPagedResponse<LeaveRequest>>("/api/v1/time/leaverequests", {
            from,
            to,
            employeeIds,
            pageNumber,
            pageSize: ps,
          }),
        size
      );
      return jsonResult({ totalRecords, pagesFetched, count: data.length, leaves: data });
    })
  );
}
