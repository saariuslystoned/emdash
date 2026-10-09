# Experimental private PDF handoff proof

This is a fork-only design prototype for [EmDash issue 4049](https://github.com/emdash-cms/emdash/issues/4049). No upstream design has been accepted. It is not ready for upstream implementation admission or merge.

## Source and behavior

Base: `58e5f648fed36606e26152edd576c93c5ef4f1e7` from `emdash-cms/emdash/main`.
Branch: `codex/private-pdf-handoff-20261009`.

The host accepts a same-plugin private raw GET route, bounded object identity and view/download intent. It uses the current dispatcher to reauthorize every retrieval, forwards session identity and token scopes, and removes POST entity headers before dispatching a bodyless GET. The response must be status 200, PDF MIME, non-empty, have a PDF signature, and remain within the byte bound. Responses are private/no-store and nosniff. The stricter passive response CSP survives production auth middleware without widening the global admin CSP.

View uses a host-owned PDF.js worker and canvas without plugin JavaScript, scripting/annotation layers, XFA or arbitrary asset URLs. It bounds page count and canvas dimensions, cancels on close/replacement/unmount, and expires in two minutes. Download requests fresh bytes and revokes its temporary object URL. Neither action changes business state.

## Verification

- Frozen dependency installation succeeds. PDF.js is pinned to 6.4.299.
- Root formatting, package build, type checking, quick lint and type-aware lint are required for closeout. The final PR description records their results.
- Core route/dispatcher tests: 32 passed, including missing session, role and token-scope denial, bodyless GET, exact bytes, public-route rejection, invalid MIME/signature and oversized dispatcher output.
- Production CSP tests: 3 passed. Only the strict mediator policy is retained; ordinary admin API policy remains unchanged.
- Block Kit validation tests: 107 passed. Plugin capability/element inventory: 9 passed.
- Chromium browser suite: 11 passed. Covers existing Registry install/update/disable/enable/uninstall and fixture Block Kit interactions, plus private PDF view/download.
- The signed local Registry test builds its sandbox plugin through the public plugin CLI, verifies checksum-bound signed publisher records, presents capability consent, installs a Registry `r_` identity and renders its PDF. Authentication is a normal session created by the setup wizard using Chromium's virtual WebAuthn authenticator; the PDF test does not use dev-bypass authentication.
- That test rejects a wrong object identity (404), absent CSRF header (403), and retrieval after logout (401). It checks private/no-store and nosniff.
- Download: 604 bytes; SHA-256 `503dd5581e69b778088f5dae273d23315f5e50d371def81a1d23c0730137f8bb`; filename `fixture-download.pdf`.
- Documentation build succeeds.

## Visible evidence

![Arabic RTL signed Registry PDF view](https://raw.githubusercontent.com/saari-co/public-oss-proof-assets/9019058849ea37b55bab8b979fb84c34f351e667/browser/emdash-4049/2026-10-09/c7678701aa314b0b79834de523db5b7936cac77c8d7459466df8d1bb46aa4767-signed-registry-ar-rtl.png)

Asset: PNG, 45,673 bytes; SHA-256 `c7678701aa314b0b79834de523db5b7936cac77c8d7459466df8d1bb46aa4767`. Captured by the authenticated signed Registry browser test from this implementation tree. Reviewed pixels contain only synthetic fixture identity, local test site and PDF text; no credentials, cookies, customer data or private coordinates. The immutable asset commit is linked above. The selected page is visibly rendered in the Arabic RTL admin.

## Limits and gates

- These are genuine local signed conformance records served by the disposable test Registry, not a publicly published Registry package. Public Registry publication/authority is untested and requires separate owner authorization.
- Virtual WebAuthn proves the normal session path, not a physical passkey device.
- A native browser Print attempt was prepared with the exact downloaded file, but browser security policy rejected opening its local `file:` URL. No workaround was attempted. No print dialog, print-ready page, one-click printing or physical output is verified.
- The sandbox owns object/domain authorization; the fixture checks its document identity on every retrieval. Commerce-specific identity rules are outside this generic host prototype.
- Comprehensive exact-revision OpenClaw review, CI and native reviewer availability are recorded separately in PR closeout. Drafts are ineligible for the upstream native bot; absence of a native run is not a clean review.
- No merge, deployment, provider call or public Registry publication is included.

AI assistance: Codex GPT-6.1 Sol and Cursor ACP GPT-5.6 Luna. The parent corrected, inspected and independently tested the ACP output.
