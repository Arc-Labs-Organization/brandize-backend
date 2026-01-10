const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const functions = require('firebase-functions');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

try {
  if (!admin.apps.length) {
    admin.initializeApp();
  }
} catch (e) {
  // ignore re-init in emulator hot-reload
}

const db = getFirestore();

/**
 * verifyAppleDeviceTrial
 * Callable Cloud Function (Gen 2) to verify an Apple DeviceCheck token
 * and grant a one-time free trial per device.
 *
 * Requirements:
 * - Secrets: APPLE_PRIVATE_KEY (p8 content)
 * - Config: functions.config().apple.key_id, functions.config().apple.team_id
 */
const verifyAppleDeviceTrial = onCall({
  region: 'europe-west1',
  // Declare secret for Gen 2; still read via process.env
  secrets: ['APPLE_PRIVATE_KEY'],
}, async (request) => {
  const context = request;

  // Enforce authentication
  if (!context.auth || !context.auth.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = context.auth.uid;
  const inputToken = request.data && request.data.inputToken;

  if (!inputToken || typeof inputToken !== 'string') {
    throw new HttpsError('invalid-argument', 'Missing or invalid "inputToken".');
  }

  // Load Apple credentials
  const cfg = functions.config() || {};
  const keyId = (cfg.apple && cfg.apple.key_id) || process.env.APPLE_KEY_ID; // fallback if set via env
  const teamId = (cfg.apple && cfg.apple.team_id) || process.env.APPLE_TEAM_ID; // fallback if set via env
  const privateKey = process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n');

  if (!keyId || !teamId || !privateKey) {
    console.error('Apple config missing', { hasKeyId: !!keyId, hasTeamId: !!teamId, hasPrivateKey: !!privateKey });
    throw new HttpsError('failed-precondition', 'Apple DeviceCheck configuration missing.');
  }

  // Create JWT for Apple DeviceCheck (ES256)
  const iatSeconds = Math.floor(Date.now() / 1000);
  let authToken;
  try {
    authToken = jwt.sign(
      { iss: teamId, iat: iatSeconds },
      privateKey,
      {
        algorithm: 'ES256',
        header: { alg: 'ES256', kid: keyId },
      },
    );
  } catch (e) {
    console.error('JWT sign error:', e);
    throw new HttpsError('internal', 'Failed to generate Apple auth token.');
  }

  const headers = {
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
  };

  // Dynamic Apple DeviceCheck base URL (config/env with safe default)
  const appleCfg = (cfg.apple || {});
  const rawBaseUrl = appleCfg.devicecheck_base_url || process.env.APPLE_DEVICECHECK_BASE_URL || 'https://api.devicecheck.apple.com';
  const baseUrl = String(rawBaseUrl).replace(/\/+$/, ''); // trim trailing slashes
  const queryUrl = `${baseUrl}/v1/query_two_bits`;
  const updateUrl = `${baseUrl}/v1/update_two_bits`;

  // Step 1: Query two bits
  const transactionId1 = uuidv4();
  let bit0Val = 0;
  let bit1Val = 0;
  try {
    const queryResp = await axios.post(
      queryUrl,
      {
        device_token: inputToken,
        transaction_id: transactionId1,
        timestamp: Date.now(),
      },
      { headers },
    );

    const data = queryResp && queryResp.data ? queryResp.data : {};
    // Attempt to normalize possible response shapes
    if (typeof data.bit0 !== 'undefined') {
      bit0Val = Number(data.bit0) || 0;
    } else if (data.bitStates && typeof data.bitStates.first !== 'undefined') {
      bit0Val = data.bitStates.first ? 1 : 0;
    }

    if (typeof data.bit1 !== 'undefined') {
      bit1Val = Number(data.bit1) || 0;
    } else if (data.bitStates && typeof data.bitStates.second !== 'undefined') {
      bit1Val = data.bitStates.second ? 1 : 0;
    }
  } catch (e) {
    const status = e.response && e.response.status;
    const body = e.response && e.response.data;
    console.error('Apple query_two_bits error:', { status, body, error: e.message });
    throw new HttpsError('internal', 'Failed to query device trial state.');
  }

  // If already claimed on device
  if (bit0Val === 1) {
    throw new HttpsError('permission-denied', 'Trial already claimed on this device');
  }

  // Step 2: Grant trial credits
  try {
    const userRef = db.collection('users').doc(uid);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const exists = snap.exists;
      const incrementBy = 50;

      if (!exists) {
        tx.set(userRef, {
          hasClaimedTrial: true,
          credits: incrementBy,
          createdAt: FieldValue.serverTimestamp(),
          lastUsedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      } else {
        tx.update(userRef, {
          hasClaimedTrial: true,
          credits: FieldValue.increment(incrementBy),
          lastUsedAt: FieldValue.serverTimestamp(),
        });
      }
    });
  } catch (e) {
    console.error('Firestore grant error:', e);
    throw new HttpsError('internal', 'Failed to grant trial credits.');
  }

  // Step 3: Update two bits (mark bit0 true)
  const transactionId2 = uuidv4();
  try {
    await axios.post(
      updateUrl,
      {
        device_token: inputToken,
        transaction_id: transactionId2,
        timestamp: Date.now(),
        bit0: true,
        bit1: false,
      },
      { headers },
    );
  } catch (e) {
    const status = e.response && e.response.status;
    const body = e.response && e.response.data;
    console.error('Apple update_two_bits error:', { status, body, error: e.message });
    // Do not revoke credits; report but return success as credits already granted.
    return { ok: true, creditsGranted: 50, note: 'Credits granted; device state update failed.' };
  }

  return { ok: true, creditsGranted: 50 };
});

module.exports = { verifyAppleDeviceTrial };
