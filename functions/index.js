'use strict';
// Load local env variables when running in emulator/development.
// Will look for .env.local first, then .env. Safe in production (ignored if files absent).
try {
  require('dotenv').config({ path: '.env.local' });
  require('dotenv').config();
} catch (e) {
  // dotenv optional
}

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const cors = require('cors')({ origin: true });
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { randomUUID } = require('crypto');
const JSZip = require('jszip');
const Busboy = require('busboy');
const path = require('path');
const os = require('os');
const fs = require('fs');
try {
  if (!admin.apps.length) {
    // Artık her şey FIREBASE_CONFIG üzerinden otomatik gelecek
    admin.initializeApp();
  }
} catch (e) {
  // ignore re-init in emulator hot-reload
}

// Ortak Firestore ve Storage referansları:
const db = getFirestore();
const bucket = admin.storage().bucket();

// Path helpers (centralized for consistency)
function buildCommonImagePath(imageId, ext) {
  return `images/common/${imageId}.${ext}`;
}
function buildGeneratedImagePath(uid, imageId, ext) {
  return `images/generated/${uid}/${imageId}.${ext}`;
}

// User accounting helpers
async function ensureUserExists(uid) {
  if (!uid || typeof uid !== 'string') {
    throw new Error('Invalid uid provided');
  }

  const userRef = db.collection('users').doc(uid);
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    // Create user with default values
    await userRef.set({
      remainingUsage: {
        download: 100, // default download limit
        generate: 100, // default generate limit
      },
      brand: {
        name: null,
        website: null,
      },
      createdAt: FieldValue.serverTimestamp(),
      lastUsedAt: FieldValue.serverTimestamp(),
    });
  } else {
    // Update lastUsedAt timestamp
    await userRef.update({
      lastUsedAt: FieldValue.serverTimestamp(),
    });
  }
}

async function decrementUsage(uid, usageType) {
  if (!uid || typeof uid !== 'string') {
    throw new Error('Invalid uid provided');
  }
  if (usageType !== 'download' && usageType !== 'generate') {
    throw new Error("Invalid usage type. Must be 'download' or 'generate'");
  }

  const userRef = db.collection('users').doc(uid);

  // Use a transaction to ensure atomic decrement and validation
  return await db.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(userRef);

    if (!userDoc.exists) {
      throw new Error('User does not exist. Call ensureUserExists first.');
    }

    const userData = userDoc.data();
    const remainingUsage = userData.remainingUsage || {};
    const currentUsage = remainingUsage[usageType] || 0;

    if (currentUsage <= 0) {
      throw new Error(`No remaining ${usageType} usage available`);
    }

    // Decrement the usage
    transaction.update(userRef, {
      [`remainingUsage.${usageType}`]: FieldValue.increment(-1),
      lastUsedAt: FieldValue.serverTimestamp(),
    });

    return currentUsage - 1; // return new value
  });
}

// Define secret for Google AI Studio API key (Gemini API)
// Secrets:
// - Production: set via `firebase functions:secrets:set ANTHROPIC_API_KEY` (and GOOGLE_API_KEY, FREEPIK_API_KEY)
// - Emulator: provide in `.env.local` or `.env` under functions/
const GOOGLE_API_KEY = defineSecret('GOOGLE_API_KEY');
const FREEPIK_API_KEY = defineSecret('FREEPIK_API_KEY');
// Anthropic no longer used; key removed

/**
 * Proxy search to Freepik API to keep API key server-side.
 * GET /api/freepik/search?q=<query>&page=<n>&limit=<n>
 * Returns: JSON response from Freepik (or a normalized subset if desired).
 *
 * According to Freepik API docs, stock content search uses:
 *   GET https://api.freepik.com/v1/resources?term=...&page=...&limit=...
 * with header: x-freepik-api-key: <API_KEY>
 */
exports.freepikSearch = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 30,
    memory: '256MiB',
    cors: true,
    secrets: [FREEPIK_API_KEY],
  },
  async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).send('');
    }

    return cors(req, res, async () => {
      if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed. Use GET.' });
      }

      const q = (req.query.q || '').toString().trim();
      let page = parseInt((req.query.page || '1').toString(), 10) || 1;
      let limit = parseInt((req.query.limit || '24').toString(), 10) || 24;
      if (!q) return res.status(400).json({ error: 'Missing required query parameter: q' });

      if (!process.env.FREEPIK_API_KEY) {
        return res.status(500).json({ error: 'FREEPIK_API_KEY not configured on server' });
      }

      try {
        // Normalize page/limit bounds
        if (page < 1) page = 1;
        if (limit < 1) limit = 1;
        if (limit > 100) limit = 100;

        // Freepik stock content search endpoint
        const apiUrl = new URL('https://api.freepik.com/v1/resources');
        apiUrl.searchParams.set('term', q);
        apiUrl.searchParams.set('page', String(page));
        apiUrl.searchParams.set('limit', String(limit));
        // Optional params you can experiment with:
        // apiUrl.searchParams.set('sort', 'relevance');
        // apiUrl.searchParams.set('order', 'desc');
        // apiUrl.searchParams.set('filters', 'resource_type:psd'); // check docs for valid filters

        // Provide Accept-Language if available
        const acceptLang = req.headers['accept-language'] || 'en-US';

        // Add timeout to avoid hanging
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        // Normalize API key to avoid trailing whitespace or newlines from Secret Manager
        const apiKey = (process.env.FREEPIK_API_KEY || '').trim();
        const fpResp = await fetch(apiUrl.toString(), {
          method: 'GET',
          headers: {
            // Freepik docs specify x-freepik-api-key; include Authorization as Bearer for compatibility
            'x-freepik-api-key': apiKey,
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
            'Accept-Language': Array.isArray(acceptLang) ? acceptLang[0] : acceptLang,
            'User-Agent': 'NanoBanana/1.0 (+firebase-functions)',
          },
          signal: controller.signal,
        }).catch((e) => {
          if (e && e.name === 'AbortError') {
            return {
              ok: false,
              status: 504,
              text: async () => JSON.stringify({ message: 'Upstream timeout' }),
            };
          }
          throw e;
        });

        clearTimeout(timeout);

        const text = await fpResp.text();
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = { raw: text };
        }

        if (!fpResp.ok) {
          const msg = json?.message || json?.error || `Freepik API error (${fpResp.status})`;
          return res.status(fpResp.status || 502).json({ error: msg, details: json });
        }

        // Optionally normalize the response to only what's needed by the UI
        // Apply temporary heuristic free filter if requested.
        // const onlyFree = String(req.query.onlyFree || "").toLowerCase() === "true";
        // if (onlyFree && Array.isArray(json?.data)) {
        // 	console.log('[freepikSearch] onlyFree pre-count=', json.data.length);
        // 	try {
        // 		json.data = json.data.filter((item) => {
        // 			if (!item || typeof item !== "object") return false;
        // 			const url = (item.url || "").toString();
        // 			if (!url) return false;
        // 			if (url.includes("/premium-")) return false; // exclude premium-marked URLs
        // 			if (item.products && Array.isArray(item.products) && item.products.length > 0) return false; // has products => likely restricted
        // 			if (url.includes("/free-")) return true; // heuristic keep
        // 			// Relax heuristic: keep if no premium markers and no products (potentially free)
        // 			return true;
        // 		});
        // 		console.log('[freepikSearch] onlyFree post-count=', json.data.length);
        // 	} catch (e) {
        // 		console.warn("onlyFree heuristic filtering error:", e?.message || e);
        // 	}
        // }
        // Here we pass through the original payload so you can map on the client.
        return res.status(200).json(json);
      } catch (err) {
        console.error('freepikSearch error:', err);
        return res
          .status(500)
          .json({ error: 'Failed to fetch from Freepik', details: String(err?.message || err) });
      }
    });
  },
);

/**
 * Proxy download to Freepik API to keep API key server-side.
 * GET /api/freepik/download?resourceId=<id>&variant=<optional>&filetype=<optional>
 * Returns: { downloadUrl: string | null, raw: any }
 */
// Download (or link) a Freepik resource. Implements new unified image schema:
// Storage:
//   /images/common/{imageId}.{ext}
// Firestore master doc:
//   images/{imageId} { storagePath, type: 'downloaded', ownerId: null, createdAt, resourceId, mimeType, size }
// User link doc:
//   users/{uid}/downloads/{imageId} { createdAt }
// If the resource was previously cached, we only create (or upsert) the user link.
// imageId chosen = resourceId (stable) to avoid duplicates.
exports.freepikDownload = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 30,
    memory: '1GiB',
    cors: true,
    secrets: [FREEPIK_API_KEY],
  },
  async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).send('');
    }

    return cors(req, res, async () => {
      if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed. Use GET.' });
      }

      const resourceId = (req.query.resourceId || '').toString().trim();
      const uid = (req.query.uid || '').toString().trim();
      if (!resourceId)
        return res.status(400).json({ error: 'Missing required query parameter: resourceId' });
      if (!uid) return res.status(400).json({ error: 'Missing required query parameter: uid' });

      if (!process.env.FREEPIK_API_KEY) {
        return res.status(500).json({ error: 'FREEPIK_API_KEY not configured on server' });
      }

      try {
        // Ensure user exists and decrement download usage
        await ensureUserExists(uid);
        await decrementUsage(uid, 'download');

        const apiUrl = new URL(
          `https://api.freepik.com/v1/resources/${encodeURIComponent(resourceId)}/download`,
        );
        if (typeof req.query.variant !== 'undefined' && req.query.variant !== null)
          apiUrl.searchParams.set('variant', req.query.variant.toString());
        if (typeof req.query.filetype !== 'undefined' && req.query.filetype !== null)
          apiUrl.searchParams.set('filetype', req.query.filetype.toString());
        const acceptLang = req.headers['accept-language'] || 'en-US';
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const apiKey = (process.env.FREEPIK_API_KEY || '').trim();
        const fpResp = await fetch(apiUrl.toString(), {
          method: 'GET',
          headers: {
            'x-freepik-api-key': apiKey,
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
            'Accept-Language': Array.isArray(acceptLang) ? acceptLang[0] : acceptLang,
            'User-Agent': 'NanoBanana/1.0 (+firebase-functions)',
          },
          signal: controller.signal,
        }).catch((e) => {
          if (e && e.name === 'AbortError') {
            return {
              ok: false,
              status: 504,
              text: async () => JSON.stringify({ message: 'Upstream timeout' }),
            };
          }
          throw e;
        });
        clearTimeout(timeout);
        const text = await fpResp.text();
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = { raw: text };
        }
        if (!fpResp.ok) {
          const msg =
            (json && (json.message || json.error)) || `Freepik API error (${fpResp.status})`;
          return res.status(fpResp.status || 502).json({ error: msg, details: json });
        }
        const downloadUrl = (json && (json.data?.url || json.url || json.location)) || null;
        if (!downloadUrl)
          return res
            .status(502)
            .json({ error: 'Missing download URL from Freepik response', raw: json });

        // Check existing master doc
        const imageDocRef = db.collection('images').doc(resourceId);
        const existing = await imageDocRef.get();
        let storagePath;
        let signedUrl = null;
        let mimeType = null;
        let size = null;
        if (existing.exists) {
          const data = existing.data();
          storagePath = data.storagePath;
          signedUrl = data.downloadUrl || null;
          mimeType = data.mimeType || null;
          // If no downloadUrl or expired, regenerate URL
          if (!signedUrl && storagePath) {
            try {
              const file = bucket.file(storagePath);
              const [metadata] = await file.getMetadata().catch(() => [{}]);
              let token = metadata.metadata?.firebaseStorageDownloadTokens;
              if (!token) {
                token = randomUUID();
                await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
              }
              signedUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
              await imageDocRef.update({ downloadUrl: signedUrl });
            } catch (e) {
              console.warn('Regenerate URL failed', e?.message || e);
            }
          }
        } else {
          try {
            const assetResp = await fetch(downloadUrl);
            if (!assetResp.ok)
              return res.status(assetResp.status).json({ error: 'Failed to fetch Freepik asset' });
            const zipBuffer = Buffer.from(await assetResp.arrayBuffer());
            const zip = await JSZip.loadAsync(zipBuffer);
            const imageFiles = Object.values(zip.files).filter(
              (f) => !f.dir && /\.(png|jpg|jpeg|webp)$/i.test(f.name),
            );
            if (!imageFiles.length) return res.status(422).json({ error: 'NO_IMAGE_IN_ZIP' });
            const mainImage = imageFiles[0];
            const imgBuffer = await mainImage.async('nodebuffer');
            size = imgBuffer.length;
            const name = mainImage.name.toLowerCase();
            if (name.endsWith('.png')) mimeType = 'image/png';
            else if (name.endsWith('.webp')) mimeType = 'image/webp';
            else mimeType = 'image/jpeg';
            const ext =
              mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
            storagePath = buildCommonImagePath(resourceId, ext);
            const file = bucket.file(storagePath);
            const token = randomUUID();
            await file.save(imgBuffer, {
              resumable: false,
              contentType: mimeType,
              metadata: {
                cacheControl: 'public, max-age=31536000',
                metadata: { firebaseStorageDownloadTokens: token },
              },
            });
            signedUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
            await imageDocRef.set({
              storagePath,
              type: 'downloaded',
              ownerId: null,
              createdAt: FieldValue.serverTimestamp(),
              resourceId,
              mimeType,
              size,
              downloadUrl: signedUrl || null,
              originalDownloadUrl: downloadUrl,
              imageFileName: mainImage.name,
              apiResponse: json,
            });
          } catch (e) {
            console.error('Caching Freepik resource failed', e);
            return res
              .status(500)
              .json({ error: 'CACHE_FAILED', details: e?.message || String(e) });
          }
        }

        // User link
        try {
          await db.collection('users').doc(uid).collection('downloads').doc(resourceId).set(
            {
              createdAt: FieldValue.serverTimestamp(),
              imageId: resourceId,
              storagePath,
              type: 'downloaded',
            },
            { merge: true },
          );
        } catch (e) {
          console.warn('User link write failed', e?.message || e);
        }

        return res
          .status(200)
          .json({ imageId: resourceId, storagePath, downloadUrl: signedUrl, type: 'downloaded' });
      } catch (err) {
        console.error('freepikDownload error:', err);
        return res
          .status(500)
          .json({ error: 'Failed to download from Freepik', details: String(err?.message || err) });
      }
    });
  },
);

/**
 * Gen 2 HTTPS function: POST /api/generateImage
 * Body: { prompt: string, style?: string, aspectRatio?: '1:1'|'16:9'|'9:16'|'3:2'|'2:3'|'4:3'|'3:4'|'5:4'|'4:5'|'21:9' }
 * Returns: { imageBase64: string, mimeType: string, modelVersion?: string }
 */
exports.generateImageV2 = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 120,
    memory: '1GiB',
    cors: true,
    secrets: [GOOGLE_API_KEY],
  },
  async (req, res) => {
    // Handle CORS preflight explicitly for some clients
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).send('');
    }

    return cors(req, res, async () => {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed. Use POST.' });
      }

      const {
        prompt,
        style,
        aspectRatio,
        mockupImageUrl,
        logoUrl,
        uid,
        templateId,
        cropRect,
        blueprint,
      } = req.body || {};

      if ((!prompt || typeof prompt !== 'string' || !prompt.trim()) && !blueprint) {
        return res.status(400).json({ error: 'Missing required field: prompt (string).' });
      }

      if (!uid || typeof uid !== 'string') {
        return res.status(400).json({ error: 'Missing required field: uid (string).' });
      }

      try {
        const { generateImageFlow } = await getFlows();
        const finalPrompt =
          (!prompt || !String(prompt).trim()) && blueprint
            ? 'Rebrand this design according to the provided blueprint and brand guidelines.'
            : String(prompt || '').trim();
        const result = await generateImageFlow({
          prompt: finalPrompt,
          style,
          aspectRatio,
          mockupImageUrl,
          logoUrl,
          uid,
          templateId,
          cropRect,
          blueprint,
        });
        return res.status(200).json(result);
      } catch (err) {
        if (err && (err.name === 'ZodError' || err.issues)) {
          return res
            .status(400)
            .json({ error: 'Invalid input', details: err.issues || String(err) });
        }
        console.error('generateImage error:', err);
        return res
          .status(500)
          .json({ error: 'Internal error generating image', details: String(err.message || err) });
      }
    });
  },
);

// Lazy Genkit bootstrap: configure once and expose flows for reuse.
const getFlows = (() => {
  let bootPromise;
  return async () => {
    if (bootPromise) return bootPromise;
    bootPromise = (async () => {
      // Dynamically import Genkit core, Google AI plugin, Firebase telemetry, and Zod
      const [core, genkitPkg, googleAIPkg, firebasePkg, zodPkg] = await Promise.all([
        import('@genkit-ai/core'),
        import('genkit'),
        import('@genkit-ai/googleai'),
        import('@genkit-ai/firebase'),
        import('zod'),
      ]);

      const { flow } = core;
      const { genkit } = genkitPkg;
      const { googleAI } = googleAIPkg;
      const { enableFirebaseTelemetry } = firebasePkg;
      const { z } = zodPkg;

      // Sanity log to surface missing API key during cold starts/emulator runs
      console.log('GOOGLE_API_KEY set?', !!process.env.GOOGLE_API_KEY);

      if (!process.env.GOOGLE_API_KEY) {
        // Throw early so endpoints can return a good error
        throw new Error('Missing GOOGLE_API_KEY secret for Genkit');
      }

      // Initialize Genkit telemetry (required for flows) using Firebase integration.
      enableFirebaseTelemetry();

      // Initialize a Genkit instance with Google AI plugin. It will pick up GOOGLE_API_KEY automatically.
      const ai = genkit({
        plugins: [googleAI()],
        // Default model here is optional; we set it explicitly in generate() below
      });

      // Anthropic client initialization removed (Gemini-only setup)

      const allowedRatios = [
        '1:1',
        '16:9',
        '9:16',
        '3:2',
        '2:3',
        '4:3',
        '3:4',
        '5:4',
        '4:5',
        '21:9',
      ];

      // Helper: Build a rebranding blueprint from gemini result + brand
      // Blueprint is a suggested plan the caller can override before image generation.
      // All values in text_updates are defaults/suggestions and can be changed by the client.
      function buildRebrandBlueprint({
        llmResult,
        brand,
        userId = null,
        templateId = null,
        templateUrl = null,
        aspectRatio = null,
      }) {
        const originalTexts = Array.isArray(llmResult?.original_texts)
          ? llmResult.original_texts
          : [];
        const updatedTexts = Array.isArray(llmResult?.updated_texts) ? llmResult.updated_texts : [];
        const replaceLogoFlag = !!llmResult?.replacable_logo;

        const text_updates = {};
        for (let i = 0; i < originalTexts.length; i++) {
          const key = String(originalTexts[i] || '');
          const val = typeof updatedTexts[i] === 'string' ? updatedTexts[i] : null; // null => suggest removal
          text_updates[key] = val;
        }

        const additions = [];
        if (brand?.brandLogoUrl) additions.push({ type: 'brand_logo', location: 'top-right' });
        if (brand?.brandWebsite) additions.push({ type: 'website', location: 'bottom-mid' });
        if (brand?.phoneNumber) additions.push({ type: 'phone_number', location: 'bottom-right' });

        return {
          user_id: userId || null,
          template_id: templateId || null,
          template_url: templateUrl || null,
          replace_logo: replaceLogoFlag,
          use_brand_colors: true,
          text_updates,
          additions,
          aspect_ratio: aspectRatio || null,
        };
      }

      const generateImageFlow = flow(
        {
          name: 'generateImage',
          inputSchema: z.object({
            prompt: z.string().min(1),
            style: z.string().optional(),
            aspectRatio: z.enum(allowedRatios).optional(),
            mockupImageUrl: z.string().url().optional(),
            logoUrl: z.string().url().optional(),
            // Optional: blueprint input to drive prompt construction
            blueprint: z
              .object({
                user_id: z.string().nullable().optional(),
                template_id: z.string().nullable().optional(),
                template_url: z.string().url().nullable().optional(),
                replace_logo: z.boolean().optional(),
                use_brand_colors: z.boolean().optional(),
                text_updates: z.record(z.string().nullable()).optional(),
                additions: z.array(z.object({ type: z.string(), location: z.string() })).optional(),
                aspect_ratio: z.enum(allowedRatios).nullable().optional(),
              })
              .optional(),
            //templateId: z.string().optional(), // freepikDownload'tan gelen uuid
            // cropRect: z
            //  .object({
            // 	x: z.number(),
            // 	y: z.number(),
            // 	width: z.number(),
            // 	height: z.number(),
            // 	})
            // 	.optional(), // varsa crop bilgisi
            uid: z.string().min(1),
          }),
          outputSchema: z.object({
            mimeType: z.string(),
            modelVersion: z.string().optional(),
            id: z.string(),
            storagePath: z.string(),
            downloadUrl: z.string().optional().nullable(),
          }),
        },
        async ({ prompt, style, aspectRatio, mockupImageUrl, logoUrl, uid, blueprint }) => {
          // Ensure user exists and decrement generate usage
          await ensureUserExists(uid);
          await decrementUsage(uid, 'generate');

          // If blueprint is provided, prefer it to build the natural language prompt
          let fullPrompt;
          if (blueprint && typeof blueprint === 'object') {
            const bp = blueprint;
            const textOps = bp.text_updates || {};
            const additions = Array.isArray(bp.additions) ? bp.additions : [];
            const parts = [];
            parts.push('Update the design per the following blueprint suggestions.');
            if (bp.use_brand_colors)
              parts.push('Apply the brand colors consistently to key elements (backgrounds, buttons, highlights) ' + 'but keep the overall contrast and readability high.');
            if (bp.replace_logo)
              parts.push(
                    'If there is an existing logo, replace it with the provided brand logo. ' + 'Keep the approximate size and position similar to the original logo placement.',
              );
            // Text updates
            const keys = Object.keys(textOps);
            if (keys.length) {
              parts.push('TEXT RULES: Only modify the texts explicitly listed below. ' + 'Do NOT change any other text in the design.');
              for (const k of keys) {
                const v = textOps[k];
                if (v === null || typeof v === 'undefined') {
                  parts.push(`- Remove text: "${k}"`);
                } else {
                  parts.push(`- Replace "${k}" with "${v}" while preserving the approximate font size, ` + 'weight, and position.');
                }
              }
            }
            // Additions
            if (additions.length) {
              parts.push('ADDITIONS: Add only the following elements. Do NOT invent other new elements: ');
              for (const add of additions) {
                parts.push(`- Add ${add.type} at ${add.location}`);
              }
            }
            // Aspect ratio
            if (bp.aspect_ratio && allowedRatios.includes(bp.aspect_ratio)) {
              aspectRatio = bp.aspect_ratio;
            }

            parts.push('GENERAL RULES: Preserve the overall layout, composition, and visual hierarchy of the original design. ' + 'Do not remove or drastically move major visual elements unless explicitly requested.');

            fullPrompt = parts.join(' \n');
          } else {
            const stylePrefix = style ? `Style: ${style}. ` : '';
            fullPrompt = `${stylePrefix}${prompt}`.trim();
          }

          // Best-effort: If a mockup image URL is provided, try to fetch it and include as multimodal input.
          // If anything fails, we fallback to text-only generation.
          let imageInput = null;
          let logoInput = null;
          if (mockupImageUrl) {
            try {
              const r = await fetch(mockupImageUrl);
              const mimeType = r.headers.get('content-type') || 'image/jpeg';
              const buffer = Buffer.from(await r.arrayBuffer());
              const base64 = buffer.toString('base64');
              imageInput = { mimeType, base64 };
            } catch (e) {
              console.warn('Failed to fetch mockup image, proceeding without it:', e?.message || e);
            }
          }

          // Best-effort: Optional logo image as a second media input
          if (logoUrl) {
            try {
              const r = await fetch(logoUrl);
              const mimeType = r.headers.get('content-type') || 'image/jpeg';
              const buffer = Buffer.from(await r.arrayBuffer());
              const base64 = buffer.toString('base64');
              logoInput = { mimeType, base64 };
            } catch (e) {
              console.warn('Failed to fetch logo image, proceeding without it:', e?.message || e);
            }
          }

          // Use Genkit to generate an image with Gemini 2.5 Flash Image
          let media, rawResponse;
          if (imageInput || logoInput) {
            const promptArray = [];
            if (imageInput) {
              const dataUrl = `data:${imageInput.mimeType};base64,${imageInput.base64}`;
              promptArray.push({ media: { contentType: imageInput.mimeType, url: dataUrl } });
            }
            if (logoInput) {
              const logoDataUrl = `data:${logoInput.mimeType};base64,${logoInput.base64}`;
              promptArray.push({ media: { contentType: logoInput.mimeType, url: logoDataUrl } });
            }
            const enhancedPrompt = `Based on the provided reference image, ${fullPrompt}. Keep the composition and style similar to the reference image.`;
            promptArray.push({ text: enhancedPrompt });

            try {
              ({ media, rawResponse } = await ai.generate({
                model: googleAI.model('gemini-3-pro-image-preview'),
                prompt: promptArray,
                config: {
                  responseModalities: ['IMAGE'],
                  ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
                },
                output: { format: 'media' },
              }));
            } catch (primaryErr) {
              console.warn(
                'Primary model failed, falling back to gemini-2.5-flash-image:',
                primaryErr?.message || primaryErr,
              );
              ({ media, rawResponse } = await ai.generate({
                model: googleAI.model('gemini-2.5-flash-image'),
                prompt: promptArray,
                config: {
                  responseModalities: ['IMAGE'],
                  ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
                },
                output: { format: 'media' },
              }));
            }
          } else {
            try {
              ({ media, rawResponse } = await ai.generate({
                model: googleAI.model('gemini-3-pro-image-preview'),
                prompt: fullPrompt,
                config: {
                  responseModalities: ['IMAGE'],
                  ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
                },
                output: { format: 'media' },
              }));
            } catch (primaryErr) {
              console.warn(
                'Primary model failed, falling back to gemini-2.5-flash-image:',
                primaryErr?.message || primaryErr,
              );
              ({ media, rawResponse } = await ai.generate({
                model: googleAI.model('gemini-2.5-flash-image'),
                prompt: fullPrompt,
                config: {
                  responseModalities: ['IMAGE'],
                  ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
                },
                output: { format: 'media' },
              }));
            }
          }

          // Genkit may return media as an array or a single object. Normalize it.
          const m = Array.isArray(media) ? media[0] : media;
          if (!m?.url) {
            console.error('generate: missing media in response', { media, rawResponse });
            throw new Error('Model did not return image media.');
          }

          // m.url is a data URL: data:<mime>;base64,<data>
          const dataUrl = m.url;
          const commaIdx = dataUrl.indexOf(',');
          const header = dataUrl.substring(0, commaIdx);
          const imageBase64 = dataUrl.substring(commaIdx + 1);
          const mimeTypeMatch = /data:(.*?);base64/.exec(header);
          const mimeType = (mimeTypeMatch && mimeTypeMatch[1]) || 'image/png';

          // Persist to Cloud Storage and Firestore
          const buffer = Buffer.from(imageBase64, 'base64');

          const ext = ((mime) => {
            if (mime === 'image/png') return 'png';
            if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
            if (mime === 'image/webp') return 'webp';
            return 'bin';
          })(mimeType);

          // Generate an id up front so Storage write doesn't depend on Firestore availability
          const id = randomUUID();
          const imagePath = buildGeneratedImagePath(uid, id, ext);

          // Attempt to persist to Cloud Storage. If the bucket isn't available (e.g., emulator not initialized)
          // do not fail the entire request — log and continue returning the imageBase64.
          const appOptions = admin.app().options || {};
          const configuredBucket = appOptions.storageBucket;
          const projId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
          const bucketName = configuredBucket || (projId ? `${projId}.appspot.com` : undefined);
          const bucket = bucketName ? admin.storage().bucket(bucketName) : admin.storage().bucket();

          let file = null;
          let downloadToken = null;
          try {
            const [bucketExists] = await bucket.exists();
            if (!bucketExists) {
              console.warn(
                `Storage bucket not found. Skipping storage write. Attempted bucket: ${bucketName || '(default)'} `,
              );
            } else {
              file = bucket.file(imagePath);
              downloadToken = randomUUID();
              await file.save(buffer, {
                resumable: false,
                contentType: mimeType,
                metadata: {
                  cacheControl: 'public, max-age=31536000',
                  metadata: { firebaseStorageDownloadTokens: downloadToken },
                },
              });
            }
          } catch (storageErr) {
            console.warn('Storage write skipped due to error:', storageErr?.message || storageErr);
            file = null;
          }

          // Create a usable download URL when Storage write succeeds
          let downloadUrl = null;
          if (file) {
            try {
              const [url] = await file.getSignedUrl({
                action: 'read',
                expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
              });
              downloadUrl = url;
            } catch (e) {
              console.warn('getSignedUrl failed:', e?.message || e);
              // Try to read or set legacy download token, then build token URL
              try {
                const [metadata] = await file.getMetadata().catch(() => [{}]);
                let token = metadata?.metadata?.firebaseStorageDownloadTokens;
                if (!token) {
                  token = downloadToken || randomUUID();
                  await file
                    .setMetadata({ metadata: { firebaseStorageDownloadTokens: token } })
                    .catch(() => {});
                }
                downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(imagePath)}?alt=media&token=${token}`;
              } catch (tokErr) {
                console.warn(
                  'Token URL fallback failed, using public media URL:',
                  tokErr?.message || tokErr,
                );
                downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(imagePath)}?alt=media`;
              }
            }
          } else {
            console.warn('Skipping URL generation because file was not written to Storage');
            downloadUrl = null;
          }

          // Attempt to write Firestore metadata, but don't fail the whole request if Firestore isn't set up
          const ownerId = uid.trim();
          try {
            await db
              .collection('images')
              .doc(id)
              .set({
                storagePath: imagePath,
                type: 'generated',
                ownerId: ownerId || null,
                createdAt: FieldValue.serverTimestamp(),
                prompt,
                style: style || null,
                aspectRatio: aspectRatio || null,
                mockupImageUrl: mockupImageUrl || null,
                mimeType,
                downloadUrl,
                modelVersion: rawResponse?.modelVersion || null,
                size: buffer.length,
                //templateId: templateId || null,
                //cropRect: cropRect || null
              });
            if (ownerId) {
              await db.collection('users').doc(ownerId).collection('generated').doc(id).set({
                createdAt: FieldValue.serverTimestamp(),
                imageId: id,
                storagePath: imagePath,
                type: 'generated',
              });
            }
          } catch (metaErr) {
            console.warn('Firestore metadata write skipped:', metaErr?.message || metaErr);
          }

          return {
            mimeType,
            modelVersion: rawResponse?.modelVersion,
            id,
            storagePath: imagePath,
            downloadUrl,
          };
        },
      );

      // Flow: updateImageTextsForBrand
      const extractText = flow(
        {
          name: 'updateImageTextsForBrand',
          inputSchema: z
            .object({
              brand: z.record(z.any()),
              imageUrl: z.string().url().optional(),
              imageBase64: z.string().optional(),
            })
            .refine((v) => !!v.imageUrl || !!v.imageBase64, {
              message: 'Provide imageUrl or imageBase64',
            }),
          outputSchema: z.object({
            original_texts: z.array(z.string()),
            updated_texts: z.array(z.string()),
            replacable_logo: z.boolean(),
          }),
        },
        async ({ brand, imageUrl, imageBase64 }) => {
          console.log('[updateImageTextsForBrand] Using Gemini for extraction');

          const brandJson = JSON.stringify(brand, null, 2);
          const promptText = [
            'We will update the texts in the provided image so they align with the branding of:',
            '',
            brandJson,
            '',
            '**Task:**',
            '',
            '1. Extract **all text that appears in the image** exactly as shown.',
            '2. Rewrite and improve each extracted text so it matches the above brand’s brand voice, while trying to keep the character length similar to the original.',
            '3. Identify whether the image contains **any logo that could be replaced** with the new brand logo.',
            '4. Return the final result strictly in the following JSON structure:',
            '',
            '{\n  "original_texts": [\n    "..."\n  ],\n  "updated_texts": [\n    "..."\n  ],\n  "replacable_logo": true\n}',
          ].join('\n');
          console.log(brandJson);

          // Prepare image media in Genkit prompt format
          const mediaParts = [];
          if (imageBase64) {
            mediaParts.push({
              media: { contentType: 'image/jpeg', url: `data:image/jpeg;base64,${imageBase64}` },
            });
          } else if (imageUrl) {
            // Fetch and convert to data URL to ensure Gemini receives the image
            try {
              const r = await fetch(imageUrl);
              const mimeType = r.headers.get('content-type') || 'image/jpeg';
              const buffer = Buffer.from(await r.arrayBuffer());
              const b64 = buffer.toString('base64');
              mediaParts.push({
                media: { contentType: mimeType, url: `data:${mimeType};base64,${b64}` },
              });
            } catch (e) {
              console.warn('Failed to fetch imageUrl; passing URL directly:', e?.message || e);
              mediaParts.push({ media: { contentType: 'image/jpeg', url: imageUrl } });
            }
          }

          // Build Genkit prompt for Gemini (media + instruction)
          const promptArray = [...mediaParts, { text: promptText }];

          console.log('[updateImageTextsForBrand] Calling Gemini with', {
            images: mediaParts.length,
          });

          const { text } = await ai.generate({
            model: googleAI.model('gemini-2.5-flash'),
            prompt: promptArray,
            output: { format: 'text' },
            config: { temperature: 0 },
          });

          // Log raw text for debugging
          console.log('[updateImageTextsForBrand] Gemini raw text:', text);

          let json;
          try {
            let toParse = (text || '').trim();
            // Strip leading fenced code markers like ```json or ```
            if (toParse.startsWith('```')) {
              // Remove the opening fence and optional language marker
              toParse = toParse.replace(/^```(?:json)?\n?/, '');
            }
            // Strip trailing closing fence
            if (toParse.endsWith('```')) {
              toParse = toParse.replace(/\n?```$/, '');
            }
            // If the model added extra prose, try to extract only the JSON object
            const firstBrace = toParse.indexOf('{');
            const lastBrace = toParse.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
              toParse = toParse.substring(firstBrace, lastBrace + 1);
            }
            json = JSON.parse(toParse);
          } catch (e) {
            console.error('[updateImageTextsForBrand] JSON parse failed:', e?.message || e);
            console.error('[updateImageTextsForBrand] Raw text:', text);
            console.error('[updateImageTextsForBrand] Cleaned text:', (text || '').trim());
            throw new Error('Gemini returned non-JSON output');
          }
          const parsed = z
            .object({
              original_texts: z.array(z.string()),
              updated_texts: z.array(z.string()),
              replacable_logo: z.boolean(),
            })
            .parse(json);
          return parsed;
        },
      );

      return { generateImageFlow, updateImageTextsForBrand: extractText, buildRebrandBlueprint };
    })();
    return bootPromise;
  };
})();

// HTTP wrapper: POST /api/updateImageTextsForBrand
exports.updateImageTextsForBrand = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 60,
    memory: '256MiB',
    cors: true,
    secrets: [GOOGLE_API_KEY, FREEPIK_API_KEY],
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).send('');
    }
    return cors(req, res, async () => {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed. Use POST.' });
      }
      try {
        const {
          brand,
          imageUrl,
          imageBase64,
          includeBlueprint,
          userId,
          templateId,
          templateUrl,
          aspectRatio,
        } = req.body || {};
        const { updateImageTextsForBrand, buildRebrandBlueprint } = await getFlows();
        const llmResult = await updateImageTextsForBrand({ brand, imageUrl, imageBase64 });
        if (includeBlueprint) {
          const blueprint = buildRebrandBlueprint({
            llmResult,
            brand,
            userId: userId || null,
            templateId: templateId || null,
            templateUrl: templateUrl || null,
            aspectRatio: aspectRatio || null,
          });
          return res.status(200).json({ llm_result: llmResult, blueprint });
        }
        return res.status(200).json(llmResult);
      } catch (err) {
        if (err && (err.name === 'ZodError' || err.issues)) {
          return res
            .status(400)
            .json({ error: 'Invalid input', details: err.issues || String(err) });
        }
        console.error('updateImageTextsForBrand error:', err);
        return res
          .status(500)
          .json({ error: 'Internal error', details: String(err?.message || err) });
      }
    });
  },
);

/**
 * Brand management endpoints: addBrand, updateBrand, deleteBrand
 * Firestore path: /users/{userId}/brands/{brandId}
 * Storage logo path convention: images/brands/{userId}/{brandId}/logo.png
 */
exports.addBrand = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 60,
    memory: '512MiB',
    cors: true,
  },
  async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).send('');
    }

    return cors(req, res, async () => {
      if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed. Use POST.' });
      }

      let user_id;
      let brandInfo;
      let logoFile = null;

      try {
        if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
          console.log('Processing multipart request for addBrand');
          const busboy = Busboy({ headers: req.headers });
          const fields = {};
          const writes = [];

          await new Promise((resolve, reject) => {
            busboy.on('field', (fieldname, val) => {
              console.log(`Busboy field: ${fieldname}`);
              fields[fieldname] = val;
            });

            busboy.on('file', (fieldname, file, { filename, mimeType }) => {
              console.log(`Busboy file: ${fieldname}, filename: ${filename}, mimeType: ${mimeType}`);
              if (fieldname === 'logo') {
                const filepath = path.join(os.tmpdir(), `logo_${randomUUID()}_${filename}`);
                logoFile = { filepath, filename, mimeType };
                const writeStream = fs.createWriteStream(filepath);
                file.pipe(writeStream);
                writes.push(new Promise((res, rej) => {
                  writeStream.on('finish', res);
                  writeStream.on('error', rej);
                }));
              } else {
                console.log(`Skipping file field: ${fieldname}`);
                file.resume();
              }
            });

            busboy.on('finish', async () => {
              console.log('Busboy finished parsing');
              await Promise.all(writes);
              resolve();
            });

            busboy.on('error', (err) => {
              console.error('Busboy error:', err);
              reject(err);
            });

            if (req.rawBody) {
              console.log('Using req.rawBody for busboy');
              busboy.end(req.rawBody);
            } else {
              console.log('Piping req to busboy');
              req.pipe(busboy);
            }
          });

          user_id = fields.user_id;
          try {
            brandInfo = fields.brandInfo ? JSON.parse(fields.brandInfo) : null;
          } catch (e) {
            return res.status(400).json({ success: false, error: 'Invalid brandInfo JSON' });
          }
        } else {
          console.log('Processing JSON request for addBrand');
          user_id = req.body.user_id;
          brandInfo = req.body.brandInfo;
        }

        if (!user_id || typeof user_id !== 'string') {
          return res.status(400).json({ success: false, error: 'Missing required field: user_id' });
        }
        if (!brandInfo || typeof brandInfo !== 'object') {
          return res.status(400).json({ success: false, error: 'Missing required field: brandInfo' });
        }
        const brandName = (brandInfo.brandName || '').toString().trim();
        if (!brandName) {
          return res
            .status(400)
            .json({ success: false, error: 'Missing required field: brandInfo.brandName' });
        }

        const brandsCol = db.collection('users').doc(user_id).collection('brands');
        const brandRef = brandsCol.doc(); // auto-id

        let logoUrl = null;
        if (logoFile) {
          console.log('Uploading logo file:', logoFile.filepath);
          try {
            const downloadToken = randomUUID();
            const destination = `images/brand_logos/${user_id}/${brandRef.id}/${logoFile.filename}`;
            const [file] = await bucket.upload(logoFile.filepath, {
              destination,
              metadata: {
                contentType: logoFile.mimeType,
                metadata: {
                  firebaseStorageDownloadTokens: downloadToken
                }
              },
            });

            // Try to get signed URL (valid for 1 year)
            try {
              const [url] = await file.getSignedUrl({
                action: 'read',
                expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
              });
              logoUrl = url;
              console.log('Logo uploaded successfully, signed url:', logoUrl);
            } catch (signErr) {
              console.warn('getSignedUrl failed, falling back to token URL:', signErr.message);
              // Fallback to token-based URL
              // Ensure bucket name is correct. If bucket.name is missing, try to infer it or use a placeholder (though it should be there).
              const bName = bucket.name || `${process.env.GCLOUD_PROJECT || 'brandize-101db'}.appspot.com`;
              logoUrl = `https://firebasestorage.googleapis.com/v0/b/${bName}/o/${encodeURIComponent(destination)}?alt=media&token=${downloadToken}`;
              console.log('Logo uploaded successfully, token url:', logoUrl);
            }
          } catch (uploadErr) {
            console.error('Logo upload failed:', uploadErr);
            throw new Error('Failed to upload logo: ' + uploadErr.message);
          } finally {
            fs.unlink(logoFile.filepath, () => {});
          }
        } else {
          console.log('No logo file to upload');
        }

        const nowFields = {
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };
        const docData = {
          brandName,
          website: brandInfo.website ?? null,
          phone: brandInfo.phone ?? null,
          address: brandInfo.address ?? null,
          description: brandInfo.description ?? null,
          colorPalette: Array.isArray(brandInfo.colorPalette) ? brandInfo.colorPalette : [],
          logoUrl: logoUrl || null,
          ...nowFields,
        };

        await brandRef.set(docData);
        return res.status(200).json({ success: true, brandId: brandRef.id, logoUrl });
      } catch (err) {
        console.error('addBrand error:', err);
        if (logoFile) fs.unlink(logoFile.filepath, () => {});
        return res
          .status(500)
          .json({ success: false, error: 'Internal error creating brand', details: String(err?.message || err) });
      }
    });
  },
);

exports.updateBrand = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 30,
    memory: '256MiB',
    cors: true,
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).send('');
    }

    return cors(req, res, async () => {
      if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed. Use POST.' });
      }
      try {
        const { user_id, brand_id, brandInfo } = req.body || {};
        if (!user_id || typeof user_id !== 'string') {
          return res.status(400).json({ success: false, error: 'Missing required field: user_id' });
        }
        if (!brand_id || typeof brand_id !== 'string') {
          return res.status(400).json({ success: false, error: 'Missing required field: brand_id' });
        }
        if (!brandInfo || typeof brandInfo !== 'object') {
          return res.status(400).json({ success: false, error: 'Missing required field: brandInfo' });
        }

        const brandRef = db.collection('users').doc(user_id).collection('brands').doc(brand_id);
        const existing = await brandRef.get();
        if (!existing.exists) {
          return res.status(404).json({ success: false, error: 'Brand not found' });
        }

        const updatePayload = { ...brandInfo, updatedAt: FieldValue.serverTimestamp() };
        await brandRef.set(updatePayload, { merge: true });
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error('updateBrand error:', err);
        return res
          .status(500)
          .json({ success: false, error: 'Internal error updating brand', details: String(err?.message || err) });
      }
    });
  },
);

exports.deleteBrand = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 30,
    memory: '256MiB',
    cors: true,
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).send('');
    }

    return cors(req, res, async () => {
      if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed. Use POST.' });
      }
      try {
        const { user_id, brand_id } = req.body || {};
        if (!user_id || typeof user_id !== 'string') {
          return res.status(400).json({ success: false, error: 'Missing required field: user_id' });
        }
        if (!brand_id || typeof brand_id !== 'string') {
          return res.status(400).json({ success: false, error: 'Missing required field: brand_id' });
        }

        const brandRef = db.collection('users').doc(user_id).collection('brands').doc(brand_id);
        const existing = await brandRef.get();
        if (!existing.exists) {
          console.warn(`deleteBrand: brand not found for user ${user_id}, id ${brand_id}`);
        }

        // Attempt Firestore delete regardless
        await brandRef.delete().catch((e) => {
          console.warn('deleteBrand Firestore delete error:', e?.message || e);
        });

        // Attempt to delete logo file at the conventional path; ignore not found
        const logoPath = `images/brands/${user_id}/${brand_id}/logo.png`;
        try {
          await bucket.file(logoPath).delete({ ignoreNotFound: true });
        } catch (e) {
          console.warn('deleteBrand logo delete warning:', e?.message || e);
        }

        return res.status(200).json({ success: true });
      } catch (err) {
        console.error('deleteBrand error:', err);
        return res
          .status(500)
          .json({ success: false, error: 'Internal error deleting brand', details: String(err?.message || err) });
      }
    });
  },
);
