const { onRequest } = require('firebase-functions/v2/https');
const cors = require('cors')({ origin: true });
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { randomUUID } = require('crypto');
const Busboy = require('busboy');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createMultipartParser } = require('../common/utils');

try {
  if (!admin.apps.length) {
    admin.initializeApp();
  }
} catch (e) {
  // ignore re-init in emulator hot-reload
}

const db = getFirestore();
const bucket = admin.storage().bucket();

exports.addBrand = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 60,
    memory: '512MiB',
    cors: true,
  },
  async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).send('');
    }

    return cors(req, res, async () => {
      if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed. Use POST.' });
      }

      let user_id;
      let brandInfo;
      let logoFile = null;

      try {
        if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
          console.log('Processing multipart request for addBrand');
          const busboy = createMultipartParser(req.headers);
          const fields = {};
          const writes = [];

          await new Promise((resolve, reject) => {
            busboy.on('field', (fieldname, val) => {
              console.log(`Busboy field: ${fieldname}`);
              fields[fieldname] = val;
            });

            busboy.on('file', (fieldname, file, { filename, mimeType }) => {
              console.log(`Busboy file: ${fieldname}, filename: ${filename}, mimeType: ${mimeType}`);
              if (fieldname === 'logo') {
                const filepath = path.join(os.tmpdir(), `logo_${randomUUID()}_${filename}`);
                logoFile = { filepath, filename, mimeType };
                const writeStream = fs.createWriteStream(filepath);
                file.pipe(writeStream);
                writes.push(new Promise((res, rej) => {
                  writeStream.on('finish', res);
                  writeStream.on('error', rej);
                }));
              } else {
                console.log(`Skipping file field: ${fieldname}`);
                file.resume();
              }
            });

            busboy.on('finish', async () => {
              console.log('Busboy finished parsing');
              await Promise.all(writes);
              resolve();
            });

            busboy.on('error', (err) => {
              console.error('Busboy error:', err);
              reject(err);
            });

            if (req.rawBody) {
              console.log('Using req.rawBody for busboy');
              busboy.end(req.rawBody);
            } else {
              console.log('Piping req to busboy');
              req.pipe(busboy);
            }
          });

          user_id = fields.user_id;
          try {
            brandInfo = fields.brandInfo ? JSON.parse(fields.brandInfo) : null;
          } catch (e) {
            return res.status(400).json({ success: false, error: 'Invalid brandInfo JSON' });
          }
        } else {
          console.log('Processing JSON request for addBrand');
          user_id = req.body.user_id;
          brandInfo = req.body.brandInfo;
        }

        if (!user_id || typeof user_id !== 'string') {
          return res.status(400).json({ success: false, error: 'Missing required field: user_id' });
        }
        if (!brandInfo || typeof brandInfo !== 'object') {
          return res.status(400).json({ success: false, error: 'Missing required field: brandInfo' });
        }
        const brandName = (brandInfo.brandName || '').toString().trim();
        if (!brandName) {
          return res
            .status(400)
            .json({ success: false, error: 'Missing required field: brandInfo.brandName' });
        }

        const brandsCol = db.collection('users').doc(user_id).collection('brands');
        const brandRef = brandsCol.doc(); // auto-id

        let logoUrl = null;
        if (logoFile) {
          console.log('Uploading logo file:', logoFile.filepath);
          try {
            const downloadToken = randomUUID();
            const destination = `images/brand_logos/${user_id}/${brandRef.id}/${logoFile.filename}`;
            const [file] = await bucket.upload(logoFile.filepath, {
              destination,
              metadata: {
                contentType: logoFile.mimeType,
                metadata: {
                  firebaseStorageDownloadTokens: downloadToken
                }
              },
            });

            // Try to get signed URL (valid for 1 year)
            try {
              const [url] = await file.getSignedUrl({
                action: 'read',
                expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
              });
              logoUrl = url;
              console.log('Logo uploaded successfully, signed url:', logoUrl);
            } catch (signErr) {
              console.warn('getSignedUrl failed, falling back to token URL:', signErr.message);
              // Fallback to token-based URL
              // Ensure bucket name is correct. If bucket.name is missing, try to infer it or use a placeholder (though it should be there).
              const bName = bucket.name || `${process.env.GCLOUD_PROJECT || 'brandize-101db'}.appspot.com`;
              logoUrl = `https://firebasestorage.googleapis.com/v0/b/${bName}/o/${encodeURIComponent(destination)}?alt=media&token=${downloadToken}`;
              console.log('Logo uploaded successfully, token url:', logoUrl);
            }
          } catch (uploadErr) {
            console.error('Logo upload failed:', uploadErr);
            throw new Error('Failed to upload logo: ' + uploadErr.message);
          } finally {
            fs.unlink(logoFile.filepath, () => {});
          }
        } else {
          console.log('No logo file to upload');
        }

        const nowFields = {
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };
        const docData = {
          brandName,
          website: brandInfo.website ?? null,
          phone: brandInfo.phone ?? null,
          address: brandInfo.address ?? null,
          description: brandInfo.description ?? null,
          colorPalette: Array.isArray(brandInfo.colorPalette) ? brandInfo.colorPalette : [],
          logoUrl: logoUrl || null,
          ...nowFields,
        };

        await brandRef.set(docData);
        return res.status(200).json({ success: true, brandId: brandRef.id, logoUrl });
      } catch (err) {
        console.error('addBrand error:', err);
        if (logoFile) fs.unlink(logoFile.filepath, () => {});
        return res
          .status(500)
          .json({ success: false, error: 'Internal error creating brand', details: String(err?.message || err) });
      }
    });
  },
);

exports.updateBrand = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 60,
    memory: '512MiB',
    cors: true,
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).send('');
    }

    return cors(req, res, async () => {
      if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed. Use POST.' });
      }

      let user_id;
      let brand_id;
      let brandInfo = {};
      let logoFile = null;

      try {
        if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
          const busboy = Busboy({ headers: req.headers });
          const fields = {};
          const writes = [];

          await new Promise((resolve, reject) => {
            busboy.on('field', (fieldname, val) => {
              fields[fieldname] = val;
            });

            busboy.on('file', (fieldname, file, { filename, mimeType }) => {
              if (fieldname === 'logo') {
                const filepath = path.join(os.tmpdir(), `logo_${randomUUID()}_${filename}`);
                logoFile = { filepath, filename, mimeType };
                const writeStream = fs.createWriteStream(filepath);
                file.pipe(writeStream);
                writes.push(new Promise((res, rej) => {
                  writeStream.on('finish', res);
                  writeStream.on('error', rej);
                }));
              } else {
                file.resume();
              }
            });

            busboy.on('finish', async () => {
              await Promise.all(writes);
              resolve();
            });

            busboy.on('error', reject);

            if (req.rawBody) {
              busboy.end(req.rawBody);
            } else {
              req.pipe(busboy);
            }
          });

          user_id = fields.user_id;
          brand_id = fields.brand_id;
          if (fields.brandInfo) {
            try {
              brandInfo = JSON.parse(fields.brandInfo);
            } catch (e) {
              return res.status(400).json({ success: false, error: 'Invalid brandInfo JSON' });
            }
          }
        } else {
          user_id = req.body.user_id;
          brand_id = req.body.brand_id;
          brandInfo = req.body.brandInfo || {};
        }

        if (!user_id || typeof user_id !== 'string') {
          return res.status(400).json({ success: false, error: 'Missing required field: user_id' });
        }
        if (!brand_id || typeof brand_id !== 'string') {
          return res.status(400).json({ success: false, error: 'Missing required field: brand_id' });
        }

        const brandRef = db.collection('users').doc(user_id).collection('brands').doc(brand_id);
        const existing = await brandRef.get();
        if (!existing.exists) {
          if (logoFile) fs.unlink(logoFile.filepath, () => {});
          return res.status(404).json({ success: false, error: 'Brand not found' });
        }

        let logoUrl = undefined;
        if (logoFile) {
          // Delete old logo(s)
          const prefix = `images/brand_logos/${user_id}/${brand_id}/`;
          try {
            const [files] = await bucket.getFiles({ prefix });
            if (files.length > 0) {
              await Promise.all(files.map((f) => f.delete()));
            }
          } catch (e) {
            console.warn('Failed to cleanup old logos:', e);
          }

          // Upload new logo
          try {
            const downloadToken = randomUUID();
            const destination = `${prefix}${logoFile.filename}`;
            const [file] = await bucket.upload(logoFile.filepath, {
              destination,
              metadata: {
                contentType: logoFile.mimeType,
                metadata: {
                  firebaseStorageDownloadTokens: downloadToken,
                },
              },
            });

            try {
              const [url] = await file.getSignedUrl({
                action: 'read',
                expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
              });
              logoUrl = url;
            } catch (signErr) {
              const bName = bucket.name || `${process.env.GCLOUD_PROJECT || 'brandize-101db'}.appspot.com`;
              logoUrl = `https://firebasestorage.googleapis.com/v0/b/${bName}/o/${encodeURIComponent(destination)}?alt=media&token=${downloadToken}`;
            }
          } catch (uploadErr) {
            throw new Error('Failed to upload logo: ' + uploadErr.message);
          } finally {
            fs.unlink(logoFile.filepath, () => {});
          }
        }

        const updatePayload = {
          updatedAt: FieldValue.serverTimestamp(),
        };

        if (brandInfo) {
          if (typeof brandInfo.brandName !== 'undefined') updatePayload.brandName = brandInfo.brandName;
          if (typeof brandInfo.website !== 'undefined') updatePayload.website = brandInfo.website;
          if (typeof brandInfo.phone !== 'undefined') updatePayload.phone = brandInfo.phone;
          if (typeof brandInfo.address !== 'undefined') updatePayload.address = brandInfo.address;
          if (typeof brandInfo.description !== 'undefined') updatePayload.description = brandInfo.description;
          if (typeof brandInfo.colorPalette !== 'undefined') updatePayload.colorPalette = brandInfo.colorPalette;
        }

        if (logoUrl) {
          updatePayload.logoUrl = logoUrl;
        }

        await brandRef.set(updatePayload, { merge: true });
        return res.status(200).json({ success: true, logoUrl });
      } catch (err) {
        console.error('updateBrand error:', err);
        if (logoFile) fs.unlink(logoFile.filepath, () => {});
        return res
          .status(500)
          .json({ success: false, error: 'Internal error updating brand', details: String(err?.message || err) });
      }
    });
  },
);

exports.deleteBrand = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 30,
    memory: '256MiB',
    cors: true,
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).send('');
    }

    return cors(req, res, async () => {
      if (req.method !== 'DELETE') {
        return res.status(405).json({ success: false, error: 'Method not allowed. Use DELETE.' });
      }
      try {
        // Support both body (if client sends it) and query params (standard for DELETE)
        const user_id = (req.body?.user_id || req.query?.user_id);
        const brand_id = (req.body?.brand_id || req.query?.brand_id);

        if (!user_id || typeof user_id !== 'string') {
          return res.status(400).json({ success: false, error: 'Missing required field: user_id' });
        }
        if (!brand_id || typeof brand_id !== 'string') {
          return res.status(400).json({ success: false, error: 'Missing required field: brand_id' });
        }

        const brandRef = db.collection('users').doc(user_id).collection('brands').doc(brand_id);

        // Delete Firestore document
        await brandRef.delete();

        // Delete all files in the brand's storage folder (logos)
        const prefix = `images/brand_logos/${user_id}/${brand_id}/`;
        try {
          const [files] = await bucket.getFiles({ prefix });
          if (files.length > 0) {
            await Promise.all(files.map((f) => f.delete()));
          }
        } catch (e) {
          console.warn('deleteBrand storage cleanup warning:', e?.message || e);
        }

        return res.status(200).json({ success: true });
      } catch (err) {
        console.error('deleteBrand error:', err);
        return res
          .status(500)
          .json({ success: false, error: 'Internal error deleting brand', details: String(err?.message || err) });
      }
    });
  },
);

exports.getBrands = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 30,
    memory: '256MiB',
    cors: true,
  },
  async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).send('');
    }

    return cors(req, res, async () => {
      if (req.method !== 'GET') {
        return res.status(405).json({ success: false, error: 'Method not allowed. Use GET.' });
      }

      try {
        const user_id = (req.query.user_id || '').toString().trim();

        if (!user_id) {
          return res.status(400).json({ success: false, error: 'Missing required query parameter: user_id' });
        }

        const brandsSnapshot = await db
          .collection('users')
          .doc(user_id)
          .collection('brands')
          .orderBy('createdAt', 'desc')
          .get();

        const brands = [];
        brandsSnapshot.forEach((doc) => {
          brands.push({
            id: doc.id,
            ...doc.data(),
          });
        });

        return res.status(200).json({ success: true, brands });
      } catch (err) {
        console.error('getBrands error:', err);
        return res
          .status(500)
          .json({ success: false, error: 'Internal error fetching brands', details: String(err?.message || err) });
      }
    });
  },
);
