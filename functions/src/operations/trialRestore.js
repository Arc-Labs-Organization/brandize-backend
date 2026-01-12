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
    const restoreId = request.data?.restoreId;
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
      const hasFromFreeGenerate = Object.prototype.hasOwnProperty.call(fromFree, 'generate');
      const fromFreeGenerate = hasFromFreeGenerate
        ? (Number(fromFree.generate) || 0)
        : (Number(fromData.trialCreditsRemaining) || 0);
      const fromFreeDownload = Number(fromFree.download) || 0;

      if (fromFreeGenerate <= 0 && fromFreeDownload <= 0) {
        tx.set(
          restoreRef,
          { lastSeenAt: FieldValue.serverTimestamp(), lastUid: uid },
          { merge: true },
        );
        return { restored: 0, reason: 'no_free_remaining', fromUid };
      }

      const toData = toSnap.exists ? (toSnap.data() || {}) : {};

      const toFree = toData.freeCredits || {};
      const toFreeGenerate = Number(toFree.generate) || 0;
      const toFreeDownload = Number(toFree.download) || 0;

      const newToFreeGenerate = toFreeGenerate + Math.max(0, fromFreeGenerate);
      const newToFreeDownload = toFreeDownload + Math.max(0, fromFreeDownload);

      // Remove from old uid
      tx.set(
        fromUserRef,
        {
          // Clear legacy trial field to avoid double-counting
          trialCreditsRemaining: 0,
          freeCredits: {
            ...(fromData.freeCredits || {}),
            generate: 0,
            download: 0,
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
            ...(toData.freeCredits || {}),
            generate: newToFreeGenerate,
            download: newToFreeDownload,
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
        restored: fromFreeGenerate + fromFreeDownload,
        restoredFreeCredits: { generate: fromFreeGenerate, download: fromFreeDownload },
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
