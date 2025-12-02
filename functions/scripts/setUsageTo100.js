/*
  Batch script to set all users' remainingUsage to 100 for both download and generate.

  Usage (from functions dir):
    node scripts/setUsageTo100.js
    DRY_RUN=1 node scripts/setUsageTo100.js   # shows what would change

  Notes:
  - Requires Firebase Admin credentials. Locally, set GOOGLE_APPLICATION_CREDENTIALS to your service account JSON.
  - Safe to re-run. It will upsert the remainingUsage fields.
*/
'use strict';

try {
  require('dotenv').config({ path: '.env.local' });
  require('dotenv').config();
} catch (_) {}

const admin = require('firebase-admin');

function init() {
  try {
    if (!admin.apps.length) {
      admin.initializeApp();
    }
  } catch (e) {
    // ignore hot-reload reinit
  }
}

async function main() {
  init();
  const db = admin.firestore();
  const dryRun = Boolean(process.env.DRY_RUN);

  const pageSize = 500;
  let lastDoc = null;
  let total = 0;
  let page = 0;

  console.log(`[setUsageTo100] Starting. DRY_RUN=${dryRun}`);

  while (true) {
    let q = db.collection('users').orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);
    if (lastDoc) q = q.startAfter(lastDoc.id);
    const snap = await q.get();
    if (snap.empty) break;

    page += 1;
    const batch = db.batch();

    snap.docs.forEach((doc) => {
      const ref = doc.ref;
      const data = doc.data() || {};
      const current = (data.remainingUsage || {});
      const next = {
        download: 100,
        generate: 100,
      };
      if (dryRun) {
        console.log(`Would update user ${ref.id}:`, { from: current, to: next });
      } else {
        batch.set(ref, { remainingUsage: next }, { merge: true });
      }
    });

    if (!dryRun) await batch.commit();

    total += snap.size;
    lastDoc = snap.docs[snap.docs.length - 1];
    console.log(`[setUsageTo100] Processed page ${page}, total ${total}`);

    if (snap.size < pageSize) break; // done
  }

  console.log(`[setUsageTo100] Completed. Users touched: ${total}`);
}

main().catch((e) => {
  console.error('[setUsageTo100] Failed:', e && e.stack || e);
  process.exit(1);
});
