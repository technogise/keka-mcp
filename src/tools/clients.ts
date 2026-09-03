import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KekaClient, paginateAll, type KekaPagedResponse } from "../kekaClient.js";
import { clampPageSize, jsonResult, safeHandler } from "./helpers.js";

interface Client {
  id: string;
  identifier?: string | null;
  name?: string | null;
  code?: string | null;
  status?: number | null;
  isArchived?: boolean | null;
  [key: string]: unknown;
}

export function registerClientTools(server: McpServer, client: KekaClient): void {
  server.registerTool(
    "get_clients",
    {
      title: "Get clients",
      description:
        "Fetch all PSA clients (customers) from Keka. Automatically pages through the entire result " +
        "set and returns it combined. Use this to map a project's clientId (from get_projects) to a " +
        "readable client/customer name for reporting.",
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
    safeHandler("get_clients", async ({ pageSize }) => {
      const size = clampPageSize(pageSize);
      const { data, pagesFetched, totalRecords } = await paginateAll<Client>(
        (pageNumber, ps) =>
          client.get<KekaPagedResponse<Client>>("/api/v1/psa/clients", {
            pageNumber,
            pageSize: ps,
          }),
        size
      );
      return jsonResult({ totalRecords, pagesFetched, count: data.length, clients: data });
    })
  );
}
