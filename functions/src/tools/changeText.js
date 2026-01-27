const { onRequest } = require('firebase-functions/v2/https');
const cors = require('cors')({ origin: true });
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { randomUUID } = require('crypto');
const { createAndUploadThumbnail, computeThumbPath } = require('../operations/thumbnailOperations');
const { createMultipartParser, buildGeneratedImagePath, verifyAuth } = require('../common/utils');
const { ensureUserExists, decrementUsage, checkHasCredits } = require('../operations/userOperations');
const { initGenkit, GOOGLE_API_KEY } = require('../common/genkit');
const { getExtractTextsPrompt, buildChangeTextPrompt } = require('../common/prompts');
const {
  AppError,
  ErrorCodes,
  unauthenticated,
  validationError,
  storageError,
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

let flows = null;

async function getChangeTextFlows() {
  if (flows) return flows;
  const { ai, flow, z, googleAI } = await initGenkit();

  const extractTexts = flow(
    {
      name: 'extractTexts',
      inputSchema: z.object({
        croppedImageBase64: z.string(),
        croppedImageMimeType: z.string().optional(),
      }),
      outputSchema: z.object({
        original_texts: z.array(z.string()),
        suggested_texts: z.array(z.string()),
      }),
    },
    async ({ croppedImageBase64, croppedImageMimeType }) => {
      const mime = croppedImageMimeType || 'image/png';
      const prompt = [
        {
          media: {
            url: `data:${mime};base64,${croppedImageBase64}`,
            contentType: mime,
          },
        },
        { text: getExtractTextsPrompt() },
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
        parsed = match ? JSON.parse(match[0]) : { original_texts: [] };
      }

      const original = Array.isArray(parsed.original_texts) ? parsed.original_texts : [];
      // Do not provide suggestions anymore; return empty array for compatibility
      return { original_texts: original, suggested_texts: [] };
    }
  );

  const generateChangeText = flow(
    {
      name: 'generateChangeText',
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

      const bp = blueprint || {};
      const textOps = bp.updated_texts || {};
      const aspectRatio = bp.aspectRatio || null;
      const fullPrompt = buildChangeTextPrompt({ textOps, aspectRatio });

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

      // Generate and upload thumbnail via helper
      let thumbUrl = null;
      let thumbPath = computeThumbPath(imagePath);
      if (file) {
        const { thumbPath: p, thumbUrl: u } = await createAndUploadThumbnail(bucket, buffer, imagePath);
        thumbPath = p;
        thumbUrl = u;
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
            thumbUrl: thumbUrl || null,
            thumbPath,
            thumbSize: 256,
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
            thumbUrl: thumbUrl || null,
            thumbPath,
            thumbSize: 256,
          });
      } catch (_) {}

      return { mimeType, id, storagePath: imagePath, downloadUrl };
    }
  );

  flows = { extractTexts, generateChangeText };
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
    const requestId = randomUUID();
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).send('');
    }

    return cors(req, res, async () => {
      if (req.method !== 'POST') {
        const err = new AppError({ code: ErrorCodes.INVALID_STATE, message: 'Method Not Allowed', httpStatus: 405, retryable: false });
        logError({ requestId, endpoint: 'extractTexts', err });
        return sendError(res, err, requestId);
      }
      
      let uid;
      try {
        uid = await verifyAuth(req);
      } catch (e) {
        const err = unauthenticated(e?.message || 'Unauthorized');
        logError({ requestId, endpoint: 'extractTexts', err });
        return sendError(res, err, requestId);
      }
      
      try {
        await ensureUserExists(uid);
        await checkHasCredits(uid, 'generate');
      } catch (e) {
        logError({ requestId, uid, endpoint: 'extractTexts', err: e });
        return sendError(res, e, requestId);
      }

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

          if (!imageBuffer) {
            const storagePath = fields.storagePath;
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
                  const err = new AppError({ code: ErrorCodes.VALIDATION_ERROR, message: 'Image not found at storagePath', httpStatus: 404, retryable: false });
                  logError({ requestId, uid, endpoint: 'extractTexts', err });
                  return sendError(res, err, requestId);
                }

                const [metadata] = await file.getMetadata();
                imageMimeType = metadata.contentType || 'image/png';

                const [downloadedBuffer] = await file.download();
                imageBuffer = downloadedBuffer;
              } catch (e) {
                const err = storageError('Failed to download image from storage', true);
                logError({ requestId, uid, endpoint: 'extractTexts', err });
                return sendError(res, err, requestId);
              }
            } else {
              const err = validationError({ croppedImage: 'required', storagePath: 'required' });
              logError({ requestId, uid, endpoint: 'extractTexts', err });
              return sendError(res, err, requestId);
            }
          }

          const out = await extractTexts({
            croppedImageBase64: imageBuffer.toString('base64'),
            croppedImageMimeType: imageMimeType,
          });
          
          await decrementUsage(uid, 'generate');

          return res.status(200).json(out);
        }

        // Fallback: JSON body with base64
        const body = req.body || {};
        const base64 = body.croppedImageBase64 || body.croppedimage;
        if (!base64) {
          const err = validationError({ croppedImageBase64: 'required' });
          logError({ requestId, uid, endpoint: 'extractTexts', err });
          return sendError(res, err, requestId);
        }
        const out = await extractTexts({
          croppedImageBase64: base64,
          croppedImageMimeType: body.croppedImageMimeType,
        });

        await decrementUsage(uid, 'generate');

        res.status(200).json(out);
      } catch (err) {
        const appErr = normalizeUnknownError(err);
        logError({ requestId, uid, endpoint: 'extractTexts', err: appErr });
        return sendError(res, appErr, requestId);
      }
    });
  }
);

exports.generateChangeText = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 120,
    memory: '1GiB',
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
        const err = new AppError({ code: ErrorCodes.INVALID_STATE, message: 'Method Not Allowed', httpStatus: 405, retryable: false });
        logError({ requestId, endpoint: 'generateChangeText', err });
        return sendError(res, err, requestId);
      }
      
      let uid;
      try {
        uid = await verifyAuth(req);
      } catch (e) {
        const err = unauthenticated(e?.message || 'Unauthorized');
        logError({ requestId, endpoint: 'generateChangeText', err });
        return sendError(res, err, requestId);
      }

      try {
        const { generateChangeText } = await getChangeTextFlows();

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

          // const uid = String(fields.uid || '').trim(); // Removed
          const bpText = fields.blueprint || fields.blueprintText;

          if (!bpText) {
            const err = validationError({ blueprint: 'required' });
            logError({ requestId, uid, endpoint: 'generateChangeText', err });
            return sendError(res, err, requestId);
          }

          if (!imageBuffer) {
            const storagePath = fields.storagePath;
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
                  const err = new AppError({ code: ErrorCodes.VALIDATION_ERROR, message: 'Image not found at storagePath', httpStatus: 404, retryable: false });
                  logError({ requestId, uid, endpoint: 'generateChangeText', err });
                  return sendError(res, err, requestId);
                }

                const [metadata] = await file.getMetadata();
                imageMimeType = metadata.contentType || 'image/png';

                const [downloadedBuffer] = await file.download();
                imageBuffer = downloadedBuffer;
              } catch (e) {
                const err = storageError('Failed to download image from storage', true);
                logError({ requestId, uid, endpoint: 'generateChangeText', err });
                return sendError(res, err, requestId);
              }
            } else {
              const err = validationError({ croppedImage: 'required', storagePath: 'required' });
              logError({ requestId, uid, endpoint: 'generateChangeText', err });
              return sendError(res, err, requestId);
            }
          }
          let blueprint;
          try {
            blueprint = JSON.parse(bpText);
          } catch (_) {
            const err = validationError({ blueprint: 'invalid JSON' });
            logError({ requestId, uid, endpoint: 'generateChangeText', err });
            return sendError(res, err, requestId);
          }

          const out = await generateChangeText({
            uid,
            blueprint,
            croppedImageBase64: imageBuffer.toString('base64'),
            croppedImageMimeType: imageMimeType,
          });
          
          return res.status(200).json(out);
        }

        // Fallback: JSON body with base64
        const body = req.body || {};
        // const uid = String(body.uid || '').trim(); // Removed
        if (!body.blueprint || !(body.croppedImageBase64 || body.croppedImage)) {
          const err = validationError({ blueprint: !body.blueprint ? 'required' : undefined, croppedImageBase64: !(body.croppedImageBase64 || body.croppedImage) ? 'required' : undefined });
          logError({ requestId, uid, endpoint: 'generateChangeText', err });
          return sendError(res, err, requestId);
        }
        const blueprint = typeof body.blueprint === 'string' ? JSON.parse(body.blueprint) : body.blueprint;
        const out = await generateChangeText({
          uid,
          blueprint,
          croppedImageBase64: body.croppedImageBase64 || body.croppedImage,
          croppedImageMimeType: body.croppedImageMimeType,
        });

        res.status(200).json(out);
      } catch (err) {
        const appErr = normalizeUnknownError(err);
        logError({ requestId, uid, endpoint: 'generateChangeText', err: appErr });
        return sendError(res, appErr, requestId);
      }
    });
  }
);
