import { describe, it, expect, vi } from "vitest";
import { TokenManager, type KekaConfig } from "../auth.js";

const config: KekaConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  apiKey: "test-api-key",
  baseUrl: "https://sandbox.keka.com",
  tokenUrl: "https://login.kekademo.com/connect/token",
};

function makeFetchMock(responses: Array<{ status: number; body: unknown }>) {
  let call = 0;
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    const r = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {
      ok: r.status < 400,
      status: r.status,
      statusText: "",
      text: async () => JSON.stringify(r.body),
    } as unknown as Response;
  });
  return fn;
}

describe("TokenManager.getValidToken", () => {
  it("reuses a cached token while it is still valid", async () => {
    let now = 1_000_000;
    const fetchMock = makeFetchMock([{ status: 200, body: { access_token: "tok1", expires_in: 3600 } }]);
    const tm = new TokenManager(config, fetchMock as unknown as typeof fetch, () => now);

    const t1 = await tm.getValidToken();
    now += 10_000; // 10s later, well within the 3600s expiry
    const t2 = await tm.getValidToken();

    expect(t1).toBe("tok1");
    expect(t2).toBe("tok1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-runs the API-key exchange on expiry when no refresh_token was issued", async () => {
    let now = 1_000_000;
    const fetchMock = makeFetchMock([
      { status: 200, body: { access_token: "tok1", expires_in: 100 } },
      { status: 200, body: { access_token: "tok2", expires_in: 100 } },
    ]);
    const tm = new TokenManager(config, fetchMock as unknown as typeof fetch, () => now);

    const t1 = await tm.getValidToken();
    now += 10_000_000; // well past the 100s expiry
    const t2 = await tm.getValidToken();

    expect(t1).toBe("tok1");
    expect(t2).toBe("tok2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const body = (call[1]?.body as string) ?? "";
      expect(body).toContain("grant_type=kekaapi");
      expect(body).not.toContain("grant_type=refresh_token");
    }
  });

  it("uses the refresh_token endpoint instead of re-running the API-key exchange when a refresh_token is cached", async () => {
    let now = 1_000_000;
    const fetchMock = makeFetchMock([
      { status: 200, body: { access_token: "tok1", expires_in: 100, refresh_token: "refresh-abc" } },
      { status: 200, body: { access_token: "tok2", expires_in: 100 } },
    ]);
    const tm = new TokenManager(config, fetchMock as unknown as typeof fetch, () => now);

    await tm.getValidToken();
    now += 10_000_000; // well past expiry
    const t2 = await tm.getValidToken();

    expect(t2).toBe("tok2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = (fetchMock.mock.calls[1][1]?.body as string) ?? "";
    expect(secondBody).toContain("grant_type=refresh_token");
    expect(secondBody).toContain("refresh-abc");
  });

  it("falls back to a full API-key exchange if the refresh_token call fails", async () => {
    let now = 1_000_000;
    const fetchMock = makeFetchMock([
      { status: 200, body: { access_token: "tok1", expires_in: 100, refresh_token: "refresh-abc" } },
      { status: 400, body: { error: "invalid_grant" } },
      { status: 200, body: { access_token: "tok3", expires_in: 100 } },
    ]);
    const tm = new TokenManager(config, fetchMock as unknown as typeof fetch, () => now);

    await tm.getValidToken();
    now += 10_000_000;
    const t2 = await tm.getValidToken();

    expect(t2).toBe("tok3");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const thirdBody = (fetchMock.mock.calls[2][1]?.body as string) ?? "";
    expect(thirdBody).toContain("grant_type=kekaapi");
  });

  it("throws a clear error when the token endpoint returns a non-2xx response", async () => {
    const fetchMock = makeFetchMock([{ status: 401, body: { error: "invalid_client" } }]);
    const tm = new TokenManager(config, fetchMock as unknown as typeof fetch, () => Date.now());

    await expect(tm.getValidToken()).rejects.toThrow(/invalid_client/);
  });
});
