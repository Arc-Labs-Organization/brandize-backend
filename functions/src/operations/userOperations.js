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
      remainingUsage: {
        download: 100, // default download limit
        generate: 100, // default generate limit
      },
      brand: {
        name: null,
        website: null,
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
    const currentUsage = remainingUsage[usageType] || 0;

    if (currentUsage <= 0) {
      throw new Error(`No remaining ${usageType} usage available`);
    }

    // Decrement the usage
    transaction.update(userRef, {
      [`remainingUsage.${usageType}`]: FieldValue.increment(-1),
      lastUsedAt: FieldValue.serverTimestamp(),
    });

    return currentUsage - 1; // return new value
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
      res.set('Access-Control-Allow-Headers', 'Content-Type');
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

          // Fetch image details from images collection to get the URL
          // We do this to ensure we get the latest signed URL or metadata
          const imageDoc = await db.collection('images').doc(imageId).get();
          if (imageDoc.exists) {
            const imageData = imageDoc.data();
            return {
              ...data,
              downloadUrl: imageData.downloadUrl,
              originalDownloadUrl: imageData.originalDownloadUrl,
              mimeType: imageData.mimeType,
              size: imageData.size,
              imageFileName: imageData.imageFileName,
            };
          }
          return data;
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
      res.set('Access-Control-Allow-Headers', 'Content-Type');
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

          // Fetch image details from images collection to get the URL
          const imageDoc = await db.collection('images').doc(imageId).get();
          if (imageDoc.exists) {
            const imageData = imageDoc.data();
            return {
              ...data,
              downloadUrl: imageData.downloadUrl,
              mimeType: imageData.mimeType,
              size: imageData.size,
              prompt: imageData.prompt,
              aspectRatio: imageData.aspectRatio,
            };
          }
          return data;
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
