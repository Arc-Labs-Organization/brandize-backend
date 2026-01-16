const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const crypto = require('crypto');

// Initialize if needed
try {
  if (!admin.apps.length) {
    admin.initializeApp();
  }
} catch (e) {
  // ignore re-init
}

const db = getFirestore();

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

/**
 * verifyAndroidDeviceTrial
 * Callable Cloud Function (Gen 2) to verify an Android Device ID
 * and grant a one-time free trial per device.
 */
exports.verifyAndroidDeviceTrial = onCall({
  region: 'europe-west1',
}, async (request) => {
  try {
    const context = request;
    let uid;

    // 1. Try standard context auth
    if (context.auth && context.auth.uid) {
      uid = context.auth.uid;
    } 
    // 2. Fallback: Verify manually passed ID token (Fix for Android race conditions)
    else if (request.data && request.data.idToken) {
      try {
        const decoded = await admin.auth().verifyIdToken(request.data.idToken);
        uid = decoded.uid;
        logger.info('verifyAndroidDeviceTrial:verified_via_manual_token', { uid });
      } catch(e) {
        logger.error('verifyAndroidDeviceTrial:token_verify_error', { message: e.message });
        throw new HttpsError('unauthenticated', 'Invalid ID token provided.');
      }
    } else {
      throw new HttpsError('unauthenticated', 'Authentication required.');
    }

    const deviceId = request.data && request.data.deviceId;
    const restoreId = request.data && request.data.restoreId; // Optional

    logger.info('verifyAndroidDeviceTrial:start', {
      uid,
      hasDeviceId: !!deviceId,
      hasRestoreId: !!restoreId
    });

    if (!deviceId || typeof deviceId !== 'string') {
      throw new HttpsError('invalid-argument', 'Missing or invalid "deviceId".');
    }

    const deviceHash = sha256Hex(deviceId);
    const deviceRef = db.collection('androidDeviceTrials').doc(deviceHash);
    const userRef = db.collection('users').doc(uid);
    
    const restoreKey =
        typeof restoreId === 'string' && restoreId.length >= 12
          ? sha256Hex(restoreId)
          : null;
    const restoreRef = restoreKey ? db.collection('deviceRestores').doc(restoreKey) : null;

    const grant = { generate: 3, download: 3 };

    const result = await db.runTransaction(async (tx) => {
      const deviceSnap = await tx.get(deviceRef);
      const deviceData = deviceSnap.data() || {};

      if (deviceData.trialUsed) {
          return { success: false, reason: 'device_already_used' };
      }

      const userSnap = await tx.get(userRef);
      const userData = userSnap.data() || {};
      
      if (userData.hasClaimedTrial) {
          return { success: false, reason: 'user_already_used' };
      }

      // Grant trial logic
      tx.set(deviceRef, {
          trialUsed: true,
          firstUid: uid,
          usedAt: FieldValue.serverTimestamp(),
          restoreId: restoreId || null
      }, { merge: true });
      
      if (restoreRef) {
          tx.set(restoreRef, {
              firstUid: uid,
              lastUid: uid,
              createdAt: FieldValue.serverTimestamp(),
              lastSeenAt: FieldValue.serverTimestamp(),
              platform: 'android'
          }, { merge: true });
      }

      if (!userSnap.exists) {
           tx.set(userRef, {
               hasClaimedTrial: true,
               trialClaimedAt: FieldValue.serverTimestamp(),
               freeCredits: {
                   generateLimit: grant.generate,
                   downloadLimit: grant.download,
                   generationsUsed: 0,
                   downloadsUsed: 0
               },
               createdAt: FieldValue.serverTimestamp(),
               platform: 'android'
           });
      } else {
           tx.update(userRef, {
               hasClaimedTrial: true,
               trialClaimedAt: FieldValue.serverTimestamp(),
               'freeCredits.generateLimit': FieldValue.increment(grant.generate),
               'freeCredits.downloadLimit': FieldValue.increment(grant.download)
           });
      }

      return { success: true, granted: grant };
    });

    if (!result.success) {
        if (result.reason === 'device_already_used') {
             throw new HttpsError('permission-denied', 'Trial already claimed on this device');
        }
        if (result.reason === 'user_already_used') {
             return { success: true, granted: { generate: 0, download: 0 }, message: 'User already claimed trial.' };
        }
    }

    return { success: true, granted: result.granted };
  } catch (err) {
    if (err instanceof HttpsError) {
      throw err;
    }
    logger.error('verifyAndroidDeviceTrial:internal_error', { message: err.message, stack: err.stack });
    throw new HttpsError('internal', `Internal error: ${err.message}`);
  }
});

/**
 * resetAndroidDeviceTrialDev
 * Callable Cloud Function (Gen 2) - DEV ONLY
 */
exports.resetAndroidDeviceTrialDev = onCall({
  region: 'europe-west1',
}, async (request) => {
  const context = request;
  if (!context.auth || !context.auth.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const deviceId = request.data && request.data.deviceId;
  const alsoResetFirestore = request.data && request.data.alsoResetFirestore;

  if (!deviceId || typeof deviceId !== 'string') {
    throw new HttpsError('invalid-argument', 'Missing deviceId.');
  }

  const deviceHash = sha256Hex(deviceId);
  await db.collection('androidDeviceTrials').doc(deviceHash).delete();

  if (alsoResetFirestore) {
    const uid = context.auth.uid;
    const userRef = db.collection('users').doc(uid);
    await userRef.set({
        hasClaimedTrial: false,
        trialClaimedAt: FieldValue.delete()
    }, { merge: true });
  }

  return { success: true };
});
