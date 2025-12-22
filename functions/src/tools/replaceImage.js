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

const { createAndUploadThumbnail, computeThumbPath } = require('../operations/thumbnailOperations');

async function getReplaceImageFlows() {
	if (flows) return flows;
	const { ai, flow, z, googleAI } = await initGenkit();

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
			aspectRatio,
		}) => {
			await ensureUserExists(uid);
			await decrementUsage(uid, 'generate');

			const parts = [];
			parts.push('Task: In the first image (template crop), replace the described object/subject using the second image (replacement source).');
			parts.push('STRICT RULES (follow precisely):');
			parts.push('- Fit strategy: COVER the target region with the replacement image, then CENTER-CROP so it fills the region with no gaps. Never CONTAIN or shrink to fit inside.');
			parts.push('- Anchor: Use the TARGET REGION CENTER as the placement anchor. Do NOT anchor to top-left.');
			parts.push('- Scale/size: The replacement must fill the region naturally (not tiny). Prefer slight overfill to avoid borders.');
			parts.push('- Rotation: Apply at most one orientation alignment. Do NOT add extra tilt. If the region is angled, prefer subtle perspective/warp alignment rather than stacking rotation twice.');
			parts.push('- Composition: Preserve original layout and visual hierarchy. Do NOT move or edit unrelated elements.');
			parts.push('- Lighting & color: Match surrounding lighting, color temperature, white balance, and grain/noise. Add realistic shadows/reflections where needed.');
			parts.push('- Edges/mask: Keep replacement fully within the region; feather/blend edges subtly (1–2px) to integrate.');
			parts.push('- Transparency: Preserve and pass through any transparent areas of the base image. Do NOT add checkerboard or flatten alpha.');
			parts.push('- Non-goals: Do NOT change any texts, logos, or background graphics outside the replacement area.');
			if (description) {
				parts.push(`Target replacement description: ${description}.`);
			}
			// Aspect ratio applies to the final generated image only and is handled via model config below.
			const fullPrompt = parts.join('\n');

			const baseMime = croppedImageMimeType || 'image/png';
			const newMime = newImageMimeType || 'image/png';

			const promptArray = [
				{
					media: { url: `data:${baseMime};base64,${croppedImageBase64}`, contentType: baseMime },
				},
				{
					media: { url: `data:${newMime};base64,${newImageBase64}`, contentType: newMime },
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

			// Always export PNG to preserve alpha (avoid checkerboard artifacts)
			const dataUrl = m.url;
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
					style: null,
					aspectRatio: aspectRatio || null,
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
					if (!croppedBuffer || !newBuffer || !description) {
						return res.status(400).json({ error: 'Missing required fields: cropped_img, new_img, replacable_img_description' });
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
					return res.status(400).json({ error: 'Missing required fields: croppedImageBase64, newImageBase64, replacable_img_description' });
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
				console.error('generateReplaceImage error:', err?.message || err);
				return res.status(500).json({ error: 'Internal Server Error' });
			}
		});
	}
);

