import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/auth", () => ({ authenticate: vi.fn() }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));
vi.mock("astro:middleware", () => ({ defineMiddleware: (handler: unknown) => handler }));
const { getUserById } = vi.hoisted(() => ({ getUserById: vi.fn() }));
vi.mock("@emdash-cms/auth/adapters/kysely", () => ({
	createKyselyAdapter: () => ({ getUserById }),
}));
import { onRequest } from "../../../src/astro/middleware/auth.js";
import { buildEmDashCsp } from "../../../src/astro/middleware/csp.js";

afterEach(() => vi.unstubAllEnvs());
const PASSIVE = "sandbox; default-src 'none'; frame-ancestors 'none'";

describe("production private PDF response policy", () => {
	it.each([
		["/_emdash/api/plugin-assets/r_fixture/pdf", PASSIVE, PASSIVE],
		["/_emdash/api/plugin-assets/r_fixture/pdf", "default-src *", buildEmDashCsp()],
		["/_emdash/api/admin/plugins", PASSIVE, buildEmDashCsp()],
	])("keeps the strict policy only on the mediator: %s", async (path, policy, expected) => {
		vi.stubEnv("DEV", false);
		getUserById.mockResolvedValue({ id: "fixture-user", role: 50, disabled: false });
		const url = new URL(path, "https://example.test");
		const response = await onRequest(
			{
				url,
				request: new Request(url, { method: "POST", headers: { "X-EmDash-Request": "1" } }),
				locals: { emdash: { db: {}, config: {} } },
				session: { get: async () => ({ id: "fixture-user" }) },
			} as never,
			async () => new Response("fixture", { headers: { "Content-Security-Policy": policy } }),
		);
		expect(response.headers.get("Content-Security-Policy")).toBe(expected);
	});
});
