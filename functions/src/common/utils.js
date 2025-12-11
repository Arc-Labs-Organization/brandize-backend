const Busboy = require('busboy');

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

module.exports = { createMultipartParser, buildCommonImagePath, buildGeneratedImagePath };
