const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const cors = require('cors')({ origin: true });
const { verifyAuth } = require('../common/utils');
const { SUBSCRIPTION_TIERS } = require('../common/subscriptionConfig');
const { randomUUID } = require('crypto');
const { AppError, ErrorCodes, unauthenticated, validationError, sendError, normalizeUnknownError, logError } = require('../common/errors');

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
      subscription: {
        status: 'free',
        isActive: false,
        currentPeriodEnd: null,
        provider: null,
      },
      monthlyAllowance: {
        downloadLimit: 0,
        generateLimit: 0,
        downloadsUsed: 0,
        generationsUsed: 0,
      },
      freeCredits: {
        downloadLimit: 0,
        generateLimit: 0,
        downloadsUsed: 0,
        generationsUsed: 0,
      },
      trialCreditsRemaining: 0,
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
    
    // 1. Check Monthly Allowance first
    const subscription = userData.subscription || {};
    const monthlyAllowance = userData.monthlyAllowance || { 
      downloadLimit: 0, generateLimit: 0, downloadsUsed: 0, generationsUsed: 0 
    };

    const freeCredits = userData.freeCredits || {};

    const resolveUsedKey = (t) => t === 'generate' ? 'generationsUsed' : 'downloadsUsed';

    // Helper to get free remaining (handles legacy structure)
    const getFreeRemaining = (type) => {
       if (freeCredits[`${type}Limit`] !== undefined) {
          const limit = Number(freeCredits[`${type}Limit`]) || 0;
          const usedKey = resolveUsedKey(type);
          const used = Number(freeCredits[usedKey]) || 0;
          return Math.max(0, limit - used);
       }
       // Legacy
       let val = Number(freeCredits[type]);
       if (type === 'generate' && isNaN(val)) {
          val = Number(userData.trialCreditsRemaining) || 0;
       }
       return Number.isFinite(val) ? val : 0;
    };

    const isSubActive = subscription.isActive === true;
    const limitKey = `${usageType}Limit`;
    const usedKey = resolveUsedKey(usageType);

    const limit = Number(monthlyAllowance[limitKey]) || 0;
    const used = Number(monthlyAllowance[usedKey]) || 0;
    const monthlyRemaining = Math.max(0, limit - used);

    if (isSubActive && monthlyRemaining > 0) {
      // Consume from monthly allowance
      transaction.update(userRef, {
        [`monthlyAllowance.${usedKey}`]: FieldValue.increment(1),
        lastUsedAt: FieldValue.serverTimestamp(),
      });
      // Return total remaining (monthly + free)
      return (monthlyRemaining - 1) + getFreeRemaining(usageType); 
    }

    // 2. Fallback to Free Credits
    const actualFreeRemaining = getFreeRemaining(usageType);

    if (actualFreeRemaining > 0) {
       // Consume free credit
       const update = {
         lastUsedAt: FieldValue.serverTimestamp(),
       };
       
       if (freeCredits[`${usageType}Limit`] !== undefined) {
         update[`freeCredits.${usedKey}`] = FieldValue.increment(1);
       } else {
         // Migrate legacy to new structure on write
         // Assume legacy limit was 5 (since we just changed default to 3, but legacy users likely had 5)
         const LEGACY_LIMIT = 5;

         const oldGen = Number(freeCredits.generate);
         const genRemaining = Number.isFinite(oldGen) ? oldGen : (Number(userData.trialCreditsRemaining) || 0);
         const dlRemaining = Number(freeCredits.download) || 0;
         
         // Calculate limit and used based on remaining
         const genLimit = Math.max(LEGACY_LIMIT, genRemaining);
         const genUsed = genLimit - genRemaining;

         const dlLimit = Math.max(LEGACY_LIMIT, dlRemaining);
         const dlUsed = dlLimit - dlRemaining;

         const newCredits = {
           generateLimit: genLimit,
           generationsUsed: genUsed,
           downloadLimit: dlLimit,
           downloadsUsed: dlUsed,
         };
         
         // Mark current as used (increment used count)
         newCredits[usedKey] = newCredits[usedKey] + 1;

         update.freeCredits = newCredits;
         // Clean legacy
         if (userData.trialCreditsRemaining) {
           update.trialCreditsRemaining = 0;
         }
       }
       
       transaction.update(userRef, update);
       return actualFreeRemaining - 1;
    }

    // 3. No credits left
    throw new Error(`No remaining ${usageType} usage available`);
  });
}

/**
 * Get user info and remaining usage.
 * GET /userInfo
 * Auth: Authorization: Bearer <idToken>
 * Firestore: users/{uid}
 * Response:
 * {
 *   remainingDownload: number,
 *   remainingGenerate: number,
 *   monthlyAllowance: { ... },
 *   freeCredits: { ... },
 *   subStatus: 'free' | 'starter' | 'pro' | 'max'
 * }
 */
const userInfo = onRequest(
  {
    region: 'europe-west1',
    cors: true,
  },
  async (req, res) => {
    const requestId = randomUUID();
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      return res.status(204).send('');
    }

    return cors(req, res, async () => {
      if (req.method !== 'GET') {
        const err = new AppError({
          code: ErrorCodes.INVALID_STATE,
          message: 'Method not allowed. Use GET.',
          httpStatus: 405,
          retryable: false,
        });
        logError({ requestId, endpoint: 'userInfo', err });
        return sendError(res, err, requestId);
      }

      let uid;
      try {
        uid = await verifyAuth(req);
      } catch (e) {
        const err = unauthenticated(e?.message || 'Unauthorized');
        logError({ requestId, endpoint: 'userInfo', err });
        return sendError(res, err, requestId);
      }

      try {
        // Ensure user doc exists (server-side authority)
        await ensureUserExists(uid);

        const userRef = db.collection('users').doc(uid);
        const snap = await userRef.get();
        const data = snap.data() || {};

        const subscription = data.subscription || {};
        const monthlyAllowance = data.monthlyAllowance || {
          downloadLimit: 0, generateLimit: 0, downloadsUsed: 0, generationsUsed: 0
        };
        const freeCredits = data.freeCredits || {};

        // Calculate Monthly Remaining
        const monthlyDownloadsRemaining = Math.max(0, (monthlyAllowance.downloadLimit || 0) - (monthlyAllowance.downloadsUsed || 0));
        const monthlyGenerationsRemaining = Math.max(0, (monthlyAllowance.generateLimit || 0) - (monthlyAllowance.generationsUsed || 0));

        // Calculate Free Remaining
        let freeGenerate = 0;
        let freeDownload = 0;
        let freeCreditsResponse = {};

        // Check new structure
        if (freeCredits.generateLimit !== undefined || freeCredits.downloadLimit !== undefined) {
          freeGenerate = Math.max(0, (freeCredits.generateLimit || 0) - (freeCredits.generationsUsed || 0));
          freeDownload = Math.max(0, (freeCredits.downloadLimit || 0) - (freeCredits.downloadsUsed || 0));

          freeCreditsResponse = {
            downloadLimit: freeCredits.downloadLimit || 0,
            generateLimit: freeCredits.generateLimit || 0,
            downloadsUsed: freeCredits.downloadsUsed || 0,
            generationsUsed: freeCredits.generationsUsed || 0,
            remainingGenerate: freeGenerate,
            remainingDownload: freeDownload,
          };
        } else {
          // Legacy fallback
          freeGenerate = Number.isFinite(freeCredits.generate)
            ? Math.max(0, freeCredits.generate)
            : Math.max(0, Number(data.trialCreditsRemaining) || 0);
          freeDownload = Number.isFinite(freeCredits.download)
            ? Math.max(0, freeCredits.download)
            : 0;

          // Expose as new structure to frontend
          freeCreditsResponse = {
            downloadLimit: freeDownload,
            generateLimit: freeGenerate,
            downloadsUsed: 0,
            generationsUsed: 0,
            remainingGenerate: freeGenerate,
            remainingDownload: freeDownload,
          };
        }

        // Total
        // Only count monthly remaining if subscription is active
        const isSubActive = subscription.isActive === true;
        
        const totalRemainingDownload = (isSubActive ? monthlyDownloadsRemaining : 0) + freeDownload;
        const totalRemainingGenerate = (isSubActive ? monthlyGenerationsRemaining : 0) + freeGenerate;

        return res.status(200).json({
          remainingDownload: totalRemainingDownload,
          remainingGenerate: totalRemainingGenerate,
          monthlyAllowance: {
            ...monthlyAllowance,
            remainingDownload: monthlyDownloadsRemaining,
            remainingGenerate: monthlyGenerationsRemaining
          },
          freeCredits: freeCreditsResponse,
          subscriptionStatus: subscription.status || 'free',
          // Back-compat
          subStatus: subscription.status || 'free',
          // Next reset for UI
          currentPeriodEnd: subscription.currentPeriodEnd 
            ? subscription.currentPeriodEnd.toDate().toISOString() 
            : null,
        });
      } catch (error) {
        const appErr = normalizeUnknownError(error);
        logError({ requestId, uid, endpoint: 'userInfo', err: appErr });
        return sendError(res, appErr, requestId);
      }
    });
  },
);

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
    const requestId = randomUUID();
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      return res.status(204).send('');
    }

    return cors(req, res, async () => {
      if (req.method !== 'GET') {
        const err = new AppError({
          code: ErrorCodes.INVALID_STATE,
          message: 'Method not allowed. Use GET.',
          httpStatus: 405,
          retryable: false,
        });
        logError({ requestId, endpoint: 'getDownloadedImages', err });
        return sendError(res, err, requestId);
      }

      let uid;
      try {
        uid = await verifyAuth(req);
      } catch (e) {
        const err = unauthenticated(e?.message || 'Unauthorized');
        logError({ requestId, endpoint: 'getDownloadedImages', err });
        return sendError(res, err, requestId);
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
        const appErr = normalizeUnknownError(error);
        logError({ requestId, uid, endpoint: 'getDownloadedImages', err: appErr });
        return sendError(res, appErr, requestId);
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
    const requestId = randomUUID();
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      return res.status(204).send('');
    }

    return cors(req, res, async () => {
      if (req.method !== 'GET') {
        const err = new AppError({
          code: ErrorCodes.INVALID_STATE,
          message: 'Method not allowed. Use GET.',
          httpStatus: 405,
          retryable: false,
        });
        logError({ requestId, endpoint: 'getCreatedImages', err });
        return sendError(res, err, requestId);
      }

      let uid;
      try {
        uid = await verifyAuth(req);
      } catch (e) {
        const err = unauthenticated(e?.message || 'Unauthorized');
        logError({ requestId, endpoint: 'getCreatedImages', err });
        return sendError(res, err, requestId);
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
        const appErr = normalizeUnknownError(error);
        logError({ requestId, uid, endpoint: 'getCreatedImages', err: appErr });
        return sendError(res, appErr, requestId);
      }
    });
  },
);

module.exports = { ensureUserExists, decrementUsage, getDownloadedImages, getCreatedImages, userInfo };
