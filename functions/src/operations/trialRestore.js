const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const crypto = require('crypto');

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
 * restoreTrialCredits
 * Callable: moves remaining trial credits from the previous uid on this device
 * to the current uid.
 *
 * Client provides a restoreId (random UUID stored in Keychain/SecureStore).
 * Server hashes it and uses the hash as the Firestore doc id.
 */
const restoreTrialCredits = onCall(
  {
    region: 'europe-west1',
  },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Authentication required.');
    }

    const uid = request.auth.uid;
    let restoreId = request.data?.restoreId;

    // Optional: Android Device ID to recover original restoreId if local storage was cleared
    const deviceId = request.data?.deviceId;
    if (deviceId && typeof deviceId === 'string') {
       const deviceHash = sha256Hex(deviceId);
       const deviceRef = db.collection('androidDeviceTrials').doc(deviceHash);
       const deviceSnap = await deviceRef.get();
       // If we find an existing record with a stored restoreId, USE IT.
       // This bridges the gap when Android clears SecureStore on uninstall.
       if (deviceSnap.exists) {
           const data = deviceSnap.data() || {};
           if (data.restoreId && typeof data.restoreId === 'string') {
               logger.info('restoreTrialCredits:switched_to_persistent_restoreId', {
                   uid,
                   providedRestoreId: restoreId,
                   persistentRestoreId: data.restoreId
               });
               restoreId = data.restoreId;
           }
       }
    }

    if (!restoreId || typeof restoreId !== 'string' || restoreId.length < 12) {
      throw new HttpsError('invalid-argument', 'Missing or invalid restoreId.');
    }

    const restoreKey = sha256Hex(restoreId);
    const restoreRef = db.collection('deviceRestores').doc(restoreKey);
    const userRef = db.collection('users').doc(uid);

    logger.info('restoreTrialCredits:start', {
      uid,
      restoreKeyPrefix: restoreKey.slice(0, 10),
    });

    // Ensure user doc exists (match existing backend behavior)
    try {
      const { ensureUserExists } = require('./userOperations');
      await ensureUserExists(uid);
    } catch (e) {
      // best effort; continue
    }

    const result = await db.runTransaction(async (tx) => {
      const restoreSnap = await tx.get(restoreRef);
      if (!restoreSnap.exists) {
        return { restored: 0, reason: 'no_record' };
      }

      const restoreData = restoreSnap.data() || {};
      const fromUid = restoreData.lastUid || restoreData.firstUid;
      if (!fromUid || typeof fromUid !== 'string') {
        return { restored: 0, reason: 'no_source_uid' };
      }

      if (fromUid === uid) {
        tx.set(
          restoreRef,
          { lastSeenAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        return { restored: 0, reason: 'same_uid' };
      }

      const fromUserRef = db.collection('users').doc(fromUid);
      const fromSnap = await tx.get(fromUserRef);
      const toSnap = await tx.get(userRef);

      if (!fromSnap.exists) {
        tx.set(
          restoreRef,
          { lastSeenAt: FieldValue.serverTimestamp(), lastUid: uid },
          { merge: true },
        );
        return { restored: 0, reason: 'source_missing' };
      }

      const fromData = fromSnap.data() || {};
      const fromFree = fromData.freeCredits || {};

      let sourceGenLimit = 0;
      let sourceGenUsed = 0;
      let sourceDlLimit = 0;
      let sourceDlUsed = 0;

      // 1. Extract raw usage from source
      if (
        fromFree.generateLimit !== undefined ||
        fromFree.downloadLimit !== undefined
      ) {
         sourceGenLimit = Number(fromFree.generateLimit) || 0;
         sourceGenUsed = Number(fromFree.generationsUsed) || 0;
         sourceDlLimit = Number(fromFree.downloadLimit) || 0;
         sourceDlUsed = Number(fromFree.downloadsUsed) || 0;
      } else {
        // Legacy fallback: treat 'generate'/'trialCreditsRemaining' as pure limit with 0 usage
        const hasFromFreeGenerate = Object.prototype.hasOwnProperty.call(
          fromFree,
          'generate',
        );
        sourceGenLimit = hasFromFreeGenerate
          ? Number(fromFree.generate) || 0
          : Number(fromData.trialCreditsRemaining) || 0;
        sourceDlLimit = Number(fromFree.download) || 0;
      }

      const netGenRemaining = Math.max(0, sourceGenLimit - sourceGenUsed);
      const netDlRemaining = Math.max(0, sourceDlLimit - sourceDlUsed);

      if (netGenRemaining <= 0 && netDlRemaining <= 0) {
        tx.set(
          restoreRef,
          { lastSeenAt: FieldValue.serverTimestamp(), lastUid: uid },
          { merge: true },
        );
        return { restored: 0, reason: 'no_free_remaining', fromUid };
      }

      const toData = toSnap.exists ? toSnap.data() || {} : {};
      const toFree = toData.freeCredits || {};

      // 2. Add to destination
      let finalGenLimit = 0;
      let finalGenUsed = 0;
      let finalDlLimit = 0;
      let finalDlUsed = 0;

      if (
        toFree.generateLimit !== undefined ||
        toFree.downloadLimit !== undefined
      ) {
        // Destination already has new format
        finalGenLimit = (Number(toFree.generateLimit) || 0) + sourceGenLimit;
        finalGenUsed = (Number(toFree.generationsUsed) || 0) + sourceGenUsed;
        
        finalDlLimit = (Number(toFree.downloadLimit) || 0) + sourceDlLimit;
        finalDlUsed = (Number(toFree.downloadsUsed) || 0) + sourceDlUsed;
      } else {
        // Destination has legacy or no format
        const oldToGen = Number(toFree.generate) || 0;
        const oldToDl = Number(toFree.download) || 0;
        
        // Convert old 'generate' balance to limit+0 usage, then add source
        finalGenLimit = oldToGen + sourceGenLimit;
        finalGenUsed = sourceGenUsed;

        finalDlLimit = oldToDl + sourceDlLimit;
        finalDlUsed = sourceDlUsed;
      }

      // Remove from old uid
      tx.set(
        fromUserRef,
        {
          // Clear legacy trial field to avoid double-counting
          trialCreditsRemaining: 0,
          freeCredits: {
            generateLimit: 0,
            downloadLimit: 0,
            generationsUsed: 0,
            downloadsUsed: 0,
            generate: FieldValue.delete(),
            download: FieldValue.delete(),
          },
          lastUsedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      // Add to current uid
      tx.set(
        userRef,
        {
          hasClaimedTrial: true,
          trialProvider: 'restore',
          trialRestoredAt: FieldValue.serverTimestamp(),
          freeCredits: {
            generateLimit: finalGenLimit,
            downloadLimit: finalDlLimit,
            generationsUsed: finalGenUsed,
            downloadsUsed: finalDlUsed,
            generate: FieldValue.delete(),
            download: FieldValue.delete(),
          },
          lastUsedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      // Update restore record
      tx.set(
        restoreRef,
        {
          lastUid: uid,
          lastSeenAt: FieldValue.serverTimestamp(),
          lastRestoredAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return {
        restored: netGenRemaining + netDlRemaining,
        restoredFreeCredits: { generate: netGenRemaining, download: netDlRemaining },
        fromUid,
      };
    });

    logger.info('restoreTrialCredits:done', {
      uid,
      restored: result.restored,
      reason: result.reason,
      fromUid: result.fromUid,
    });

    return result;
  },
);

module.exports = { restoreTrialCredits };
