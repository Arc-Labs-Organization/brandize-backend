const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const cors = require('cors')({ origin: true });
const { verifyAuth } = require('../common/utils');
const { SUBSCRIPTION_TIERS } = require('../common/subscriptionConfig');

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
        generate: 0,
        download: 0,
      },
      // Deprecated fields kept for strict safety if needed, but not primarily used anymore
      remainingUsage: {
        download: 0,
        generate: 0,
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

    const isSubActive = subscription.isActive === true;
    const limitKey = `${usageType}Limit`;
    const usedKey = `${usageType}sUsed`; // downloadsUsed or generationsUsed

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
      const freeRemaining = (userData.freeCredits && userData.freeCredits[usageType]) || 0;
      return (monthlyRemaining - 1) + freeRemaining; 
    }

    // 2. Fallback to Free Credits
    const freeCredits = userData.freeCredits || {};
    // Handle legacy formats if present, but prioritize map
    const freeRemaining = Number(freeCredits[usageType]) || 0;

    // Handle legacy trialCreditsRemaining for 'generate' if not in freeCredits
    const legacyTrial = (usageType === 'generate' && !freeCredits.generate) 
      ? (Number(userData.trialCreditsRemaining) || 0) 
      : 0;
    
    const actualFreeRemaining = Math.max(freeRemaining, legacyTrial);

    if (actualFreeRemaining > 0) {
       // Consume free credit
       const update = {
         lastUsedAt: FieldValue.serverTimestamp(),
       };
       
       if (freeRemaining > 0) {
         update[`freeCredits.${usageType}`] = actualFreeRemaining - 1;
       } else if (legacyTrial > 0) {
         update.trialCreditsRemaining = actualFreeRemaining - 1;
         // Also verify if we should migrate this to freeCredits structure
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

        const subscription = data.subscription || {};
        const monthlyAllowance = data.monthlyAllowance || {
          downloadLimit: 0, generateLimit: 0, downloadsUsed: 0, generationsUsed: 0
        };
        const freeCredits = data.freeCredits || {};

        // Calculate Monthly Remaining
        const monthlyDownloadsRemaining = Math.max(0, (monthlyAllowance.downloadLimit || 0) - (monthlyAllowance.downloadsUsed || 0));
        const monthlyGenerationsRemaining = Math.max(0, (monthlyAllowance.generateLimit || 0) - (monthlyAllowance.generationsUsed || 0));

        // Calculate Free Remaining
        // Legacy fallback
        const freeGenerate = Number.isFinite(freeCredits.generate)
          ? Math.max(0, freeCredits.generate)
          : Math.max(0, Number(data.trialCreditsRemaining) || 0);
        const freeDownload = Number.isFinite(freeCredits.download)
          ? Math.max(0, freeCredits.download)
          : 0;

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
          freeCredits: {
            generate: freeGenerate,
            download: freeDownload,
          },
          subscriptionStatus: subscription.status || 'free',
          // Back-compat
          subStatus: subscription.status || 'free',
        });
      } catch (error) {
        console.error('Error in userInfo:', error);
        return res.status(500).json({ error: 'Internal Server Error', details: error.message });
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

module.exports = { ensureUserExists, decrementUsage, getDownloadedImages, getCreatedImages, userInfo };
