#!/usr/bin/env node
// MCP server entrypoint. Registers all thirteen read-only Keka tools and serves
// them over stdio. stdout is reserved for MCP protocol messages, so all
// logging here goes to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfigFromEnv, TokenManager } from "./auth.js";
import { KekaClient } from "./kekaClient.js";
import { registerTimeEntryTools } from "./tools/timeEntries.js";
import { registerEmployeeTools } from "./tools/employees.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerClientTools } from "./tools/clients.js";
import { registerLeaveTools } from "./tools/leaves.js";
import { registerHolidayTools } from "./tools/holidays.js";
import { registerLeaveBalanceTools } from "./tools/leaveBalances.js";
import { registerExpenseTools } from "./tools/expenses.js";

function log(...args: unknown[]): void {
  console.error("[keka-mcp]", ...args);
}

async function main(): Promise<void> {
  // Missing required env vars is the one class of error allowed to be
  // fatal at startup - everything after this point must keep the process
  // alive even when individual tool calls fail.
  const config = loadConfigFromEnv();

  const tokens = new TokenManager(config);
  const client = new KekaClient(config.baseUrl, tokens);

  const server = new McpServer({ name: "keka-mcp", version: "0.1.0" });

  registerTimeEntryTools(server, client);
  registerEmployeeTools(server, client);
  registerProjectTools(server, client);
  registerClientTools(server, client);
  registerLeaveTools(server, client);
  registerHolidayTools(server, client);
  registerLeaveBalanceTools(server, client);
  registerExpenseTools(server, client);

  // Last-resort safety net. Every tool handler already catches its own
  // errors (see tools/helpers.ts safeHandler), so these should not normally
  // fire - but if something unexpected slips through, log it and keep the
  // process (and the MCP connection) alive instead of exiting.
  process.on("uncaughtException", (err) => {
    log("uncaughtException (server stays alive):", err?.stack ?? err);
  });
  process.on("unhandledRejection", (reason) => {
    log("unhandledRejection (server stays alive):", reason);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(
    "connected via stdio. Registered tools: get_timesheet_entries, get_project_time_entries, get_employees, get_projects, get_clients, get_leaves, get_holidays, get_leavebalance, get_expense_claims, get_employee_expenses, get_expense_categories, get_expense_policies, get_advance_requests"
  );
}

main().catch((err) => {
  log("FATAL error during startup:", err?.stack ?? err);
  process.exit(1);
});
