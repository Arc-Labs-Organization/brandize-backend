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

    let { type, app_user_id, product_id, entitlement_ids, expiration_at_ms, transferred_from, transferred_to, store } = event;

    // FIX: For TRANSFER events, app_user_id might be missing. We use the destination user as the primary ID.
    if (type === 'TRANSFER') {
        if (!app_user_id && transferred_to && transferred_to.length > 0) {
            app_user_id = transferred_to[0];
        }
    }

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

        if (type === 'TRANSFER') {
             const fromIds = transferred_from || [];
             // Ensure toId is a string, not an array
             let toId = app_user_id; // defaulted correctly above
             if (Array.isArray(transferred_to) && transferred_to.length > 0) {
                 toId = transferred_to[0];
             } else if (typeof transferred_to === 'string') {
                 toId = transferred_to;
             }

             console.log(`Processing TRANSFER from ${JSON.stringify(fromIds)} to ${toId}`);

             let totalDownloadsUsed = 0;
             let totalGenerationsUsed = 0;
             
             // Track the best subscription found on old users to apply to new user
             let transferredTier = 'free';
             let transferredPeriodEnd = null;

             if (fromIds.length > 0) {
                 for (const oldUid of fromIds) {
                     const oldUserRef = db.collection('users').doc(oldUid);
                     const oldSnap = await oldUserRef.get();
                     if (oldSnap.exists) {
                         const oldData = oldSnap.data();
                         const d = oldData.monthlyAllowance || {};
                         const s = oldData.subscription || {};

                         // Accumulate usage
                         totalDownloadsUsed += (d.downloadsUsed || 0);
                         totalGenerationsUsed += (d.generationsUsed || 0);

                         // Check if this user had a valid subscription to transfer
                         if (s.status && s.status !== 'free' && s.isActive) {
                             // Simple overwrite strategy: If we find a paid tier, use it. 
                             // Realistically only one source user should have an active sub in a merge scenario.
                             if (transferredTier === 'free') { 
                                 transferredTier = s.status;
                                 transferredPeriodEnd = s.currentPeriodEnd;
                             }
                         }

                         // Transfer Subcollections (Images, Brands)
                         await moveUserSubcollection(oldUid, toId, 'downloads');
                         await moveUserSubcollection(oldUid, toId, 'generated');
                         await moveUserSubcollection(oldUid, toId, 'brands');

                         // Disable old user
                         await oldUserRef.set({
                             subscription: {
                                 status: 'free',
                                 isActive: false,
                                 transferredTo: toId,
                                 lastUpdated: FieldValue.serverTimestamp()
                             }
                         }, { merge: true });
                     }
                 }

                 if (totalDownloadsUsed > 0 || totalGenerationsUsed > 0) {
                     console.log(`Transferring usage: DL=${totalDownloadsUsed}, GEN=${totalGenerationsUsed}`);
                     await userRef.set({
                         monthlyAllowance: {
                             downloadsUsed: FieldValue.increment(totalDownloadsUsed),
                             generationsUsed: FieldValue.increment(totalGenerationsUsed)
                         }
                     }, { merge: true });
                 }
             }

             // Apply transferred subscription info if found
             // Note: If the new user ALREADY has a tier from the event (tier !== 'free'), we prefer that. 
             // But usually TRANSFER events don't have entitlement info in them.
             const finalTier = (tier !== 'free') ? tier : transferredTier;

             // Ensure the target user has the correct subscription status
             if (finalTier !== 'free') {
                 const newTierConfig = SUBSCRIPTION_TIERS[finalTier] || SUBSCRIPTION_TIERS['free'];
                 
                 // Determine period end: From event (expiration_at_ms) OR from old user (transferredPeriodEnd)
                 let finalPeriodEnd = null;
                 if (expiration_at_ms) {
                     finalPeriodEnd = Timestamp.fromMillis(expiration_at_ms);
                 } else if (transferredPeriodEnd) {
                     finalPeriodEnd = transferredPeriodEnd;
                 }

                 await userRef.set({
                     subscription: {
                         status: finalTier,
                         isActive: true,
                         currentPeriodEnd: finalPeriodEnd,
                         provider: 'revenuecat',
                         lastUpdated: FieldValue.serverTimestamp(),
                     },
                     monthlyAllowance: {
                         downloadLimit: newTierConfig.downloadLimit,
                         generateLimit: newTierConfig.generateLimit
                         // Do NOT reset usage here, we only incrementally added transferred usage above
                     }
                 }, { merge: true });
             }

             return res.status(200).send('Transfer Processed');
        }

        // Fetch current user state to prevent race conditions (e.g. stale webhooks overwriting new upgrades)
        // We want to ignore events that refer to an expiration timestamp OLDER than what we already have.
        // This commonly happens during upgrades where PRODUCT_CHANGE (old sub end) and INITIAL_PURCHASE (new sub start) arrive concurrently.
        const userSnap = await userRef.get();
        const userData = userSnap.exists ? userSnap.data() : {};
        const currentPeriodEnd = userData.subscription?.currentPeriodEnd?.toMillis() || 0;
        const eventExpiration = expiration_at_ms || 0;

        // PLAY_STORE FIX ONLY: If the event is about a subscription that expires BEFORE our current valid one, ignore it.
        // This assumes that a later expiration date always supersedes an earlier one.
        if (store === 'PLAY_STORE' && eventExpiration > 0 && currentPeriodEnd > 0 && eventExpiration < currentPeriodEnd) {
             console.log(`Ignoring stale event (Exp: ${eventExpiration}) as user has newer subscription (Exp: ${currentPeriodEnd})`);
             return res.status(200).send('Ignored Stale Event');
        }

        // Handle Events
        // For Play Store, we ignore PRODUCT_CHANGE as it typically carries the OLD product info/expiration during an upgrade.
        // We rely on 'INITIAL_PURCHASE' of the NEW product to set the new state.
        const activationEvents = ['INITIAL_PURCHASE', 'RENEWAL'];
        if (store !== 'PLAY_STORE') {
             activationEvents.push('PRODUCT_CHANGE');
        }

        if (activationEvents.includes(type) && tier !== 'free') {
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

/**
 * Helper to move documents from one user's subcollection to another
 * @param {string} sourceUid 
 * @param {string} targetUid 
 * @param {string} collectionName 
 */
async function moveUserSubcollection(sourceUid, targetUid, collectionName) {
    try {
        const sourceRef = db.collection('users').doc(sourceUid).collection(collectionName);
        const targetRef = db.collection('users').doc(targetUid).collection(collectionName);

        // Get documents in batches
        const snapshot = await sourceRef.limit(400).get();
        
        if (snapshot.empty) return;

        const batch = db.batch();
        let count = 0;

        for (const doc of snapshot.docs) {
            const data = doc.data();
            // Preserve ID
            const newDocRef = targetRef.doc(doc.id);
            
            // Meta fields to track history, but keep core data
            batch.set(newDocRef, { 
                ...data, 
                originalOwner: sourceUid, 
                transferredAt: FieldValue.serverTimestamp() 
            });
            batch.delete(doc.ref);
            count++;
        }

        await batch.commit();
        console.log(`Transferred ${count} docs in ${collectionName} from ${sourceUid} to ${targetUid}`);

        // If we hit the limit, recurse to get the rest
        if (count >= 400) {
            await moveUserSubcollection(sourceUid, targetUid, collectionName);
        }

    } catch (error) {
        console.error(`Error transferring subcollection ${collectionName}:`, error);
        // Don't throw, we want to continue partially if possible
    }
}

module.exports = { revenueCatWebhook };
