import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KekaClient, paginateAll, type KekaPagedResponse } from "../kekaClient.js";
import { assertValidDateRange } from "../dateRange.js";
import { clampPageSize, jsonResult, safeHandler } from "./helpers.js";

// Keka's documented response shape for /psa/timeentries and
// /psa/projects/{id}/timeentries returns `status` as an integer 0-5. The
// numeric-to-label mapping below follows the order the user described
// (UnSubmitted, Submitted, Approved, Rejected, InApprovalProcess, Invoiced)
// but that exact ordering has NOT been confirmed against a live Keka
// response - see README "Open questions" section. The raw `status` value
// from the API is always preserved unmodified; `statusLabel` is an
// unverified best-effort annotation.
const STATUS_LABELS = ["UnSubmitted", "Submitted", "Approved", "Rejected", "InApprovalProcess", "Invoiced"] as const;

interface TimeEntry {
  id: string;
  identifier?: string | null;
  date: string;
  employeeId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  totalMinutes: number;
  startTime?: string | null;
  endTime?: string | null;
  comments?: string | null;
  isBillable: boolean;
  status: number;
  [key: string]: unknown;
}

function annotateStatus(entries: TimeEntry[]): TimeEntry[] {
  return entries.map((entry) => ({
    ...entry,
    statusLabel: STATUS_LABELS[entry.status] ?? `unknown(${entry.status})`,
  }));
}

export function registerTimeEntryTools(server: McpServer, client: KekaClient): void {
  server.registerTool(
    "get_timesheet_entries",
    {
      title: "Get timesheet entries",
      description:
        "Fetch PSA timesheet entries from Keka across employees/projects for a date range. " +
        "Automatically pages through the entire result set and returns it combined - callers never " +
        "need to loop on pageNumber themselves. The 'from'..'to' range cannot exceed 60 days (validated " +
        "before calling Keka). Each entry's numeric `status` field is preserved as returned by the API, " +
        "with a best-effort `statusLabel` (UnSubmitted/Submitted/Approved/Rejected/InApprovalProcess/Invoiced) added alongside it.",
      inputSchema: {
        from: z
          .string()
          .optional()
          .describe("Start date (e.g. 2026-06-01). Defaults to 30 days before 'to' if omitted."),
        to: z.string().optional().describe("End date (e.g. 2026-06-30). Defaults to today if omitted."),
        employeeIds: z.string().optional().describe("Comma-separated Keka employee IDs to filter by."),
        projectIds: z.string().optional().describe("Comma-separated Keka project IDs to filter by."),
        pageSize: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe("Page size used internally per request to Keka (max 200, default 100). Does not limit total results - all pages are fetched and combined."),
      },
    },
    safeHandler("get_timesheet_entries", async ({ from, to, employeeIds, projectIds, pageSize }) => {
      assertValidDateRange(from, to);
      const size = clampPageSize(pageSize);
      const { data, pagesFetched, totalRecords } = await paginateAll<TimeEntry>(
        (pageNumber, ps) =>
          client.get<KekaPagedResponse<TimeEntry>>("/api/v1/psa/timeentries", {
            from,
            to,
            employeeIds,
            projectIds,
            pageNumber,
            pageSize: ps,
          }),
        size
      );
      return jsonResult({ totalRecords, pagesFetched, count: data.length, entries: annotateStatus(data) });
    })
  );

  server.registerTool(
    "get_project_time_entries",
    {
      title: "Get project timesheet entries",
      description:
        "Fetch PSA timesheet entries for a single project from Keka. Automatically pages through the " +
        "entire result set and returns it combined. The 'from'..'to' range cannot exceed 60 days " +
        "(validated before calling Keka).",
      inputSchema: {
        projectId: z.string().min(1).describe("Keka project ID to fetch time entries for (required)."),
        from: z.string().optional().describe("Start date. Defaults to 30 days before 'to' if omitted."),
        to: z.string().optional().describe("End date. Defaults to today if omitted."),
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
    safeHandler("get_project_time_entries", async ({ projectId, from, to, employeeIds, pageSize }) => {
      assertValidDateRange(from, to);
      const size = clampPageSize(pageSize);
      const { data, pagesFetched, totalRecords } = await paginateAll<TimeEntry>(
        (pageNumber, ps) =>
          client.get<KekaPagedResponse<TimeEntry>>(`/api/v1/psa/projects/${encodeURIComponent(projectId)}/timeentries`, {
            from,
            to,
            employeeIds,
            pageNumber,
            pageSize: ps,
          }),
        size
      );
      return jsonResult({ projectId, totalRecords, pagesFetched, count: data.length, entries: annotateStatus(data) });
    })
  );
}
