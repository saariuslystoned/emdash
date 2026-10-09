import { randomUUID } from "node:crypto";

import { SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { POST as privatePdfPOST } from "../../../src/astro/routes/api/plugin-assets/[pluginId]/pdf.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { pluginResponse } from "../../../src/plugin-types.js";
import { definePlugin, definePluginRoute } from "../../../src/plugins/define-plugin.js";
import { dispatchPluginApiRequest } from "../../../src/plugins/http-route-dispatch.js";
import type { PluginRoute } from "../../../src/plugins/types.js";

const runtimes: EmDashRuntime[] = [];

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
});

async function invoke(route: PluginRoute, request: Request) {
	const runtime = await EmDashRuntime.create({
		config: { database: { entrypoint: randomUUID(), config: {}, type: "sqlite" } },
		plugins: [definePlugin({ id: "raw-demo", version: "1.0.0", routes: { test: route } })],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	});
	runtimes.push(runtime);
	return dispatchPluginApiRequest({
		runtime,
		pluginId: "raw-demo",
		path: "/test",
		request,
	});
}

async function invokePrivatePdf(
	route: PluginRoute,
	body: unknown,
	user?: { role: number },
	tokenScopes?: string[],
) {
	const runtime = await EmDashRuntime.create({
		config: { database: { entrypoint: randomUUID(), config: {}, type: "sqlite" } },
		plugins: [definePlugin({ id: "raw-demo", version: "1.0.0", routes: { test: route } })],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	});
	runtimes.push(runtime);
	return privatePdfPOST({
		params: { pluginId: "raw-demo" },
		request: new Request("https://example.com/_emdash/api/plugin-assets/raw-demo/pdf", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-EmDash-Request": "1",
				"Content-Length": String(JSON.stringify(body).length),
			},
			body: JSON.stringify(body),
		}),
		locals: {
			emdash: runtime,
			user: user
				? {
						id: "user-1",
						email: "user@example.test",
						name: null,
						role: user.role,
						createdAt: new Date(),
					}
				: null,
			tokenScopes,
		},
	} as never);
}

describe("trusted raw plugin route runtime", () => {
	it("preserves request and response bytes across the full runtime boundary", async () => {
		const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0, 13, 10, 128]);
		const response = await invoke(
			definePluginRoute({
				public: true,
				methods: ["POST"],
				request: { body: "bytes", maxBytes: 1024 },
				response: "raw",
				handler: async ({ input }) =>
					pluginResponse({
						status: 202,
						headers: { "content-type": "application/octet-stream" },
						body: { kind: "bytes", value: input },
					}),
			}),
			new Request("https://example.com/_emdash/api/plugins/raw-demo/test", {
				method: "POST",
				body: bytes,
			}),
		);
		expect(response.status).toBe(202);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
	});

	it("preserves webhook text and keeps legacy JSON parsing unchanged", async () => {
		const text = '{  "b": 1,\r\n  "a": "x"  }';
		let delivered = "";
		const textResponse = await invoke(
			definePluginRoute({
				public: true,
				request: { body: "text" },
				handler: async ({ input }) => {
					delivered = input;
					return { ok: true };
				},
			}),
			new Request("https://example.com/_emdash/api/plugins/raw-demo/test", {
				method: "POST",
				body: text,
			}),
		);
		expect(textResponse.status).toBe(200);
		expect(delivered).toBe(text);

		let legacyInput: unknown;
		const legacyResponse = await invoke(
			{
				public: true,
				handler: async ({ input }) => {
					legacyInput = input;
					return { ok: true };
				},
			},
			new Request("https://example.com/_emdash/api/plugins/raw-demo/test", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: text,
			}),
		);
		expect(legacyResponse.status).toBe(200);
		expect(legacyInput).toEqual({ a: "x", b: 1 });
	});

	it("returns a bounded request error before invoking the handler", async () => {
		let invoked = false;
		const response = await invoke(
			definePluginRoute({
				public: true,
				request: { body: "bytes", maxBytes: 2 },
				handler: async () => {
					invoked = true;
					return null;
				},
			}),
			new Request("https://example.com/_emdash/api/plugins/raw-demo/test", {
				method: "POST",
				body: new Uint8Array([1, 2, 3]),
			}),
		);
		expect(response.status).toBe(413);
		expect(invoked).toBe(false);
	});

	it("reauthorizes the private PDF handoff and preserves exact PDF bytes", async () => {
		const bytes = new Uint8Array([37, 80, 68, 70, 45, 1, 2, 3]);
		const route = definePluginRoute({
			methods: ["GET"],
			response: "raw",
			handler: async () =>
				pluginResponse({
					headers: { "content-type": "application/pdf" },
					body: { kind: "bytes", value: bytes },
				}),
		});
		const denied = await invokePrivatePdf(route, {
			route: "/test",
			object: { documentId: "doc-1" },
			intent: "view",
		});
		expect(denied.status).toBe(401);

		const response = await invokePrivatePdf(
			route,
			{
				route: "/test",
				object: { documentId: "doc-1" },
				intent: "download",
				filename: "invoice.pdf",
			},
			{ role: 50 },
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("application/pdf");
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Content-Disposition")).toContain("attachment");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
	});

	it("retains role and token scope authorization before invoking the PDF handler", async () => {
		let calls = 0;
		const route = definePluginRoute({
			methods: ["GET"],
			request: { body: "none" },
			response: "raw",
			handler: async () => {
				calls++;
				return pluginResponse({
					headers: { "content-type": "application/pdf" },
					body: { kind: "bytes", value: new Uint8Array([37, 80, 68, 70, 45]) },
				});
			},
		});
		const body = { route: "/test", object: { id: "one" }, intent: "view" };
		expect((await invokePrivatePdf(route, body, { role: 10 })).status).toBe(403);
		expect((await invokePrivatePdf(route, body, { role: 50 }, ["content:read"])).status).toBe(403);
		expect(calls).toBe(0);
		expect((await invokePrivatePdf(route, body, { role: 50 }, ["admin"])).status).toBe(200);
		expect(calls).toBe(1);
	});

	it.each([
		["empty", new Uint8Array(), 502],
		["invalid signature", new TextEncoder().encode("plain data"), 502],
		["over dispatcher response limit", new Uint8Array(8 * 1024 * 1024 + 1), 502],
	])("rejects %s PDF bytes", async (_label, bytes, status) => {
		const route = definePluginRoute({
			methods: ["GET"],
			response: "raw",
			handler: async () =>
				pluginResponse({
					headers: { "content-type": "application/pdf" },
					body: { kind: "bytes", value: bytes },
				}),
		});
		const response = await invokePrivatePdf(
			route,
			{ route: "/test", object: { id: "one" }, intent: "download" },
			{ role: 50 },
		);
		expect(response.status).toBe(status);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	});

	it.each([
		["100%.pdf", "100%.pdf"],
		[`${"a".repeat(155)}😀`, `${"a".repeat(155)}😀.pdf`],
		["lone\ud800.pdf", "lone_.pdf"],
	])("safely encodes filename %s", async (name, expectedName) => {
		const route = definePluginRoute({
			methods: ["GET"],
			response: "raw",
			handler: async () =>
				pluginResponse({
					headers: { "content-type": "application/pdf" },
					body: { kind: "bytes", value: new Uint8Array([37, 80, 68, 70, 45]) },
				}),
		});
		const response = await invokePrivatePdf(
			route,
			{ route: "/test", object: { id: "one" }, intent: "download", filename: name },
			{ role: 50 },
		);
		expect(response.status).toBe(200);
		const disposition = response.headers.get("Content-Disposition")!;
		const encoded = disposition.split("filename*=UTF-8''")[1]!;
		const decoded = decodeURIComponent(encoded);
		expect(decoded).toBe(expectedName);
	});

	it("denies public route declarations", async () => {
		const response = await invokePrivatePdf(
			definePluginRoute({
				methods: ["GET"],
				public: true,
				response: "raw",
				handler: async () =>
					pluginResponse({
						headers: { "content-type": "application/pdf" },
						body: { kind: "bytes", value: new Uint8Array([37, 80, 68, 70, 45]) },
					}),
			}),
			{ route: "/test", object: { documentId: "doc-1" }, intent: "view" },
			{ role: 50 },
		);
		expect(response.status).toBe(400);
	});

	it.each([
		["non-GET", { methods: ["POST"] as const, response: "raw" as const }, 400],
		["wrong MIME", { methods: ["GET"] as const, response: "raw" as const }, 502],
	])("rejects %s route declarations or responses", async (_name, options, expectedStatus) => {
		const response = await invokePrivatePdf(
			definePluginRoute({
				...options,
				handler: async () =>
					pluginResponse({
						headers: { "content-type": "text/plain" },
						body: { kind: "text", value: "not a PDF" },
					}),
			}),
			{ route: "/test", object: { documentId: "doc-1" }, intent: "view" },
			{ role: 50 },
		);
		expect(response.status).toBe(expectedStatus);
		expect(response.headers.get("Cache-Control")).toContain("no-store");
	});

	it("rejects malformed target paths and reserved request fields", async () => {
		const route = definePluginRoute({
			methods: ["GET"],
			response: "raw",
			handler: async () =>
				pluginResponse({
					headers: { "content-type": "application/pdf" },
					body: { kind: "bytes", value: new Uint8Array([37, 80, 68, 70, 45]) },
				}),
		});
		expect(
			(
				await invokePrivatePdf(
					route,
					{ route: "/test/../other", object: { id: "x" }, intent: "view" },
					{ role: 50 },
				)
			).status,
		).toBe(400);
		expect(
			(
				await invokePrivatePdf(
					route,
					{ route: "/test", object: { "x/y": "x" }, intent: "view" },
					{ role: 50 },
				)
			).status,
		).toBe(400);
	});
});
