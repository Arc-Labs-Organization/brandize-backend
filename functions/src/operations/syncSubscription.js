const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { verifyAuth } = require('../common/utils');
const { SUBSCRIPTION_TIERS, ENTITLEMENT_TO_TIER } = require('../common/subscriptionConfig');
const axios = require('axios');

const db = getFirestore();

const REVENUECAT_SECRET_KEY = defineSecret('REVENUECAT_SECRET_KEY');

/**
 * Manually sync subscription status from RevenueCat to Firestore
 * Callable Function
 */
const syncSubscription = onCall(
  {
    region: 'europe-west1',
    secrets: [REVENUECAT_SECRET_KEY],
  },
  async (request) => {
    // 1. Auth Check - user must be logged in
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'User must be logged in.');
    }
    const uid = request.auth.uid;

    try {
      // 2. Fetch from RevenueCat API
      const response = await axios.get(`https://api.revenuecat.com/v1/subscribers/${uid}`, {
        headers: {
            'Authorization': `Bearer ${REVENUECAT_SECRET_KEY.value()}`,
            'Content-Type': 'application/json',
            'X-Platform': 'firebase'
        }
      });

      const subscriber = response.data && response.data.subscriber;
      if (!subscriber) {
          throw new HttpsError('internal', 'Invalid response from RevenueCat');
      }

      // 3. Determine Active Entitlement
      const entitlements = subscriber.entitlements;
      let activeTier = 'free';
      let activeEntitlementInfo = null;

      // Check priorities: Max > Pro > Starter
      if (entitlements.active['max']) {
          activeTier = 'max';
          activeEntitlementInfo = entitlements.active['max'];
      } else if (entitlements.active['pro']) {
          activeTier = 'pro';
          activeEntitlementInfo = entitlements.active['pro'];
      } else if (entitlements.active['starter']) {
          activeTier = 'starter';
          activeEntitlementInfo = entitlements.active['starter'];
      }

      const originalAppUserId = subscriber.original_app_user_id;
      
      // Get stable identifier for the subscription chain (Original Purchase Date)
      // This persists even if 'original_app_user_id' changes due to Transfer behavior.
      let subscriptionFingerprint = null;
      if (activeEntitlementInfo) {
          const productId = activeEntitlementInfo.product_identifier;
          if (productId && subscriber.subscriptions && subscriber.subscriptions[productId]) {
              subscriptionFingerprint = subscriber.subscriptions[productId].original_purchase_date;
          }
      }

      // 4. Update Firestore
      const userRef = db.collection('users').doc(uid);
      const userDoc = await userRef.get();
      const userData = userDoc.exists ? userDoc.data() : {};
      
      const currentSubscription = userData.subscription || {};
      const currentPeriodEnd = currentSubscription.currentPeriodEnd 
        ? currentSubscription.currentPeriodEnd.toDate().getTime() 
        : 0;

      // Extract new expiration
      let newPeriodEndMs = 0;
      if (activeEntitlementInfo && activeEntitlementInfo.expires_date) {
         newPeriodEndMs = new Date(activeEntitlementInfo.expires_date).getTime();
      }

      // Check for carried over usage (Anti-Exploit)
      // We look for other users with the same subscription fingerprint (Original Purchase Date).
      let carriedOverDownloads = 0;
      let carriedOverGenerations = 0;

      if (subscriptionFingerprint && newPeriodEndMs > 0 && activeTier !== 'free') {
          try {
              const duplicatesSnapshot = await db.collection('users')
                .where('subscription.fingerprint', '==', subscriptionFingerprint)
                .get();
              
              if (!duplicatesSnapshot.empty) {
                  duplicatesSnapshot.forEach(doc => {
                     if (doc.id === uid) return; // Skip self
                     
                     const d = doc.data();
                     const sub = d.subscription || {};
                     const pEnd = sub.currentPeriodEnd ? sub.currentPeriodEnd.toDate().getTime() : 0;
                     
                     // If expiration matches closely (same billing period)
                     // We use a 12h buffer to account for minor time sync differences/server processing time
                     if (Math.abs(pEnd - newPeriodEndMs) < 1000 * 60 * 60 * 12) {
                         const uDl = (d.monthlyAllowance && d.monthlyAllowance.downloadsUsed) || 0;
                         const uGen = (d.monthlyAllowance && d.monthlyAllowance.generationsUsed) || 0;
                         if (uDl > carriedOverDownloads) carriedOverDownloads = uDl;
                         if (uGen > carriedOverGenerations) carriedOverGenerations = uGen;
                     }
                  });
              }
              if (carriedOverDownloads > 0 || carriedOverGenerations > 0) {
                  console.log(`[Anti-Exploit] Found existing usage for Fingerprint ${subscriptionFingerprint}: DL=${carriedOverDownloads}, GEN=${carriedOverGenerations}`);
              }
          } catch (err) {
              console.error('Error checking duplicate usage:', err);
          }
      }

      const tierConfig = SUBSCRIPTION_TIERS[activeTier];
      const updateData = {
          'subscription.lastSyncedAt': FieldValue.serverTimestamp(),
          'subscription.provider': 'revenuecat',
          'subscription.revenueCatId': originalAppUserId || FieldValue.delete(),
          'subscription.fingerprint': subscriptionFingerprint || FieldValue.delete(),
      };

      // Check if we need to reset usage logic
      // Reset if:
      // A) It is a new billing period (new expiration > old expiration)
      // B) User upgraded tier (activeTier changed and is not free) 
      
      const isNewPeriod = newPeriodEndMs > (currentPeriodEnd + 1000 * 60 * 60); // 1 hour buffer
      const wasInactive = !currentSubscription.isActive || currentSubscription.status === 'free';
      
      if (activeTier !== 'free' && (isNewPeriod || wasInactive)) {
          // RESET COUNTERS (or Apply Carried Over)
          updateData['subscription.status'] = activeTier;
          updateData['subscription.isActive'] = true;
          updateData['subscription.currentPeriodEnd'] = admin.firestore.Timestamp.fromMillis(newPeriodEndMs);
          
          updateData['monthlyAllowance.downloadLimit'] = tierConfig.downloadLimit;
          updateData['monthlyAllowance.generateLimit'] = tierConfig.generateLimit;
          
          updateData['monthlyAllowance.downloadsUsed'] = carriedOverDownloads;
          updateData['monthlyAllowance.generationsUsed'] = carriedOverGenerations;
          
          console.log(`Sync for ${uid}: New Period/Upgrade detected. Limits: ${tierConfig.downloadLimit}, Usage: ${carriedOverDownloads}/${carriedOverGenerations}`);
      } else if (activeTier !== 'free') {
          // Active, but same period. Just ensure limits match tier (in case of config change) but DO NOT reset usage.
          updateData['subscription.status'] = activeTier;
          updateData['subscription.isActive'] = true;
          // update expiration just in case
          updateData['subscription.currentPeriodEnd'] = admin.firestore.Timestamp.fromMillis(newPeriodEndMs);
          
          updateData['monthlyAllowance.downloadLimit'] = tierConfig.downloadLimit;
          updateData['monthlyAllowance.generateLimit'] = tierConfig.generateLimit;
          // Do NOT touch downloadsUsed/generationsUsed
          console.log(`Sync for ${uid}: Active within same period. Updating metadata only.`);
      } else {
          // Expired / Free
          updateData['subscription.status'] = 'free';
          updateData['subscription.isActive'] = false;
          console.log(`Sync for ${uid}: No active subscription found.`);
      }

      await userRef.update(updateData);

      return { success: true, tier: activeTier };

    } catch (error) {
      console.error('Sync Subscription Error:', error);
      // RevenueCat 404 means user never purchased anything -> treat as free
      if (axios.isAxiosError(error) && error.response && error.response.status === 404) {
          // User exists in Firebase but not in RC?
          await db.collection('users').doc(uid).update({
              'subscription.status': 'free',
              'subscription.isActive': false
          });
          return { success: true, tier: 'free' };
      }
      throw new HttpsError('internal', 'Unable to sync subscription.');
    }
  }
);

module.exports = { syncSubscription };
