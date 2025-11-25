/**
 * Migration script (run manually with: `node functions/scripts/migrateExistingImages.js` from repo root)
 *
 * Purpose:
 *  - Backfill legacy Freepik template documents in `freepikDownloads` into new master `images/{imageId}` docs.
 *  - Optionally move files from `templates/{legacyId}.<ext>` to `images/common/{imageId}.<ext>` (keeping same ext).
 *  - Create user link docs if you have historical ownership data (not included here).
 *
 * NOTES:
 *  - This script is idempotent: skips if target master doc already exists.
 *  - It uses the legacy doc's resourceId as the new imageId for consistency (if available), else falls back to the legacy doc id.
 *  - For safety, by default it does NOT delete the old file or doc; set `DELETE_LEGACY=true` env var to remove after successful migration.
 */

const admin = require('firebase-admin');
try { if (!admin.apps.length) admin.initializeApp(); } catch {}
const db = admin.firestore();
const bucket = admin.storage().bucket();

async function migrate() {
  const snapshot = await db.collection('freepikDownloads').get();
  console.log(`Found ${snapshot.size} legacy docs.`);
  let migrated = 0;
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const legacyId = doc.id;
    const imageId = data.resourceId || legacyId;
    const masterRef = db.collection('images').doc(imageId);
    const masterSnap = await masterRef.get();
    if (masterSnap.exists) {
      console.log(`[skip] images/${imageId} already exists.`);
      continue;
    }
    const storagePath = data.storagePath; // templates/<id>.<ext>
    if (!storagePath) {
      console.warn(`[warn] legacy doc ${legacyId} missing storagePath, skipping.`);
      continue;
    }
    const extMatch = storagePath.split('.').pop();
    const ext = (extMatch || 'jpg').toLowerCase();
    const newPath = `images/common/${imageId}.${ext}`;

    try {
      // Copy file if not already at new path
      if (storagePath !== newPath) {
        const srcFile = bucket.file(storagePath);
        const destFile = bucket.file(newPath);
        const [exists] = await destFile.exists();
        if (!exists) {
          await srcFile.copy(destFile);
          console.log(`[file] Copied ${storagePath} -> ${newPath}`);
        } else {
          console.log(`[file-skip] ${newPath} already exists.`);
        }
      }

      await masterRef.set({
        storagePath: newPath,
        type: 'downloaded',
        ownerId: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        resourceId: data.resourceId || null,
        mimeType: data.mimeType || null,
        size: data.size || null,
        downloadUrl: data.signedUrl || null,
        originalDownloadUrl: data.originalDownloadUrl || null,
        imageFileName: data.imageFileName || null,
        apiResponse: data.apiResponse || null,
        migratedFrom: legacyId,
      });
      console.log(`[doc] Created images/${imageId}`);
      migrated++;

      if (process.env.DELETE_LEGACY === 'true') {
        await doc.ref.delete();
        console.log(`[cleanup] Deleted legacy doc freepikDownloads/${legacyId}`);
      }
    } catch (e) {
      console.error(`[error] Failed migrating ${legacyId} -> ${imageId}:`, e.message || e);
    }
  }
  console.log(`Migration complete. Migrated ${migrated}/${snapshot.size} docs.`);
}

migrate().catch(e => { console.error('Migration fatal:', e); process.exit(1); });
