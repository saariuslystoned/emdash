/**
 * Signed local Registry PDF conformance with a normal session created by virtual WebAuthn.
 * Runs against the default fixture URL (http://localhost:4444).
 *
 * Uses local signed Registry records, not public Registry publication.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "../fixtures";
import { refreshServerPatAfterDevBypass } from "../fixtures/refresh-server-pat";
import { addVirtualWebAuthnAuthenticator } from "../fixtures/virtual-authenticator";

const ADMIN_DASHBOARD_PATTERN = /\/_emdash\/admin\/?$/;

const SERVER_INFO_PATH = join(tmpdir(), "emdash-pw-server.json");

function fixtureBaseUrl(): string {
	return JSON.parse(readFileSync(SERVER_INFO_PATH, "utf-8")).baseUrl as string;
}

async function resetSetup(): Promise<void> {
	const base = fixtureBaseUrl();
	const res = await fetch(`${base}/_emdash/api/setup/dev-reset`, {
		method: "POST",
		headers: { "X-EmDash-Request": "1", Origin: base },
	});
	if (!res.ok) throw new Error(`dev-reset failed: ${res.status}`);
}

async function restoreFixtureSetup(): Promise<void> {
	await refreshServerPatAfterDevBypass(fixtureBaseUrl());
}

test.describe("Private PDF signed local Registry with passkey session", () => {
	test.describe.configure({ mode: "serial" });

	test.beforeEach(async () => {
		await resetSetup();
	});

	test.afterAll(async () => {
		await restoreFixtureSetup();
	});

	test("installs a signed sandbox plugin and reauthorizes PDF retrieval", async ({
		admin,
		page,
	}) => {
		test.setTimeout(180_000);
		const removeAuth = await addVirtualWebAuthnAuthenticator(page);

		try {
			await admin.goToSetup();

			await page.getByLabel("Site Title").fill("Virtual Auth Site");
			await page.getByRole("button", { name: "Continue" }).click();
			await expect(page.locator("text=Create your account")).toBeVisible();

			await page.getByLabel("Your Email").fill("virtual-auth@example.com");
			await page.getByLabel("Your Name").fill("Virtual Auth User");
			await page.getByRole("button", { name: "Continue" }).click();

			await expect(
				page.getByRole("heading", {
					name: "With a passkey, you don’t need to remember complex passwords",
				}),
			).toBeVisible();
			await page.getByRole("button", { name: "Create passkey" }).click();
			await expect(page.getByRole("heading", { name: "Passkey created" })).toBeVisible();
			await page.getByRole("button", { name: "Open the dashboard" }).click();

			// admin-verify now creates the session, so the wizard lands on the dashboard.
			await expect(page).toHaveURL(ADMIN_DASHBOARD_PATTERN, { timeout: 60_000 });
			await admin.waitForShell();

			await page.addInitScript(() => {
				localStorage.setItem(
					"emdash:did-handle:did:plc:delegated00000000000000",
					JSON.stringify({ resolution: { status: "missing" }, expiresAt: Date.now() + 60_000 }),
				);
			});
			await admin.goto("/plugins/registry/did:plc:delegated00000000000000/gallery");
			await admin.waitForShell();
			await expect(page.getByRole("heading", { name: "Gallery", exact: true })).toBeVisible({
				timeout: 15_000,
			});
			await page.getByLabel("Version").click();
			await page.getByRole("option", { name: "1.2.3" }).click();
			const verify = page.waitForResponse(
				(r) => r.url().endsWith("/plugins/registry/verify") && r.request().method() === "POST",
			);
			await page.getByRole("button", { name: "Install", exact: true }).click();
			expect((await verify).status()).toBe(200);
			const consent = page.getByRole("dialog", { name: "Capability consent" });
			const install = page.waitForResponse(
				(r) => r.url().endsWith("/plugins/registry/install") && r.request().method() === "POST",
			);
			await consent.getByRole("button", { name: "Accept & Install" }).click();
			expect((await install).status()).toBe(201);
			const installedResponse = await page.request.get("/_emdash/api/admin/plugins");
			const installedBody = await installedResponse.json();
			const installed = installedBody.data.items.find(
				(item: { source: string; registrySlug: string }) =>
					item.source === "registry" && item.registrySlug === "gallery",
			);
			expect(installed.id).toMatch(/^r_/);
			const endpoint = `/_emdash/api/plugin-assets/${installed.id}/pdf`;
			await page
				.context()
				.addCookies([{ name: "emdash-locale", value: "ar", domain: "localhost", path: "/" }]);
			await admin.goto(`/plugins/${installed.id}/overview`);
			await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
			await page.getByRole("button", { name: "View private PDF" }).click();
			await expect(page.locator('canvas[data-pdf-rendered="true"]')).toBeVisible();
			await expect(page.getByText("PRIVATE PDF FIXTURE", { exact: true })).toHaveCount(1);
			await page.screenshot({
				path: ".emdash/private-pdf-handoff-runs/signed-registry-ar-rtl.png",
				fullPage: true,
			});
			const downloadEvent = page.waitForEvent("download");
			await page.getByRole("button", { name: "Download private PDF" }).click();
			const download = await downloadEvent;
			await download.saveAs(".emdash/private-pdf-handoff-runs/downloaded-fixture.pdf");
			const stream = await download.createReadStream();
			const chunks: Buffer[] = [];
			for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
			const content = Buffer.concat(chunks);
			expect(content.length).toBe(604);
			expect(createHash("sha256").update(content).digest("hex")).toBe(
				"503dd5581e69b778088f5dae273d23315f5e50d371def81a1d23c0730137f8bb",
			);
			expect(download.suggestedFilename()).toBe("fixture-download.pdf");
			const headers = { "X-EmDash-Request": "1", Origin: fixtureBaseUrl() };
			const payload = {
				route: "/document",
				object: { documentId: "fixture-document" },
				intent: "view",
			};
			const wrongObject = await page.request.post(endpoint, {
				headers,
				data: { ...payload, object: { documentId: "other-document" } },
			});
			expect(wrongObject.status()).toBe(404);
			const noCsrf = await page.request.post(endpoint, { data: payload });
			expect(noCsrf.status()).toBe(403);
			const valid = await page.request.post(endpoint, { headers, data: payload });
			expect(valid.status()).toBe(200);
			expect(valid.headers()["cache-control"]).toBe("private, no-store");
			expect(valid.headers()["x-content-type-options"]).toBe("nosniff");
			await page.request.post("/_emdash/api/auth/logout", { headers });
			const afterLogout = await page.request.post(endpoint, { headers, data: payload });
			expect(afterLogout.status()).toBe(401);
		} finally {
			await removeAuth();
		}
	});
});
