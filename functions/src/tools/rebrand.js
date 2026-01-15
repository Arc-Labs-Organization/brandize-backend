const { onRequest } = require('firebase-functions/v2/https');
const cors = require('cors')({ origin: true });
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { randomUUID } = require('crypto');
const { createAndUploadThumbnail, computeThumbPath } = require('../operations/thumbnailOperations');
const { createMultipartParser, buildGeneratedImagePath, verifyAuth } = require('../common/utils');
const { ensureUserExists, decrementUsage } = require('../operations/userOperations');
const { initGenkit, GOOGLE_API_KEY } = require('../common/genkit');
const { buildRebrandPrompt, buildSmartBlueprintPrompt } = require('../common/prompts');

try {
  if (!admin.apps.length) {
    admin.initializeApp();
  }
} catch (e) {
  // ignore re-init in emulator hot-reload
}

const db = getFirestore();

// Helper: Build a rebranding blueprint from gemini result + brand
// Blueprint is a suggested plan the caller can override before image generation.
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

  const additions = {};

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

let rebrandFlows = null;

async function getRebrandFlows() {
  if (rebrandFlows) return rebrandFlows;

  const { ai, flow, z, googleAI } = await initGenkit();

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

  const generateRebrandFlow = flow(
    {
      name: 'generateRebrand',
      inputSchema: z.object({
        uid: z.string().min(1),
        brand: z.record(z.any()).optional(),
        blueprint: z.record(z.any()),
        croppedImageBase64: z.string(),
        croppedImageMimeType: z.string().optional(),
      }),
      outputSchema: z.object({
        mimeType: z.string(),
        modelVersion: z.string().optional(),
        id: z.string(),
        storagePath: z.string(),
        downloadUrl: z.string().optional().nullable(),
      }),
    },
    async ({ uid, brand, blueprint, croppedImageBase64, croppedImageMimeType }) => {
      // Ensure user exists and decrement generate usage
      await ensureUserExists(uid);
      await decrementUsage(uid, 'generate');

      const bp = blueprint || {};
      const additions = bp.additions || {};

      // Determine if logo media is needed
      let logoUrlToFetch = null;
      const needsLogo =
        bp.replace_logo ||
        (additions &&
         Object.keys(additions).some((k) => {
          const lower = k.toLowerCase();
          return lower === 'brand_logo' || lower === 'logo';
         }));
      if (needsLogo && brand?.logoUrl) {
        logoUrlToFetch = brand.logoUrl;
      }

      // Aspect Ratio
      let aspectRatio = null;
      if (bp.aspectRatio && allowedRatios.includes(bp.aspectRatio)) {
        aspectRatio = bp.aspectRatio;
      }

      const fullPrompt = buildRebrandPrompt({ brand, blueprint: bp });

      // Prepare Media
      const promptArray = [];
      
      // 1. Cropped Image
      const mime = croppedImageMimeType || 'image/png';
      promptArray.push({
         media: {
            url: `data:${mime};base64,${croppedImageBase64}`,
            contentType: mime
         }
      });

      // 2. Logo (if needed)
      if (logoUrlToFetch) {
         try {
            const logoResp = await fetch(logoUrlToFetch);
            if (logoResp.ok) {
               const logoBuf = await logoResp.arrayBuffer();
               const logoBase64 = Buffer.from(logoBuf).toString('base64');
               const logoMime = logoResp.headers.get('content-type') || 'image/png';
               promptArray.push({
                  media: {
                     url: `data:${logoMime};base64,${logoBase64}`,
                     contentType: logoMime
                  }
               });
            }
         } catch (e) {
            console.warn('Failed to fetch brand logo:', e);
         }
      }

      promptArray.push({ text: fullPrompt });

      console.log('--- GEMINI PROMPT START ---');
      console.log(fullPrompt);
      console.log('--- GEMINI PROMPT END ---');

      // Use Genkit to generate an image with Gemini 2.5 Flash Image
      let media, rawResponse;
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

      // Generate and upload thumbnail via helper
      let thumbUrl = null;
      let thumbPath = computeThumbPath(imagePath);
      if (file) {
        const { thumbPath: p, thumbUrl: u } = await createAndUploadThumbnail(bucket, buffer, imagePath);
        thumbPath = p;
        thumbUrl = u;
      }

      // Attempt to write Firestore metadata, but don't fail the entire request if Firestore isn't set up
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
            prompt: fullPrompt,
            style: null,
            aspectRatio: aspectRatio || null,
            mockupImageUrl: null,
            mimeType,
            downloadUrl,
            modelVersion: rawResponse?.modelVersion || null,
            size: buffer.length,
            thumbUrl: thumbUrl || null,
            thumbPath,
            thumbSize: 256,
          });
        if (ownerId) {
          await db.collection('users').doc(ownerId).collection('generated').doc(id).set({
            createdAt: FieldValue.serverTimestamp(),
            imageId: id,
            storagePath: imagePath,
            type: 'generated',
            thumbUrl: thumbUrl || null,
            thumbPath,
            thumbSize: 256,
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

  const generateSmartBlueprintFlow = flow(
    {
      name: 'generateSmartBlueprint',
      inputSchema: z
        .object({
          brand: z.record(z.any()),
          imageBase64: z.string(),
          updateFields: z.record(z.boolean()),
        }),
      outputSchema: z.object({
        original_texts: z.array(z.string()),
        updated_texts: z.array(z.string().nullable()),
        additions: z.array(
          z.object({
            type: z.enum(['phone', 'website', 'brand_name', 'brand_address']),
            location: z.enum([
              'bottom-left',
              'bottom-mid',
              'bottom-right',
              'top-left',
              'top-mid',
              'top-right',
            ]),
          }),
        ),
        replacable_logo: z.boolean(),
      }),
    },
    async ({ brand, imageBase64, updateFields }) => {
      console.log('[generateSmartBlueprint] Using Gemini for extraction');

      // Construct the field values table for the prompt
      const fieldValues = {};
      for (const [key, enabled] of Object.entries(updateFields)) {
        if (enabled && brand[key]) {
          fieldValues[key] = brand[key];
        } else {
          fieldValues[key] = null;
        }
      }

      const fieldValuesJson = JSON.stringify(fieldValues, null, 2);
      const promptText = buildSmartBlueprintPrompt({ brand, updateFields });
      
      console.log('[generateSmartBlueprint] Prompt table:', fieldValuesJson);

      // Prepare image media in Genkit prompt format
      const mediaParts = [];
      if (imageBase64) {
        mediaParts.push({
          media: { contentType: 'image/jpeg', url: `data:image/jpeg;base64,${imageBase64}` },
        });
      }

      // Build Genkit prompt for Gemini (media + instruction)
      const promptArray = [...mediaParts, { text: promptText }];

      console.log('[generateSmartBlueprint] Calling Gemini with', {
        images: mediaParts.length,
      });

      const { text } = await ai.generate({
        model: googleAI.model('gemini-2.5-flash'),
        prompt: promptArray,
        output: { format: 'text' },
        config: { temperature: 0 },
      });

      // Log raw text for debugging
      console.log('[generateSmartBlueprint] Gemini raw text:', text);

      let json;
      try {
        let toParse = (text || '').trim();
        if (toParse.startsWith('```')) {
          toParse = toParse.replace(/^```(?:json)?\n?/, '');
        }
        if (toParse.endsWith('```')) {
          toParse = toParse.replace(/\n?```$/, '');
        }
        const firstBrace = toParse.indexOf('{');
        const lastBrace = toParse.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          toParse = toParse.substring(firstBrace, lastBrace + 1);
        }
        json = JSON.parse(toParse);
      } catch (e) {
        console.error('[generateSmartBlueprint] JSON parse failed:', e?.message || e);
        console.error('[generateSmartBlueprint] Raw text:', text);
        console.error('[generateSmartBlueprint] Cleaned text:', (text || '').trim());
        throw new Error('Gemini returned non-JSON output');
      }
      const parsed = z
        .object({
          original_texts: z.array(z.string()),
          updated_texts: z.array(z.string().nullable()),
          additions: z.array(
            z.object({
              type: z.enum(['phone', 'website', 'brand_name', 'brand_address']),
              location: z.enum([
                'bottom-left',
                'bottom-mid',
                'bottom-right',
                'top-left',
                'top-mid',
                'top-right',
              ]),
            }),
          ),
          replacable_logo: z.boolean(),
        })
        .parse(json);
      return parsed;
    },
  );

  rebrandFlows = { generateRebrandFlow, generateSmartBlueprintFlow };
  return rebrandFlows;
}

exports.generateRebrand = onRequest(
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

      let uid;
      try {
        uid = await verifyAuth(req);
      } catch (e) {
        return res.status(401).json({ error: e.message });
      }

      // Check for multipart/form-data
      if (!req.headers['content-type'] || !req.headers['content-type'].includes('multipart/form-data')) {
        return res.status(400).json({ error: 'Content-Type must be multipart/form-data' });
      }

      const busboy = createMultipartParser(req.headers);
      const fields = {};
      let imageBuffer = null;
      let imageMimeType = null;

      try {
        await new Promise((resolve, reject) => {
          busboy.on('field', (fieldname, val) => {
            fields[fieldname] = val;
          });

          busboy.on('file', (fieldname, file, { filename, mimeType }) => {
            if (fieldname === 'croppedImage') {
              const chunks = [];
              file.on('data', (data) => chunks.push(data));
              file.on('end', () => {
                imageBuffer = Buffer.concat(chunks);
                imageMimeType = mimeType;
              });
            } else {
              file.resume(); // Discard other files
            }
          });

          busboy.on('finish', resolve);
          busboy.on('error', reject);

          if (req.rawBody) {
            busboy.end(req.rawBody);
          } else {
            req.pipe(busboy);
          }
        });

        const { brand_id, blueprint, storagePath } = fields;

        if (!brand_id || !blueprint) {
          return res.status(400).json({ error: 'Missing required fields: brand_id, blueprint' });
        }

        if (!imageBuffer) {
          if (storagePath) {
            try {
              const appOptions = admin.app().options || {};
              const configuredBucket = appOptions.storageBucket;
              const projId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
              const bucketName = configuredBucket || (projId ? `${projId}.appspot.com` : undefined);
              const bucket = bucketName ? admin.storage().bucket(bucketName) : admin.storage().bucket();

              const file = bucket.file(storagePath);
              const [exists] = await file.exists();
              if (!exists) {
                return res.status(404).json({ error: 'Image not found at storagePath' });
              }

              const [metadata] = await file.getMetadata();
              imageMimeType = metadata.contentType || 'image/png';

              const [downloadedBuffer] = await file.download();
              imageBuffer = downloadedBuffer;
            } catch (e) {
              console.error('Error downloading from storage:', e);
              return res.status(500).json({ error: 'Failed to download image from storage' });
            }
          } else {
            return res.status(400).json({ error: 'Missing required file: croppedImage or field: storagePath' });
          }
        }

        // Fetch brand from Firestore
        const brandDoc = await db.collection('users').doc(uid).collection('brands').doc(brand_id).get();
        if (!brandDoc.exists) {
          return res.status(404).json({ error: 'Brand not found' });
        }

        const brandData = brandDoc.data();
        let parsedBlueprint;

        try {
          parsedBlueprint = JSON.parse(blueprint);
        } catch (e) {
          return res.status(400).json({ error: 'Invalid blueprint JSON format' });
        }

        const croppedImageBase64 = imageBuffer.toString('base64');

        const { generateRebrandFlow } = await getRebrandFlows();
        const result = await generateRebrandFlow({
          uid,
          brand: brandData,
          blueprint: parsedBlueprint,
          croppedImageBase64,
          croppedImageMimeType: imageMimeType,
        });

        return res.status(200).json(result);
      } catch (err) {
        if (err && (err.name === 'ZodError' || err.issues)) {
          return res
            .status(400)
            .json({ error: 'Invalid input', details: err.issues || String(err) });
        }
        console.error('generateRebrand error:', err);
        return res
          .status(500)
          .json({ error: 'Internal error generating image', details: String(err.message || err) });
      }
    });
  },
);

exports.generateSmartBlueprint = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 60,
    memory: '512MiB',
    cors: true,
    secrets: [GOOGLE_API_KEY],
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

      let user_id;
      try {
        user_id = await verifyAuth(req);
      } catch (e) {
        return res.status(401).json({ error: e.message });
      }

      // Check for multipart/form-data
      if (!req.headers['content-type'] || !req.headers['content-type'].includes('multipart/form-data')) {
        return res.status(400).json({ error: 'Content-Type must be multipart/form-data' });
      }

      const busboy = createMultipartParser(req.headers);
      const fields = {};
      let imageBuffer = null;

      try {
        await new Promise((resolve, reject) => {
          busboy.on('field', (fieldname, val) => {
            fields[fieldname] = val;
          });

          busboy.on('file', (fieldname, file, { filename, mimeType }) => {
            if (fieldname === 'croppedImage') {
              const chunks = [];
              file.on('data', (data) => chunks.push(data));
              file.on('end', () => {
                imageBuffer = Buffer.concat(chunks);
              });
            } else {
              file.resume(); // Discard other files
            }
          });

          busboy.on('finish', resolve);
          busboy.on('error', reject);

          if (req.rawBody) {
            busboy.end(req.rawBody);
          } else {
            req.pipe(busboy);
          }
        });

        const { brand_id, updateFields, storagePath } = fields;

        if (!brand_id || !updateFields) {
          return res.status(400).json({ error: 'Missing required fields: brand_id, updateFields' });
        }

        if (!imageBuffer) {
          if (storagePath) {
            try {
              const appOptions = admin.app().options || {};
              const configuredBucket = appOptions.storageBucket;
              const projId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
              const bucketName = configuredBucket || (projId ? `${projId}.appspot.com` : undefined);
              const bucket = bucketName ? admin.storage().bucket(bucketName) : admin.storage().bucket();

              const file = bucket.file(storagePath);
              const [exists] = await file.exists();
              if (!exists) {
                return res.status(404).json({ error: 'Image not found at storagePath' });
              }
              const [downloadedBuffer] = await file.download();
              imageBuffer = downloadedBuffer;
            } catch (e) {
              console.error('Error downloading from storage:', e);
              return res.status(500).json({ error: 'Failed to download image from storage' });
            }
          } else {
            return res.status(400).json({ error: 'Missing required file: croppedImage or field: storagePath' });
          }
        }

        // Fetch brand from Firestore
        const brandDoc = await db.collection('users').doc(user_id).collection('brands').doc(brand_id).get();
        if (!brandDoc.exists) {
          return res.status(404).json({ error: 'Brand not found' });
        }

        const brandData = brandDoc.data();
        let parsedUpdateFields;

        // Parse updateFields JSON
        try {
          parsedUpdateFields = JSON.parse(updateFields);
        } catch (e) {
          console.warn('Invalid updateFields JSON', e);
          return res.status(400).json({ error: 'Invalid updateFields JSON format' });
        }

        const imageBase64 = imageBuffer.toString('base64');

        const { generateSmartBlueprintFlow } = await getRebrandFlows();
        const llmResult = await generateSmartBlueprintFlow({ brand: brandData, imageBase64, updateFields: parsedUpdateFields });

        return res.status(200).json(llmResult);
      } catch (err) {
        if (err && (err.name === 'ZodError' || err.issues)) {
          return res
            .status(400)
            .json({ error: 'Invalid input', details: err.issues || String(err) });
        }
        console.error('generateSmartBlueprint error:', err);
        return res
          .status(500)
          .json({ error: 'Internal error', details: String(err?.message || err) });
      }
    });
  },
);
