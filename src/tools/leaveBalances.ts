import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KekaClient, paginateAll, type KekaPagedResponse } from "../kekaClient.js";
import { clampPageSize, jsonResult, safeHandler } from "./helpers.js";

// GET /time/leavebalance returns one row per employee, each carrying a list
// of per-leave-type balances. It is a point-in-time snapshot (current
// balances), so unlike get_leaves there is no date range to validate. The
// per-type fields are typed loosely and passed through unmodified. Observed
// in the sandbox: `annualQuota: -1` on types with no fixed quota (e.g.
// Unpaid Leave), so -1 is preserved raw rather than reinterpreted.
interface LeaveTypeBalance {
  leaveTypeId?: string;
  leaveTypeName?: string;
  annualQuota?: number;
  accruedAmount?: number;
  consumedAmount?: number;
  availableBalance?: number;
  [key: string]: unknown;
}

interface EmployeeLeaveBalance {
  employeeIdentifier?: string | null;
  employeeNumber?: string | null;
  employeeName?: string | null;
  leaveBalance?: LeaveTypeBalance[];
  [key: string]: unknown;
}

export function registerLeaveBalanceTools(server: McpServer, client: KekaClient): void {
  server.registerTool(
    "get_leavebalance",
    {
      title: "Get leave balances",
      description:
        "Fetch current leave balances for employees from Keka. Returns one entry per employee, each " +
        "with a breakdown per leave type (annualQuota, accruedAmount, consumedAmount, availableBalance, as " +
        "returned by Keka; annualQuota is -1 for types with no fixed quota, e.g. unpaid leave). " +
        "Optionally filter by employee IDs and/or leave type IDs. Automatically pages through the " +
        "entire result set and returns it combined.",
      inputSchema: {
        employeeIds: z.string().optional().describe("Comma-separated Keka employee IDs to filter by."),
        leaveTypeIds: z.string().optional().describe("Comma-separated Keka leave type IDs to filter by."),
        pageSize: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe("Page size used internally per request to Keka (max 200, default 100)."),
      },
    },
    safeHandler("get_leavebalance", async ({ employeeIds, leaveTypeIds, pageSize }) => {
      const size = clampPageSize(pageSize);
      const { data, pagesFetched, totalRecords } = await paginateAll<EmployeeLeaveBalance>(
        (pageNumber, ps) =>
          client.get<KekaPagedResponse<EmployeeLeaveBalance>>("/api/v1/time/leavebalance", {
            employeeIds,
            leaveTypeIds,
            pageNumber,
            pageSize: ps,
          }),
        size
      );
      return jsonResult({ totalRecords, pagesFetched, count: data.length, leaveBalances: data });
    })
  );
}
