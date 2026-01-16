const { onRequest } = require('firebase-functions/v2/https');
const cors = require('cors')({ origin: true });
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { randomUUID } = require('crypto');
const { createMultipartParser, buildGeneratedImagePath, verifyAuth } = require('../common/utils');
const { createAndUploadThumbnail, computeThumbPath } = require('../operations/thumbnailOperations');
const { ensureUserExists, decrementUsage } = require('../operations/userOperations');
const { initGenkit, GOOGLE_API_KEY } = require('../common/genkit');
const { buildAddObjectPrompt } = require('../common/prompts');
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

async function getAddObjectFlows() {
	if (flows) return flows;
	const { ai, flow, z, googleAI } = await initGenkit();

	const generateAddObject = flow(
		{
			name: 'generateAddObject',
			inputSchema: z.object({
				uid: z.string().min(1),
				croppedImageBase64: z.string(),
				croppedImageMimeType: z.string().optional(),
				objectImageBase64: z.string(),
				objectImageMimeType: z.string().optional(),
				objectLocation: z.string().min(1),
				objectBox: z
					.object({ left: z.number().nonnegative(), top: z.number().nonnegative(), width: z.number().positive(), height: z.number().positive() })
					.optional(),
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
			objectImageBase64,
			objectImageMimeType,
			objectLocation,
			objectBox,
			aspectRatio,
		}) => {
			await ensureUserExists(uid);

			// Path A: deterministic composite when objectBox is provided
			if (objectBox && typeof objectBox.left === 'number' && typeof objectBox.top === 'number' && typeof objectBox.width === 'number' && typeof objectBox.height === 'number') {
				const sharp = require('sharp');
				const baseBuf = Buffer.from(croppedImageBase64, 'base64');
				const objBuf = Buffer.from(objectImageBase64, 'base64');

				const baseImg = sharp(baseBuf, { unlimited: true });
				const meta = await baseImg.metadata();
				const canvasW = meta.width || 0;
				const canvasH = meta.height || 0;

				const targetW = Math.max(1, Math.round(objectBox.width));
				const targetH = Math.max(1, Math.round(objectBox.height));
				const objResized = await sharp(objBuf, { unlimited: true })
					.resize(targetW, targetH, { fit: 'cover', position: 'centre' })
					.png()
					.toBuffer();

				const left = Math.max(0, Math.round(objectBox.left));
				const top = Math.max(0, Math.round(objectBox.top));

				const outBuffer = await baseImg
					.resize(canvasW, canvasH, { fit: 'fill' })
					.composite([{ input: objResized, left, top }])
					.png()
					.toBuffer();

				const id = randomUUID();
				const imagePath = buildGeneratedImagePath(uid, id, 'png');

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
						await file.save(outBuffer, {
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

				// Generate and upload thumbnail via helper for generated image
				let thumbUrl = null;
				let thumbPath = computeThumbPath(imagePath);
				if (file) {
					const { thumbPath: p, thumbUrl: u } = await createAndUploadThumbnail(bucket, outBuffer, imagePath);
					thumbPath = p;
					thumbUrl = u;
				}

				try {
					await db.collection('images').doc(id).set({
						storagePath: imagePath,
						type: 'generated',
						ownerId: uid || null,
						createdAt: FieldValue.serverTimestamp(),
						prompt: 'deterministic_add_object_sharp',
						style: null,
						aspectRatio: `${canvasW}:${canvasH}`,
						mockupImageUrl: null,
						mimeType: 'image/png',
						downloadUrl,
						modelVersion: null,
						size: outBuffer.length,
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
					mimeType: 'image/png',
					id,
					storagePath: imagePath,
					downloadUrl,
					generated_img_url: downloadUrl,
				};
			}

			// Path B: Gemini fallback with concise, high-signal prompt
			const fullPrompt = buildAddObjectPrompt({ objectLocation, aspectRatio });

			const baseMime = croppedImageMimeType || 'image/png';
			const objMime = objectImageMimeType || 'image/png';

			const promptArray = [
				{ media: { url: `data:${baseMime};base64,${croppedImageBase64}`, contentType: baseMime } },
				{ media: { url: `data:${objMime};base64,${objectImageBase64}`, contentType: objMime } },
				{ text: fullPrompt },
			];

			let media, rawResponse;
			// Derive aspect ratio from base image if not provided
			let derivedAspect = aspectRatio;
			try {
				if (!derivedAspect) {
					const sharp = require('sharp');
					const baseBufForAspect = Buffer.from(croppedImageBase64, 'base64');
					const meta = await sharp(baseBufForAspect).metadata();
					const w = meta.width || 0;
					const h = meta.height || 0;
					if (w > 0 && h > 0) {
						const ratio = w / h;
						const candidates = [
							{ r: 1, label: '1:1' },
							{ r: 16 / 9, label: '16:9' },
							{ r: 4 / 3, label: '4:3' },
							{ r: 3 / 2, label: '3:2' },
							{ r: 9 / 16, label: '9:16' },
						];
						let best = candidates[0];
						let bestDiff = Math.abs(ratio - best.r);
						for (const c of candidates) {
							const d = Math.abs(ratio - c.r);
							if (d < bestDiff) { best = c; bestDiff = d; }
						}
						derivedAspect = best.label;
						console.log('Canvas lock base size:', w, h, 'derived aspect:', derivedAspect);
					}
				}
			} catch (_) {}
			try {
				({ media, rawResponse } = await ai.generate({
					model: googleAI.model('gemini-3-pro-image-preview'),
					prompt: promptArray,
					config: {
						responseModalities: ['IMAGE'],
						...(derivedAspect ? { imageConfig: { aspectRatio: derivedAspect } } : {}),
					},
					output: { format: 'media' },
				}));
			} catch (_) {
				({ media, rawResponse } = await ai.generate({
					model: googleAI.model('gemini-2.5-flash-image'),
					prompt: promptArray,
					config: {
						responseModalities: ['IMAGE'],
						...(derivedAspect ? { imageConfig: { aspectRatio: derivedAspect } } : {}),
					},
					output: { format: 'media' },
				}));
			}

			const m = Array.isArray(media) ? media[0] : media;
			if (!m?.url) throw new Error('Model did not return image media.');

			const dataUrl = m.url;
			const commaIdx = dataUrl.indexOf(',');
			const imageBase64 = dataUrl.substring(commaIdx + 1);
			let buffer = Buffer.from(imageBase64, 'base64');
			let mimeType = 'image/png';
			try {
				const sharp = require('sharp');
				const outMeta = await sharp(buffer).metadata();
				console.log('Model output size:', outMeta.width, outMeta.height);
				buffer = await sharp(buffer, { unlimited: true }).png().toBuffer();
				mimeType = 'image/png';
			} catch (_) {
				// keep buffer as-is; still store as PNG
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
							await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } }).catch(() => {});
						}
						downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(imagePath)}?alt=media&token=${token}`;
					} catch (_) {
						downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(imagePath)}?alt=media`;
					}
				}
			}

			// Thumbnail generation via helper
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
					aspectRatio: aspectRatio || null,
					mockupImageUrl: null,
					mimeType: 'image/png',
					downloadUrl,
					modelVersion: rawResponse?.modelVersion || null,
					size: buffer.length,
				});
				await db.collection('users').doc(uid).collection('generated').doc(id).set({
					createdAt: FieldValue.serverTimestamp(),
					imageId: id,
					storagePath: imagePath,
					type: 'generated',
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

	flows = { generateAddObject };
	return flows;
}

exports.generateAddObject = onRequest(
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
					const err = new AppError({
						code: ErrorCodes.INVALID_STATE,
						message: 'Method Not Allowed',
						httpStatus: 405,
						retryable: false,
					});
					logError({ requestId, endpoint: 'generateAddObject', err });
					return sendError(res, err, requestId);
				}

			try {
				uid = await verifyAuth(req);
			} catch (e) {
					const err = unauthenticated(e?.message || 'Unauthorized');
					logError({ requestId, endpoint: 'generateAddObject', err });
					return sendError(res, err, requestId);
			}

			try {
				const { generateAddObject } = await getAddObjectFlows();

				// multipart/form-data path
				if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
					const busboy = createMultipartParser(req.headers);
					const fields = {};
					let croppedBuffer = null;
					let croppedMime = null;
					let objectBuffer = null;
					let objectMime = null;

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
								} else if (fieldname === 'object_img' || fieldname === 'objectImage') {
									objectBuffer = buf;
									objectMime = mimeType;
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

					const objectLocation = String(fields.object_location || fields.objectLocation || '').trim();
					const aspectRatio = String(fields.aspectRatio || '').trim() || undefined;

					if (!objectBuffer || !objectLocation) {
						const err = validationError({ object_img: !objectBuffer ? 'required' : undefined, object_location: !objectLocation ? 'required' : undefined });
						logError({ requestId, uid, endpoint: 'generateAddObject', err });
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
									const err = new AppError({
										code: ErrorCodes.VALIDATION_ERROR,
										message: 'Image not found at storagePath',
										httpStatus: 404,
										retryable: false,
									});
									logError({ requestId, uid, endpoint: 'generateAddObject', err });
									return sendError(res, err, requestId);
								}

								const [metadata] = await file.getMetadata();
								croppedMime = metadata.contentType || 'image/png';

								const [downloadedBuffer] = await file.download();
								croppedBuffer = downloadedBuffer;
							} catch (e) {
								const err = storageError('Failed to download image from storage', true);
								logError({ requestId, uid, endpoint: 'generateAddObject', err });
								return sendError(res, err, requestId);
							}
						} else {
							const err = validationError({ cropped_img: 'required', storagePath: 'required' });
							logError({ requestId, uid, endpoint: 'generateAddObject', err });
							return sendError(res, err, requestId);
						}
					}

					const out = await generateAddObject({
						uid,
						croppedImageBase64: croppedBuffer.toString('base64'),
						croppedImageMimeType: croppedMime,
						objectImageBase64: objectBuffer.toString('base64'),
						objectImageMimeType: objectMime,
						objectLocation,
						aspectRatio,
					});
					return res.status(200).json(out);
				}

				// JSON body fallback
				const body = req.body || {};
				const croppedBase64 = body.croppedImageBase64 || body.cropped_img;
				const objectBase64 = body.objectImageBase64 || body.object_img;
				const objectLocation = String(body.objectLocation || body.object_location || '').trim();
				const aspectRatio = body.aspectRatio;
				if (!croppedBase64 || !objectBase64 || !objectLocation) {
					const err = validationError({ croppedImageBase64: !croppedBase64 ? 'required' : undefined, objectImageBase64: !objectBase64 ? 'required' : undefined, object_location: !objectLocation ? 'required' : undefined });
					logError({ requestId, uid, endpoint: 'generateAddObject', err });
					return sendError(res, err, requestId);
				}
				const out = await generateAddObject({
					uid,
					croppedImageBase64: croppedBase64,
					croppedImageMimeType: body.croppedImageMimeType,
					objectImageBase64: objectBase64,
					objectImageMimeType: body.objectImageMimeType,
					objectLocation,
					aspectRatio,
				});
				return res.status(200).json(out);
			} catch (err) {
				const appErr = normalizeUnknownError(err);
				logError({ requestId, uid, endpoint: 'generateAddObject', err: appErr });
				return sendError(res, appErr, requestId);
			}
		});
	}
);

