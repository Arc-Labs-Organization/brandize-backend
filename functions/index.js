'use strict';
// Load local env variables when running in emulator/development.
// Will look for .env.local first, then .env. Safe in production (ignored if files absent).
try {
  require('dotenv').config({ path: '.env.local' });
  require('dotenv').config();
} catch (e) {
  // dotenv optional
}

const admin = require('firebase-admin');

try {
  if (!admin.apps.length) {
    // Artık her şey FIREBASE_CONFIG üzerinden otomatik gelecek
    admin.initializeApp();
  }
} catch (e) {
  // ignore re-init in emulator hot-reload
}

// Import and export Brand Operations
const { addBrand, updateBrand, deleteBrand, getBrands } = require('./src/operations/brandOperations');
exports.addBrand = addBrand;
exports.updateBrand = updateBrand;
exports.deleteBrand = deleteBrand;
exports.getBrands = getBrands;

// Import and export Freepik Operations
const { freepikSearch, freepikDownload } = require('./src/operations/freepikOperations');
exports.freepikSearch = freepikSearch;
exports.freepikDownload = freepikDownload;

// Import and export Rebrand Tool Operations (Image Generation & Blueprinting)
const { generateRebrand, generateSmartBlueprint } = require('./src/tools/rebrand');
exports.generateRebrand = generateRebrand;
exports.generateSmartBlueprint = generateSmartBlueprint;

// Import and export Change Text Tool
const { extractTexts, generateChangeText } = require('./src/tools/changeText');
exports.extractTexts = extractTexts;
exports.generateChangeText = generateChangeText;

// Import and export Replace Image Tool
const { generateReplaceImage } = require('./src/tools/replaceImage');
exports.generateReplaceImage = generateReplaceImage;

// Import and export Add Object Tool
const { generateAddObject } = require('./src/tools/addObject');
exports.generateAddObject = generateAddObject;

// Import and export User Operations
const { getDownloadedImages, getCreatedImages, userInfo } = require('./src/operations/userOperations');
exports.getDownloadedImages = getDownloadedImages;
exports.getCreatedImages = getCreatedImages;
exports.userInfo = userInfo;
