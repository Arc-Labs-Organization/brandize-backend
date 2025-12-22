const { randomUUID } = require('crypto');
const sharp = require('sharp');

/**
 * Compute thumbnail path from original Storage path.
 * Example: images/.../imageId.jpg -> images/.../imageId_thumb_256.jpg
 */
function computeThumbPath(storagePath) {
  return String(storagePath).replace(/\.[a-z0-9]+$/i, '_thumb_256.jpg');
}

/**
 * Create a 256x256 JPEG thumbnail from an image buffer and upload to Storage.
 * Returns { thumbPath, thumbUrl }.
 * - Uses rotate() to respect EXIF
 * - fit: 'cover', quality: 80
 * - cacheControl: 'public, max-age=31536000'
 */
async function createAndUploadThumbnail(bucket, originalBuffer, originalStoragePath) {
  const thumbPath = computeThumbPath(originalStoragePath);
  let thumbUrl = null;
  try {
    const thumbBuffer = await sharp(originalBuffer)
      .rotate()
      .resize(256, 256, { fit: 'cover' })
      .jpeg({ quality: 80 })
      .toBuffer();

    const thumbFile = bucket.file(thumbPath);
    const thumbToken = randomUUID();
    await thumbFile.save(thumbBuffer, {
      resumable: false,
      contentType: 'image/jpeg',
      metadata: {
        cacheControl: 'public, max-age=31536000',
        metadata: { firebaseStorageDownloadTokens: thumbToken },
      },
    });

    // Signed URL first, fallback to token URL
    try {
      const [signedUrl] = await thumbFile.getSignedUrl({
        action: 'read',
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      });
      thumbUrl = signedUrl;
    } catch (e) {
      const [meta] = await thumbFile.getMetadata().catch(() => [{}]);
      let tkn = meta?.metadata?.firebaseStorageDownloadTokens;
      if (!tkn) {
        tkn = thumbToken || randomUUID();
        await thumbFile.setMetadata({ metadata: { firebaseStorageDownloadTokens: tkn } }).catch(() => {});
      }
      thumbUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(thumbPath)}?alt=media&token=${tkn}`;
    }
  } catch (err) {
    // Log upstream; return null URL
    console.warn('Thumbnail creation/upload failed:', err?.message || err);
    thumbUrl = null;
  }
  return { thumbPath, thumbUrl };
}

module.exports = { computeThumbPath, createAndUploadThumbnail };
