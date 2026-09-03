import { describe, it, expect, vi } from "vitest";
import { paginateAll, type KekaPagedResponse } from "../kekaClient.js";

interface Row {
  id: number;
}

function page(data: Row[], pageNumber: number, totalPages: number, totalRecords: number): KekaPagedResponse<Row> {
  return {
    succeeded: true,
    message: null,
    errors: null,
    data,
    pageNumber,
    pageSize: 2,
    totalPages,
    totalRecords,
  };
}

describe("paginateAll", () => {
  it("combines results across 3 pages into one result set", async () => {
    const pages = [
      page([{ id: 1 }, { id: 2 }], 1, 3, 5),
      page([{ id: 3 }, { id: 4 }], 2, 3, 5),
      page([{ id: 5 }], 3, 3, 5),
    ];
    const fetchPage = vi.fn(async (pageNumber: number) => pages[pageNumber - 1]);

    const result = await paginateAll(fetchPage, 2);

    expect(result.data.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(result.pagesFetched).toBe(3);
    expect(result.totalRecords).toBe(5);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    // Confirms it looped through pageNumber 1, 2, 3 in order.
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  it("returns all rows from a single-page result without over-fetching", async () => {
    const fetchPage = vi.fn(async () => page([{ id: 1 }, { id: 2 }], 1, 1, 2));

    const result = await paginateAll(fetchPage, 2);

    expect(result.data).toHaveLength(2);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("stops on an empty page even if totalPages implies more remain", async () => {
    const fetchPage = vi.fn(async (pageNumber: number) => {
      if (pageNumber === 1) return page([{ id: 1 }], 1, 5, 1);
      return page([], pageNumber, 5, 1);
    });

    const result = await paginateAll(fetchPage, 10);

    expect(result.data).toHaveLength(1);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});

// get_clients (src/tools/clients.ts) uses this exact same paginateAll helper,
// same as get_projects and get_employees - these cases exercise it against a
// Client-shaped row to confirm that tool's pagination behaves identically.
interface ClientRow {
  id: string;
  name: string;
}

function clientPage(
  data: ClientRow[],
  pageNumber: number,
  totalPages: number,
  totalRecords: number
): KekaPagedResponse<ClientRow> {
  return {
    succeeded: true,
    message: null,
    errors: null,
    data,
    pageNumber,
    pageSize: 2,
    totalPages,
    totalRecords,
  };
}

describe("paginateAll (get_clients)", () => {
  it("combines client results across 2 pages into one result set", async () => {
    const pages = [
      clientPage([{ id: "c1", name: "Acme" }, { id: "c2", name: "Globex" }], 1, 2, 3),
      clientPage([{ id: "c3", name: "Initech" }], 2, 2, 3),
    ];
    const fetchPage = vi.fn(async (pageNumber: number) => pages[pageNumber - 1]);

    const result = await paginateAll(fetchPage, 2);

    expect(result.data.map((r) => r.id)).toEqual(["c1", "c2", "c3"]);
    expect(result.pagesFetched).toBe(2);
    expect(result.totalRecords).toBe(3);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("returns all rows from a single-page client result without over-fetching", async () => {
    const fetchPage = vi.fn(async () => clientPage([{ id: "c1", name: "Acme" }], 1, 1, 1));

    const result = await paginateAll(fetchPage, 100);

    expect(result.data).toHaveLength(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("stops on an empty client page even if totalPages implies more remain", async () => {
    const fetchPage = vi.fn(async (pageNumber: number) => {
      if (pageNumber === 1) return clientPage([{ id: "c1", name: "Acme" }], 1, 4, 1);
      return clientPage([], pageNumber, 4, 1);
    });

    const result = await paginateAll(fetchPage, 10);

    expect(result.data).toHaveLength(1);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});
