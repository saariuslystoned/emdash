import { Button } from "@cloudflare/kumo";
// Vite turns the worker asset import into a URL string.
// oxlint-disable-next-line import/default
import pdfWorkerUrl from "@emdash-cms/admin/pdf-worker?url";
import type { PrivatePdfElement } from "@emdash-cms/blocks";
import { useLingui } from "@lingui/react/macro";
import type { PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch, API_BASE } from "../lib/api/client.js";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 8;
const VIEW_LIFETIME_MS = 120_000;
const PDF_SUFFIX = /\.pdf$/iu;

function downloadFilename(value: string | undefined): string {
	const name = Array.from(value ?? "document.pdf", (character) => {
		const code = character.codePointAt(0)!;
		return code < 32 ||
			code === 127 ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069) ||
			(code >= 0xd800 && code <= 0xdfff) ||
			'"\\/:*?<>|'.includes(character)
			? "_"
			: character;
	}).join("");
	// Count code points so truncation cannot split a surrogate pair.
	// oxlint-disable-next-line e18e/prefer-spread-syntax
	return `${Array.from(name.replace(PDF_SUFFIX, "")).slice(0, 156).join("") || "document"}.pdf`;
}

export function PrivatePdfHandoff({
	pluginId,
	element,
}: {
	pluginId: string;
	element: PrivatePdfElement;
}) {
	const { t } = useLingui();
	const [bytes, setBytes] = useState<Uint8Array<ArrayBuffer> | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pageNumber, setPageNumber] = useState(1);
	const [pageCount, setPageCount] = useState(0);
	const [text, setText] = useState("");
	const requestRef = useRef<AbortController | null>(null);
	const generationRef = useRef(0);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const identity = JSON.stringify([
		pluginId,
		element.route,
		element.object,
		element.intent,
		element.filename,
	]);
	const close = useCallback(() => {
		generationRef.current += 1;
		requestRef.current?.abort();
		requestRef.current = null;
		setBytes(null);
		setPageCount(0);
		setText("");
		setLoading(false);
	}, []);

	useEffect(() => {
		close();
		setError(null);
		return () => {
			generationRef.current += 1;
			requestRef.current?.abort();
		};
	}, [identity, close]);

	useEffect(() => {
		if (!bytes) return;
		const timer = setTimeout(close, VIEW_LIFETIME_MS);
		return () => clearTimeout(timer);
	}, [bytes, close]);

	const load = async () => {
		close();
		const generation = generationRef.current;
		const controller = new AbortController();
		requestRef.current = controller;
		setLoading(true);
		setError(null);
		try {
			const response = await apiFetch(
				`${API_BASE}/plugin-assets/${encodeURIComponent(pluginId)}/pdf`,
				{
					method: "POST",
					signal: controller.signal,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						route: element.route,
						object: element.object,
						intent: element.intent,
						filename: element.filename,
					}),
				},
			);
			if (response.status !== 200 || response.headers.get("Content-Type") !== "application/pdf")
				throw new Error("PDF unavailable");
			const data = new Uint8Array(await response.arrayBuffer());
			if (controller.signal.aborted || generation !== generationRef.current) return;
			if (
				data.length < 5 ||
				data.length > MAX_BYTES ||
				new TextDecoder().decode(data.subarray(0, 5)) !== "%PDF-"
			)
				throw new Error("Invalid PDF");
			if (element.intent === "download") {
				const url = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
				try {
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = downloadFilename(element.filename);
					anchor.click();
				} finally {
					setTimeout(() => URL.revokeObjectURL(url), 1000);
				}
			} else {
				setPageNumber(1);
				setBytes(data);
			}
		} catch {
			if (!controller.signal.aborted && generation === generationRef.current)
				setError(t`Unable to load the PDF`);
		} finally {
			if (!controller.signal.aborted && generation === generationRef.current) setLoading(false);
		}
	};

	useEffect(() => {
		if (!bytes || !canvasRef.current) return;
		const canvas = canvasRef.current;
		let cancelled = false;
		let task: PDFDocumentLoadingTask | undefined;
		let render: RenderTask | undefined;
		canvas.removeAttribute("data-pdf-rendered");
		setText("");
		void (async () => {
			try {
				const pdfjs = await import("pdfjs-dist");
				if (cancelled) return;
				pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
				task = pdfjs.getDocument({
					data: bytes.slice(),
					useWorkerFetch: false,
					useWasm: false,
					disableFontFace: true,
					useSystemFonts: true,
					enableXfa: false,
					maxImageSize: 4_000_000,
					canvasMaxAreaInBytes: 16_000_000,
					stopAtErrors: true,
				});
				const pdf = await task.promise;
				if (cancelled) return;
				if (pdf.numPages < 1 || pdf.numPages > MAX_PAGES) throw new Error("PDF page limit");
				setPageCount(pdf.numPages);
				const page = await pdf.getPage(pageNumber);
				if (cancelled) return;
				const base = page.getViewport({ scale: 1 });
				if (
					!Number.isFinite(base.width) ||
					!Number.isFinite(base.height) ||
					base.width <= 0 ||
					base.height <= 0
				)
					throw new Error("Invalid PDF page");
				const viewport = page.getViewport({
					scale: Math.min(1.5, 2000 / base.width, 2000 / base.height),
				});
				canvas.width = Math.ceil(viewport.width);
				canvas.height = Math.ceil(viewport.height);
				render = page.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE });
				await render.promise;
				const content = await page.getTextContent();
				if (cancelled) return;
				setText(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
				canvas.setAttribute("data-pdf-rendered", "true");
			} catch {
				if (!cancelled) {
					close();
					setError(t`Unable to display the PDF`);
				}
			}
		})();
		return () => {
			cancelled = true;
			render?.cancel();
			void task?.destroy().catch(() => undefined);
			canvas.width = 0;
			canvas.height = 0;
			canvas.removeAttribute("data-pdf-rendered");
		};
	}, [bytes, pageNumber, close, t]);

	return (
		<div className="flex flex-col gap-2">
			<Button type="button" loading={loading} onClick={() => void load()}>
				{element.label}
			</Button>
			{error ? (
				<p role="alert" className="text-sm text-kumo-danger">
					{error}
				</p>
			) : null}
			{bytes ? (
				<div className="flex flex-col gap-2">
					<Button type="button" variant="secondary" onClick={close}>{t`Close viewer`}</Button>
					{pageCount > 1 ? (
						<div className="flex items-center gap-2">
							<Button
								type="button"
								disabled={pageNumber <= 1}
								onClick={() => setPageNumber(pageNumber - 1)}
							>{t`Previous page`}</Button>
							<span>{t`Page ${pageNumber} of ${pageCount}`}</span>
							<Button
								type="button"
								disabled={pageNumber >= pageCount}
								onClick={() => setPageNumber(pageNumber + 1)}
							>{t`Next page`}</Button>
						</div>
					) : null}
					<canvas
						ref={canvasRef}
						role="img"
						aria-label={element.filename ?? t`Private PDF`}
						className="max-w-full border border-kumo-line"
					/>
					<p className="sr-only">{text}</p>
				</div>
			) : null}
		</div>
	);
}
