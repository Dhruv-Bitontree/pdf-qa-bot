import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We need to test the API client module
describe("API Client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should make login request", async () => {
    const mockResponse = {
      user: { id: 1, email: "test@test.com", name: "Test" },
      token: "jwt-token-123",
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    // Dynamic import to get fresh module
    const { api } = await import("@/lib/api");

    const result = await api.login("test@test.com", "password123");
    expect(result.token).toBe("jwt-token-123");
    expect(result.user.email).toBe("test@test.com");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/auth/login"),
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("should throw on error response", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: "Invalid credentials" }),
    });

    const { api } = await import("@/lib/api");

    await expect(api.login("bad@test.com", "wrong")).rejects.toThrow(
      "Invalid credentials"
    );
  });

  it("should include auth token in requests", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const { api } = await import("@/lib/api");
    api.setToken("my-token");

    await api.getDocuments();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/documents"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer my-token",
        }),
      })
    );
  });
});
