const { onRequest } = require('firebase-functions/v2/https');
const cors = require('cors')({ origin: true });
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { randomUUID } = require('crypto');
const { createMultipartParser, buildGeneratedImagePath, verifyAuth } = require('../common/utils');
const { createAndUploadThumbnail, computeThumbPath } = require('../operations/thumbnailOperations');
const { ensureUserExists, decrementUsage } = require('../operations/userOperations');
const { initGenkit, GOOGLE_API_KEY } = require('../common/genkit');
const { buildVirtualModelPrompt } = require('../common/prompts');
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

// Normalize and validate supported aspect ratios
function normalizeAspectRatio(input) {
	if (!input) return undefined;
	let s = String(input).trim().toLowerCase().replace(/\s+/g, '');
	const map = {
		'1:1': '1:1',
		'1/1': '1:1',
		'square': '1:1',
		'16:9': '16:9',
		'16/9': '16:9',
		'landscape': '16:9',
		'9:16': '9:16',
		'9/16': '9:16',
		'portrait': '9:16',
		'4:3': '4:3',
		'4/3': '4:3',
		'3:2': '3:2',
		'3/2': '3:2',
	};
	return map[s] || undefined;
}

async function getVirtualModelFlows() {
	if (flows) return flows;
	const { ai, flow, z, googleAI } = await initGenkit();

	const generateVirtualModel = flow(
		{
			name: 'generateVirtualModel',
			inputSchema: z.object({
				uid: z.string().min(1),
				modelImageBase64: z.string(),
				modelImageMimeType: z.string().optional(),
				productImageBase64: z.string(),
				productImageMimeType: z.string().optional(),
				mode: z.enum(['hold', 'wear']),
				targetHand: z.enum(['left', 'right']).optional(),
				aspectRatio: z.string().optional(),
			}),
			outputSchema: z.object({
				mimeType: z.string(),
				id: z.string(),
				storagePath: z.string(),
				downloadUrl: z.string().optional().nullable(),
				generated_img_url: z.string().optional().nullable(),
				thumbUrl: z.string().optional().nullable(),
				thumbPath: z.string().optional().nullable(),
			}),
		},
		async ({
			uid,
			modelImageBase64,
			modelImageMimeType,
			productImageBase64,
			productImageMimeType,
			mode,
			targetHand,
			aspectRatio,
		}) => {
			await ensureUserExists(uid);

			const fullPrompt = buildVirtualModelPrompt({ mode, targetHand });

			const baseMime = modelImageMimeType || 'image/png';
			const prodMime = productImageMimeType || 'image/png';

			const promptArray = [
				{ media: { url: `data:${baseMime};base64,${modelImageBase64}`, contentType: baseMime } },
				{ media: { url: `data:${prodMime};base64,${productImageBase64}`, contentType: prodMime } },
				{ text: fullPrompt },
			];

			// Read original model dimensions for deterministic canvas lock
			let modelWidth = null;
			let modelHeight = null;
			try {
				const sharp = require('sharp');
				const baseBuf = Buffer.from(modelImageBase64, 'base64');
				const meta = await sharp(baseBuf).metadata();
				modelWidth = meta.width || null;
				modelHeight = meta.height || null;
			} catch (_) {}

			let media, rawResponse;
			const safeAspect = normalizeAspectRatio(aspectRatio);
			try {
				({ media, rawResponse } = await ai.generate({
					model: googleAI.model('gemini-3-pro-image-preview'),
					prompt: promptArray,
					config: {
						responseModalities: ['IMAGE'],
						...(safeAspect ? { imageConfig: { aspectRatio: safeAspect } } : {}),
					},
					output: { format: 'media' },
				}));
			} catch (_) {
				({ media, rawResponse } = await ai.generate({
					model: googleAI.model('gemini-2.5-flash-image'),
					prompt: promptArray,
					config: {
						responseModalities: ['IMAGE'],
						...(safeAspect ? { imageConfig: { aspectRatio: safeAspect } } : {}),
					},
					output: { format: 'media' },
				}));
			}

			const m = Array.isArray(media) ? media[0] : media;
			if (!m?.url) throw new Error('Model did not return image media.');

			// Convert to PNG and enforce canvas lock to the model image size
			const dataUrl = m.url;
			const commaIdx = dataUrl.indexOf(',');
      const header = dataUrl.substring(0, commaIdx);
			const imageBase64 = dataUrl.substring(commaIdx + 1);

      const mimeTypeMatch = /data:(.*?);base64/.exec(header);
      let mimeType = (mimeTypeMatch && mimeTypeMatch[1]) || 'image/png';

			let buffer = Buffer.from(imageBase64, 'base64');
			try {
        // Enforce canvas lock only if we have original dimensions
				if (modelWidth && modelHeight) {
          const sharp = require('sharp');
					buffer = await sharp(buffer, { unlimited: true })
						.resize(modelWidth, modelHeight, { fit: 'cover', position: 'centre' })
						.png()
						.toBuffer();
          mimeType = 'image/png';
				}
			} catch (_) {}
      
      const ext = ((mime) => {
        if (mime === 'image/png') return 'png';
        if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
        if (mime === 'image/webp') return 'webp';
        return 'png';
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
							await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } }).catch(() => {});
						}
						downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(imagePath)}?alt=media&token=${token}`;
					} catch (_) {
						downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(imagePath)}?alt=media`;
					}
				}
			}

			// Thumbnail generation for generated image
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
					style: null,
					aspectRatio: safeAspect || null,
					mockupImageUrl: null,
					mimeType: mimeType,
					downloadUrl,
					modelVersion: rawResponse?.modelVersion || null,
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
				generated_img_url: downloadUrl,
				thumbUrl,
				thumbPath,
			};
		}
	);

	flows = { generateVirtualModel };
	return flows;
}

async function fetchImageBufferFromUrl(url) {
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`Failed to fetch image: ${resp.status}`);
	const buf = Buffer.from(await resp.arrayBuffer());
	const mime = resp.headers.get('content-type') || 'image/png';
	return { buffer: buf, mimeType: mime };
}

exports.generateVirtualModel = onRequest(
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
			res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
			return res.status(204).send('');
		}

		return cors(req, res, async () => {
			if (req.method !== 'POST') {
				const err = new AppError({ code: ErrorCodes.INVALID_STATE, message: 'Method Not Allowed', httpStatus: 405, retryable: false });
				logError({ requestId, endpoint: 'generateVirtualModel', err });
				return sendError(res, err, requestId);
			}

			let uid;
			try {
				uid = await verifyAuth(req);
			} catch (e) {
				const err = unauthenticated(e?.message || 'Unauthorized');
				logError({ requestId, endpoint: 'generateVirtualModel', err });
				return sendError(res, err, requestId);
			}

			try {
				const { generateVirtualModel } = await getVirtualModelFlows();

				// multipart/form-data path
				if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
					const busboy = createMultipartParser(req.headers);
					const fields = {};
					let modelBuffer = null;
					let modelMime = null;
					let productBuffer = null;
					let productMime = null;

					await new Promise((resolve, reject) => {
						busboy.on('field', (fieldname, val) => {
							fields[fieldname] = val;
						});
						busboy.on('file', (fieldname, file, { mimeType }) => {
							const chunks = [];
							file.on('data', (d) => chunks.push(d));
							file.on('end', () => {
								const buf = Buffer.concat(chunks);
								if (fieldname === 'model_img' || fieldname === 'modelImage' || fieldname === 'cropped_img' || fieldname === 'croppedImage') {
									modelBuffer = buf;
									modelMime = mimeType;
								} else if (fieldname === 'product_img' || fieldname === 'productImage') {
									productBuffer = buf;
									productMime = mimeType;
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

					const mode = String(fields.mode || '').trim().toLowerCase();
					const targetHand = String(fields.target_hand || fields.targetHand || '').trim() || undefined;
					const aspectRatio = String(fields.aspectRatio || '').trim() || undefined;

					if (!mode || (mode !== 'hold' && mode !== 'wear')) {
						const err = validationError({ mode: 'must be hold|wear' });
						logError({ requestId, uid, endpoint: 'generateVirtualModel', err });
						return sendError(res, err, requestId);
					}

					// If modelBuffer missing, load from storagePath (required alternative to file)
					if (!modelBuffer) {
						const storagePath = fields.modelStoragePath || fields.storagePath;
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
									const err = new AppError({ code: ErrorCodes.VALIDATION_ERROR, message: 'Model image not found at storagePath', httpStatus: 404, retryable: false });
									logError({ requestId, uid, endpoint: 'generateVirtualModel', err });
									return sendError(res, err, requestId);
								}

								const [metadata] = await file.getMetadata();
								modelMime = metadata.contentType || 'image/png';

								const [downloadedBuffer] = await file.download();
								modelBuffer = downloadedBuffer;
							} catch (e) {
								const err = storageError('Failed to download model image from storage', true);
								logError({ requestId, uid, endpoint: 'generateVirtualModel', err });
								return sendError(res, err, requestId);
							}
						} else {
							const err = validationError({ cropped_img: 'required', modelStoragePath: 'required' });
							logError({ requestId, uid, endpoint: 'generateVirtualModel', err });
							return sendError(res, err, requestId);
						}
					}

					// product image must be provided as file in multipart
					if (!productBuffer) {
						const err = validationError({ product_img: 'file required' });
						logError({ requestId, uid, endpoint: 'generateVirtualModel', err });
						return sendError(res, err, requestId);
					}

					const out = await generateVirtualModel({
						uid,
						modelImageBase64: modelBuffer.toString('base64'),
						modelImageMimeType: modelMime,
						productImageBase64: productBuffer.toString('base64'),
						productImageMimeType: productMime,
						mode,
						targetHand: targetHand === 'left' || targetHand === 'right' ? targetHand : undefined,
						aspectRatio,
					});
					return res.status(200).json(out);
				}

				// JSON body is not supported for product file upload; instruct clients to use multipart/form-data
				const err = validationError({
					product_img: 'use multipart/form-data (file)',
					cropped_img: 'multipart file or modelStoragePath',
					modelStoragePath: 'multipart alternative to cropped_img',
				});
				logError({ requestId, uid, endpoint: 'generateVirtualModel', err });
				return sendError(res, err, requestId);
			} catch (err) {
				const appErr = normalizeUnknownError(err);
				logError({ requestId, uid, endpoint: 'generateVirtualModel', err: appErr });
				return sendError(res, appErr, requestId);
			}
		});
	}
);

