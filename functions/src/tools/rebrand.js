const { onRequest } = require('firebase-functions/v2/https');
const cors = require('cors')({ origin: true });
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { randomUUID } = require('crypto');
const { createAndUploadThumbnail, computeThumbPath } = require('../operations/thumbnailOperations');
const { createMultipartParser, buildGeneratedImagePath, verifyAuth } = require('../common/utils');
const { ensureUserExists, decrementUsage, checkHasCredits } = require('../operations/userOperations');
const { initGenkit, GOOGLE_API_KEY } = require('../common/genkit');
const { buildRebrandPrompt, buildSmartBlueprintPrompt } = require('../common/prompts');
const {
  AppError,
  ErrorCodes,
  unauthenticated,
  validationError,
  providerTimeout,
  providerUnavailable,
  providerRejected,
  sendError,
  normalizeUnknownError,
  logError,
} = require('../common/errors');

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
      // Ensure user exists; decrement only after successful generation
      await ensureUserExists(uid);

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

      // 1. Calculate Input Aspect Ratio
      let inputAspectRatio = null;
      try {
        const sharp = require('sharp');
        const baseBuf = Buffer.from(croppedImageBase64, 'base64');
        const meta = await sharp(baseBuf).metadata();
        const w = meta.width || 0;
        const h = meta.height || 0;
        
        if (w > 0 && h > 0) {
          const ratio = w / h;
          // Map allowed ratios to numerical values for comparison
           const candidates = allowedRatios.map(r => {
            const [rw, rh] = r.split(':').map(Number);
            return { label: r, value: rw / rh };
          });

          let best = candidates[0];
          let bestDiff = Math.abs(ratio - best.value);
          
          for (const c of candidates) {
            const diff = Math.abs(ratio - c.value);
            if (diff < bestDiff) {
              best = c;
              bestDiff = diff;
            }
          }
          inputAspectRatio = best.label;
          console.log(`Derived aspect ratio ${inputAspectRatio} from dimensions ${w}x${h}`);
        }
      } catch (e) {
        console.warn('Failed to derive aspect ratio:', e);
      }

      // 2. Determine Target/Final Aspect Ratio
      let aspectRatio = null; // This will be the FINAL target used for generation
      if (bp.aspectRatio && allowedRatios.includes(bp.aspectRatio)) {
        aspectRatio = bp.aspectRatio;
      } else {
        aspectRatio = inputAspectRatio;
      }

      const fullPrompt = buildRebrandPrompt({ 
        brand, 
        blueprint: bp,
        originalAspectRatio: inputAspectRatio,
        targetAspectRatio: aspectRatio
      });

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

      // Use @google/genai SDK directly to avoid protocol mismatch errors with Genkit
      // for the gemini-3-pro-image-preview model.
      const { GoogleGenAI } = require("@google/genai");
      const genaiClient = new GoogleGenAI({ apiKey: GOOGLE_API_KEY.value() });
      
      const contentsParts = [];

      // Add text parts first as recommended by some Gemini documentation patterns
      // (though interleaved is supported, consistent ordering helps)
      for (const item of promptArray) {
        if (item.text) {
          contentsParts.push({ text: item.text });
        }
      }

      // Add media parts
      for (const item of promptArray) {
        if (item.media) {
          // item.media.url is "data:<mime>;base64,<data>"
          const matches = item.media.url.match(/^data:([^;]+);base64,(.+)$/);
          if (matches) {
            contentsParts.push({
              inlineData: {
                mimeType: matches[1],
                data: matches[2] 
              }
            });
          }
        }
      }

      const imageConfig = {
        aspectRatio: aspectRatio || '1:1',
      };
      
      // Explicitly set 2K resolution if not provided, or map logic if needed.
      // The user example had '2K'. We'll stick to aspectRatio for now unless we want to force resolution.
      // Based on user snippet, let's include imageSize logic via aspectRatio mapping or default.
      // The user prompt specifically showed "imageSize": "2K" in the successful example.
      imageConfig.imageSize = '2K'; 

      const response = await genaiClient.models.generateContent({
        model: 'gemini-3-pro-image-preview',
        contents: [{ parts: contentsParts }],
        config: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: imageConfig,
        },
      });

      // Extract image data from GoogleGenAI response
      let dataUrl = null;
      const candidates = response.candidates || [];
      const firstCandidate = candidates[0];
      
      // We will use the model version we requested since the SDK response structure varies
      const modelVersion = 'gemini-3-pro-image-preview';
      
      if (firstCandidate && firstCandidate.content && firstCandidate.content.parts) {
        for (const part of firstCandidate.content.parts) {
           // We might get text parts (thoughts) and inlineData parts (image)
           if (part.inlineData) {
             const mime = part.inlineData.mimeType || 'image/png';
             const b64 = part.inlineData.data;
             dataUrl = `data:${mime};base64,${b64}`;
           }
           if (part.text) {
             console.log('Gemini Thought:', part.text);
           }
        }
      }

      if (!dataUrl) {
        console.error('generate: missing image in GoogleGenAI response', JSON.stringify(response, null, 2));
        throw new Error('Model did not return image media.');
      }

      const commaIdx = dataUrl.indexOf(',');
      const header = dataUrl.substring(0, commaIdx);
      const imageBase64 = dataUrl.substring(commaIdx + 1);
      const mimeTypeMatch = /data:(.*?);base64/.exec(header);
      const mimeType = (mimeTypeMatch && mimeTypeMatch[1]) || 'image/png';

      // --- LOG RESOLUTION ---
      try {
        const sharp = require('sharp');
        const buf = Buffer.from(imageBase64, 'base64');
        const meta = await sharp(buf).metadata();
        console.log(`GEMINI GENERATED RESOLUTION: ${meta.width}x${meta.height}`);
      } catch (e) {
        console.log('Failed to read dimensions:', e);
      }
      // ---------------------

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
            modelVersion: modelVersion || null,
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

      // No decrement here; credits are consumed at blueprint extraction step
      return {
        mimeType,
        modelVersion: modelVersion,
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
            type: z.enum(['phone', 'website', 'brand_name', 'brand_address', 'brand_logo']),
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
      
      // console.log('[generateSmartBlueprint] Prompt table:', fieldValuesJson);
      console.log('[generateSmartBlueprint] Full Prompt Text:', promptText);

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
              type: z.enum(['phone', 'website', 'brand_name', 'brand_address', 'brand_logo']),
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
    const requestId = randomUUID();
    // Handle CORS preflight explicitly for some clients
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).send('');
    }

    return cors(req, res, async () => {
      if (req.method !== 'POST') {
        const err = new AppError({
          code: ErrorCodes.INVALID_STATE,
          message: 'Method not allowed. Use POST.',
          httpStatus: 405,
          retryable: false,
        });
        logError({ requestId, endpoint: 'generateRebrand', err });
        return sendError(res, err, requestId);
      }

      let uid;
      try {
        uid = await verifyAuth(req);
      } catch (e) {
        const err = unauthenticated(e?.message || 'Unauthorized');
        logError({ requestId, endpoint: 'generateRebrand', err });
        return sendError(res, err, requestId);
      }

      // Check for multipart/form-data
      if (!req.headers['content-type'] || !req.headers['content-type'].includes('multipart/form-data')) {
        const err = validationError({ 'content-type': 'must be multipart/form-data' });
        logError({ requestId, uid, endpoint: 'generateRebrand', err });
        return sendError(res, err, requestId);
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
          const err = validationError({ brand_id: !brand_id ? 'required' : undefined, blueprint: !blueprint ? 'required' : undefined });
          logError({ requestId, uid, endpoint: 'generateRebrand', err });
          return sendError(res, err, requestId);
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
                const err = new AppError({
                  code: ErrorCodes.VALIDATION_ERROR,
                  message: 'Image not found at storagePath',
                  httpStatus: 404,
                  retryable: false,
                });
                logError({ requestId, uid, endpoint: 'generateRebrand', err });
                return sendError(res, err, requestId);
              }

              const [metadata] = await file.getMetadata();
              imageMimeType = metadata.contentType || 'image/png';

              const [downloadedBuffer] = await file.download();
              imageBuffer = downloadedBuffer;
            } catch (e) {
              const err = storageError('Failed to download image from storage', true);
              logError({ requestId, uid, endpoint: 'generateRebrand', err });
              return sendError(res, err, requestId);
            }
          } else {
            const err = validationError({ croppedImage: 'required', storagePath: 'required' });
            logError({ requestId, uid, endpoint: 'generateRebrand', err });
            return sendError(res, err, requestId);
          }
        }

        // Fetch brand from Firestore
        const brandDoc = await db.collection('users').doc(uid).collection('brands').doc(brand_id).get();
        if (!brandDoc.exists) {
          const err = new AppError({
            code: ErrorCodes.VALIDATION_ERROR,
            message: 'Brand not found',
            httpStatus: 404,
            retryable: false,
          });
          logError({ requestId, uid, endpoint: 'generateRebrand', err });
          return sendError(res, err, requestId);
        }

        const brandData = brandDoc.data();
        let parsedBlueprint;

        try {
          parsedBlueprint = JSON.parse(blueprint);
        } catch (e) {
          const err = validationError({ blueprint: 'invalid JSON' });
          logError({ requestId, uid, endpoint: 'generateRebrand', err });
          return sendError(res, err, requestId);
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
          const appErr = validationError(err.issues || String(err));
          logError({ requestId, endpoint: 'generateRebrand', err: appErr });
          return sendError(res, appErr, requestId);
        }
        const appErr = normalizeUnknownError(err);
        logError({ requestId, endpoint: 'generateRebrand', err: appErr });
        return sendError(res, appErr, requestId);
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
    const requestId = randomUUID();
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).send('');
    }
    return cors(req, res, async () => {
      if (req.method !== 'POST') {
        const err = new AppError({
          code: ErrorCodes.INVALID_STATE,
          message: 'Method not allowed. Use POST.',
          httpStatus: 405,
          retryable: false,
        });
        logError({ requestId, endpoint: 'generateSmartBlueprint', err });
        return sendError(res, err, requestId);
      }

      let user_id;
      try {
        user_id = await verifyAuth(req);
      } catch (e) {
        const err = unauthenticated(e?.message || 'Unauthorized');
        logError({ requestId, endpoint: 'generateSmartBlueprint', err });
        return sendError(res, err, requestId);
      }

      try {
        await ensureUserExists(user_id);
        await checkHasCredits(user_id, 'generate');
      } catch (e) {
        logError({ requestId, uid: user_id, endpoint: 'generateSmartBlueprint', err: e });
        return sendError(res, e, requestId);
      }

      // Check for multipart/form-data
      if (!req.headers['content-type'] || !req.headers['content-type'].includes('multipart/form-data')) {
        const err = validationError({ 'content-type': 'must be multipart/form-data' });
        logError({ requestId, uid: user_id, endpoint: 'generateSmartBlueprint', err });
        return sendError(res, err, requestId);
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
          const err = validationError({ brand_id: !brand_id ? 'required' : undefined, updateFields: !updateFields ? 'required' : undefined });
          logError({ requestId, uid: user_id, endpoint: 'generateSmartBlueprint', err });
          return sendError(res, err, requestId);
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
                const err = new AppError({
                  code: ErrorCodes.VALIDATION_ERROR,
                  message: 'Image not found at storagePath',
                  httpStatus: 404,
                  retryable: false,
                });
                logError({ requestId, uid: user_id, endpoint: 'generateSmartBlueprint', err });
                return sendError(res, err, requestId);
              }
              const [downloadedBuffer] = await file.download();
              imageBuffer = downloadedBuffer;
            } catch (e) {
              const err = storageError('Failed to download image from storage', true);
              logError({ requestId, uid: user_id, endpoint: 'generateSmartBlueprint', err });
              return sendError(res, err, requestId);
            }
          } else {
            const err = validationError({ croppedImage: 'required', storagePath: 'required' });
            logError({ requestId, uid: user_id, endpoint: 'generateSmartBlueprint', err });
            return sendError(res, err, requestId);
          }
        }

        // Fetch brand from Firestore
        const brandDoc = await db.collection('users').doc(user_id).collection('brands').doc(brand_id).get();
        if (!brandDoc.exists) {
          const err = new AppError({
            code: ErrorCodes.VALIDATION_ERROR,
            message: 'Brand not found',
            httpStatus: 404,
            retryable: false,
          });
          logError({ requestId, uid: user_id, endpoint: 'generateSmartBlueprint', err });
          return sendError(res, err, requestId);
        }

        const brandData = brandDoc.data();
        let parsedUpdateFields;

        // Parse updateFields JSON
        try {
          parsedUpdateFields = JSON.parse(updateFields);
        } catch (e) {
          const err = validationError({ updateFields: 'invalid JSON' });
          logError({ requestId, uid: user_id, endpoint: 'generateSmartBlueprint', err });
          return sendError(res, err, requestId);
        }

        const imageBase64 = imageBuffer.toString('base64');

        const { generateSmartBlueprintFlow } = await getRebrandFlows();
        const llmResult = await generateSmartBlueprintFlow({ brand: brandData, imageBase64, updateFields: parsedUpdateFields });

        // Decrement usage only after successful extraction (bill as a generation credit)
        await decrementUsage(user_id, 'generate');

        return res.status(200).json(llmResult);
      } catch (err) {
        if (err && (err.name === 'ZodError' || err.issues)) {
          const appErr = validationError(err.issues || String(err));
          logError({ requestId, endpoint: 'generateSmartBlueprint', err: appErr });
          return sendError(res, appErr, requestId);
        }
        const appErr = normalizeUnknownError(err);
        logError({ requestId, endpoint: 'generateSmartBlueprint', err: appErr });
        return sendError(res, appErr, requestId);
      }
    });
  },
);
