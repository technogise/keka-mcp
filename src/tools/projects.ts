import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KekaClient, paginateAll, type KekaPagedResponse } from "../kekaClient.js";
import { clampPageSize, jsonResult, safeHandler } from "./helpers.js";

interface Project {
  id: string;
  identifier?: string | null;
  clientId?: string | null;
  name?: string | null;
  code?: string | null;
  status?: number | null;
  isBillable?: boolean | null;
  isArchived?: boolean | null;
  [key: string]: unknown;
}

export function registerProjectTools(server: McpServer, client: KekaClient): void {
  server.registerTool(
    "get_projects",
    {
      title: "Get projects",
      description:
        "Fetch all PSA projects from Keka. Automatically pages through the entire result set and " +
        "returns it combined. Use this to map project IDs found in timesheet data to project names.",
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
    safeHandler("get_projects", async ({ pageSize }) => {
      const size = clampPageSize(pageSize);
      const { data, pagesFetched, totalRecords } = await paginateAll<Project>(
        (pageNumber, ps) =>
          client.get<KekaPagedResponse<Project>>("/api/v1/psa/projects", {
            pageNumber,
            pageSize: ps,
          }),
        size
      );
      return jsonResult({ totalRecords, pagesFetched, count: data.length, projects: data });
    })
  );
}
