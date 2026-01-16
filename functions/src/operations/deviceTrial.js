const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { defineSecret, defineString } = require('firebase-functions/params');
const crypto = require('crypto');

try {
  if (!admin.apps.length) {
    admin.initializeApp();
  }
} catch (e) {
  // ignore re-init in emulator hot-reload
}

const db = getFirestore();

function normalizePemPrivateKey(raw) {
  const asString = String(raw ?? '');
  if (!asString) return asString;

  // If secret was pasted with literal "\n", convert to actual newlines.
  let key = asString.replace(/\\n/g, '\n').trim();

  // If it's a PEM but collapsed to one line, reformat it.
  const beginMarker = '-----BEGIN PRIVATE KEY-----';
  const endMarker = '-----END PRIVATE KEY-----';
  const hasMarkers = key.includes(beginMarker) && key.includes(endMarker);
  const hasAnyNewlines = key.includes('\n') || key.includes('\r');

  if (hasMarkers && !hasAnyNewlines) {
    const body = key
      .replace(beginMarker, '')
      .replace(endMarker, '')
      .replace(/\s+/g, '');
    const wrapped = body.match(/.{1,64}/g)?.join('\n') ?? body;
    key = `${beginMarker}\n${wrapped}\n${endMarker}`;
  }

  return key;
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

// Params (non-secret). These replace functions.config() (deprecated March 2026).
const APPLE_KEY_ID = defineSecret('APPLE_KEY_ID');
const APPLE_TEAM_ID = defineSecret('APPLE_TEAM_ID');
// Hardcoded to development endpoint for now.
const APPLE_DEVICECHECK_BASE_URL = 'https://api.development.devicecheck.apple.com';

//Use the base URL shown in the example curl commands—that is, https://api.development.devicecheck.apple.com—only for testing during development. 
// When you’re ready to transition to a production environment, you must use the production base URL https://api.devicecheck.apple.com. 

// Secret (p8 content)
const APPLE_PRIVATE_KEY = defineSecret('APPLE_PRIVATE_KEY');

/**
 * verifyAppleDeviceTrial
 * Callable Cloud Function (Gen 2) to verify an Apple DeviceCheck token
 * and grant a one-time free trial per device.
 *
 * Requirements:
 * - Secret: APPLE_PRIVATE_KEY (p8 content)
 * - Params: APPLE_KEY_ID, APPLE_TEAM_ID, APPLE_DEVICECHECK_BASE_URL
 */
const verifyAppleDeviceTrial = onCall({
  region: 'europe-west1',
  secrets: [APPLE_PRIVATE_KEY, APPLE_KEY_ID, APPLE_TEAM_ID],
}, async (request) => {
  const requestId = crypto.randomUUID();
  const context = request;
  const startedAt = Date.now();
  const trace =
    (context.rawRequest && context.rawRequest.headers && (context.rawRequest.headers['x-cloud-trace-context'] || context.rawRequest.headers['X-Cloud-Trace-Context'])) ||
    undefined;
  const traceId = typeof trace === 'string' ? trace.split('/')[0] : undefined;

  // Enforce authentication
  if (!context.auth || !context.auth.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = context.auth.uid;
  const inputToken = request.data && request.data.inputToken;
  const restoreId = request.data && request.data.restoreId;

  logger.info('verifyAppleDeviceTrial:start', {
    uid,
    requestId,
    traceId,
    hasInputToken: typeof inputToken === 'string' && inputToken.length > 0,
    inputTokenLen: typeof inputToken === 'string' ? inputToken.length : 0,
    hasRestoreId: typeof restoreId === 'string' && restoreId.length > 0,
  });

  if (!inputToken || typeof inputToken !== 'string') {
    throw new HttpsError('invalid-argument', 'Missing or invalid "inputToken".');
  }

  // Load Apple credentials
  const keyId = APPLE_KEY_ID.value();
  const teamId = APPLE_TEAM_ID.value();
  const rawPrivateKey = APPLE_PRIVATE_KEY.value();

  if (!keyId || !teamId || !rawPrivateKey) {
    logger.error('verifyAppleDeviceTrial:apple_config_missing', {
      uid,
      traceId,
      hasKeyId: !!keyId,
      hasTeamId: !!teamId,
      hasPrivateKey: !!rawPrivateKey,
    });
    throw new HttpsError('failed-precondition', 'Apple DeviceCheck configuration missing.');
  }

  const privateKey = normalizePemPrivateKey(rawPrivateKey);

  // Create JWT for Apple DeviceCheck (ES256)
  const iatSeconds = Math.floor(Date.now() / 1000);
  const expSeconds = iatSeconds + (20 * 60); // 20 minutes
  let authToken;
  try {
    authToken = jwt.sign(
      { iss: teamId, iat: iatSeconds, exp: expSeconds },
      privateKey,
      {
        algorithm: 'ES256',
        header: { alg: 'ES256', kid: keyId },
      },
    );
  } catch (e) {
    logger.error('verifyAppleDeviceTrial:jwt_sign_error', {
      uid,
      traceId,
      message: e && e.message,
      stack: e && e.stack,
    });
    throw new HttpsError('internal', 'Failed to generate Apple auth token.');
  }

  const headers = {
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
  };

  // Apple DeviceCheck base URL
  const rawBaseUrl = APPLE_DEVICECHECK_BASE_URL;
  const baseUrl = String(rawBaseUrl).trim().replace(/\/+$/, ''); // trim trailing slashes
  const queryUrl = `${baseUrl}/v1/query_two_bits`;
  const updateUrl = `${baseUrl}/v1/update_two_bits`;

  logger.info('verifyAppleDeviceTrial:apple_endpoints', {
    uid,
    requestId,
    traceId,
    baseUrl,
  });

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

    logger.info('verifyAppleDeviceTrial:query_two_bits_ok', {
      uid,
      traceId,
      transactionId: transactionId1,
      bit0: bit0Val,
      bit1: bit1Val,
      status: queryResp && queryResp.status,
    });
  } catch (e) {
    const status = e.response && e.response.status;
    const body = e.response && e.response.data;
    logger.error('verifyAppleDeviceTrial:query_two_bits_error', {
      uid,
      requestId,
      traceId,
      transactionId: transactionId1,
      status,
      body,
      message: e && e.message,
    });
    // Map provider errors to more specific codes
    const isTimeout = e.code === 'ECONNABORTED' || /timeout/i.test(String(e.message || ''));
    if (isTimeout) {
      throw new HttpsError('deadline-exceeded', 'Apple DeviceCheck timeout.');
    }
    if (status === 401 || status === 403) {
      throw new HttpsError('failed-precondition', 'Apple DeviceCheck authentication or permission error.');
    }
    if (status >= 500) {
      throw new HttpsError('unavailable', 'Apple DeviceCheck service unavailable.');
    }
    throw new HttpsError('internal', 'Failed to query device trial state.');
  }

  // If already claimed on device
  if (bit0Val === 1) {
    logger.info('verifyAppleDeviceTrial:already_claimed_device', { uid, traceId });
    throw new HttpsError('permission-denied', 'Trial already claimed on this device');
  }

  // If bit1 is set, treat as "in progress" / locked to reduce double-claims.
  if (bit1Val === 1) {
    logger.info('verifyAppleDeviceTrial:already_in_progress', { uid, traceId });
    throw new HttpsError('permission-denied', 'Trial claim already in progress on this device');
  }

  // Step 2: Acquire lock using bit1=true (best-effort race reduction)
  try {
    await axios.post(
      updateUrl,
      {
        device_token: inputToken,
        transaction_id: uuidv4(),
        timestamp: Date.now(),
        bit0: false,
        bit1: true,
      },
      { headers },
    );

    logger.info('verifyAppleDeviceTrial:lock_acquired', { uid, requestId, traceId });
  } catch (e) {
    const status = e.response && e.response.status;
    const body = e.response && e.response.data;
    logger.error('verifyAppleDeviceTrial:lock_error', {
      uid,
      requestId,
      traceId,
      status,
      body,
      message: e && e.message,
    });
    const isTimeout = e.code === 'ECONNABORTED' || /timeout/i.test(String(e.message || ''));
    if (isTimeout) {
      throw new HttpsError('deadline-exceeded', 'Apple DeviceCheck timeout during lock.');
    }
    if (status === 401 || status === 403) {
      throw new HttpsError('failed-precondition', 'Apple DeviceCheck authentication or permission error.');
    }
    if (status >= 500) {
      throw new HttpsError('unavailable', 'Apple DeviceCheck service unavailable.');
    }
    throw new HttpsError('internal', 'Failed to reserve device trial state.');
  }

  // Step 3: Grant trial credits (idempotent per uid)
  // Grant into dedicated freeCredits fields (NOT remainingUsage/AI credits)
  const grant = { generate: 3, download: 3 };
  let creditsGrantedTotal = 0;
  let freeCreditsGranted = { generate: 0, download: 0 };
  let alreadyClaimedForUid = false;
  try {
    const userRef = db.collection('users').doc(uid);

    const restoreKey =
      typeof restoreId === 'string' && restoreId.length >= 12
        ? crypto.createHash('sha256').update(String(restoreId)).digest('hex')
        : null;
    const restoreRef = restoreKey ? db.collection('deviceRestores').doc(restoreKey) : null;

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const exists = snap.exists;
      const data = snap.data() || {};
      const alreadyClaimed = data.hasClaimedTrial === true;

      if (alreadyClaimed) {
        alreadyClaimedForUid = true;
        creditsGrantedTotal = 0;
        freeCreditsGranted = { generate: 0, download: 0 };
        tx.set(userRef, { lastUsedAt: FieldValue.serverTimestamp() }, { merge: true });

        if (restoreRef) {
          tx.set(
            restoreRef,
            {
              lastUid: uid,
              lastSeenAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
        }
        return;
      }

      creditsGrantedTotal = grant.generate + grant.download;
      freeCreditsGranted = grant;

      if (!exists) {
        tx.set(
          userRef,
          {
            hasClaimedTrial: true,
            trialClaimedAt: FieldValue.serverTimestamp(),
            trialProvider: 'devicecheck',
            freeCredits: {
              generateLimit: grant.generate,
              downloadLimit: grant.download,
              downloadsUsed: 0,
              generationsUsed: 0,
            },
            createdAt: FieldValue.serverTimestamp(),
            lastUsedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      } else {
        const freeCredits = data.freeCredits || {};
        const isLegacy =
          freeCredits.generateLimit === undefined && freeCredits.downloadLimit === undefined;

        if (isLegacy) {
          const oldGen = Number(freeCredits.generate);
          const genBase = Number.isFinite(oldGen)
            ? oldGen
            : Number(data.trialCreditsRemaining) || 0;
          const dlBase = Number(freeCredits.download) || 0;

          tx.update(userRef, {
            hasClaimedTrial: true,
            trialClaimedAt: FieldValue.serverTimestamp(),
            trialProvider: 'devicecheck',
            freeCredits: {
              generateLimit: genBase + grant.generate,
              generationsUsed: 0,
              downloadLimit: dlBase + grant.download,
              downloadsUsed: 0,
            },
            trialCreditsRemaining: 0,
            lastUsedAt: FieldValue.serverTimestamp(),
          });
        } else {
          tx.update(userRef, {
            hasClaimedTrial: true,
            trialClaimedAt: FieldValue.serverTimestamp(),
            trialProvider: 'devicecheck',
            'freeCredits.generateLimit': FieldValue.increment(grant.generate),
            'freeCredits.downloadLimit': FieldValue.increment(grant.download),
            lastUsedAt: FieldValue.serverTimestamp(),
          });
        }
      }

      if (restoreRef) {
        tx.set(
          restoreRef,
          {
            firstUid: uid,
            lastUid: uid,
            trialClaimedAt: FieldValue.serverTimestamp(),
            lastSeenAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
    });

    logger.info('verifyAppleDeviceTrial:firestore_grant_ok', {
      uid,
      traceId,
      creditsGrantedTotal,
      grant,
      durationMs: Date.now() - startedAt,
    });
  } catch (e) {
    logger.error('verifyAppleDeviceTrial:firestore_grant_error', {
      uid,
      requestId,
      traceId,
      message: e && e.message,
      stack: e && e.stack,
    });

    // Best-effort: release lock so the device isn't stuck.
    try {
      await axios.post(
        updateUrl,
        {
          device_token: inputToken,
          transaction_id: uuidv4(),
          timestamp: Date.now(),
          bit0: false,
          bit1: false,
        },
        { headers },
      );
    } catch (_) {}

    throw new HttpsError('internal', 'Failed to grant trial credits.');
  }

  // Step 4: Finalize bits (bit0=true, bit1=false)
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
    logger.error('verifyAppleDeviceTrial:finalize_error', {
      uid,
      requestId,
      traceId,
      transactionId: transactionId2,
      status,
      body,
      message: e && e.message,
    });
    // Do not revoke credits; report but return success as credits may already be granted.
    return {
      ok: true,
      creditsGrantedTotal,
      freeCreditsGranted,
      alreadyClaimedForUid,
      note: 'Trial processed; device state finalize failed.',
    };
  }

  logger.info('verifyAppleDeviceTrial:success', {
    uid,
    requestId,
    traceId,
    creditsGrantedTotal,
    durationMs: Date.now() - startedAt,
  });

  return { ok: true, creditsGrantedTotal, freeCreditsGranted, alreadyClaimedForUid };
});

/**
 * resetAppleDeviceTrialDev
 * Dev-only callable to reset Apple DeviceCheck bits for the current device.
 * Only allowed when APPLE_DEVICECHECK_BASE_URL points to the development endpoint.
 */
const resetAppleDeviceTrialDev = onCall(
  {
    region: 'europe-west1',
    secrets: [APPLE_PRIVATE_KEY, APPLE_KEY_ID, APPLE_TEAM_ID],
  },
  async (request) => {
    const requestId = crypto.randomUUID();
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Authentication required.');
    }

    const uid = request.auth.uid;
    const inputToken = request.data && request.data.inputToken;
    const alsoResetFirestore = !!(request.data && request.data.alsoResetFirestore);
    const startedAt = Date.now();

    if (!inputToken || typeof inputToken !== 'string') {
      throw new HttpsError('invalid-argument', 'Missing or invalid "inputToken".');
    }

    const rawBaseUrl = APPLE_DEVICECHECK_BASE_URL;
    const baseUrl = String(rawBaseUrl).trim().replace(/\/+$/, '');
    const isDevEndpoint = baseUrl === 'https://api.development.devicecheck.apple.com';
    if (!isDevEndpoint) {
      throw new HttpsError(
        'failed-precondition',
        'resetAppleDeviceTrialDev is only allowed against the Apple DEVELOPMENT DeviceCheck endpoint.',
      );
    }

    // Load Apple credentials
    const keyId = APPLE_KEY_ID.value();
    const teamId = APPLE_TEAM_ID.value();
    const rawPrivateKey = APPLE_PRIVATE_KEY.value();
    if (!keyId || !teamId || !rawPrivateKey) {
      throw new HttpsError('failed-precondition', 'Apple DeviceCheck configuration missing.');
    }

    const privateKey = normalizePemPrivateKey(rawPrivateKey);

    // Create JWT for Apple DeviceCheck (ES256)
    const iatSeconds = Math.floor(Date.now() / 1000);
    const expSeconds = iatSeconds + (20 * 60);
    let authToken;
    try {
      authToken = jwt.sign(
        { iss: teamId, iat: iatSeconds, exp: expSeconds },
        privateKey,
        {
          algorithm: 'ES256',
          header: { alg: 'ES256', kid: keyId },
        },
      );
    } catch (e) {
      logger.error('resetAppleDeviceTrialDev:jwt_sign_error', {
        uid,
        requestId,
        message: e && e.message,
      });
      throw new HttpsError('internal', 'Failed to generate Apple auth token.');
    }

    const headers = {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    };

    const queryUrl = `${baseUrl}/v1/query_two_bits`;
    const updateUrl = `${baseUrl}/v1/update_two_bits`;
    const tokenHashPrefix = sha256Hex(inputToken).slice(0, 10);

    let before = { bit0: undefined, bit1: undefined };
    try {
      const queryResp = await axios.post(
        queryUrl,
        {
          device_token: inputToken,
          transaction_id: uuidv4(),
          timestamp: Date.now(),
        },
        { headers },
      );
      const data = queryResp?.data ?? {};
      before.bit0 = typeof data.bit0 !== 'undefined' ? Number(data.bit0) || 0 : undefined;
      before.bit1 = typeof data.bit1 !== 'undefined' ? Number(data.bit1) || 0 : undefined;
    } catch (e) {
      logger.warn('resetAppleDeviceTrialDev:query_before_failed', {
        uid,
        requestId,
        tokenHashPrefix,
        status: e?.response?.status,
      });
    }

    try {
      await axios.post(
        updateUrl,
        {
          device_token: inputToken,
          transaction_id: uuidv4(),
          timestamp: Date.now(),
          bit0: false,
          bit1: false,
        },
        { headers },
      );
    } catch (e) {
      logger.error('resetAppleDeviceTrialDev:update_error', {
        uid,
        requestId,
        tokenHashPrefix,
        status: e?.response?.status,
        body: e?.response?.data,
        message: e && e.message,
      });
      throw new HttpsError('internal', 'Failed to reset device trial bits.');
    }

    let firestoreReset = false;
    if (alsoResetFirestore) {
      try {
        await db
          .collection('users')
          .doc(uid)
          .set(
            {
              hasClaimedTrial: false,
              trialClaimedAt: FieldValue.delete(),
              trialProvider: FieldValue.delete(),
              freeCredits: {
                generate: 0,
                download: 0,
              },
              lastUsedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
        firestoreReset = true;
      } catch (e) {
        logger.warn('resetAppleDeviceTrialDev:firestore_reset_failed', {
          uid,
          requestId,
          message: e && e.message,
        });
      }
    }

    logger.info('resetAppleDeviceTrialDev:ok', {
      uid,
      requestId,
      tokenHashPrefix,
      before,
      firestoreReset,
      durationMs: Date.now() - startedAt,
    });

    return { ok: true, before, firestoreReset };
  },
);

module.exports = { verifyAppleDeviceTrial, resetAppleDeviceTrialDev };
