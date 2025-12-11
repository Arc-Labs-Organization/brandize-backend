const { defineSecret } = require('firebase-functions/params');

// Define secret for Google AI Studio API key (Gemini API)
const GOOGLE_API_KEY = defineSecret('GOOGLE_API_KEY');

let genkitInstance = null;

/**
 * Initializes Genkit with Google AI plugin.
 * Returns the ai instance, flow, z, and other utilities.
 */
async function initGenkit() {
  if (genkitInstance) return genkitInstance;

  // Dynamically import Genkit core, Google AI plugin, Firebase telemetry, and Zod
  const [core, genkitPkg, googleAIPkg, firebasePkg, zodPkg] = await Promise.all([
    import('@genkit-ai/core'),
    import('genkit'),
    import('@genkit-ai/googleai'),
    import('@genkit-ai/firebase'),
    import('zod'),
  ]);

  const { flow } = core;
  const { genkit } = genkitPkg;
  const { googleAI } = googleAIPkg;
  const { enableFirebaseTelemetry } = firebasePkg;
  const { z } = zodPkg;

  // Sanity log to surface missing API key during cold starts/emulator runs
  console.log('GOOGLE_API_KEY set?', !!process.env.GOOGLE_API_KEY);

  if (!process.env.GOOGLE_API_KEY) {
    // Throw early so endpoints can return a good error
    throw new Error('Missing GOOGLE_API_KEY secret for Genkit');
  }

  // Initialize Genkit telemetry (required for flows) using Firebase integration.
  enableFirebaseTelemetry();

  // Initialize a Genkit instance with Google AI plugin. It will pick up GOOGLE_API_KEY automatically.
  const ai = genkit({
    plugins: [googleAI()],
  });

  genkitInstance = { ai, flow, z, googleAI };
  return genkitInstance;
}

module.exports = { initGenkit, GOOGLE_API_KEY };
