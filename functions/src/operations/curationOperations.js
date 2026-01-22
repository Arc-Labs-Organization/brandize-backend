const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { randomUUID } = require('crypto');
const { logError, normalizeUnknownError, sendError, unauthenticated } = require('../common/errors');

try {
  if (!admin.apps.length) {
    admin.initializeApp();
  }
} catch (e) {
  // ignore
}

const db = getFirestore();
const bucket = admin.storage().bucket();
const FREEPIK_API_KEY = defineSecret('FREEPIK_API_KEY');

const TEMPLATE_QUERIES = {
    story: { query: 'gradient instagram story', limit: 10 },
    post: { query: 'creative instagram post', limit: 10 },
    poster: { query: 'creative poster', limit: 10 },
    businessCard: { query: 'colorful business card', limit: 10 },
    flyer: { query: 'modern-flyer', limit: 10 },
    invitation: { query: 'invitation', limit: 10 },
    banner: { query: 'creative social media banner', limit: 10 },
    youtube: { query: 'creative youtube thumbnail', limit: 10 },
    clothModels: { query: 'fashion model', limit: 10 },
    modelsWithProduct: { query: 'model holding product', limit: 10 },
    productMockup: { query: 'product mockup', limit: 10 },
    musicAlbumCover: { query: 'music album cover', limit: 10 },
};

async function downloadAndUploadImage(imageUrl, storagePath) {
    try {
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);
        
        const buffer = Buffer.from(await response.arrayBuffer());
        const file = bucket.file(storagePath);
        const token = randomUUID();
        
        await file.save(buffer, {
            resumable: false,
            metadata: {
                contentType: 'image/jpeg', // Assuming jpeg for thumbnails usually
                cacheControl: 'public, max-age=31536000',
                metadata: {
                    firebaseStorageDownloadTokens: token,
                }
            }
        });

        // Construct public URL
        return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
    } catch (error) {
        console.error(`Error processing image ${imageUrl}:`, error);
        return null;
    }
}

/**
 * Manually triggered function to refresh home page templates.
 * Scrapes Freepik, saves images to Storage, updates Firestore.
 * GET /refreshHomeTemplates
 */
exports.refreshHomeTemplates = onRequest(
    {
        region: 'europe-west1',
        timeoutSeconds: 540, // 9 minutes max
        memory: '1GiB',
        secrets: [FREEPIK_API_KEY],
    },
    async (req, res) => {
        const requestId = randomUUID();
        
        try {
            // Optional: Add simple auth check if needed, e.g. check for a query secret or Admin auth
            // For now allowing it as a utility function
            
            const results = {};
            const cats = Object.keys(TEMPLATE_QUERIES);

            // Process categories sequentially to avoid rate limits or memory bursts
            for (const category of cats) {
                const config = TEMPLATE_QUERIES[category];
                console.log(`Processing category: ${category} with query "${config.query}"`);
                
                // 1. Search Freepik
                const apiUrl = new URL('https://api.freepik.com/v1/resources');
                apiUrl.searchParams.set('term', config.query);
                apiUrl.searchParams.set('page', '1');
                apiUrl.searchParams.set('limit', String(config.limit));
                
                const apiKey = process.env.FREEPIK_API_KEY.trim();
                const fpResp = await fetch(apiUrl.toString(), {
                    method: 'GET',
                    headers: {
                        'x-freepik-api-key': apiKey,
                        'Accept-Language': 'en-US'
                    }
                });

                if (!fpResp.ok) {
                    console.error(`Freepik API failed for ${category}: ${fpResp.status}`);
                    results[category] = { error: `API error ${fpResp.status}` };
                    continue;
                }

                const json = await fpResp.json();
                const items = json.data || [];
                const processedItems = [];

                // 2. Process each item
                for (const item of items) {
                    // Find largest preview that isn't too huge
                    const previewUrl = item.image?.source?.url || item.image?.url || item.thumbnail;
                    
                    if (!previewUrl) continue;

                    const filename = `${item.id}.jpg`;
                    const storagePath = `home_page_thumbnails/${category}/${filename}`;
                    
                    // Check if we already have it to avoid re-downloading (Optional optimization)
                    // For refresh, we might want to overwrite or check existence. 
                    // Let's just overwrite to ensure freshness/token validity, or check exists.
                    // To keep it simple and robust: Just download and upload.
                    
                    const publicUrl = await downloadAndUploadImage(previewUrl, storagePath);
                    
                    if (publicUrl) {
                        processedItems.push({
                            id: String(item.id),
                            title: item.title,
                            image: { uri: publicUrl },
                            original_freepik_url: previewUrl,
                            freepik_resource_id: item.id
                        });
                    }
                }

                // 3. Save to Firestore
                // We overwrite the category document in 'home_templates' collection
                await db.collection('home_templates').doc(category).set({
                    items: processedItems,
                    lastUpdated: FieldValue.serverTimestamp(),
                    query: config.query
                });

                results[category] = { count: processedItems.length };
                console.log(`Saved ${processedItems.length} items for ${category}`);
                
                 // Small delay to be nice to API
                 await new Promise(r => setTimeout(r, 500));
            }

            return res.status(200).json({ 
                success: true, 
                message: "Home page templates refreshed",
                details: results 
            });

        } catch (err) {
            console.error('refreshHomeTemplates failed:', err);
            const appErr = normalizeUnknownError(err);
            logError({ requestId, endpoint: 'refreshHomeTemplates', err: appErr });
            return sendError(res, appErr, requestId);
        }
    }
);
