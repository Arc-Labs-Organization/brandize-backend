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

let flows = null;

async function getChangeTextFlows() {
  if (flows) return flows;
  const { ai, flow, z, googleAI } = await initGenkit();

  const extractTexts = flow(
    {
      name: 'extractTexts',
      inputSchema: z.object({
        uid: z.string().min(1),
        croppedImageBase64: z.string(),
        croppedImageMimeType: z.string().optional(),
        targetAudience: z.string().min(1),
      }),
      outputSchema: z.object({
        original_texts: z.array(z.string()),
        suggested_texts: z.array(z.string()),
      }),
    },
    async ({ uid, croppedImageBase64, croppedImageMimeType, targetAudience }) => {
      await ensureUserExists(uid);
      await decrementUsage(uid, 'generate');

      const mime = croppedImageMimeType || 'image/png';
      const audience = (targetAudience || 'general consumer audience; modern, friendly, concise tone').trim();
      const prompt = [
        {
          media: {
            url: `data:${mime};base64,${croppedImageBase64}`,
            contentType: mime,
          },
        },
        {
          text: [
            `You are rewriting visible marketing copy for target audience: ${audience}.`,
            'Step 1: Extract ALL visible texts exactly as shown (preserve order).',
            'Step 2: For EACH extracted line, produce a rewritten version tailored to the audience.',
            'Constraints:',
            '- Keep length within ±20% of original.',
            '- Improve clarity, specificity, and actionability; avoid generic filler.',
            '- Ensure wording changes meaningfully; do NOT return identical strings.',
            '- Preserve casing/format where reasonable (e.g., headline uppercase).',
            'Output: ONLY valid JSON object:',
            '{"original_texts": ["..."], "suggested_texts": ["..."]}',
          ].join('\n'),
        },
      ];

      const { text } = await ai.generate({
        model: googleAI.model('gemini-2.5-flash'),
        prompt,
        config: { responseModalities: ['TEXT'], temperature: 0.7 },
        output: { format: 'text' },
      });

      // Try to parse JSON; if model returned wrappers, attempt to extract first JSON block
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        const match = text.match(/\{[\s\S]*\}/);
        parsed = match ? JSON.parse(match[0]) : { original_texts: [], suggested_texts: [] };
      }

      const original = Array.isArray(parsed.original_texts) ? parsed.original_texts : [];
      let suggested = Array.isArray(parsed.suggested_texts) ? parsed.suggested_texts : [];

      // Post-processing safeguards: ensure suggestions differ and respect ±20% length
      const clamp = (s, minLen, maxLen) => {
        if (!s) return s;
        const trimmed = s.trim();
        if (trimmed.length < minLen) {
          return (trimmed + ' ').repeat(Math.ceil((minLen - trimmed.length) / 2)).trim().slice(0, minLen);
        }
        if (trimmed.length > maxLen) {
          return trimmed.slice(0, maxLen);
        }
        return trimmed;
      };
      const tweakIfIdentical = (orig, sug) => {
        if (!orig) return sug || '';
        const o = String(orig).trim();
        const s = String(sug || '').trim();
        if (o.toLowerCase() !== s.toLowerCase()) return s;
        // Apply simple transformations to encourage difference
        const replacements = [
          ['Shop', 'Discover'],
          ['Sale', 'Offer'],
          ['Now', 'Today'],
          ['Get', 'Unlock'],
          ['Join', 'Explore'],
          ['Learn', 'See'],
        ];
        let out = s;
        for (const [a, b] of replacements) {
          const re = new RegExp(`\\b${a}\\b`, 'i');
          if (re.test(out)) {
            out = out.replace(re, b);
            break;
          }
        }
        if (out.toLowerCase() === o.toLowerCase()) {
          out = `${s} — ${audience.split(/[;,]/)[0].trim()}`;
        }
        return out;
      };

      suggested = original.map((orig, i) => {
        const sug = suggested[i] ?? '';
        const minLen = Math.max(1, Math.floor(String(orig || '').length * 0.8));
        const maxLen = Math.max(minLen, Math.ceil(String(orig || '').length * 1.2));
        const tweaked = tweakIfIdentical(orig, sug);
        return clamp(tweaked, minLen, maxLen);
      });

      return { original_texts: original, suggested_texts: suggested };
    }
  );

  const generateImage2 = flow(
    {
      name: 'generateImage2',
      inputSchema: z.object({
        uid: z.string().min(1),
        blueprint: z.record(z.any()),
        croppedImageBase64: z.string(),
        croppedImageMimeType: z.string().optional(),
      }),
      outputSchema: z.object({
        mimeType: z.string(),
        id: z.string(),
        storagePath: z.string(),
        downloadUrl: z.string().optional().nullable(),
      }),
    },
    async ({ uid, blueprint, croppedImageBase64, croppedImageMimeType }) => {
      await ensureUserExists(uid);
      await decrementUsage(uid, 'generate');

      const bp = blueprint || {};
      const textOps = bp.updated_texts || {};
      const aspectRatio = bp.aspectRatio || null;

      const parts = [];
      parts.push('Update the design by applying the following text changes. Remove any field where the new value is null. Preserve layout and composition.');
      const keys = Object.keys(textOps);
      if (keys.length) {
        for (const key of keys) {
          const val = textOps[key];
          if (val === null || val === undefined) {
            parts.push(`- Remove the text "${key}".`);
          } else {
            parts.push(`- Replace "${key}" with "${val}".`);
          }
        }
      }
      if (aspectRatio) {
        parts.push(`Target aspect ratio: ${aspectRatio}.`);
      }

      const fullPrompt = parts.join('\n');

      const mime = croppedImageMimeType || 'image/png';
      const promptArray = [
        {
          media: {
            url: `data:${mime};base64,${croppedImageBase64}`,
            contentType: mime,
          },
        },
        { text: fullPrompt },
      ];

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

      const m = Array.isArray(media) ? media[0] : media;
      if (!m?.url) throw new Error('Model did not return image media.');

      const dataUrl = m.url;
      const commaIdx = dataUrl.indexOf(',');
      const header = dataUrl.substring(0, commaIdx);
      const imageBase64 = dataUrl.substring(commaIdx + 1);
      const mimeTypeMatch = /data:(.*?);base64/.exec(header);
      const mimeType = (mimeTypeMatch && mimeTypeMatch[1]) || 'image/png';

      const buffer = Buffer.from(imageBase64, 'base64');
      const ext = ((mime) => {
        if (mime === 'image/png') return 'png';
        if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
        if (mime === 'image/webp') return 'webp';
        return 'bin';
      })(mimeType);

      const id = randomUUID();
      const imagePath = buildGeneratedImagePath(uid, id, ext);

      const appOptions = admin.app().options || {};
      const configuredBucket = appOptions.storageBucket;
      const projId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
      const bucketName = configuredBucket || (projId ? `${projId}.appspot.com` : undefined);
      const bucket = bucketName ? admin.storage().bucket(bucketName) : admin.storage().bucket();

      let file = null;
      let downloadToken = null;
      try {
        const [bucketExists] = await bucket.exists();
        if (bucketExists) {
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
      } catch (e) {
        file = null;
      }

      let downloadUrl = null;
      if (file) {
        try {
          const [url] = await file.getSignedUrl({
            action: 'read',
            expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
          });
          downloadUrl = url;
        } catch (e) {
          try {
            const [metadata] = await file.getMetadata().catch(() => [{}]);
            let token = metadata?.metadata?.firebaseStorageDownloadTokens;
            if (!token) {
              token = downloadToken || randomUUID();
              await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } }).catch(
                () => {}
              );
            }
            downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(
              imagePath
            )}?alt=media&token=${token}`;
          } catch (_) {
            downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(
              imagePath
            )}?alt=media`;
          }
        }
      }

      try {
        await db
          .collection('images')
          .doc(id)
          .set({
            storagePath: imagePath,
            type: 'generated',
            ownerId: uid || null,
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
        await db
          .collection('users')
          .doc(uid)
          .collection('generated')
          .doc(id)
          .set({
            createdAt: FieldValue.serverTimestamp(),
            imageId: id,
            storagePath: imagePath,
            type: 'generated',
          });
      } catch (_) {}

      return { mimeType, id, storagePath: imagePath, downloadUrl };
    }
  );

  flows = { extractTexts, generateImage2 };
  return flows;
}

exports.extractTexts = onRequest(
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
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      try {
        const { extractTexts } = await getChangeTextFlows();

        // If multipart/form-data, parse via Busboy
        if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
          const busboy = createMultipartParser(req.headers);
          const fields = {};
          let imageBuffer = null;
          let imageMimeType = null;

          await new Promise((resolve, reject) => {
            busboy.on('field', (fieldname, val) => {
              fields[fieldname] = val;
            });
            busboy.on('file', (fieldname, file, { mimeType }) => {
              if (fieldname === 'croppedImage' || fieldname === 'croppedimage') {
                const chunks = [];
                file.on('data', (d) => chunks.push(d));
                file.on('end', () => {
                  imageBuffer = Buffer.concat(chunks);
                  imageMimeType = mimeType;
                });
              } else {
                file.resume();
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

          const uid = String(fields.uid || '').trim();
          const targetAudience = String(fields.targetAudience || fields.audience || '').trim();
          if (!uid || !imageBuffer) {
              return res.status(400).json({ error: 'Missing required fields: uid, croppedImage' });
          }

          const out = await extractTexts({
            uid,
            croppedImageBase64: imageBuffer.toString('base64'),
            croppedImageMimeType: imageMimeType,
            targetAudience: targetAudience || 'general consumer audience; modern, friendly, concise tone',
          });
          return res.status(200).json(out);
        }

        // Fallback: JSON body with base64
        const body = req.body || {};
        const uid = String(body.uid || '').trim();
        const base64 = body.croppedImageBase64 || body.croppedimage;
        const targetAudience = String(body.targetAudience || body.audience || '').trim();
        if (!uid || !base64) {
          return res.status(400).json({ error: 'Missing required fields: uid, croppedImageBase64' });
        }
        const out = await extractTexts({
          uid,
          croppedImageBase64: base64,
          croppedImageMimeType: body.croppedImageMimeType,
          targetAudience: targetAudience || 'general consumer audience; modern, friendly, concise tone',
        });
        res.status(200).json(out);
      } catch (err) {
        console.error('extractTexts error:', err?.message || err);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });
  }
);

exports.generateImage2 = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 120,
    memory: '1GiB',
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
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      try {
        const { generateImage2 } = await getChangeTextFlows();

        if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
          const busboy = createMultipartParser(req.headers);
          const fields = {};
          let imageBuffer = null;
          let imageMimeType = null;

          await new Promise((resolve, reject) => {
            busboy.on('field', (fieldname, val) => {
              fields[fieldname] = val;
            });
            busboy.on('file', (fieldname, file, { mimeType }) => {
              if (fieldname === 'croppedImage' || fieldname === 'croppedimage') {
                const chunks = [];
                file.on('data', (d) => chunks.push(d));
                file.on('end', () => {
                  imageBuffer = Buffer.concat(chunks);
                  imageMimeType = mimeType;
                });
              } else {
                file.resume();
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

          const uid = String(fields.uid || '').trim();
          const bpText = fields.blueprint || fields.blueprintText;
          if (!uid || !bpText || !imageBuffer) {
            return res.status(400).json({ error: 'Missing required fields: uid, blueprint, croppedImage' });
          }
          let blueprint;
          try {
            blueprint = JSON.parse(bpText);
          } catch (_) {
            return res.status(400).json({ error: 'Invalid blueprint JSON format' });
          }

          const out = await generateImage2({
            uid,
            blueprint,
            croppedImageBase64: imageBuffer.toString('base64'),
            croppedImageMimeType: imageMimeType,
          });
          return res.status(200).json(out);
        }

        // Fallback: JSON body with base64
        const body = req.body || {};
        const uid = String(body.uid || '').trim();
        if (!uid || !body.blueprint || !(body.croppedImageBase64 || body.croppedImage)) {
          return res.status(400).json({ error: 'Missing required fields: uid, blueprint, croppedImageBase64' });
        }
        const blueprint = typeof body.blueprint === 'string' ? JSON.parse(body.blueprint) : body.blueprint;
        const out = await generateImage2({
          uid,
          blueprint,
          croppedImageBase64: body.croppedImageBase64 || body.croppedImage,
          croppedImageMimeType: body.croppedImageMimeType,
        });
        res.status(200).json(out);
      } catch (err) {
        console.error('generateImage2 error:', err?.message || err);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });
  }
);
