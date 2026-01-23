// Centralized prompt builders for tools

const REPLACE_IMAGE_PROMPT_VERSION = 'replace-image-v1';

function getExtractTextsPrompt() {
  return [
    'Task: Extract ALL visible texts exactly as shown in the image (preserve order).',
    'Do NOT rewrite or suggest alternatives. Only extract what is visibly present.',
    'Output ONLY the following JSON object:',
    '{"original_texts": ["..."]}',
  ].join('\n');
}

function buildChangeTextPrompt({ textOps = {}, aspectRatio = null }) {
  const parts = [];
  parts.push(
    'Update the design by applying the following text changes. Remove any field where the new value is null. Preserve layout and composition.'
  );
  const keys = Object.keys(textOps);
  if (keys.length) {
    for (const key of keys) {
      const val = textOps[key];
      if (val === null || val === undefined) {
        parts.push(`- Remove the text "${key}".`);
      } else {
        parts.push(`- Replace "${key}" with "${val}".`);
      }
    }
  }
  if (aspectRatio) parts.push(`Target aspect ratio: ${aspectRatio}.`);
  return parts.join('\n');
}

function buildAddObjectPrompt({ objectLocation, aspectRatio }) {
  const parts = [];
  parts.push('Output size: exactly match Image 1 (same width and height).');
  parts.push('Add the object from Image 2 into Image 1.');
  parts.push(`Target location: ${objectLocation}.`);
  parts.push('Edit only the target region; preserve everything else.');
  parts.push('Match lighting, color balance, and shadows.');
  if (aspectRatio) parts.push(`Target aspect ratio: ${aspectRatio}.`);
  return parts.join('\n');
}

function buildReplaceImagePrompt({ description, aspectRatio }) {
  const parts = [];
  parts.push('You are an expert image editor.');
  parts.push(
    'Task: In image #1 (the template crop), replace the described object/subject using image #2 (the replacement source).'
  );
  parts.push(
    'Target region: the ENTIRE bounds of image #1. The output must match image #1 canvas exactly (no padding, borders, blank areas, or resizing the canvas).'
  );
  parts.push('Rules (follow strictly):');
  parts.push(
    '1) Preserve everything in image #1 except the target object/subject. Do NOT change layout, background graphics, logos, or any text.'
  );
  parts.push(
    '2) Use ONLY the subject from image #2. Do not invent details that are not present in image #2.'
  );
  parts.push(
    '3) Fit: COVER the target region with the replacement subject and center-crop as needed. Maintain natural proportions (no stretching). Prefer slight overfill over borders. Never CONTAIN.'
  );
  parts.push(
    '4) Blend: Keep edges inside the region and softly blend/feather (1–2px). Match lighting direction, color temperature, white balance, and grain/noise. Add realistic shadows/reflections only if consistent with image #1.'
  );
  parts.push(
    '5) No extras: no stickers/watermarks, no duplicated subjects, no extra objects, no heavy filters, no border artifacts.'
  );
  if (description) parts.push(`Replacement description: ${String(description).trim()}`);
  if (aspectRatio)
    parts.push(
      `Output aspect ratio hint (also enforced via config): ${String(aspectRatio).trim()}`
    );
  return parts.join('\n');
}

function buildRebrandPrompt({ brand = {}, blueprint = {} }) {
  const parts = [];
  parts.push('Update the design per the following blueprint suggestions.');

  if (
    blueprint.use_brand_colors &&
    Array.isArray(brand.colorPalette) &&
    brand.colorPalette.length > 0
  ) {
    parts.push(`Use the following brand colors: ${brand.colorPalette.join(', ')}.`);
  }

  const textOps = blueprint.text_updates || {};
  const keys = Object.keys(textOps);
  if (keys.length) {
    parts.push('Text updates:');
    for (const key of keys) {
      const val = textOps[key];
      if (val === null || val === undefined) {
        parts.push(`- Remove the text "${key}".`);
      } else {
        parts.push(`- Change "${key}" to "${val}".`);
      }
    }
  }

  const additions = blueprint.additions || {};
  if (blueprint.replace_logo) {
    parts.push('Replace the existing logo with the provided brand logo.');
  }
  if (additions && typeof additions === 'object') {
    for (const [type, location] of Object.entries(additions)) {
      const lowerType = String(type).toLowerCase();
      if (lowerType === 'brand_logo' || lowerType === 'logo') {
        parts.push(`Place the brand logo at ${location}.`);
        continue;
      }
      if (lowerType === 'brand_website' || lowerType === 'website') {
        if (brand?.website) parts.push(`Add the website "${brand.website}" at ${location}.`);
        continue;
      }
      if (lowerType === 'phone_number' || lowerType === 'phone') {
        if (brand?.phone) parts.push(`Add the phone number "${brand.phone}" at ${location}.`);
        continue;
      }
      if (lowerType === 'brand_name' || lowerType === 'name') {
        if (brand?.brandName)
          parts.push(`Add the brand name "${brand.brandName}" at ${location}.`);
        continue;
      }
      if (lowerType === 'brand_address' || lowerType === 'address') {
        if (brand?.address) parts.push(`Add the address "${brand.address}" at ${location}.`);
        continue;
      }
    }
  }

  if (blueprint.aspectRatio) {
    parts.push(`Target aspect ratio: ${blueprint.aspectRatio}.`);
    parts.push('IMPORTANT: If the target aspect ratio differs from the input image, DO NOT STRETCH or distort the original content. Instead, intelligently extend the background or crop to fit the new dimensions, keeping all text and logos natural and proportionate.');
  }

  parts.push(
    'GENERAL RULES: Preserve the overall layout, composition, and visual hierarchy of the original design. Do not remove or drastically move major visual elements unless explicitly requested.'
  );

  return parts.join('\n');
}

function buildSmartBlueprintPrompt({ brand = {}, updateFields = {} }) {
  // Build field values table with nulls for disabled/missing fields
  const fieldValues = {};
  for (const [key, enabled] of Object.entries(updateFields)) {
    if (enabled && brand[key]) {
      fieldValues[key] = brand[key];
    } else {
      fieldValues[key] = null;
    }
  }
  const fieldValuesJson = JSON.stringify(fieldValues, null, 2);

  const promptText = [
    'We will update the texts in the provided image so they align with the branding of:',
    '',
    `- **Brand Name:** ${brand.brandName || 'N/A'}`,
    `- **Description:** ${brand.description || 'N/A'}`,
    '',
    'Use the table below to determine which types of text should appear in the updated output:',
    '',
    '```json',
    fieldValuesJson,
    '```',
    '',
    '- **Fields that are `null`** must **not** appear in either **“updated_texts”** or **“additions.”**',
    '    - If these fields exist in the original image, you should either **replace them with appropriate content** or **remove them entirely**.',
    '    - If you choose to remove them, set their value to **`null`**.',
    '- **Fields that have a valid value,** must appear **at least once** in either **“updated_texts”** or **“additions.”**',
    '    - If you can replace original text with a context-appropriate and similarly sized version, do so in **“updated_texts.”**',
    '    - If no suitable replacement exists, add the content to “additions” with a strict object per entry containing: **type**, and **location**.',
    '      - **type** must be one of: "phone" | "website" | "brand_name" | "brand_address" | "brand_logo".',
    '      - **location** must be one of exactly: "bottom-right", "bottom-left", "bottom-mid", "top-left", "top-mid", "top-right". Do not use synonyms like "left-bottom" or "center-bottom".',
    '',
    '**Task:**',
    '',
    '1. Extract **all text that appears in the image** exactly as shown.',
    '2. Rewrite and improve each extracted text so it matches the above brand’s brand voice, while trying to keep the character length similar to the original.',
    '3. Identify whether the image contains **any logo that could be replaced** with the new brand logo.',
    '4. Return the final result strictly in the following JSON structure:',
    '',
    '```json',
    '{',
    '  "original_texts": [',
    '    "..."',
    '  ],',
    '  "updated_texts": [',
    '    "..."',
    '  ],',
    '  "additions": [',
    '    {',
    '      "type": "...",',
    '      "location": "..."',
    '    }',
    '  ],',
    '  "replacable_logo": boolean',
    '}',
    '```',
    '',
    'Only include the JSON in your final answer.',
  ].join('\n');

  return promptText;
}

function buildVirtualModelPrompt({ mode, targetHand }) {
  const parts = [];
  parts.push(
    'Task: Using the first image (the model), integrate the product from the second image either as held in hand or worn on the body based on the requested mode.'
  );
  parts.push('GENERAL RULES (follow precisely):');
  parts.push('- Canvas lock: OUTPUT WIDTH and HEIGHT MUST MATCH the FIRST IMAGE exactly. No padding, borders, whitespace, or re-layout.');
  parts.push("- Identity: Preserve the model’s identity, face, skin, hair, and pose. Do not alter facial features or body shape.");
  parts.push('- Lighting & color: Match ambient lighting, color temperature, white balance, grain/noise, and shadows.');
  parts.push('- Scale: Keep natural scale relative to the model and surrounding scene.');
  parts.push('- Occlusion: Respect natural occlusions between fingers/clothing/body.');
  parts.push('- Non-goals: Do NOT modify unrelated background elements or texts.');
  if (mode === 'hold') {
    parts.push('Mode: HOLD in HAND.');
    if (targetHand) parts.push(`Target hand: ${targetHand}.`);
    parts.push('Placement: Place the product naturally in the specified hand; align orientation to match grip.');
    parts.push('Fingers: Ensure realistic finger wrapping/occlusion partly covering the product when appropriate.');
    parts.push('Contact: Add subtle contact shadows and highlights between hand and product.');
  } else if (mode === 'wear') {
    parts.push('Mode: WEAR on BODY.');
    parts.push('Fit: Align and conform the product to the body region, maintaining realistic drape/warp for cloth or fit for shoes/accessories.');
    parts.push('Edges: Blend edges; follow contours and joints; no floating or clipping.');
  }
  return parts.join('\n');
}

module.exports = {
  REPLACE_IMAGE_PROMPT_VERSION,
  getExtractTextsPrompt, 
  buildChangeTextPrompt, 
  buildAddObjectPrompt, 
  buildReplaceImagePrompt, 
  buildRebrandPrompt, 
  buildSmartBlueprintPrompt, 
  buildVirtualModelPrompt, 
};
