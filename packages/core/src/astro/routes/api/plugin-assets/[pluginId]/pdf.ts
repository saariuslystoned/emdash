import type { APIRoute } from "astro";
import { z } from "zod";

import { apiError, handleError } from "#api/error.js";
import { parseBody } from "#api/parse.js";
import { dispatchPluginApiRequest } from "#plugins/http-route-dispatch.js";

export const prerender = false;

const MAX_BYTES = 8 * 1024 * 1024;
const PLUGIN_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const ROUTE = /^\/[a-z0-9](?:[a-z0-9/_-]*[a-z0-9_-])?$/i;
const KEY = /^[a-z][a-z0-9_-]{0,63}$/i;
const PDF_SUFFIX = /\.pdf$/iu;
const UNSAFE_FILENAME_CHARACTERS = new Set(['"', "\\", "/", ":", "*", "?", "<", ">", "|"]);

function hasUnsafePdfText(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (
			code <= 0x1f ||
			code === 0x7f ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069) ||
			character === "\\"
		) {
			return true;
		}
	}
	return false;
}

const requestSchema = z
	.object({
		route: z.string().min(2).max(128).regex(ROUTE),
		object: z
			.record(z.string().regex(KEY), z.string().min(1).max(256))
			.refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 16),
		intent: z.enum(["view", "download"]),
		filename: z.string().min(1).max(160).optional(),
	})
	.strict()
	.refine((value) => !value.route.split("/").some((segment) => segment === "." || segment === ".."))
	.refine((value) => !value.route.includes("\\") && !value.route.includes("%"))
	.refine((value) => value.filename === undefined || !hasUnsafePdfText(value.filename));

function privateHeaders(response: Response): Response {
	response.headers.set("Cache-Control", "private, no-store");
	response.headers.set("X-Content-Type-Options", "nosniff");
	response.headers.set(
		"Content-Security-Policy",
		"sandbox; default-src 'none'; frame-ancestors 'none'",
	);
	return response;
}

function filename(value: string | undefined): string {
	const safe = Array.from(value ?? "document.pdf", (character) =>
		hasUnsafePdfText(character) ||
		UNSAFE_FILENAME_CHARACTERS.has(character) ||
		(character.length === 1 &&
			character.charCodeAt(0) >= 0xd800 &&
			character.charCodeAt(0) <= 0xdfff)
			? "_"
			: character,
	).join("");
	const stem = safe.replace(PDF_SUFFIX, "") || "document";
	// Count code points so truncation cannot split a surrogate pair.
	// oxlint-disable-next-line e18e/prefer-spread-syntax
	return `${Array.from(stem).slice(0, 156).join("")}.pdf`;
}

const handleRequest: APIRoute = async ({ params, request, locals }) => {
	try {
		const pluginId = params.pluginId;
		if (!pluginId || !PLUGIN_ID.test(pluginId)) {
			return privateHeaders(apiError("NOT_FOUND", "Plugin asset not found", 404));
		}
		const parsed = await parseBody(request, requestSchema);
		if (parsed instanceof Response) return privateHeaders(parsed);

		const { emdash, user } = locals;
		if (!emdash?.handlePluginApiRoute) {
			return privateHeaders(apiError("NOT_CONFIGURED", "EmDash not configured", 500));
		}

		const routeMeta = emdash.getPluginRouteMeta(pluginId, parsed.route);
		if (!routeMeta) {
			return privateHeaders(apiError("NOT_FOUND", "Plugin asset not found", 404));
		}
		if (routeMeta.public || routeMeta.response !== "raw" || !routeMeta.methods?.includes("GET")) {
			return privateHeaders(
				apiError("INVALID_PRIVATE_PDF_ROUTE", "Private PDF route is not eligible", 400),
			);
		}

		const targetUrl = new URL(request.url);
		targetUrl.pathname = `/_emdash/api/plugins/${encodeURIComponent(pluginId)}/${parsed.route.slice(1)}`;
		targetUrl.search = new URLSearchParams(parsed.object).toString();
		const headers = new Headers(request.headers);
		for (const header of [
			"Content-Length",
			"Content-Type",
			"Content-Encoding",
			"Transfer-Encoding",
			"Range",
			"If-Range",
		])
			headers.delete(header);
		const response = await dispatchPluginApiRequest({
			runtime: emdash,
			pluginId,
			path: parsed.route,
			request: new Request(targetUrl, { method: "GET", headers }),
			user,
			tokenScopes: locals.tokenScopes,
		});
		if (response.status !== 200) {
			if (
				response.status === 401 ||
				response.status === 403 ||
				response.status === 404 ||
				response.status === 405
			) {
				return privateHeaders(response);
			}
			return privateHeaders(apiError("PRIVATE_PDF_UNAVAILABLE", "Private PDF unavailable", 502));
		}

		const contentType = response.headers
			.get("Content-Type")
			?.split(";", 1)[0]
			?.trim()
			.toLowerCase();
		if (contentType !== "application/pdf") {
			return privateHeaders(
				apiError("PRIVATE_PDF_INVALID_MIME", "Private PDF has an invalid MIME type", 502),
			);
		}
		const body = new Uint8Array(await response.arrayBuffer());
		if (body.byteLength === 0 || body.byteLength > MAX_BYTES) {
			return privateHeaders(
				apiError(
					body.byteLength > MAX_BYTES ? "PRIVATE_PDF_TOO_LARGE" : "PRIVATE_PDF_INVALID",
					body.byteLength > MAX_BYTES
						? "Private PDF exceeds the size limit"
						: "Private PDF is empty",
					body.byteLength > MAX_BYTES ? 413 : 502,
				),
			);
		}
		if (
			body[0] !== 0x25 ||
			body[1] !== 0x50 ||
			body[2] !== 0x44 ||
			body[3] !== 0x46 ||
			body[4] !== 0x2d
		) {
			return privateHeaders(apiError("PRIVATE_PDF_INVALID", "Private PDF is invalid", 502));
		}

		return privateHeaders(
			new Response(body, {
				status: 200,
				headers: {
					"Content-Type": "application/pdf",
					"Content-Disposition": `${parsed.intent === "download" ? "attachment" : "inline"}; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(filename(parsed.filename))}`,
					"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
				},
			}),
		);
	} catch (error) {
		return privateHeaders(handleError(error, "Private PDF unavailable", "PRIVATE_PDF_ERROR"));
	}
};

export const POST = handleRequest;
