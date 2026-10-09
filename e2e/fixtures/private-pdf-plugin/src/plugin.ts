import { pluginResponse, pluginRoute } from "emdash/plugin";
import type { SandboxedPlugin } from "emdash/plugin";

const version = "__FIXTURE_VERSION__";
function createFixturePdf(): Uint8Array {
	const content = "BT\n/F1 24 Tf\n72 700 Td\n(PRIVATE PDF FIXTURE) Tj\nET\n";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${new TextEncoder().encode(content).byteLength} >>\nstream\n${content}endstream`,
	];
	const header = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
	const body = objects.map((object, index) => `${index + 1} 0 obj\n${object}\nendobj\n`);
	const offsets: number[] = [0];
	let position = new TextEncoder().encode(header).byteLength;
	for (const object of body) {
		offsets.push(position);
		position += new TextEncoder().encode(object).byteLength;
	}
	const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
		.join("")}`;
	const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${
		position
	}\n%%EOF\n`;
	return new Uint8Array(new TextEncoder().encode(header + body.join("") + xref + trailer));
}

const fixturePdf = createFixturePdf();

const plugin: SandboxedPlugin = {
	routes: {
		admin: {
			handler: async () => ({
				blocks: [
					{ type: "header", text: `Installed Gallery ${version}` },
					{
						type: "actions",
						elements: [
							{
								type: "private_pdf",
								label: "View private PDF",
								route: "/document",
								object: { documentId: "fixture-document" },
								intent: "view",
								filename: "fixture.pdf",
							},
							{
								type: "private_pdf",
								label: "Download private PDF",
								route: "/document",
								object: { documentId: "fixture-document" },
								intent: "download",
								filename: "fixture-download.pdf",
							},
						],
					},
				],
			}),
		},
		hello: { public: true, handler: async () => ({ version }) },
		document: pluginRoute({
			methods: ["GET"],
			request: { body: "none" },
			response: "raw",
			handler: async (route) => {
				if (!route.user || route.input.documentId !== "fixture-document") {
					return pluginResponse({ status: 404, body: { kind: "text", value: "Not found" } });
				}
				return pluginResponse({
					headers: { "content-type": "application/pdf" },
					body: { kind: "bytes", value: fixturePdf },
				});
			},
		}),
	},
};
export default plugin;
