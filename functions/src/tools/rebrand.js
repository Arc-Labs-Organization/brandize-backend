const { onRequest } = require('firebase-functions/v2/https');
const cors = require('cors')({ origin: true });
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { randomUUID } = require('crypto');
const { createMultipartParser, buildGeneratedImagePath } = require('../common/utils');
const { ensureUserExists, decrementUsage } = require('../operations/userOperations');
const { initGenkit, GOOGLE_API_KEY } = require('../common/genkit');

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
      const textOps = bp.text_updates || {};
      const additions = bp.additions || {};
      
      const parts = [];
      parts.push('Update the design per the following blueprint suggestions.');

      // Brand Colors
      if (bp.use_brand_colors && brand?.colorPalette && Array.isArray(brand.colorPalette) && brand.colorPalette.length > 0) {
         parts.push(`Use the following brand colors: ${brand.colorPalette.join(', ')}.`);
      }

      // Text Updates
      const keys = Object.keys(textOps);
      if (keys.length) {
        parts.push('Text updates:');
        for (const key of keys) {
          const val = textOps[key];
          if (val === null || val === undefined) {
            parts.push(`- Remove the text "${key}".`);
          } else {
            parts.push(`- Change "${key}" to "${val}".`);
          }
        }
      }

      // Additions & Logo Replacement
      let logoUrlToFetch = null;
      
      // Check if we need to use the brand logo
      const needsLogo = bp.replace_logo || (additions && Object.keys(additions).some(k => {
         const lower = k.toLowerCase();
         return lower === 'brand_logo' || lower === 'logo';
      }));
      
      if (needsLogo && brand?.logoUrl) {
         logoUrlToFetch = brand.logoUrl;
      }

      if (bp.replace_logo) {
         parts.push('Replace the existing logo with the provided brand logo.');
      }

      // Handle additions (object: type -> location)
      if (additions) {
         for (const [type, location] of Object.entries(additions)) {
            const lowerType = type.toLowerCase();
            
            if (lowerType === 'brand_logo' || lowerType === 'logo') {
               parts.push(`Place the brand logo at ${location}.`);
               continue;
            }
            
            if (lowerType === 'brand_website' || lowerType === 'website') {
               if (brand?.website) {
                  parts.push(`Add the website "${brand.website}" at ${location}.`);
               }
               continue;
            }
            
            if (lowerType === 'phone_number' || lowerType === 'phone') {
               if (brand?.phone) {
                  parts.push(`Add the phone number "${brand.phone}" at ${location}.`);
               }
               continue;
            }

            if (lowerType === 'brand_name' || lowerType === 'name') {
               if (brand?.brandName) {
                  parts.push(`Add the brand name "${brand.brandName}" at ${location}.`);
               }
               continue;
            }

            if (lowerType === 'brand_address' || lowerType === 'address') {
               if (brand?.address) {
                  parts.push(`Add the address "${brand.address}" at ${location}.`);
               }
               continue;
            }
         }
      }

      // Aspect Ratio
      let aspectRatio = null;
      if (bp.aspectRatio && allowedRatios.includes(bp.aspectRatio)) {
         aspectRatio = bp.aspectRatio;
         parts.push(`Target aspect ratio: ${bp.aspectRatio}.`);
      }

      parts.push('GENERAL RULES: Preserve the overall layout, composition, and visual hierarchy of the original design. Do not remove or drastically move major visual elements unless explicitly requested.');

      const fullPrompt = parts.join('\n');

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
      const promptText = [
        'We will update the texts in the provided image so they align with the branding of:',
        '',
        `- **Brand Name:** ${brand.brandName || 'N/A'}`,
        `- **Description:** ${brand.description || 'N/A'}`,
        '',
        'Use the table below to determine which types of text should appear in the updated output:',
        '',
        '```json',
        fieldValuesJson,
        '```',
        '',
        '- **Fields that are `null`** must **not** appear in either **“updated_texts”** or **“additions.”**',
        '    - If these fields exist in the original image, you should either **replace them with appropriate content** or **remove them entirely**.',
        '    - If you choose to remove them, set their value to **`null`**.',
        '- **Fields that have a valid value,** must appear **at least once** in either **“updated_texts”** or **“additions.”**',
        '    - If you can replace original text with a context-appropriate and similarly sized version, do so in **“updated_texts.”**',
        '    - If no suitable replacement exists, add the content to “additions” with a strict object per entry containing: **type**, and **location**.',
        '      - **type** must be one of: `"phone" | "website" | "brand_name" | "brand_address".',
        '      - **location** must be one of exactly: `"bottom-right"`, `"bottom-left"`, `"bottom-mid"`, `"top-left"`, `"top-mid"`, `"top-right"`. Do not use synonyms like "left-bottom" or "center-bottom".',
        '',
        '**Task:**',
        '',
        '1. Extract **all text that appears in the image** exactly as shown.',
        '2. Rewrite and improve each extracted text so it matches the above brand’s brand voice, while trying to keep the character length similar to the original.',
        '3. Identify whether the image contains **any logo that could be replaced** with the new brand logo.',
        '4. Return the final result strictly in the following JSON structure:',
        '',
        '```json',
        '{',
        '  "original_texts": [',
        '    "..."',
        '  ],',
        '  "updated_texts": [',
        '    "..."',
        '  ],',
        '  "additions": [',
        '    {',
        '      "type": "...",',
        '      "location": "..."',
        '    }',
        '  ],',
        '  "replacable_logo": boolean',
        '}',
        '```',
        '',
        'Only include the JSON in your final answer.',
      ].join('\n');
      
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

        const { uid, brand_id, blueprint } = fields;

        if (!uid || !brand_id || !blueprint) {
          return res.status(400).json({ error: 'Missing required fields: uid, brand_id, blueprint' });
        }

        if (!imageBuffer) {
          return res.status(400).json({ error: 'Missing required file: croppedImage' });
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

        const { user_id, brand_id, updateFields } = fields;

        if (!user_id || !brand_id || !updateFields) {
          return res.status(400).json({ error: 'Missing required fields: user_id, brand_id, updateFields' });
        }

        if (!imageBuffer) {
          return res.status(400).json({ error: 'Missing required file: croppedImage' });
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
