const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { SUBSCRIPTION_TIERS, ENTITLEMENT_TO_TIER } = require('../common/subscriptionConfig');

const db = getFirestore();

const REVENUECAT_WEBHOOK_AUTH = defineSecret('REVENUECAT_WEBHOOK_AUTH');

/**
 * Handle RevenueCat Webhooks
 * POST /revenueCatWebhook
 */
const revenueCatWebhook = onRequest(
  {
    region: 'europe-west1',
    secrets: [REVENUECAT_WEBHOOK_AUTH],
    // No CORS needed for server-to-server webhooks
  },
  async (req, res) => {
    // 1. Security Check
    const authHeader = req.headers.authorization;
    if (authHeader !== REVENUECAT_WEBHOOK_AUTH.value()) {
      console.warn('Unauthorized webhook attempt');
      return res.status(401).send('Unauthorized');
    }


    const event = req.body && req.body.event;
    if (!event) {
      return res.status(400).send('No event body');
    }

    const { type, app_user_id, product_id, entitlement_ids, expiration_at_ms } = event;

    if (!app_user_id) {
        console.log('No app_user_id in event, skipping');
        return res.status(200).send('Skipped');
    }

    console.log(`Received RevenueCat event: ${type} for user: ${app_user_id}`);

    // Map RevenueCat Entitlement to our Tier
    // RevenueCat events usually include entitlement_ids array. 
    // We pick the highest value one if multiple exist, but usually it's single for this app.
    let tier = 'free';
    if (entitlement_ids && entitlement_ids.length > 0) {
        // Simple priority check: max > pro > starter
        if (entitlement_ids.includes('max')) tier = 'max';
        else if (entitlement_ids.includes('pro')) tier = 'pro';
        else if (entitlement_ids.includes('starter')) tier = 'starter';
    } 
    // Helper: If no entitlement_ids in event (rare), try to guess from product_id
    else if (product_id) {
        if (product_id.includes('max')) tier = 'max';
        else if (product_id.includes('pro')) tier = 'pro';
        else if (product_id.includes('starter')) tier = 'starter';
    }

    const userRef = db.collection('users').doc(app_user_id);
    const tierConfig = SUBSCRIPTION_TIERS[tier] || SUBSCRIPTION_TIERS['free'];

    try {
        if (type === 'TEST') {
             // RevenueCat sends a TEST event on setup
             return res.status(200).send('Test received');
        }

        // Handle Events
        if (['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE'].includes(type) && tier !== 'free') {
            console.log(`Activating subscription for ${app_user_id} at tier ${tier}`);
            
            // Reset monthly usage on renewal/purchase
            await userRef.set({
                subscription: {
                    status: tier,
                    isActive: true,
                    currentPeriodEnd: expiration_at_ms ? Timestamp.fromMillis(expiration_at_ms) : null,
                    provider: 'revenuecat',
                    lastUpdated: FieldValue.serverTimestamp(),
                },
                monthlyAllowance: {
                    downloadLimit: tierConfig.downloadLimit,
                    generateLimit: tierConfig.generateLimit,
                    downloadsUsed: 0, // RESET
                    generationsUsed: 0, // RESET
                }
            }, { merge: true });

        } else if (['CANCELLATION', 'EXPIRATION'].includes(type)) {
             // Check if it's really expired or just user disabled auto-renew (CANCELLATION usually means auto-renew off)
             // EXPIRATION is the real "access lost" event usually.
             // BUT RevenueCat "CANCELLATION" event often means "Auto-renew turned off", access continues until expiration.
             // We should check expiration_at_ms. If it's in the future, don't kill access yet.
             
             const now = Date.now();
             const expirationTime = expiration_at_ms || 0;
             const isStillActive = expirationTime > now;

             console.log(`Subscription ${type} for ${app_user_id}. Still active? ${isStillActive}`);

             if (!isStillActive) {
                 await userRef.set({
                     subscription: {
                         isActive: false,
                         lastUpdated: FieldValue.serverTimestamp(),
                     },
                     // We do NOT reset usage stats here, just limits effectively become 0 via isActive check in code,
                     // or we can set status to free directly.
                     // Let's set status 'free' to be safe.
                     subscription: {
                        status: 'free',
                        isActive: false,
                     }
                 }, { merge: true });
             } else {
                 // Update metadata (e.g. auto renew status) but keep access
                 // We rely on the existing currentPeriodEnd
                 await userRef.set({
                    subscription: {
                        status: tier, // Keep existing tier
                        isActive: true, // Still active until period end
                        // Don't change limits or usage
                    }
                 }, { merge: true });
             }
        }

        return res.status(200).send('OK');

    } catch (error) {
        console.error('Error processing webhook:', error);
        return res.status(500).send('Error');
    }
  }
);

module.exports = { revenueCatWebhook };
