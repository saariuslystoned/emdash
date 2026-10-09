import { createHash } from "node:crypto";

import { expect, test } from "../fixtures";

test.describe("Registry fixture Block Kit", () => {
	test.beforeEach(async ({ admin, page }) => {
		await admin.devBypassAuth();
		await page
			.context()
			.addCookies([{ name: "emdash-locale", value: "ar", domain: "localhost", path: "/" }]);
	});

	test("renders diagnostics and every runtime Block Kit component in Arabic RTL", async ({
		admin,
		page,
	}, testInfo) => {
		await admin.goto("/plugins/marketplace-test/overview");
		await admin.waitForLoading();
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
		await expect(page.getByRole("heading", { name: "Registry diagnostics" })).toBeVisible();
		await expect(page.getByText("Surface")).toBeVisible();
		await expect(page.getByText("admin-page", { exact: true })).toBeVisible();
		await expect(page.getByRole("link", { name: "Documentation" })).toHaveAttribute(
			"href",
			"https://docs.example.test/plugin",
		);
		const statusImage = page.getByRole("img", { name: "Plugin status" });
		await expect(statusImage).toBeVisible();
		expect(
			await statusImage.evaluate(
				(image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
			),
		).toBe(true);
		const diagnosticResponse = page.waitForResponse(
			(response) =>
				response.url().endsWith("/_emdash/api/plugins/marketplace-test/admin") &&
				response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Run diagnostics" }).click();
		expect((await diagnosticResponse).status()).toBe(200);
		await expect(page.getByText("Diagnostics passed", { exact: true })).toBeVisible();

		await admin.goto("/plugins/marketplace-test/components");
		await admin.waitForLoading();
		await expect(page.getByRole("heading", { name: "Block Kit kitchen sink" })).toBeVisible();
		await expect(
			page.getByText("Every supported admin-page block and form element is represented here."),
		).toBeVisible();
		await expect(page.getByText("Locale")).toBeVisible();
		await expect(page.getByText("ar", { exact: true })).toBeVisible();
		await expect(page.getByText("Direction")).toBeVisible();
		await expect(page.getByText("rtl", { exact: true })).toBeVisible();
		await expect(page.getByRole("tab", { name: "Context" })).toBeVisible();
		const fixtureImage = page.getByRole("img", { name: "Fixture status" });
		await expect(fixtureImage).toBeVisible();
		expect(
			await fixtureImage.evaluate(
				(image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
			),
		).toBe(true);
		await testInfo.attach("registry-fixture-components-ar-rtl", {
			body: await page.screenshot({ fullPage: true }),
			contentType: "image/png",
		});
	});

	test("submits Block Kit forms and rejects unsafe responses", async ({ admin, page }) => {
		await admin.goto("/plugins/marketplace-test/components");
		await admin.waitForLoading();
		await page.getByRole("textbox", { name: "Text" }).fill("submitted in browser");
		await page.getByRole("spinbutton", { name: "Number" }).fill("7");
		await page.getByRole("button", { name: "Submit" }).click();
		await expect(page.getByText("Components submitted", { exact: true })).toBeVisible();
		await expect(page.getByText("submitted in browser", { exact: true })).toBeVisible();
		await expect(page.getByText("7", { exact: true })).toBeVisible();

		await page.getByRole("button", { name: "Return unsafe image" }).click();
		await expect(page.getByText(/INVALID_BLOCK_RESPONSE/)).toBeVisible();
		await expect(page.getByText("tracker.example", { exact: false })).toHaveCount(0);

		await page.reload();
		await admin.waitForLoading();
		await page.getByRole("button", { name: "Return oversized response" }).click();
		await expect(page.getByText(/INVALID_BLOCK_RESPONSE|PLUGIN_RESPONSE_TOO_LARGE/)).toBeVisible();
	});

	test("mediates a private PDF view through the declared plugin route", async ({ admin, page }) => {
		await admin.goto("/plugins/marketplace-test/components");
		await admin.waitForLoading();
		const mediatorResponse = page.waitForResponse(
			(response) =>
				response.url().endsWith("/_emdash/api/plugin-assets/marketplace-test/pdf") &&
				response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "View private PDF" }).click();
		const response = await mediatorResponse;
		expect(response.status(), await response.text()).toBe(200);
		const canvas = page.locator('canvas[data-pdf-rendered="true"]');
		await expect(canvas).toBeVisible();
		await expect(page.getByText("PRIVATE PDF FIXTURE", { exact: true })).toHaveCount(1);
		expect(await canvas.evaluate((element) => element.width > 0 && element.height > 0)).toBe(true);
		await expect(page.getByRole("button", { name: "Close viewer" })).toBeVisible();
		await page.getByRole("button", { name: "Close viewer" }).click();
		await expect(canvas).toHaveCount(0);
	});

	test("downloads the same deterministic private PDF bytes", async ({ admin, page }) => {
		await admin.goto("/plugins/marketplace-test/components");
		await admin.waitForLoading();
		const responsePromise = page.waitForResponse(
			(response) =>
				response.url().endsWith("/_emdash/api/plugin-assets/marketplace-test/pdf") &&
				response.request().method() === "POST",
		);
		const downloadPromise = page.waitForEvent("download");
		await page.getByRole("button", { name: "Download private PDF" }).click();
		const response = await responsePromise;
		expect(response.status(), await response.text()).toBe(200);
		const download = await downloadPromise;
		const bytes = await download.createReadStream();
		expect(bytes).not.toBeNull();
		const chunks: Buffer[] = [];
		for await (const chunk of bytes!) chunks.push(Buffer.from(chunk));
		const content = Buffer.concat(chunks);
		expect(content.subarray(0, 5).toString("ascii")).toBe("%PDF-");
		expect(content.toString("ascii")).toContain("PRIVATE PDF FIXTURE");
		expect(createHash("sha256").update(content).digest("hex")).toBe(
			"503dd5581e69b778088f5dae273d23315f5e50d371def81a1d23c0730137f8bb",
		);
		expect(download.suggestedFilename()).toBe("fixture-download.pdf");
	});

	test("loads the saved-entry panel lazily and runs the confirmed overflow action", async ({
		admin,
		page,
		serverInfo,
	}) => {
		const entryId = serverInfo.contentIds.posts[0]!;
		let panelRequests = 0;
		page.on("request", (request) => {
			if (request.url().includes("/plugin-extensions/marketplace-test/panel/entry-context")) {
				panelRequests++;
			}
		});

		await admin.goto(`/content/posts/${entryId}?locale=en`);
		await admin.waitForLoading();
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
		expect(panelRequests).toBe(0);

		const panelResponse = page.waitForResponse(
			(response) =>
				response.url().includes("/plugin-extensions/marketplace-test/panel/entry-context") &&
				response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Entry context", exact: true }).click();
		expect((await panelResponse).status()).toBe(200);
		await expect(page.getByText(entryId, { exact: true })).toBeVisible();
		expect(panelRequests).toBe(1);

		await page.getByRole("button", { name: "إجراءات الإضافة" }).click();
		await expect(page.getByRole("menuitem", { name: "Invalid action" })).toHaveCount(0);
		await page.getByRole("menuitem", { name: "Refresh entry" }).click();
		const dialog = page.getByRole("alertdialog", { name: "Refresh entry?" });
		await expect(dialog).toBeVisible();
		const actionResponse = page.waitForResponse(
			(response) =>
				response.url().includes("/plugin-extensions/marketplace-test/action/refresh-entry") &&
				response.request().method() === "POST",
		);
		await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
		expect((await actionResponse).status()).toBe(200);
		await expect(page.getByText(`posts/${entryId} refreshed`, { exact: true })).toBeVisible();
	});
});
