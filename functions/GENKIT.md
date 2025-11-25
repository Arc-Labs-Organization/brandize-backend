# Genkit integration (Firebase Functions)

This project now includes Genkit setup and routes image generation through a Genkit flow. It also adds a demo flow and a Cloud Function endpoint so you can validate Genkit end-to-end.

## What was added

- Dependencies: `@genkit-ai/core`, `@genkit-ai/googleai`, `@genkit-ai/firebase`, `zod`.
- New function: `genkitHello` exposed at `/api/hello`.
  - Uses dynamic ESM imports to configure Genkit in a CommonJS functions runtime.
  - Defines and runs a simple Genkit flow (`hello`) that returns a greeting.
- `generateImageV2` now delegates to a Genkit flow (`generateImage`) so responses are unchanged, but you get Genkit tracing/orchestration benefits.

## Configure secrets

Set your Google AI Studio API key (Gemini API) as a Functions secret:

```bash
# from the repo root
firebase functions:secrets:set GOOGLE_API_KEY
```

## Install and run locally

```bash
# 1) install deps for functions
cd functions
npm install

# 2) run emulators for functions + hosting
npm run serve
```

Once running, you can test the Genkit endpoints:

```bash
# in a separate terminal
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"name":"NanoBanana"}' \
  http://localhost:5001/$(firebase projects:list --json 2>/dev/null | jq -r '.results[0].projectId')/europe-west1/genkitHello
```

Or, via Hosting rewrite (if you also started Hosting emulator):

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"name":"NanoBanana"}' \
  http://localhost:5000/api/hello
```

Expected response for hello:

```json
{ "message": "Hello, NanoBanana! Genkit is ready." }
```

## Notes

- The `generateImageV2` endpoint still exists and now calls a Genkit flow internally.
- We use dynamic imports so we don't need to flip Functions to ESM right now.
- Next step (optional): migrate `generateImageV2` into a Genkit flow and use the Google AI provider to generate images through Genkit. This unlocks Genkit Studio, flow tracing, and better prompt orchestration.
  - Done: `generateImageV2` now uses a Genkit flow internally.

## Next steps (recommended)

- Convert Functions to ES modules (or TypeScript) so you can export Genkit flows directly and use Genkit Studio.
- Create a `flows` module to house flows (`hello`, `generateImage`) outside of `index.js`.
- Optional text assistant flows for prompt refinement or style suggestions.
- Add lightweight tests that exercise the flow locally before deploying.

### Test image generation (optional; will call the model)

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A photorealistic banana on a marble table, dramatic lighting","aspectRatio":"1:1"}' \
  http://localhost:5000/api/generateImage
```

If your secret is set and emulators are running, you should receive `{ imageBase64, mimeType, modelVersion }`.

## Image Storage & Firestore Schema (Updated)

The backend now uses a unified, non-duplicating image schema:

Storage Paths:
- `images/common/{imageId}.<ext>` – Cached shared template images (Freepik downloads). `imageId` equals Freepik `resourceId` for stability.
- `images/generated/{uid}/{imageId}.<ext>` – User generated images.

Firestore:
- `images/{imageId}` – Master document for any image (downloaded or generated).
  - Fields: `storagePath`, `type: 'downloaded' | 'generated'`, `ownerId` (null for downloaded), `createdAt`, plus optional metadata (`resourceId`, `mimeType`, `size`, `prompt`, `style`, etc.).
- `users/{uid}/downloads/{imageId}` – Link document referencing a shared template (no duplication of the file).
- `users/{uid}/generated/{imageId}` – Link document referencing a user-generated image.

Download Flow:
1. User calls `freepikDownload?resourceId=...&uid=...`.
2. If not cached: fetch ZIP, extract first image file, store to `images/common/{resourceId}.<ext>`, create master `images/{resourceId}` doc.
3. Create/merge user link `users/{uid}/downloads/{resourceId}`.
4. Return `{ imageId, storagePath, downloadUrl }`.

Generation Flow:
1. User calls `generateImageV2` with body including `uid`.
2. Model generates image; stored at `images/generated/{uid}/{uuid}.<ext>`.
3. Create master doc `images/{uuid}` with `type='generated'` and metadata.
4. Create user link `users/{uid}/generated/{uuid}`.
5. Return `{ id, storagePath, downloadUrl, imageBase64 }`.

Rationale:
- Prevents storage duplication for downloaded templates.
- Allows per-user relations without copying large binaries.
- Enables querying master image metadata centrally.

Migration (legacy):
If you previously stored templates under `templates/` and docs in `freepikDownloads`, run a one-off script to copy metadata into the new `images` collection and optionally move files to `images/common/`. (See `functions/scripts/migrateExistingImages.js` example stub).
