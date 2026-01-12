const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const cors = require('cors')({ origin: true });
const { verifyAuth } = require('../common/utils');

try {
  if (!admin.apps.length) {
    admin.initializeApp();
  }
} catch (e) {
  // ignore re-init in emulator hot-reload
}

const db = getFirestore();

// User accounting helpers
async function ensureUserExists(uid) {
  if (!uid || typeof uid !== 'string') {
    throw new Error('Invalid uid provided');
  }

  const userRef = db.collection('users').doc(uid);
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    // Create user with default values
    await userRef.set({
      trialCreditsRemaining: 0,
      freeCredits: {
        generate: 0,
        download: 0,
      },
      remainingUsage: {
        // Free users should have NO paid credits by default.
        // Trial credits are granted into freeCredits via DeviceCheck claim.
        download: 0,
        generate: 0,
      },
      createdAt: FieldValue.serverTimestamp(),
      lastUsedAt: FieldValue.serverTimestamp(),
    });
  } else {
    // Update lastUsedAt timestamp
    await userRef.update({
      lastUsedAt: FieldValue.serverTimestamp(),
    });
  }
}

async function decrementUsage(uid, usageType) {
  if (!uid || typeof uid !== 'string') {
    throw new Error('Invalid uid provided');
  }
  if (usageType !== 'download' && usageType !== 'generate') {
    throw new Error("Invalid usage type. Must be 'download' or 'generate'");
  }

  const userRef = db.collection('users').doc(uid);

  // Use a transaction to ensure atomic decrement and validation
  return await db.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(userRef);

    if (!userDoc.exists) {
      throw new Error('User does not exist. Call ensureUserExists first.');
    }

    const userData = userDoc.data();
    const remainingUsage = userData.remainingUsage || {};
    const subStatus = userData.subStatus === 'pro' ? 'pro' : 'free';
    // Enforce: free plan has no paid credits; only freeCredits/trial may be consumed.
    const paidRemaining = subStatus === 'pro' ? (Number(remainingUsage[usageType]) || 0) : 0;

    // freeCredits are consumed first. Legacy support: if freeCredits.generate is not present
    // but trialCreditsRemaining exists, treat it as free generate credits.
    const rawFreeCredits = userData.freeCredits;
    const freeCreditsIsMap =
      rawFreeCredits && typeof rawFreeCredits === 'object' && !Array.isArray(rawFreeCredits);
    const freeCredits = freeCreditsIsMap ? rawFreeCredits : {};

    const legacyTrialGenerate = usageType === 'generate' ? (Number(userData.trialCreditsRemaining) || 0) : 0;

    // Determine which bucket we are consuming from.
    // If `freeCredits` is malformed in Firestore (non-map), nested updates like
    // `freeCredits.generate` will throw. We detect and repair it.
    const hasFreeField = Object.prototype.hasOwnProperty.call(freeCredits, usageType);
    const mappedFreeRemaining = hasFreeField ? Math.max(0, Number(freeCredits[usageType]) || 0) : 0;
    const scalarFreeRemaining =
      !freeCreditsIsMap && typeof rawFreeCredits === 'number' && Number.isFinite(rawFreeCredits)
        ? Math.max(0, rawFreeCredits)
        : 0;

    const freeRemaining = mappedFreeRemaining > 0
      ? mappedFreeRemaining
      : (legacyTrialGenerate > 0 ? legacyTrialGenerate : scalarFreeRemaining);

    const totalRemaining = paidRemaining + freeRemaining;
    if (totalRemaining <= 0) {
      throw new Error(`No remaining ${usageType} usage available`);
    }

    const update = {
      lastUsedAt: FieldValue.serverTimestamp(),
    };

    if (freeRemaining > 0) {
      if (mappedFreeRemaining > 0 && hasFreeField) {
        // Normal path: freeCredits is a map and has the required field.
        // Use an explicit numeric write (not FieldValue.increment) so we can self-heal
        // cases where `freeCredits.generate` was accidentally stored as a string.
        update[`freeCredits.${usageType}`] = Math.max(0, mappedFreeRemaining - 1);
        transaction.update(userRef, update);
        return totalRemaining - 1;
      }

      if (legacyTrialGenerate > 0 && usageType === 'generate') {
        // Legacy fallback: older installs stored free generate credits in trialCreditsRemaining.
        // Explicit numeric write to avoid increment errors if the field is not a number.
        update.trialCreditsRemaining = Math.max(0, legacyTrialGenerate - 1);
        transaction.update(userRef, update);
        return totalRemaining - 1;
      }

      if (scalarFreeRemaining > 0) {
        // Best-effort repair: if freeCredits was accidentally stored as a scalar, convert it to a map
        // so future decrements work, then decrement the appropriate field.
        const nextFreeCredits = {
          generate: usageType === 'generate' ? Math.max(0, scalarFreeRemaining - 1) : 0,
          download: usageType === 'download' ? Math.max(0, scalarFreeRemaining - 1) : 0,
        };
        transaction.set(
          userRef,
          {
            freeCredits: nextFreeCredits,
            lastUsedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        return totalRemaining - 1;
      }

      // If we got here, we believed there were free credits but couldn't safely identify a field.
      // Fall back to paid decrement to avoid throwing internal errors.
      update[`remainingUsage.${usageType}`] = Math.max(0, paidRemaining - 1);
    } else {
      update[`remainingUsage.${usageType}`] = Math.max(0, paidRemaining - 1);
    }

    transaction.update(userRef, update);
    return totalRemaining - 1; // new total remaining
  });
}

/**
 * Get user's downloaded images.
 * GET /api/user/downloads
 * Returns: { downloads: Array }
 */
const getDownloadedImages = onRequest(
  {
    region: 'europe-west1',
    cors: true,
  },
  async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      return res.status(204).send('');
    }

    return cors(req, res, async () => {
      if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed. Use GET.' });
      }

      let uid;
      try {
        uid = await verifyAuth(req);
      } catch (e) {
        return res.status(401).json({ error: e.message });
      }

      try {
        const downloadsSnapshot = await db
          .collection('users')
          .doc(uid)
          .collection('downloads')
          .orderBy('createdAt', 'desc')
          .get();

        if (downloadsSnapshot.empty) {
          return res.status(200).json({ downloads: [] });
        }

        const downloadPromises = downloadsSnapshot.docs.map(async (doc) => {
          const data = doc.data();
          const imageId = data.imageId;

          // Fetch image details from images collection to get the latest metadata
          const imageDoc = await db.collection('images').doc(imageId).get();
          const imageData = imageDoc.exists ? imageDoc.data() : {};

          // Build a clean, minimal response object without duplicate thumb fields
          return {
            imageId,
            type: data.type || 'downloaded',
            storagePath: data.storagePath || imageData.storagePath || null,
            createdAt: data.createdAt || null,
            downloadUrl: imageData.downloadUrl || null,
            originalDownloadUrl: imageData.originalDownloadUrl || null,
            mimeType: imageData.mimeType,
            size: imageData.size,
            imageFileName: imageData.imageFileName,
            thumbnailUrl: (data.thumbUrl ?? imageData.thumbUrl ?? null),
            thumbnailPath: (data.thumbPath ?? imageData.thumbPath ?? null),
          };
        });

        const downloads = await Promise.all(downloadPromises);
        return res.status(200).json({ downloads });
      } catch (error) {
        console.error('Error fetching downloads:', error);
        return res.status(500).json({ error: 'Internal Server Error', details: error.message });
      }
    });
  },
);

/**
 * Get user's generated (created) images.
 * GET /api/user/created
 * Returns: { created: Array }
 */
const getCreatedImages = onRequest(
  {
    region: 'europe-west1',
    cors: true,
  },
  async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      return res.status(204).send('');
    }

    return cors(req, res, async () => {
      if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed. Use GET.' });
      }

      let uid;
      try {
        uid = await verifyAuth(req);
      } catch (e) {
        return res.status(401).json({ error: e.message });
      }

      try {
        const createdSnapshot = await db
          .collection('users')
          .doc(uid)
          .collection('generated')
          .orderBy('createdAt', 'desc')
          .get();

        if (createdSnapshot.empty) {
          return res.status(200).json({ created: [] });
        }

        const createdPromises = createdSnapshot.docs.map(async (doc) => {
          const data = doc.data();
          const imageId = data.imageId;

          // Fetch image details from images collection to get the latest metadata
          const imageDoc = await db.collection('images').doc(imageId).get();
          const imageData = imageDoc.exists ? imageDoc.data() : {};

          // Build a clean, minimal response object without duplicate thumb fields
          return {
            imageId,
            type: data.type || 'generated',
            storagePath: data.storagePath || imageData.storagePath || null,
            createdAt: data.createdAt || null,
            downloadUrl: imageData.downloadUrl || null,
            mimeType: imageData.mimeType,
            size: imageData.size,
            prompt: imageData.prompt,
            aspectRatio: imageData.aspectRatio,
            thumbnailUrl: (data.thumbUrl ?? imageData.thumbUrl ?? null),
            thumbnailPath: (data.thumbPath ?? imageData.thumbPath ?? null),
          };
        });

        const created = await Promise.all(createdPromises);
        return res.status(200).json({ created });
      } catch (error) {
        console.error('Error fetching created images:', error);
        return res.status(500).json({ error: 'Internal Server Error', details: error.message });
      }
    });
  },
);

module.exports = { ensureUserExists, decrementUsage, getDownloadedImages, getCreatedImages };

/**
 * Get user info and remaining usage.
 * GET /userInfo
 * Auth: Authorization: Bearer <idToken>
 * Firestore: users/{uid}
 * Response:
 * {
 *   remainingDownload: number,
 *   remainingGenerate: number,
 *   subStatus: 'free' | 'pro'
 * }
 */
const userInfo = onRequest(
  {
    region: 'europe-west1',
    cors: true,
  },
  async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      return res.status(204).send('');
    }

    return cors(req, res, async () => {
      if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed. Use GET.' });
      }

      let uid;
      try {
        uid = await verifyAuth(req);
      } catch (e) {
        return res.status(401).json({ error: e.message });
      }

      try {
        // Ensure user doc exists (server-side authority)
        await ensureUserExists(uid);

        const userRef = db.collection('users').doc(uid);
        const snap = await userRef.get();
        const data = snap.data() || {};

        // Determine subscription status (default to free)
        const subStatus = data.subStatus === 'pro' ? 'pro' : 'free';

        // Plan limits (env-configurable; safe defaults)
        // Free plan: no included credits. Trial credits are tracked in freeCredits.
        const FREE_DOWNLOAD_LIMIT = parseInt(process.env.FREE_DOWNLOAD_LIMIT || '0', 10);
        const FREE_GENERATE_LIMIT = parseInt(process.env.FREE_GENERATE_LIMIT || '0', 10);
        const PRO_DOWNLOAD_LIMIT = parseInt(process.env.PRO_DOWNLOAD_LIMIT || '100', 10);
        const PRO_GENERATE_LIMIT = parseInt(process.env.PRO_GENERATE_LIMIT || '100', 10);

        const planDownloadLimit = subStatus === 'pro' ? PRO_DOWNLOAD_LIMIT : FREE_DOWNLOAD_LIMIT;
        const planGenerateLimit = subStatus === 'pro' ? PRO_GENERATE_LIMIT : FREE_GENERATE_LIMIT;

        // Prefer server-managed remainingUsage if present; else derive from usage counters
        const remainingUsage = data.remainingUsage || {};
        const usageCounters = data.usage || {};

        const freeCredits = data.freeCredits || {};
        const freeGenerate = Number.isFinite(freeCredits.generate)
          ? Math.max(0, freeCredits.generate)
          : Math.max(0, Number(data.trialCreditsRemaining) || 0);
        const freeDownload = Number.isFinite(freeCredits.download)
          ? Math.max(0, freeCredits.download)
          : 0;

        const computedPaidRemainingDownload = Number.isFinite(remainingUsage.download)
          ? Math.max(0, remainingUsage.download)
          : Math.max(0, planDownloadLimit - (Number(usageCounters.download) || 0));

        const computedPaidRemainingGenerate = Number.isFinite(remainingUsage.generate)
          ? Math.max(0, remainingUsage.generate)
          : Math.max(0, planGenerateLimit - (Number(usageCounters.generate) || 0));

        // Enforce: free plan has no paid credits.
        const remainingDownload = subStatus === 'pro' ? computedPaidRemainingDownload : 0;
        const remainingGenerate = subStatus === 'pro' ? computedPaidRemainingGenerate : 0;

        const totalRemainingDownload = remainingDownload + freeDownload;
        const totalRemainingGenerate = remainingGenerate + freeGenerate;

        return res.status(200).json({
          remainingDownload: totalRemainingDownload,
          remainingGenerate: totalRemainingGenerate,
          // Back-compat: keep old field name, mapped to free generate credits
          trialCreditsRemaining: freeGenerate,
          freeCredits: {
            generate: freeGenerate,
            download: freeDownload,
          },
          subStatus,
        });
      } catch (error) {
        console.error('Error in userInfo:', error);
        return res.status(500).json({ error: 'Internal Server Error', details: error.message });
      }
    });
  },
);

module.exports.userInfo = userInfo;
