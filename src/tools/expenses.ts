import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KekaClient, paginateAll, type KekaPagedResponse } from "../kekaClient.js";
import { assertValidDateRange, EXPENSE_MAX_DATE_RANGE_DAYS } from "../dateRange.js";
import { clampPageSize, jsonResult, safeHandler } from "./helpers.js";

// Read-only tools over Keka's Expense module (expense claims, individual
// expenses, categories, policies) and Travel Desk advance requests.
//
// Things confirmed against the live tenant that shape these tools:
//  - Status fields (approvalStatus 0-6, paymentStatus 0-2, per-advance
//    status 0-4) are documented as bare integers with no label mapping, so
//    - same as get_leaves - they are passed through raw, with no guessed
//    labels.
//  - Expense `amount` comes back as a string with the currency attached
//    (e.g. "3700.00 INR"), not a number. It is preserved as-is rather than
//    parsed, so the currency is never lost.
//  - /expense/employees/{employeeId}/expenses requires an employee ID (the
//    flat /expense/employees/expenses variant returns 400 "Employee ID is
//    required" without one) and enforces a 90-day from/to limit.
//  - /payroll/employees/componentclaims (reimbursable salary component
//    claims) returned 403 for this API key, so no tool wraps it yet.

interface LinkedEntity {
  entityType?: number;
  id?: string;
  name?: string | null;
  [key: string]: unknown;
}

interface Expense {
  id: string;
  title?: string | null;
  date?: string;
  expenseCategoryId?: string;
  distanceKM?: number | null;
  amount?: string | null;
  comment?: string | null;
  linkedEntity?: LinkedEntity | null;
  attachments?: { id: string; name?: string | null }[];
  lastModified?: string;
  [key: string]: unknown;
}

interface ExpenseClaim {
  id: string;
  employeeIdentifier?: string | null;
  employeeName?: string | null;
  claimNumber?: string | null;
  title?: string | null;
  paymentStatus?: number;
  approvalStatus?: number;
  submittedOn?: string;
  lastModified?: string;
  expenses?: Expense[];
  [key: string]: unknown;
}

interface ExpenseCategory {
  id: string;
  name?: string | null;
  code?: string | null;
  categoryType?: number;
  [key: string]: unknown;
}

interface ExpensePolicy {
  id: string;
  name?: string | null;
  [key: string]: unknown;
}

interface AdvanceRequest {
  id: string;
  employeeId?: string | null;
  employeeNumber?: string | null;
  employeeName?: string | null;
  claimNumber?: string | null;
  approvalStatus?: number;
  paymentStatus?: number;
  advances?: { id: string; amount?: number; currency?: string; status?: number; [key: string]: unknown }[];
  [key: string]: unknown;
}

const pageSizeSchema = z
  .number()
  .int()
  .positive()
  .max(200)
  .optional()
  .describe("Page size used internally per request to Keka (max 200, default 100).");

const lastModifiedSchema = z
  .string()
  .optional()
  .describe("Only return records modified after this date-time, in UTC (e.g. 2026-10-01T00:00:00Z).");

const RAW_STATUS_NOTE =
  "Numeric status fields (approvalStatus 0-6, paymentStatus 0-2) are preserved as returned - Keka's " +
  "docs don't publish a label mapping for them, so no guessed labels are added.";

export function registerExpenseTools(server: McpServer, client: KekaClient): void {
  server.registerTool(
    "get_expense_claims",
    {
      title: "Get expense claims",
      description:
        "Fetch expense (reimbursement) claims across the organization from Keka. Each claim includes the " +
        "employee, claim number, approval and payment status, and its line-item expenses (amount is a " +
        "string with currency, e.g. \"3700.00 INR\"). Optionally filter by employee IDs, claim IDs, or " +
        "last-modified time. Automatically pages through the entire result set and returns it combined. " +
        RAW_STATUS_NOTE,
      inputSchema: {
        employeeIds: z.string().optional().describe("Comma-separated Keka employee IDs to filter by."),
        expenseClaimIds: z.string().optional().describe("Comma-separated expense claim IDs to filter by."),
        lastModified: lastModifiedSchema,
        pageSize: pageSizeSchema,
      },
    },
    safeHandler("get_expense_claims", async ({ employeeIds, expenseClaimIds, lastModified, pageSize }) => {
      const { data, pagesFetched, totalRecords } = await paginateAll<ExpenseClaim>(
        (pageNumber, ps) =>
          client.get<KekaPagedResponse<ExpenseClaim>>("/api/v1/expense/claims", {
            employeeIds,
            expenseClaimIds,
            lastModified,
            pageNumber,
            pageSize: ps,
          }),
        clampPageSize(pageSize)
      );
      return jsonResult({ totalRecords, pagesFetched, count: data.length, expenseClaims: data });
    })
  );

  server.registerTool(
    "get_employee_expenses",
    {
      title: "Get an employee's expenses",
      description:
        "Fetch individual expense line items logged by one employee in Keka (Keka requires an employee " +
        "ID for this endpoint - for organization-wide data use get_expense_claims, which already " +
        "includes each claim's expenses). The 'from'..'to' range cannot exceed 90 days (validated before " +
        "calling Keka; if omitted, Keka applies its own recent default window). Amount is a string with " +
        "currency. Automatically pages through the entire result set and returns it combined.",
      inputSchema: {
        employeeId: z.string().min(1).describe("Keka employee ID (required)."),
        from: z.string().optional().describe("Start date (e.g. 2026-09-01)."),
        to: z.string().optional().describe("End date (e.g. 2026-11-30). At most 90 days after 'from'."),
        lastModified: lastModifiedSchema,
        pageSize: pageSizeSchema,
      },
    },
    safeHandler("get_employee_expenses", async ({ employeeId, from, to, lastModified, pageSize }) => {
      assertValidDateRange(from, to, EXPENSE_MAX_DATE_RANGE_DAYS);
      const { data, pagesFetched, totalRecords } = await paginateAll<Expense>(
        (pageNumber, ps) =>
          client.get<KekaPagedResponse<Expense>>(`/api/v1/expense/employees/${encodeURIComponent(employeeId)}/expenses`, {
            from,
            to,
            lastModified,
            pageNumber,
            pageSize: ps,
          }),
        clampPageSize(pageSize)
      );
      return jsonResult({ employeeId, totalRecords, pagesFetched, count: data.length, expenses: data });
    })
  );

  server.registerTool(
    "get_expense_categories",
    {
      title: "Get expense categories",
      description:
        "Fetch the organization's expense categories from Keka (id, name, code, type, and the custom " +
        "attributes each requires). Use to map an expense's expenseCategoryId to a readable category " +
        "name. Automatically pages through the entire result set and returns it combined.",
      inputSchema: { pageSize: pageSizeSchema },
    },
    safeHandler("get_expense_categories", async ({ pageSize }) => {
      const { data, pagesFetched, totalRecords } = await paginateAll<ExpenseCategory>(
        (pageNumber, ps) =>
          client.get<KekaPagedResponse<ExpenseCategory>>("/api/v1/expense/categories", { pageNumber, pageSize: ps }),
        clampPageSize(pageSize)
      );
      return jsonResult({ totalRecords, pagesFetched, count: data.length, categories: data });
    })
  );

  server.registerTool(
    "get_expense_policies",
    {
      title: "Get expense policies",
      description:
        "Fetch the organization's expense policies from Keka: currency, whether claims/travel/cash " +
        "advances are allowed, and per-category rules (amount and frequency limits, receipt " +
        "requirements, mileage settings). Automatically pages through the entire result set and " +
        "returns it combined.",
      inputSchema: { pageSize: pageSizeSchema },
    },
    safeHandler("get_expense_policies", async ({ pageSize }) => {
      const { data, pagesFetched, totalRecords } = await paginateAll<ExpensePolicy>(
        (pageNumber, ps) =>
          client.get<KekaPagedResponse<ExpensePolicy>>("/api/v1/expensepolicies", { pageNumber, pageSize: ps }),
        clampPageSize(pageSize)
      );
      return jsonResult({ totalRecords, pagesFetched, count: data.length, policies: data });
    })
  );

  server.registerTool(
    "get_advance_requests",
    {
      title: "Get advance requests",
      description:
        "Fetch travel/cash advance requests from Keka's Travel Desk across the organization. Each " +
        "request includes the employee, approval and payment status, and its advance line items " +
        "(amount, currency, per-item status). Optionally filter by employee IDs, advance request IDs, " +
        "approval status, or last-modified time. Automatically pages through the entire result set and " +
        "returns it combined. " +
        RAW_STATUS_NOTE +
        " Per-advance `status` (0-4) is likewise raw.",
      inputSchema: {
        employeeIds: z.string().optional().describe("Comma-separated Keka employee IDs to filter by."),
        advanceRequestIds: z.string().optional().describe("Comma-separated advance request IDs to filter by."),
        approvalStatus: z
          .number()
          .int()
          .min(0)
          .max(6)
          .optional()
          .describe("Filter by the raw numeric approvalStatus (0-6) as Keka returns it."),
        lastModified: lastModifiedSchema,
        pageSize: pageSizeSchema,
      },
    },
    safeHandler(
      "get_advance_requests",
      async ({ employeeIds, advanceRequestIds, approvalStatus, lastModified, pageSize }) => {
        const { data, pagesFetched, totalRecords } = await paginateAll<AdvanceRequest>(
          (pageNumber, ps) =>
            client.get<KekaPagedResponse<AdvanceRequest>>("/api/v1/traveldesk/advancerequests", {
              employeeIds,
              advanceRequestIds,
              approvalStatus,
              lastModified,
              pageNumber,
              pageSize: ps,
            }),
          clampPageSize(pageSize)
        );
        return jsonResult({ totalRecords, pagesFetched, count: data.length, advanceRequests: data });
      }
    )
  );
}
