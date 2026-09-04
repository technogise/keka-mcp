// One-off smoke test (not part of the deliverable): drives the running
// Docker container as a real MCP client over stdio to prove the wiring
// works - initialize, list tools, call each of the seven tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const envFile = process.argv[2] ?? ".env";

const transport = new StdioClientTransport({
  command: "docker",
  args: ["run", "--rm", "-i", "--env-file", envFile, "keka-mcp"],
  stderr: "pipe",
});

const client = new Client({ name: "smoke-test-client", version: "0.0.1" });

transport.stderr?.on("data", (chunk) => {
  process.stderr.write(`[container stderr] ${chunk}`);
});

await client.connect(transport);
console.log("=== initialized OK ===");

const tools = await client.listTools();
console.log("=== tools discovered ===");
console.log(tools.tools.map((t) => t.name).join(", "));

const expected = [
  "get_timesheet_entries",
  "get_project_time_entries",
  "get_employees",
  "get_projects",
  "get_clients",
  "get_leaves",
  "get_holidays",
];
for (const t of tools.tools) {
  if (!expected.includes(t.name)) {
    throw new Error(`Unexpected tool registered: ${t.name}`);
  }
}
for (const name of expected) {
  if (!tools.tools.some((t) => t.name === name)) throw new Error(`Missing expected tool: ${name}`);
}
console.log(`=== all ${expected.length} expected tools present ===`);

async function callAndPrint(name, args) {
  console.log(`\n--- calling ${name}(${JSON.stringify(args)}) ---`);
  const result = await client.callTool({ name, arguments: args });
  console.log(`isError=${result.isError ?? false}`);
  const text = result.content?.[0]?.text ?? "(no content)";
  console.log(text.slice(0, 500));
  return result;
}

// 1) Valid-shaped calls against dummy credentials - expect a clean
//    isError result (auth will fail against the placeholder sandbox host),
//    NOT a crash and NOT a raw stack trace.
const r1 = await callAndPrint("get_timesheet_entries", { from: "2026-06-01", to: "2026-06-15" });
const r2 = await callAndPrint("get_project_time_entries", { projectId: "proj-123", from: "2026-06-01", to: "2026-06-15" });
const r3 = await callAndPrint("get_employees", {});
const r4 = await callAndPrint("get_projects", {});
const r6 = await callAndPrint("get_clients", {});
const r7 = await callAndPrint("get_leaves", { from: "2026-06-01", to: "2026-06-15" });
const r8 = await callAndPrint("get_holidays", { calendarYear: 2026 });

// 2) Intentionally invalid date range - must be rejected client-side
//    WITHOUT ever calling the (dummy) Keka host.
const r5 = await callAndPrint("get_timesheet_entries", { from: "2026-01-01", to: "2026-12-01" });

for (const [label, r] of [
  ["get_timesheet_entries", r1],
  ["get_project_time_entries", r2],
  ["get_employees", r3],
  ["get_projects", r4],
  ["get_clients", r6],
  ["get_leaves", r7],
  ["get_holidays", r8],
]) {
  if (r.isError !== true) throw new Error(`${label}: expected isError=true against dummy credentials, got ${r.isError}`);
}
if (r5.isError !== true) throw new Error("60-day validation: expected isError=true");
// Real sandbox limit is 60 days, not the 90 originally spec'd - see README "Discovery: the
// real date-range limit is 60 days, not 90".
if (!/60 days/.test(r5.content[0].text)) throw new Error("60-day validation: error message doesn't mention the 60-day limit");

console.log("\n=== ALL SMOKE CHECKS PASSED ===");
await client.close();
process.exit(0);
