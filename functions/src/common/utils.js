const Busboy = require('busboy');
const admin = require('firebase-admin');

// Support both busboy export styles and versions (constructor vs function)
function createMultipartParser(headers) {
  const lib = Busboy;
  const Ctor = (lib && (lib.Busboy || lib.default || lib)) || lib;
  try {
    return new Ctor({ headers });
  } catch (e) {
    // Some versions export a callable function instead of a class
    return Ctor({ headers });
  }
}

// Path helpers (centralized for consistency)
function buildCommonImagePath(imageId, ext) {
  return `images/common/${imageId}.${ext}`;
}
function buildGeneratedImagePath(uid, imageId, ext) {
  return `images/generated/${uid}/${imageId}.${ext}`;
}

async function verifyAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Unauthorized: Missing or invalid Authorization header');
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    return decodedToken.uid;
  } catch (error) {
    console.error('Error verifying ID token:', error);
    throw new Error('Unauthorized: Invalid ID token');
  }
}

module.exports = { createMultipartParser, buildCommonImagePath, buildGeneratedImagePath, verifyAuth };
