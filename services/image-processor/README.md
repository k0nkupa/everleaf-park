# Everleaf image processor

An authenticated HTTP Worker for managed photo normalization. This is a backend
dependency, not the Everleaf website. Originals and display images belong in the
main app's private R2 bucket; the processor stores neither.

Run from the repository root:

```sh
npm run typecheck
npm run build:images
npm run verify:images
```

`build:images` is a dry run and does not deploy. `verify:images` makes real HTTP
requests to `IMAGE_PROCESSOR_URL` with the server-only `IMAGE_PROCESSOR_TOKEN`
from ignored `.env`. It sends synthetic images, never personal photos. Cloudflare
Images counts successful unique transformations toward the account's allowance.

Deployment target: `everleaf-image-processor` in `The Ton Le Account`.
The `IMAGES` binding and `PROCESSOR_TOKEN` secret must both exist. Never deploy
a token as a plain variable or put it in source. Preserve the secret on updates.
The `wrangler.jsonc` and the generated binding types describe the same interface.

Only `POST /normalize` is supported. Authenticate with `Authorization: Bearer
<server secret>`. Send raw JPEG, PNG or WebP bytes with the matching content type.
`purpose=portrait` accepts `zoom=1..3`, `x=0..1` and `y=0..1`, crops a square,
and scales down to at most 1024px. `album` and `reference` scale down to 2400px.
All return a metadata-stripped JPEG and `X-Source-Format`. Neither route accepts
an image URL. The caller must authorize the memorial operation, preserve the
untouched original, rate-limit uploads and handle non-2xx or truncated responses.

The input limit is 20,000,000 bytes and 40 million pixels. EXIF orientation is
made explicit for JPEG/PNG/WebP because the managed API's automatic behavior
differs by format. Display metadata is removed from the JPEG header because the
binding retains copyright EXIF by default. Image decoding remains managed;
native `sharp` runs only in the verification script as the existing-behavior
reference, never in the deployed Worker.
