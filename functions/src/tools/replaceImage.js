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

// Prompt building (keep centralized + versioned)
const REPLACE_IMAGE_PROMPT_VERSION = 'replace-image-v1';

function buildReplaceImagePrompt({ description, aspectRatio }) {
  // Keep this short and ranked (models follow earlier rules more reliably)
  const parts = [];
  parts.push('You are an expert image editor.');
  parts.push('Task: In image #1 (the template crop), replace the described object/subject using image #2 (the replacement source).');
  parts.push('Target region: the ENTIRE bounds of image #1. The output must match image #1 canvas exactly (no padding, borders, blank areas, or resizing the canvas).');
  parts.push('Rules (follow strictly):');
  parts.push('1) Preserve everything in image #1 except the target object/subject. Do NOT change layout, background graphics, logos, or any text.');
  parts.push('2) Use ONLY the subject from image #2. Do not invent details that are not present in image #2.');
  parts.push('3) Fit: COVER the target region with the replacement subject and center-crop as needed. Maintain natural proportions (no stretching). Prefer slight overfill over borders. Never CONTAIN.');
  parts.push('4) Blend: Keep edges inside the region and softly blend/feather (1–2px). Match lighting direction, color temperature, white balance, and grain/noise. Add realistic shadows/reflections only if consistent with image #1.');
  parts.push('5) No extras: no stickers/watermarks, no duplicated subjects, no extra objects, no heavy filters, no border artifacts.');

  if (description) parts.push(`Replacement description: ${String(description).trim()}`);
  // Note: aspectRatio is enforced via model config; keep this line only as a hint.
  if (aspectRatio) parts.push(`Output aspect ratio hint (also enforced via config): ${String(aspectRatio).trim()}`);

  return parts.join('\n');
}

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

			const fullPrompt = buildReplaceImagePrompt({ description, aspectRatio });

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
					promptVersion: REPLACE_IMAGE_PROMPT_VERSION,
					style: null,
					aspectRatio: aspectRatio || null,
					mockupImageUrl: null,
					mimeType: 'image/png',
					downloadUrl,
					modelVersion: rawResponse?.modelVersion || null,
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

					if (!newBuffer || !description) {
						return res.status(400).json({ error: 'Missing required fields: new_img, replacable_img_description' });
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
									return res.status(404).json({ error: 'Image not found at storagePath' });
								}

								const [metadata] = await file.getMetadata();
								croppedMime = metadata.contentType || 'image/png';

								const [downloadedBuffer] = await file.download();
								croppedBuffer = downloadedBuffer;
							} catch (e) {
								console.error('Error downloading from storage:', e);
								return res.status(500).json({ error: 'Failed to download image from storage' });
							}
						} else {
							return res.status(400).json({ error: 'Missing required fields: cropped_img or storagePath' });
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
