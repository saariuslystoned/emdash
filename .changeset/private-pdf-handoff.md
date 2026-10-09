---
"@emdash-cms/blocks": minor
"emdash": minor
"@emdash-cms/admin": minor
---

Adds the experimental `private_pdf` Block Kit element so a sandboxed plugin can
offer an authenticated PDF view or download from one of its private raw `GET`
routes. The host checks caller and route authorization for every request,
accepts only bounded PDF responses with the expected MIME and signature, renders views in a bounded passive canvas,
and keeps mediator responses private and no-store. The surface is provisional;
it is not a public asset URL or print workflow.
