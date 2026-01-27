const { onRequest } = require('firebase-functions/v2/https');
const cors = require('cors')({ origin: true });
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { randomUUID } = require('crypto');
const { createMultipartParser, buildGeneratedImagePath, verifyAuth } = require('../common/utils');
const { ensureUserExists, decrementUsage } = require('../operations/userOperations');
const { initGenkit, GOOGLE_API_KEY } = require('../common/genkit');
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

const { createAndUploadThumbnail, computeThumbPath } = require('../operations/thumbnailOperations');
const { REPLACE_IMAGE_PROMPT_VERSION, buildReplaceImagePrompt } = require('../common/prompts');

async function getReplaceImageFlows() {
	if (flows) return flows;
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

	const generateReplaceImage = flow(
		{
			name: 'generateReplaceImage',
			inputSchema: z.object({
				uid: z.string().min(1),
				croppedImageBase64: z.string(),
				croppedImageMimeType: z.string().optional(),
				newImageBase64: z.string(),
				newImageMimeType: z.string().optional(),
				description: z.string().min(1),
				aspectRatio: z.string().optional(),
			}),
			outputSchema: z.object({
				mimeType: z.string(),
				id: z.string(),
				storagePath: z.string(),
				downloadUrl: z.string().optional().nullable(),
				generated_img_url: z.string().optional().nullable(),
			}),
		},
		async ({
			uid,
			croppedImageBase64,
			croppedImageMimeType,
			newImageBase64,
			newImageMimeType,
			description,
			aspectRatio: userAspectRatio,
		}) => {
			await ensureUserExists(uid);

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
      let aspectRatio = null;
      if (userAspectRatio && allowedRatios.includes(userAspectRatio)) {
        aspectRatio = userAspectRatio;
      } else {
        aspectRatio = inputAspectRatio;
      }

			const fullPrompt = buildReplaceImagePrompt({ description, aspectRatio });

			const baseMime = croppedImageMimeType || 'image/png';
			const newMime = newImageMimeType || 'image/png';

      const promptArray = [];
      promptArray.push({
         media: {
            url: `data:${baseMime};base64,${croppedImageBase64}`,
            contentType: baseMime
         }
      });
      promptArray.push({
         media: {
            url: `data:${newMime};base64,${newImageBase64}`,
            contentType: newMime
         }
      });
      promptArray.push({ text: fullPrompt });

      // Use @google/genai SDK directly
      const { GoogleGenAI } = require("@google/genai");
      const genaiClient = new GoogleGenAI({ apiKey: GOOGLE_API_KEY.value() });
      
      const contentsParts = [];
      for (const item of promptArray) {
        if (item.text) {
          contentsParts.push({ text: item.text });
        }
      }
      for (const item of promptArray) {
        if (item.media) {
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
        imageSize: '2K',
      };

      const response = await genaiClient.models.generateContent({
        model: 'gemini-3-pro-image-preview',
        contents: [{ parts: contentsParts }],
        config: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: imageConfig,
        },
      });

      // Extract image data
      let dataUrl = null;
      const candidates = response.candidates || [];
      const firstCandidate = candidates[0];
      const modelVersion = 'gemini-3-pro-image-preview';

      if (firstCandidate && firstCandidate.content && firstCandidate.content.parts) {
        for (const part of firstCandidate.content.parts) {
           if (part.inlineData) {
             const mime = part.inlineData.mimeType || 'image/png';
             const b64 = part.inlineData.data;
             dataUrl = `data:${mime};base64,${b64}`;
           }
        }
      }

      if (!dataUrl) {
        console.error('generate: missing image in GoogleGenAI response', JSON.stringify(response, null, 2));
        throw new Error('Model did not return image media.');
      }

			const commaIdx = dataUrl.indexOf(',');
			const imageBase64 = dataUrl.substring(commaIdx + 1);
			let buffer = Buffer.from(imageBase64, 'base64');
			let mimeType = 'image/png';
			try {
				// If model returned JPEG/WebP, re-encode to PNG to keep RGBA
				const sharp = require('sharp');
				buffer = await sharp(buffer, { unlimited: true }).png().toBuffer();
				mimeType = 'image/png';
			} catch (_) {
				// Fallback: use raw buffer; still mark as PNG when saving
			}
			const ext = 'png';

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
						contentType: 'image/png',
						metadata: {
							cacheControl: 'public, max-age=31536000',
							metadata: { firebaseStorageDownloadTokens: downloadToken },
						},
					});
				}
			} catch (_) {
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
						downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(imagePath)}?alt=media&token=${token}`;
					} catch (_) {
						downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(imagePath)}?alt=media`;
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
				await db.collection('images').doc(id).set({
					storagePath: imagePath,
					type: 'generated',
					ownerId: uid || null,
					createdAt: FieldValue.serverTimestamp(),
					prompt: fullPrompt,
					promptVersion: REPLACE_IMAGE_PROMPT_VERSION,
					style: null,
					aspectRatio: aspectRatio || null,
					mockupImageUrl: null,
					mimeType: 'image/png',
					downloadUrl,
					modelVersion: modelVersion || null,
					tool: 'replaceImage',
					size: buffer.length,
					thumbUrl: thumbUrl || null,
					thumbPath,
					thumbSize: 256,
				});
				await db.collection('users').doc(uid).collection('generated').doc(id).set({
					createdAt: FieldValue.serverTimestamp(),
					imageId: id,
					storagePath: imagePath,
					type: 'generated',
					tool: 'replaceImage',
					promptVersion: REPLACE_IMAGE_PROMPT_VERSION,
					thumbUrl: thumbUrl || null,
					thumbPath,
					thumbSize: 256,
				});
			} catch (_) {}

			// Decrement usage only after successful generation & persistence steps
			await decrementUsage(uid, 'generate');
			return {
				mimeType,
				id,
				storagePath: imagePath,
				downloadUrl,
				generated_img_url: downloadUrl,
			};
		}
	);

	flows = { generateReplaceImage };
	return flows;
}

exports.generateReplaceImage = onRequest(
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
				logError({ requestId, endpoint: 'generateReplaceImage', err });
				return sendError(res, err, requestId);
			}

			let uid;
			try {
				uid = await verifyAuth(req);
			} catch (e) {
				const err = unauthenticated(e?.message || 'Unauthorized');
				logError({ requestId, endpoint: 'generateReplaceImage', err });
				return sendError(res, err, requestId);
			}

			try {
				const { generateReplaceImage } = await getReplaceImageFlows();

				// multipart/form-data path
				if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
					const busboy = createMultipartParser(req.headers);
					const fields = {};
					let croppedBuffer = null;
					let croppedMime = null;
					let newBuffer = null;
					let newMime = null;

					await new Promise((resolve, reject) => {
						busboy.on('field', (fieldname, val) => {
							fields[fieldname] = val;
						});
						busboy.on('file', (fieldname, file, { mimeType }) => {
							const chunks = [];
							file.on('data', (d) => chunks.push(d));
							file.on('end', () => {
								const buf = Buffer.concat(chunks);
								if (fieldname === 'cropped_img' || fieldname === 'croppedImage') {
									croppedBuffer = buf;
									croppedMime = mimeType;
								} else if (fieldname === 'new_img' || fieldname === 'newImage') {
									newBuffer = buf;
									newMime = mimeType;
								}
							});
						});
						busboy.on('finish', resolve);
						busboy.on('error', reject);
						if (req.rawBody) {
							busboy.end(req.rawBody);
						} else {
							req.pipe(busboy);
						}
					});

					const description = String(fields.replacable_img_description || fields.description || '').trim();
					const aspectRatio = String(fields.aspectRatio || '').trim() || undefined;

					if (!newBuffer || !description) {
						const err = validationError({ new_img: !newBuffer ? 'required' : undefined, replacable_img_description: !description ? 'required' : undefined });
						logError({ requestId, uid, endpoint: 'generateReplaceImage', err });
						return sendError(res, err, requestId);
					}

					if (!croppedBuffer) {
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
									logError({ requestId, uid, endpoint: 'generateReplaceImage', err });
									return sendError(res, err, requestId);
								}

								const [metadata] = await file.getMetadata();
								croppedMime = metadata.contentType || 'image/png';

								const [downloadedBuffer] = await file.download();
								croppedBuffer = downloadedBuffer;
							} catch (e) {
								const err = storageError('Failed to download image from storage', true);
								logError({ requestId, uid, endpoint: 'generateReplaceImage', err });
								return sendError(res, err, requestId);
							}
						} else {
							const err = validationError({ cropped_img: 'required', storagePath: 'required' });
							logError({ requestId, uid, endpoint: 'generateReplaceImage', err });
							return sendError(res, err, requestId);
						}
					}

					const out = await generateReplaceImage({
						uid,
						croppedImageBase64: croppedBuffer.toString('base64'),
						croppedImageMimeType: croppedMime,
						newImageBase64: newBuffer.toString('base64'),
						newImageMimeType: newMime,
						description,
						aspectRatio,
					});
					return res.status(200).json(out);
				}

				// JSON body fallback
				const body = req.body || {};
				const croppedBase64 = body.croppedImageBase64 || body.cropped_img;
				const newBase64 = body.newImageBase64 || body.new_img;
				const description = String(body.replacable_img_description || body.description || '').trim();
				const aspectRatio = body.aspectRatio;
				if (!croppedBase64 || !newBase64 || !description) {
					const err = validationError({
						croppedImageBase64: !croppedBase64 ? 'required' : undefined,
						newImageBase64: !newBase64 ? 'required' : undefined,
						replacable_img_description: !description ? 'required' : undefined,
					});
					logError({ requestId, uid, endpoint: 'generateReplaceImage', err });
					return sendError(res, err, requestId);
				}
				const out = await generateReplaceImage({
					uid,
					croppedImageBase64: croppedBase64,
					croppedImageMimeType: body.croppedImageMimeType,
					newImageBase64: newBase64,
					newImageMimeType: body.newImageMimeType,
					description,
					aspectRatio,
				});
				return res.status(200).json(out);
			} catch (err) {
				const appErr = normalizeUnknownError(err);
				logError({ requestId, uid, endpoint: 'generateReplaceImage', err: appErr });
				return sendError(res, appErr, requestId);
			}
		});
	}
);
