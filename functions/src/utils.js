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

module.exports = { createMultipartParser };
