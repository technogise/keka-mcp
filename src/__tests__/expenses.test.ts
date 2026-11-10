// Handler-level tests for the expense tools (src/tools/expenses.ts): each
// tool is called through a real MCP client/server pair over an in-memory
// transport, with the Keka HTTP client mocked. This checks the exact path
// and query each tool sends to Keka, that it pages through every page, the
// output shape, and that errors become clean isError results.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { KekaApiError, type KekaClient, type KekaPagedResponse } from "../kekaClient.js";
import { registerExpenseTools } from "../tools/expenses.js";

type GetMock = ReturnType<typeof vi.fn>;

function page<T>(data: T[], pageNumber: number, totalPages: number, totalRecords: number): KekaPagedResponse<T> {
  return { succeeded: true, message: null, errors: null, data, pageNumber, pageSize: 2, totalPages, totalRecords };
}

let get: GetMock;
let mcp: Client;

async function connect(): Promise<void> {
  get = vi.fn();
  const server = new McpServer({ name: "test", version: "0" });
  registerExpenseTools(server, { get } as unknown as KekaClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: "test-client", version: "0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await mcp.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0].text;
  return { isError: r.isError === true, text, json: r.isError ? undefined : JSON.parse(text) };
}

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await connect();
});

describe("expense tools registration", () => {
  it("registers exactly the five read-only expense tools", async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["get_advance_requests", "get_employee_expenses", "get_expense_categories", "get_expense_claims", "get_expense_policies"]
    );
  });

  it("requires employeeId on get_employee_expenses", async () => {
    const { tools } = await mcp.listTools();
    const t = tools.find((x) => x.name === "get_employee_expenses")!;
    expect(t.inputSchema.required).toEqual(["employeeId"]);
  });
});

describe("get_expense_claims", () => {
  it("pages through every page, combines claims, and preserves raw fields", async () => {
    const claim = (id: string) => ({
      id,
      employeeIdentifier: "e1",
      paymentStatus: 2,
      approvalStatus: 5,
      expenses: [{ id: `${id}-x`, amount: "3700.00 INR" }],
    });
    get
      .mockResolvedValueOnce(page([claim("c1"), claim("c2")], 1, 2, 3))
      .mockResolvedValueOnce(page([claim("c3")], 2, 2, 3));

    const { isError, json } = await call("get_expense_claims", {});

    expect(isError).toBe(false);
    expect(json).toMatchObject({ totalRecords: 3, pagesFetched: 2, count: 3 });
    expect(json.expenseClaims.map((c: { id: string }) => c.id)).toEqual(["c1", "c2", "c3"]);
    // raw numeric statuses and string amount with currency are untouched
    expect(json.expenseClaims[0]).toMatchObject({ paymentStatus: 2, approvalStatus: 5 });
    expect(json.expenseClaims[0].expenses[0].amount).toBe("3700.00 INR");
    expect(json.expenseClaims[0]).not.toHaveProperty("paymentStatusLabel");
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0][0]).toBe("/api/v1/expense/claims");
    expect(get.mock.calls[1][1]).toMatchObject({ pageNumber: 2 });
  });

  it("forwards employeeIds, expenseClaimIds, lastModified and a clamped pageSize", async () => {
    get.mockResolvedValueOnce(page([], 1, 0, 0));

    await call("get_expense_claims", {
      employeeIds: "e1,e2",
      expenseClaimIds: "c9",
      lastModified: "2026-10-01T00:00:00Z",
      pageSize: 150,
    });

    expect(get).toHaveBeenCalledWith("/api/v1/expense/claims", {
      employeeIds: "e1,e2",
      expenseClaimIds: "c9",
      lastModified: "2026-10-01T00:00:00Z",
      pageNumber: 1,
      pageSize: 150,
    });
  });

  it("rejects a pageSize over 200 at the schema level without calling Keka", async () => {
    const r = await mcp.callTool({ name: "get_expense_claims", arguments: { pageSize: 500 } });
    expect(r.isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it("turns a Keka API error into a clean isError result", async () => {
    get.mockRejectedValueOnce(
      new KekaApiError(403, "Keka API error calling /api/v1/expense/claims: Forbidden - authenticated but not permitted to call this endpoint.")
    );

    const { isError, text } = await call("get_expense_claims", {});

    expect(isError).toBe(true);
    expect(text).toMatch(/Forbidden/);
  });
});

describe("get_employee_expenses", () => {
  it("calls the per-employee path (URL-encoded) with from/to/lastModified", async () => {
    get.mockResolvedValueOnce(page([{ id: "x1", amount: "2999.16 INR" }], 1, 1, 1));

    const { json } = await call("get_employee_expenses", {
      employeeId: "abc/def",
      from: "2026-09-01",
      to: "2026-10-31",
      lastModified: "2026-09-15T00:00:00Z",
    });

    expect(get).toHaveBeenCalledWith("/api/v1/expense/employees/abc%2Fdef/expenses", {
      from: "2026-09-01",
      to: "2026-10-31",
      lastModified: "2026-09-15T00:00:00Z",
      pageNumber: 1,
      pageSize: 100,
    });
    expect(json).toMatchObject({ employeeId: "abc/def", totalRecords: 1, count: 1 });
    expect(json.expenses[0].amount).toBe("2999.16 INR");
  });

  it("accepts an exact 90-day range (61+ days, beyond the timesheet limit)", async () => {
    get.mockResolvedValueOnce(page([], 1, 0, 0));
    const { isError } = await call("get_employee_expenses", { employeeId: "e1", from: "2026-01-01", to: "2026-04-01" });
    expect(isError).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("rejects a 91-day range client-side without calling Keka", async () => {
    const { isError, text } = await call("get_employee_expenses", { employeeId: "e1", from: "2026-01-01", to: "2026-04-02" });
    expect(isError).toBe(true);
    expect(text).toMatch(/^Invalid request: .*90 days/);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects 'from' after 'to' without calling Keka", async () => {
    const { isError } = await call("get_employee_expenses", { employeeId: "e1", from: "2026-05-01", to: "2026-04-01" });
    expect(isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a missing or empty employeeId without calling Keka", async () => {
    expect((await mcp.callTool({ name: "get_employee_expenses", arguments: {} })).isError).toBe(true);
    expect((await mcp.callTool({ name: "get_employee_expenses", arguments: { employeeId: "" } })).isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("get_expense_categories / get_expense_policies", () => {
  it("get_expense_categories pages through categories", async () => {
    get
      .mockResolvedValueOnce(page([{ id: "k1", name: "Travel" }, { id: "k2", name: "Food" }], 1, 2, 3))
      .mockResolvedValueOnce(page([{ id: "k3", name: "Stay" }], 2, 2, 3));

    const { json } = await call("get_expense_categories");

    expect(get.mock.calls[0][0]).toBe("/api/v1/expense/categories");
    expect(json).toMatchObject({ totalRecords: 3, pagesFetched: 2, count: 3 });
    expect(json.categories.map((c: { name: string }) => c.name)).toEqual(["Travel", "Food", "Stay"]);
  });

  it("get_expense_policies returns policies from /expensepolicies", async () => {
    get.mockResolvedValueOnce(page([{ id: "p1", name: "Default", currency: { code: "INR" } }], 1, 1, 1));

    const { json } = await call("get_expense_policies");

    expect(get).toHaveBeenCalledWith("/api/v1/expensepolicies", { pageNumber: 1, pageSize: 100 });
    expect(json.policies[0]).toMatchObject({ id: "p1", currency: { code: "INR" } });
  });
});

describe("get_advance_requests", () => {
  it("forwards all filters, including approvalStatus=0 (falsy but valid)", async () => {
    get.mockResolvedValueOnce(page([{ id: "a1", approvalStatus: 0 }], 1, 1, 1));

    const { json } = await call("get_advance_requests", {
      employeeIds: "e1",
      advanceRequestIds: "a1",
      approvalStatus: 0,
      lastModified: "2026-01-01T00:00:00Z",
    });

    expect(get).toHaveBeenCalledWith("/api/v1/traveldesk/advancerequests", {
      employeeIds: "e1",
      advanceRequestIds: "a1",
      approvalStatus: 0,
      lastModified: "2026-01-01T00:00:00Z",
      pageNumber: 1,
      pageSize: 100,
    });
    expect(json).toMatchObject({ totalRecords: 1, count: 1 });
    expect(json.advanceRequests[0].id).toBe("a1");
  });

  it("rejects an out-of-range approvalStatus without calling Keka", async () => {
    const r = await mcp.callTool({ name: "get_advance_requests", arguments: { approvalStatus: 9 } });
    expect(r.isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it("stops on an empty page even if totalPages implies more remain", async () => {
    get
      .mockResolvedValueOnce(page([{ id: "a1" }], 1, 5, 1))
      .mockResolvedValueOnce(page([], 2, 5, 1));

    const { json } = await call("get_advance_requests");

    expect(json.count).toBe(1);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
