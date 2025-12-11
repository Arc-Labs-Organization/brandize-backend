const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

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

module.exports = { ensureUserExists, decrementUsage };
