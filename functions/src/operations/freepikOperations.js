const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const cors = require('cors')({ origin: true });
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { randomUUID } = require('crypto');
const JSZip = require('jszip');
const sharp = require('sharp');
const { buildCommonImagePath, verifyAuth } = require('../common/utils');
const { ensureUserExists, decrementUsage } = require('./userOperations');
const { initGenkit, GOOGLE_API_KEY } = require('../common/genkit');

try {
  if (!admin.apps.length) {
    admin.initializeApp();
  }
} catch (e) {
  // ignore re-init in emulator hot-reload
}

const db = getFirestore();
const bucket = admin.storage().bucket();

const FREEPIK_API_KEY = defineSecret('FREEPIK_API_KEY');

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
      // Authentication check
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.error('Missing or invalid Authorization header');
        return res.status(401).send('Unauthorized');
      }

      const idToken = authHeader.split('Bearer ')[1];
      try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        console.log('User authenticated:', decodedToken.uid);
      } catch (error) {
        console.error('Error verifying ID token:', error);
        return res.status(401).send('Unauthorized');
      }

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

      let uid;
      try {
        uid = await verifyAuth(req);
      } catch (e) {
        return res.status(401).json({ error: e.message });
      }

      const resourceId = (req.query.resourceId || '').toString().trim();
      if (!resourceId)
        return res.status(400).json({ error: 'Missing required query parameter: resourceId' });

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

            // Generate and upload thumbnail for downloaded image
            const { createAndUploadThumbnail, computeThumbPath } = require('./thumbnailOperations');
            const { thumbPath, thumbUrl } = await createAndUploadThumbnail(bucket, imgBuffer, storagePath);
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
              thumbUrl: thumbUrl || null,
              thumbPath,
              thumbSize: 256,
            });
          } catch (e) {
            console.error('Caching Freepik resource failed', e);
            return res
              .status(500)
              .json({ error: 'CACHE_FAILED', details: e?.message || String(e) });
          }
        }

        // User link: persist thumbnail fields directly from master image doc (no fallbacks)
        try {
          const snap = await imageDocRef.get();
          const meta = snap.exists ? (snap.data() || {}) : {};
          const linkThumbUrl = typeof meta.thumbUrl === 'string' ? meta.thumbUrl : null;
          const linkThumbPath = typeof meta.thumbPath === 'string' ? meta.thumbPath : null;
          await db.collection('users').doc(uid).collection('downloads').doc(resourceId).set(
            {
              createdAt: FieldValue.serverTimestamp(),
              imageId: resourceId,
              storagePath,
              type: 'downloaded',
              thumbUrl: linkThumbUrl,
              thumbPath: linkThumbPath,
              thumbSize: typeof meta.thumbSize === 'number' ? meta.thumbSize : 256,
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
 * Download a Freepik template, analyze layouts with Gemini, crop them, and save.
 * GET /api/freepik/downloadTemplate?resourceId=<id>
 */
exports.freepikDownloadTemplate = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 300,
    memory: '1GiB',
    cors: true,
    secrets: [FREEPIK_API_KEY, GOOGLE_API_KEY],
  },
  async (req, res) => {
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

      let uid;
      try {
        uid = await verifyAuth(req);
      } catch (e) {
        return res.status(401).json({ error: e.message });
      }

      const resourceId = (req.query.resourceId || '').toString().trim();
      if (!resourceId)
        return res.status(400).json({ error: 'Missing required query parameter: resourceId' });

      if (!process.env.FREEPIK_API_KEY) {
        return res.status(500).json({ error: 'FREEPIK_API_KEY not configured on server' });
      }

      try {
        const startTime = Date.now();
        let lastTime = startTime;
        const logTime = (step) => {
            const now = Date.now();
            console.log(`[Timer] ${step}: ${now - lastTime}ms (Total: ${now - startTime}ms)`);
            lastTime = now;
        };

        // Ensure user exists and decrement download usage
        await ensureUserExists(uid);
        await decrementUsage(uid, 'download');
        logTime('User Accounting (Firestore)');

        // 1. Get Download URL from Freepik
        // Use the format-specific endpoint: /v1/resources/{id}/download/jpg
        const apiUrl = new URL(
          `https://api.freepik.com/v1/resources/${encodeURIComponent(resourceId)}/download/jpg`,
        );

        const apiKey = (process.env.FREEPIK_API_KEY || '').trim();
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

        let fpResp;
        try {
            fpResp = await fetch(apiUrl.toString(), {
              method: 'GET',
              headers: {
                'x-freepik-api-key': apiKey,
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
              },
              signal: controller.signal,
            });
        } catch (e) {
             if (e.name === 'AbortError') {
                 return res.status(504).json({ error: 'Freepik API timeout' });
             }
             throw e;
        } finally {
            clearTimeout(timeout);
        }

        if (!fpResp.ok) {
          const text = await fpResp.text();
          return res.status(fpResp.status).json({ error: 'Freepik API error', details: text });
        }

        const json = await fpResp.json();
        let downloadUrl = null;
        if (json.data && Array.isArray(json.data) && json.data.length > 0) {
             downloadUrl = json.data[0].url;
        } else {
             // Fallback for other response shapes
             downloadUrl = (json && (json.url || json.location)) || null;
        }
        
        if (!downloadUrl)
          return res.status(502).json({ error: 'Missing download URL from Freepik response' });
        
        logTime('Get Download URL');

        // 2. Download the asset (zip or image)
        const dlController = new AbortController();
        const dlTimeout = setTimeout(() => dlController.abort(), 60000); // 60s timeout for download

        let assetResp;
        try {
            assetResp = await fetch(downloadUrl, { signal: dlController.signal });
        } catch (e) {
             if (e.name === 'AbortError') {
                 return res.status(504).json({ error: 'Asset download timeout' });
             }
             throw e;
        } finally {
            clearTimeout(dlTimeout);
        }

        if (!assetResp.ok)
          return res.status(assetResp.status).json({ error: 'Failed to fetch Freepik asset' });
        
        const assetBuffer = Buffer.from(await assetResp.arrayBuffer());
        logTime('Download Asset');
        let imgBuffer = null;
        let mimeType = 'image/jpeg';

        // Check if zip
        try {
            const zip = await JSZip.loadAsync(assetBuffer);
            console.log('freepikDownloadTemplate: Downloaded file is a ZIP archive.');
            // Find the first jpg/jpeg
            const imageFiles = Object.values(zip.files).filter(
              (f) => !f.dir && /\.(jpg|jpeg)$/i.test(f.name)
            );
            if (imageFiles.length > 0) {
                imgBuffer = await imageFiles[0].async('nodebuffer');
                if (imageFiles[0].name.toLowerCase().endsWith('.jpg') || imageFiles[0].name.toLowerCase().endsWith('.jpeg')) {
                    mimeType = 'image/jpeg';
                }
            } else {
                 // Fallback to other images if no jpg
                 const anyImage = Object.values(zip.files).filter(
                    (f) => !f.dir && /\.(png|webp)$/i.test(f.name)
                 );
                 if (anyImage.length > 0) {
                     imgBuffer = await anyImage[0].async('nodebuffer');
                     if (anyImage[0].name.toLowerCase().endsWith('.png')) mimeType = 'image/png';
                     else if (anyImage[0].name.toLowerCase().endsWith('.webp')) mimeType = 'image/webp';
                 }
            }
        } catch (e) {
            console.log('freepikDownloadTemplate: Downloaded file is likely an image (not a ZIP).');
            // Not a zip, maybe it's the image directly
            imgBuffer = assetBuffer;
            const contentType = assetResp.headers.get('content-type');
            if (contentType) mimeType = contentType;
        }

        if (!imgBuffer) {
            return res.status(422).json({ error: 'No valid image found in download' });
        }
        logTime('Process Zip/Image');

        // 2.5. Start Upload of Original Image (Parallel)
        const originalPath = `images/common/${resourceId}/original.jpg`;
        const originalToken = randomUUID();
        const originalUploadPromise = bucket.file(originalPath).save(imgBuffer, {
            resumable: false,
            contentType: mimeType,
            metadata: {
                cacheControl: 'public, max-age=31536000',
                metadata: { firebaseStorageDownloadTokens: originalToken },
            },
        }).then(() => ({
            name: 'original.jpg',
            path: originalPath,
            url: `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(originalPath)}?alt=media&token=${originalToken}`
        }));

        // Generate thumbnail for original image
        const { createAndUploadThumbnail } = require('./thumbnailOperations');
        const thumbnailPromise = createAndUploadThumbnail(bucket, imgBuffer, originalPath)
            .then(({ thumbPath, thumbUrl }) => ({
                name: 'original_thumb_256.jpg',
                path: thumbPath,
                url: thumbUrl
            }));

        // 2.6. Resize for Gemini
        // Force JPEG for Gemini to keep payload small, regardless of original format
        const geminiBuffer = await sharp(imgBuffer)
            .resize({ width: 1024, height: 1024, fit: 'inside' })
            .jpeg({ quality: 80 })
            .toBuffer();
        
        logTime('Resize for Gemini');
        console.log(`Gemini Payload Size: ${(geminiBuffer.length / 1024).toFixed(2)} KB`);

        // 3. Send to Gemini
        const { ai, googleAI } = await initGenkit();
        const promptText = `can you identify how many social layouts in this images and tell me the normalized coordinates? Give me the normalized coordinates (0...1), so I can calculate to the image size on my end. Response only with json in this format:
{
"layouts": [
{
"top_left": { "x": 0.134, "y": 0.128 },
"bottom_right": { "x": 0.359, "y": 0.528 }
},
...
]
}`;

        // Use image/jpeg content type since we forced conversion
        const generateResp = await ai.generate({
            model: googleAI.model('gemini-3-flash-preview'),
            prompt: [
                { media: { url: `data:image/jpeg;base64,${geminiBuffer.toString('base64')}`, contentType: 'image/jpeg' } },
                { text: promptText }
            ],
            config: {
                temperature: 0.4,
            },
            output: { format: 'json' }
        });

        const responseText = generateResp.text;
        console.log('freepikDownloadTemplate: Gemini response:', responseText);
        const jsonStr = responseText.replace(/```json\n?|\n?```/g, '').trim();
        let layoutData;
        try {
            layoutData = JSON.parse(jsonStr);
        } catch (e) {
            console.error('Failed to parse Gemini response:', responseText);
            return res.status(500).json({ error: 'Invalid response from AI model', details: responseText });
        }

        if (!layoutData || !Array.isArray(layoutData.layouts)) {
             return res.status(500).json({ error: 'Invalid layout data format from AI', details: layoutData });
        }
        logTime('Gemini Analysis');

        // 4. Crop images
        const metadata = await sharp(imgBuffer).metadata();
        const width = metadata.width;
        const height = metadata.height;

        const crops = [];
        // Original image is already being uploaded

        for (let i = 0; i < layoutData.layouts.length; i++) {
            const layout = layoutData.layouts[i];
            
            // Get normalized coordinates (0-1)
            const x1_norm = layout.top_left?.x || 0;
            const y1_norm = layout.top_left?.y || 0;
            const x2_norm = layout.bottom_right?.x || 0;
            const y2_norm = layout.bottom_right?.y || 0;

            // Convert to pixels
            let x1 = Math.floor(x1_norm * width);
            let y1 = Math.floor(y1_norm * height);
            let x2 = Math.floor(x2_norm * width);
            let y2 = Math.floor(y2_norm * height);

            // Validate coordinates (clamp)
            x1 = Math.max(0, x1);
            y1 = Math.max(0, y1);
            x2 = Math.min(width, x2);
            y2 = Math.min(height, y2);

            const cropW = x2 - x1;
            const cropH = y2 - y1;

            if (cropW > 0 && cropH > 0) {
                try {
                    const cropBuffer = await sharp(imgBuffer)
                        .extract({ left: x1, top: y1, width: cropW, height: cropH })
                        .toFormat('jpeg')
                        .toBuffer();
                    crops.push({ name: `cropped_${i + 1}.jpg`, buffer: cropBuffer });
                } catch (e) {
                    console.error(`Failed to crop layout ${i}:`, e);
                }
            } else {
                console.warn(`Skipping invalid crop ${i}: [${x1}, ${y1}, ${x2}, ${y2}]`);
            }
        }
        logTime('Cropping Images');

        // 5. Save to Firebase Storage
        const cropUploadPromises = crops.map(async (crop) => {
            const storagePath = `images/common/${resourceId}/${crop.name}`;
            const file = bucket.file(storagePath);
            const token = randomUUID();
            await file.save(crop.buffer, {
                resumable: false,
                contentType: 'image/jpeg',
                metadata: {
                    cacheControl: 'public, max-age=31536000',
                    metadata: { firebaseStorageDownloadTokens: token },
                },
            });
            const signedUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
            return { name: crop.name, path: storagePath, url: signedUrl };
        });

        const uploadedFiles = await Promise.all([originalUploadPromise, thumbnailPromise, ...cropUploadPromises]);
        logTime('Storage Upload');

        return res.status(200).json({
            resourceId,
            files: uploadedFiles,
            layouts: layoutData.layouts
        });

      } catch (err) {
        console.error('freepikDownloadTemplate error:', err);
        return res.status(500).json({ error: 'Internal Server Error', details: err.message });
      }
    });
  }
);
