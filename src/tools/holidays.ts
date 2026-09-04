import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KekaClient, paginateAll, type KekaPagedResponse } from "../kekaClient.js";
import { clampPageSize, jsonResult, safeHandler } from "./helpers.js";

// Keka scopes holidays per calendar, not org-wide: GET /time/holidayscalendar
// lists the calendars (id + name only, no dates), and the actual holiday
// dates live behind GET /time/holidayscalendar/{calendarId}/holidays. Most
// tenants have exactly one calendar, but multi-region tenants can have
// several (e.g. one per country/office). To keep this tool as auto-pages-
// everything as the rest of them, `calendarId` is optional here: if omitted,
// every calendar is looked up first and holidays from all of them are
// fetched and combined, each tagged with the calendarId/calendarName it
// came from. Pass `calendarId` to restrict to just one.
interface HolidayCalendar {
  id: string;
  name?: string | null;
  [key: string]: unknown;
}

interface Holiday {
  id: string;
  name?: string | null;
  date: string;
  isFloater?: boolean;
  [key: string]: unknown;
}

interface HolidayWithCalendar extends Holiday {
  calendarId: string;
  calendarName?: string | null;
}

export function registerHolidayTools(server: McpServer, client: KekaClient): void {
  server.registerTool(
    "get_holidays",
    {
      title: "Get holidays",
      description:
        "Fetch holidays from Keka's holiday calendar(s). Keka scopes holidays per calendar rather than " +
        "org-wide, so if 'calendarId' is omitted this tool first looks up every holiday calendar and " +
        "then fetches and combines holidays from all of them (most tenants only have one). Each returned " +
        "holiday is tagged with the calendarId/calendarName it came from. Automatically pages through " +
        "every result set involved and returns it combined.",
      inputSchema: {
        calendarId: z
          .string()
          .optional()
          .describe("Restrict to a single holiday calendar ID. If omitted, holidays from every calendar are fetched and combined."),
        calendarYear: z
          .number()
          .int()
          .optional()
          .describe("Filter holidays to a specific calendar year (e.g. 2026). Omit to get all years Keka has data for."),
        pageSize: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe("Page size used internally per request to Keka (max 200, default 100)."),
      },
    },
    safeHandler("get_holidays", async ({ calendarId, calendarYear, pageSize }) => {
      const size = clampPageSize(pageSize);

      const fetchHolidaysForCalendar = (calId: string) =>
        paginateAll<Holiday>(
          (pageNumber, ps) =>
            client.get<KekaPagedResponse<Holiday>>(`/api/v1/time/holidayscalendar/${encodeURIComponent(calId)}/holidays`, {
              calendarYear,
              pageNumber,
              pageSize: ps,
            }),
          size
        );

      if (calendarId) {
        const { data, pagesFetched, totalRecords } = await fetchHolidaysForCalendar(calendarId);
        const holidays: HolidayWithCalendar[] = data.map((h) => ({ ...h, calendarId }));
        return jsonResult({ totalRecords, pagesFetched, count: holidays.length, holidays });
      }

      const { data: calendars } = await paginateAll<HolidayCalendar>(
        (pageNumber, ps) =>
          client.get<KekaPagedResponse<HolidayCalendar>>("/api/v1/time/holidayscalendar", {
            pageNumber,
            pageSize: ps,
          }),
        size
      );

      let pagesFetched = 0;
      let totalRecords = 0;
      const holidays: HolidayWithCalendar[] = [];
      for (const cal of calendars) {
        const page = await fetchHolidaysForCalendar(cal.id);
        pagesFetched += page.pagesFetched;
        totalRecords += page.totalRecords;
        holidays.push(...page.data.map((h) => ({ ...h, calendarId: cal.id, calendarName: cal.name })));
      }

      return jsonResult({ calendarsFetched: calendars.length, totalRecords, pagesFetched, count: holidays.length, holidays });
    })
  );
}
