import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KekaClient, paginateAll, type KekaPagedResponse } from "../kekaClient.js";
import { clampPageSize, jsonResult, safeHandler } from "./helpers.js";

interface Employee {
  id: string;
  employeeNumber?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  email?: string | null;
  jobTitle?: string | null;
  employmentStatus?: string | null;
  [key: string]: unknown;
}

export function registerEmployeeTools(server: McpServer, client: KekaClient): void {
  server.registerTool(
    "get_employees",
    {
      title: "Get employees",
      description:
        "Fetch all employees from Keka HRIS. Automatically pages through the entire result set and " +
        "returns it combined. Use this to map employee IDs found in timesheet data to names, job " +
        "titles, and employment status.",
      inputSchema: {
        pageSize: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe("Page size used internally per request to Keka (max 200, default 100)."),
      },
    },
    safeHandler("get_employees", async ({ pageSize }) => {
      const size = clampPageSize(pageSize);
      const { data, pagesFetched, totalRecords } = await paginateAll<Employee>(
        (pageNumber, ps) =>
          client.get<KekaPagedResponse<Employee>>("/api/v1/hris/employees", {
            pageNumber,
            pageSize: ps,
          }),
        size
      );
      return jsonResult({ totalRecords, pagesFetched, count: data.length, employees: data });
    })
  );
}
