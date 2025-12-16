const { onRequest } = require('firebase-functions/v2/https');
const cors = require('cors')({ origin: true });
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { randomUUID } = require('crypto');
const { createMultipartParser, buildGeneratedImagePath, verifyAuth } = require('../common/utils');
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
			aspectRatio,
		}) => {
			await ensureUserExists(uid);
			await decrementUsage(uid, 'generate');

			const parts = [];
			parts.push('Task: In the first image (template crop), ADD the object from the second image at the specified location.');
			parts.push('STRICT RULES (follow precisely):');
			parts.push('- Placement: Place the object centered within the specified target location. Do not shift unrelated elements.');
			parts.push('- Fit strategy: COVER the target region with the object; allow slight overfill to avoid borders.');
			parts.push('- Scale: Match natural scale consistent with surrounding context.');
			parts.push('- Lighting & color: Match ambient lighting, color temperature, white balance, and grain/noise.');
			parts.push('- Shadows/reflections: Add realistic contact shadows and reflections where appropriate.');
			parts.push('- Edges/mask: Keep object fully within region; feather/blend edges subtly (1–2px).');
			parts.push('- Transparency: Preserve any alpha from the base image; do not add checkerboards.');
			parts.push('- Non-goals: Do NOT modify texts, logos, or background graphics outside the placement area.');
			parts.push(`Target location description: ${objectLocation}.`);
			const fullPrompt = parts.join('\n');

			const baseMime = croppedImageMimeType || 'image/png';
			const objMime = objectImageMimeType || 'image/png';

			const promptArray = [
				{ media: { url: `data:${baseMime};base64,${croppedImageBase64}`, contentType: baseMime } },
				{ media: { url: `data:${objMime};base64,${objectImageBase64}`, contentType: objMime } },
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
			} catch (_) {
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
			const imageBase64 = dataUrl.substring(commaIdx + 1);
			let buffer = Buffer.from(imageBase64, 'base64');
			let mimeType = 'image/png';
			try {
				const sharp = require('sharp');
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
		if (req.method === 'OPTIONS') {
			res.set('Access-Control-Allow-Origin', '*');
			res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
			res.set('Access-Control-Allow-Headers', 'Content-Type');
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
					if (!croppedBuffer || !objectBuffer || !objectLocation) {
						return res.status(400).json({ error: 'Missing required fields: cropped_img, object_img, object_location' });
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
					return res.status(400).json({ error: 'Missing required fields: croppedImageBase64, objectImageBase64, object_location' });
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
				console.error('generateAddObject error:', err?.message || err);
				return res.status(500).json({ error: 'Internal Server Error' });
			}
		});
	}
);

