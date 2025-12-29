const { onRequest } = require('firebase-functions/v2/https');
const cors = require('cors')({ origin: true });
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { randomUUID } = require('crypto');
const { createMultipartParser, buildGeneratedImagePath, verifyAuth } = require('../common/utils');
const { createAndUploadThumbnail, computeThumbPath } = require('../operations/thumbnailOperations');
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
			await decrementUsage(uid, 'generate');

			const parts = [];
			parts.push('Task: Using the first image (the model), integrate the product from the second image either as held in hand or worn on the body based on the requested mode.');
			parts.push('GENERAL RULES (follow precisely):');
			parts.push('- Canvas lock: OUTPUT WIDTH and HEIGHT MUST MATCH the FIRST IMAGE exactly. No padding, borders, whitespace, or re-layout.');
			parts.push('- Identity: Preserve the model’s identity, face, skin, hair, and pose. Do not alter facial features or body shape.');
			parts.push('- Lighting & color: Match ambient lighting, color temperature, white balance, grain/noise, and shadows.');
			parts.push('- Scale: Keep natural scale relative to the model and surrounding scene.');
			parts.push('- Occlusion: Respect natural occlusions between fingers/clothing/body.');
			parts.push('- Non-goals: Do NOT modify unrelated background elements or texts.');
			if (mode === 'hold') {
				parts.push('Mode: HOLD in HAND.');
				if (targetHand) parts.push(`Target hand: ${targetHand}.`);
				parts.push('Placement: Place the product naturally in the specified hand; align orientation to match grip.');
				parts.push('Fingers: Ensure realistic finger wrapping/occlusion partly covering the product when appropriate.');
				parts.push('Contact: Add subtle contact shadows and highlights between hand and product.');
			} else if (mode === 'wear') {
				parts.push('Mode: WEAR on BODY.');
				parts.push('Fit: Align and conform the product to the body region, maintaining realistic drape/warp for cloth or fit for shoes/accessories.');
				parts.push('Edges: Blend edges; follow contours and joints; no floating or clipping.');
			}
			const fullPrompt = parts.join('\n');

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
			const imageBase64 = dataUrl.substring(commaIdx + 1);
			let buffer = Buffer.from(imageBase64, 'base64');
			let mimeType = 'image/png';
			try {
				const sharp = require('sharp');
				const resized = await sharp(buffer, { unlimited: true })
					.png()
					.toBuffer();
				if (modelWidth && modelHeight) {
					buffer = await sharp(resized, { unlimited: true })
						.resize(modelWidth, modelHeight, { fit: 'cover', position: 'centre' })
						.png()
						.toBuffer();
				} else {
					buffer = resized;
				}
				mimeType = 'image/png';
			} catch (_) {}
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
					mimeType: 'image/png',
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
		if (req.method === 'OPTIONS') {
			res.set('Access-Control-Allow-Origin', '*');
			res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
			res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
			return res.status(204).send('');
		}

		return cors(req, res, async () => {
			if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

			let uid;
			try {
				uid = await verifyAuth(req);
			} catch (e) {
				return res.status(401).json({ error: e.message });
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
						return res.status(400).json({ error: 'Missing or invalid field: mode (must be hold|wear)' });
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
									return res.status(404).json({ error: 'Model image not found at storagePath' });
								}

								const [metadata] = await file.getMetadata();
								modelMime = metadata.contentType || 'image/png';

								const [downloadedBuffer] = await file.download();
								modelBuffer = downloadedBuffer;
							} catch (e) {
								console.error('Error downloading model from storage:', e);
								return res.status(500).json({ error: 'Failed to download model image from storage' });
							}
						} else {
							return res.status(400).json({ error: 'Missing required fields: cropped_img or modelStoragePath' });
						}
					}

					// product image must be provided as file in multipart
					if (!productBuffer) {
						return res.status(400).json({ error: 'Missing required field: product_img (file)' });
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
				return res.status(400).json({ error: 'Use multipart/form-data with product_img (file) and either cropped_img (file) or modelStoragePath' });
			} catch (err) {
				console.error('generateVirtualModel error:', err?.message || err);
				return res.status(500).json({ error: 'Internal Server Error' });
			}
		});
	}
);

