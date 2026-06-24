// ThreadGen backend — AI clothing campaign generator.
// Pipeline: generate brand model -> FASHN try-on (pixel-accurate garment) ->
// scene/background -> forced upscale. Plus brand-model save + logo-lock compositing.
// One Express file. Holds FAL_KEY. Frontend (GitHub Pages) calls these routes.

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// ---- load .env manually so Render env vars also work ----
function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim();
      process.env[k] = v; // last one wins (matches dotenv behaviour)
    }
  }
}
loadEnv();

const FAL_KEY = process.env.FAL_KEY;

// ---- FAL endpoints ----
const FAL_GEN     = 'https://fal.run/fal-ai/flux/dev';                     // text -> image (brand model, real skin)
const FAL_GEN_ALT = 'https://fal.run/fal-ai/gemini-25-flash-image';        // fallback generator
const FAL_EDIT    = 'https://fal.run/fal-ai/gemini-25-flash-image/edit';   // image edit (scene / background)
// FLUX 2 Pro multi-reference edit = the ENGINE. A frontier model that REDRAWS the whole
// photo while faithfully copying the real garment from reference images (same class of tool
// as ChatGPT image gen). This REPLACES the old FASHN try-on warper, which could only bend a
// flat garment onto a body and invented fake fabric folds / smeared small patches.
const FAL_FLUX2   = 'https://fal.run/fal-ai/flux-2-pro/edit';              // garment-on-model (PRIMARY engine)
const FAL_TRYON   = 'https://fal.run/fal-ai/fashn/tryon/v1.6';             // legacy try-on (fallback only)
const FAL_UPSCALE = 'https://fal.run/fal-ai/clarity-upscaler';            // detail + real texture

const app = express();

// ---- CORS: lock to GitHub Pages origin (+ localhost for dev) ----
const ALLOWED = [
  'https://keathstone.github.io',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:5173',
];
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);            // curl / same-origin / native app
    if (ALLOWED.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
}));
app.use(express.json({ limit: '25mb' }));

const upload = multer({ dest: '/tmp/threadgen_uploads/' });

// ---- style presets (photographer-grade prompts — the "secret sauce" behind each button) ----
// Each button carries a full pro-photo recipe so a non-expert gets gallery-quality results
// from one tap. Keep these rich and specific; this is where image quality is won.
const STYLES = {
  iphone:
    'shot on a modern iPhone Pro, computational-photography realism, natural daylight, true-to-life ' +
    'color science, shallow natural depth of field with a softly blurred background, crisp in-focus subject, ' +
    'authentic candid framing, no over-processing, looks like a real photo a friend snapped',
  vintage:
    'authentic 1990s 35mm film photograph on Kodak Gold, warm faded color palette, gentle halation glow ' +
    'around highlights, fine organic film grain, soft analog contrast, slight light leak in one corner, ' +
    'nostalgic retro editorial mood, scanned-negative texture',
  streetwear:
    'high-end streetwear brand campaign, golden-hour urban lighting, confident relaxed lookbook posture, ' +
    'cinematic rim light separating subject from background, magazine-ad composition, premium color grade, ' +
    'effortless cool energy, looks like a real fashion ad',
  urban:
    'gritty urban environment, weathered concrete and brick textures, moody overcast diffused light, ' +
    'desaturated cinematic color grade with crushed shadows, documentary street-photography realism, ' +
    'strong sense of place and atmosphere',
  grainy:
    'high-ISO analog film look, heavy pronounced grain structure, high contrast black-and-white-leaning tones, ' +
    'raw unpolished documentary feel, deep shadows, hard directional light, photojournalistic edge',
  clear:
    'crisp ultra-clean high-clarity photograph, bright even diffused lighting, razor-sharp focus, ' +
    'true accurate color, minimal noise, clean neutral background, premium catalog quality',
  studio:
    'professional photography studio, three-point soft-box lighting with a soft key and gentle fill, ' +
    'visible catchlights in the eyes, seamless neutral paper sweep backdrop, polished e-commerce sharpness, ' +
    'flattering controlled shadows, high-end product-campaign finish',
};

// ---- background / scene presets (rich, so one tap = a believable real location) ----
const SCENES = {
  street:  'a real city street with shopfronts, parked cars and concrete sidewalk, natural daylight, ' +
           'shallow depth of field blurring the background, authentic urban atmosphere',
  studio:  'a clean professional photo studio with a seamless neutral paper backdrop, soft even key lighting ' +
           'and gentle fill, subtle floor shadow, polished e-commerce look',
  beach:   'a sunny beach with soft sand and ocean waves behind, warm golden natural light, gentle sea haze, ' +
           'relaxed summer atmosphere, background softly out of focus',
  rooftop: 'an urban rooftop at golden hour with a city skyline behind, warm directional sunlight, ' +
           'long soft shadows, cinematic depth, modern lifestyle mood',
  park:    'a green park with trees, dappled natural daylight and a softly blurred leafy background, ' +
           'fresh outdoor atmosphere, calm and natural',
  indoor:  'a stylish modern interior with warm ambient lighting, tasteful decor and large windows, ' +
           'soft natural window light, cozy editorial lifestyle feel',
};

// Quality base baked under everything (real texture, beats the plastic AI look)
const QUALITY_BASE =
  'CRITICAL: highly realistic facial skin texture with visible pores, fine lines and natural imperfections, ' +
  'real human skin, NOT smooth, NOT airbrushed, NOT plastic or CGI. Semi-iPhone photo quality, soft natural ' +
  'light, slight real-camera grain, looks like an actual photograph not a render. ';

// Build a brand-model description from the picker (gender/build/ethnicity/age)
function modelDescription(m = {}) {
  const gender    = m.gender    || 'person';
  const build     = m.build     ? `${m.build} build` : 'average build';
  const ethnicity = m.ethnicity ? `${m.ethnicity} ` : '';
  const age       = m.age       || 'young adult';
  return `a ${age} ${ethnicity}${gender} with ${build}`;
}

// ---- low-level FAL callers ----
async function falPost(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`FAL ${url.split('/').slice(-2).join('/')} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function genModel(prompt, seed) {
  // FLUX dev renders grittier, realistic skin (beats Gemini's plastic faces).
  // Portrait 3:4, real-photo framing. Falls back to Gemini if FLUX hiccups.
  // STRONG realism block: Don rejects fake/blurry faces — we force candid-iPhone
  // imperfection (pores, asymmetry, real skin) so the model reads like a real person.
  const realPrefix =
    'Candid amateur iPhone photograph of a REAL person, shot handheld in natural light, ' +
    'authentic and slightly imperfect — visible skin pores, subtle skin texture, natural ' +
    'facial asymmetry, real human imperfections, NOT a model render, NOT airbrushed, NOT ' +
    'plastic, NOT smooth CGI skin, sharp in-focus face with true-to-life detail. ';
  try {
    const j = await falPost(FAL_GEN, {
      prompt: realPrefix + prompt,
      image_size: 'portrait_4_3',
      num_images: 1,
      guidance_scale: 3.5,
      num_inference_steps: 36,
      enable_safety_checker: true,
      ...(seed != null ? { seed } : {}),
    });
    const u = (j.images || [])[0]?.url;
    if (u) return u;
  } catch (e) { /* fall through to alt */ }
  const j = await falPost(FAL_GEN_ALT, { prompt, aspect_ratio: '3:4', num_images: 1, ...(seed != null ? { seed } : {}) });
  return (j.images || [])[0]?.url;
}

// ===== PRIMARY ENGINE: FLUX 2 Pro multi-reference =====
// Redraws the entire photo while faithfully copying the REAL garment from the reference
// image(s). One call does garment-fidelity + a realistic model + scene — no separate warp,
// no invented fake folds, no smeared patch. Replaces the FASHN try-on pipeline.
//   garmentUrls: array of the user's product photos (front/back/detail) — all fed as refs.
//   desc: the user's free-text product description (locks ambiguous details in words).
//   modelUrl: optional approved/uploaded model image to keep identity consistent.
async function flux2Garment({ garmentUrls = [], desc = '', modelDesc = '', modelUrl = null,
                              sceneText = '', styleText = '', pose = '', edits = '', seed = null,
                              sceneRefUrl = null, refWhat = [] }) {
  const refs = [...garmentUrls];
  if (modelUrl) refs.unshift(modelUrl); // model first so identity anchors
  if (sceneRefUrl) refs.push(sceneRefUrl); // scene/pose reference last

  let p = '';
  if (modelUrl) {
    p += 'Use the SAME exact person shown in the FIRST reference image — same face, same facial ' +
         'features, same skin tone, same hairstyle. Keep their identity perfectly consistent. ';
    p += `Dress that person in EXACTLY the garment shown in the other reference image(s). `;
  } else {
    p += `A candid iPhone photograph of ${modelDesc || 'a real person'} `;
    p += `wearing EXACTLY the garment shown in the reference image(s). `;
  }
  p += 'Reproduce the garment with total fidelity: the same cut and RELAXED streetwear fit and ' +
       'silhouette (not slim, not tailored — keep it loose like the reference), the same sleeve ' +
       'length, the same fabric type and knit/weave/ribbed texture clearly visible, every printed ' +
       'graphic and all text reproduced exactly with the same wording, fonts and colors, and every ' +
       'label, tag, patch and small detail copied faithfully and kept legible. ';
  if (desc) p += `Product description (treat as ground truth, leave no room for error): ${desc}. `;
  p += 'The garment must drape with natural realistic fabric folds that follow the body and gravity. ';
  // Scene/pose reference: the LAST reference image. Tell FLUX2 exactly what to copy from it.
  if (sceneRefUrl) {
    const wantPose = !refWhat.length || refWhat.includes('pose');
    const wantBg   = !refWhat.length || refWhat.includes('background');
    p += 'The FINAL reference image is a scene/pose reference — ';
    if (wantPose && wantBg) p += 'copy the EXACT same body pose, stance and camera angle AND the exact same background, location and lighting from it. ';
    else if (wantPose) p += 'copy the EXACT same body pose, stance and camera angle from it (ignore its background). ';
    else if (wantBg) p += 'copy the exact same background, location and lighting from it (ignore its pose). ';
    p += 'Match it faithfully. ';
  } else {
    if (pose) p += `Pose: ${pose}. `;
    else p += 'Relaxed confident streetwear posture. ';
    if (sceneText) p += `Setting: ${sceneText}. `;
  }
  if (styleText) p += `Photographic style: ${styleText}. `;
  if (edits) p += `${edits}. `;
  p += 'CRITICAL — this must look like a REAL candid photo of a REAL person, NOT a fashion render: ' +
       'authentic imperfect human skin with visible pores, fine lines, slight blemishes and natural ' +
       'oiliness, natural facial asymmetry, flyaway hairs, real-world ambient lighting with uneven ' +
       'shadows, NOT airbrushed, NOT retouched, NOT smooth, NOT plastic, NOT CGI, NOT a glossy studio ' +
       'model shot. Shot handheld on a phone with slight motion and real-camera sensor grain, ' +
       'looks like a photo a friend snapped on the street, sharp in-focus face.';

  const j = await falPost(FAL_FLUX2, {
    prompt: p,
    image_urls: refs,
    image_size: 'portrait_4_3',
    output_format: 'png',
    safety_tolerance: '5',
    ...(seed != null ? { seed } : {}),
  });
  return (j.images || [])[0]?.url;
}

async function tryOn(modelUrl, garmentUrl, category = 'auto', garmentType = 'flat-lay') {
  try {
    const j = await falPost(FAL_TRYON, {
      model_image: modelUrl,
      garment_image: garmentUrl,
      category,
      garment_photo_type: garmentType,   // 'flat-lay' for product mockups (our case), 'model' for on-body refs
      segmentation_free: true,           // CRITICAL: let the garment's OWN silhouette (e.g. long sleeves)
                                         // carry through instead of clipping it to the model's existing
                                         // short-sleeve region. Without this, long-sleeve flat-lays render
                                         // as short sleeves (Don's garment-shape bug).
      mode: 'quality',
      output_format: 'png',
    });
    return (j.images || [])[0]?.url;
  } catch (e) {
    // Translate FASHN's raw API errors into plain English the user can act on
    const m = String(e.message || e);
    if (/body pose|detect.*pose|person_image/i.test(m)) {
      throw new Error("Couldn't read the model photo. Use a clear, well-lit photo showing the whole upper body or full body, facing forward, in plain clothes — not a tight face close-up or a blurry pic.");
    }
    if (/garment|clothing|cloth_image/i.test(m)) {
      throw new Error("Couldn't read the clothing photo. Use a clear flat-lay or hanger shot of the item, well-lit, filling most of the frame.");
    }
    if (/moderation|nsfw|explicit/i.test(m)) {
      throw new Error('That image was blocked by content moderation. Try a different photo.');
    }
    throw new Error('Try-on failed — try a clearer model photo and product photo.');
  }
}

async function editScene(prompt, imageUrls) {
  const j = await falPost(FAL_EDIT, { prompt, image_urls: imageUrls, num_images: 1 });
  return (j.images || [])[0]?.url;
}

async function upscale(imageUrl, opts = {}) {
  try {
    // IDENTITY-SAFE upscale. The old creativity:0.4 was high enough to REDRAW facial
    // features — it melted the model's identity after try-on (Don's #1 complaint:
    // "model in test photo doesn't match"). We now sharpen at low creativity so the
    // face/identity is preserved, and lean on FLUX dev (grittier skin) for realism
    // instead of letting the upscaler hallucinate texture over a new face.
    //   preserveIdentity (default true): gentle, face stays exact.
    //   preserveIdentity false: stronger texture pass (use only when no identity to keep).
    const preserve = opts.preserveIdentity !== false;
    const j = await falPost(FAL_UPSCALE, {
      image_url: imageUrl,
      scale_factor: 2.0,
      creativity: preserve ? 0.15 : 0.35,
      resemblance: preserve ? 0.95 : 0.8,
      prompt: 'sharp real-camera detail, realistic skin with fine natural texture, subtle photographic ' +
        'grain, keep the face and identity exactly the same, not smooth, not airbrushed, not plastic',
    });
    return (j.image && j.image.url) || ((j.images || [])[0] || {}).url || imageUrl;
  } catch { return imageUrl; } // upscale is a bonus; never fail the request over it
}

// data-URI a local upload so FAL can read it without a storage round-trip
function toDataUri(filePath, mime) {
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

// ---- health ----
app.get('/api/health', (req, res) => res.json({ status: 'ok', fal: !!FAL_KEY, pipeline: 'flux2-garment-v8' }));
app.get('/api/styles', (req, res) => res.json({ styles: Object.keys(STYLES), scenes: Object.keys(SCENES) }));

// ---- TEST shot: real garment photo(s) + model options -> ONE faithful campaign shot ----
// ENGINE: FLUX 2 Pro multi-reference (replaces FASHN). Feeds ALL the user's product photos +
// their text description as references, and (optionally) an approved/uploaded model image as an
// identity anchor, then redraws ONE realistic photo of that person wearing the EXACT garment.
// No warp, no invented fake folds, no smeared patch. Upscale at the end for crisp real texture.
app.post('/api/test-photo', upload.fields([{ name: 'product', maxCount: 4 }, { name: 'modelImg', maxCount: 1 }, { name: 'sceneRef', maxCount: 1 }]), async (req, res) => {
  const files = [];
  try {
    if (!req.files || !req.files.product || !req.files.product.length)
      return res.status(400).json({ error: 'product image required' });
    const opts = JSON.parse(req.body.options || '{}');

    // ALL product photos become references (front / back / detail). More = better fidelity.
    const garmentUrls = req.files.product.map(f => { files.push(f.path); return toDataUri(f.path, f.mimetype); });

    const sceneText = opts.scene && SCENES[opts.scene] ? SCENES[opts.scene] : '';
    const styleText = (opts.styles || []).map(s => STYLES[s]).filter(Boolean).join('; ');

    // Optional scene/pose reference photo — FLUX2 copies its pose and/or background.
    let sceneRefUrl = null;
    if (req.files.sceneRef) {
      sceneRefUrl = toDataUri(req.files.sceneRef[0].path, req.files.sceneRef[0].mimetype);
      files.push(req.files.sceneRef[0].path);
    }

    // Optional identity anchor: uploaded/saved model photo. If none, FLUX2 invents a model
    // from the picker description and keeps it consistent via the returned seed.
    let modelUrl = null;
    if (req.files.modelImg) {
      modelUrl = toDataUri(req.files.modelImg[0].path, req.files.modelImg[0].mimetype);
      files.push(req.files.modelImg[0].path);
    }

    const rawUrl = await flux2Garment({
      garmentUrls,
      desc: opts.productDesc || '',
      modelDesc: modelDescription(opts.model),
      modelUrl,
      sceneText,
      styleText,
      pose: opts.pose || '',
      edits: opts.edits || '',
      seed: opts.model && opts.model.seed,
      sceneRefUrl,
      refWhat: opts.refWhat || [],
    });
    if (!rawUrl) throw new Error('garment render failed');

    // forced upscale -> crisp real texture (identity-safe, won't melt the face)
    const url = await upscale(rawUrl);

    res.json({ success: true, image: url, raw: rawUrl });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    files.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  }
});

// ---- CAMPAIGN: approved anchor + product photo(s) -> themed shots, same model+garment ----
// ENGINE: FLUX 2 Pro multi-reference. Each shot feeds the approved test photo (identity +
// garment anchor) PLUS the real product photos (garment fidelity), then redraws the SAME
// person wearing the SAME exact garment in a new pose/angle/scene. One call per shot — no
// FASHN, no destructive post-edit. Try/catch per shot so one miss doesn't kill the batch.
app.post('/api/campaign', upload.fields([{ name: 'product', maxCount: 4 }, { name: 'approved', maxCount: 1 }, { name: 'sceneRef', maxCount: 1 }]), async (req, res) => {
  const files = [];
  try {
    if (!req.files || !req.files.product || !req.files.product.length || !req.files.approved)
      return res.status(400).json({ error: 'product and approved test image required' });
    const opts = JSON.parse(req.body.options || '{}');

    const approvedUrl = toDataUri(req.files.approved[0].path, req.files.approved[0].mimetype);
    files.push(req.files.approved[0].path);
    const garmentUrls = req.files.product.map(f => { files.push(f.path); return toDataUri(f.path, f.mimetype); });

    // Optional scene reference — its BACKGROUND/location is held across all campaign shots
    // (pose is intentionally varied per shot, so we copy background only here).
    let sceneRefUrl = null;
    if (req.files.sceneRef) {
      sceneRefUrl = toDataUri(req.files.sceneRef[0].path, req.files.sceneRef[0].mimetype);
      files.push(req.files.sceneRef[0].path);
    }

    const sceneText = opts.scene && SCENES[opts.scene] ? SCENES[opts.scene] : '';
    const styleText = (opts.styles || []).map(s => STYLES[s]).filter(Boolean).join('; ');

    const shots = [
      'wide full-body shot, full figure head to toe',
      'candid mid-action moment, natural movement',
      'upper-body close-up portrait',
      'three-quarter angle fashion shot',
      'detail shot focused on the clothing item and its print',
    ];

    const out = [];
    const errors = [];
    for (const shot of shots) {
      try {
        // refs: approved test photo FIRST (locks identity + the already-correct garment),
        // then the raw product photos (reinforce garment fidelity each shot), then scene ref.
        const refs = [approvedUrl, ...garmentUrls];
        if (sceneRefUrl) refs.push(sceneRefUrl);
        let p = 'Use the SAME exact person shown in the FIRST reference image — same face, same ' +
          'facial features, same skin tone, same hairstyle, same body. Keep their identity perfectly ' +
          'consistent. Keep them wearing EXACTLY the same garment shown in the reference images — ' +
          'reproduce the cut, sleeve length, fabric texture, every printed graphic, all text with the ' +
          'same wording/fonts/colors, and every label/patch faithfully and legibly. ';
        if (sceneRefUrl) p += 'Use the SAME background, location and lighting as shown in the FINAL reference image. ';
        else if (sceneText) p += `Setting: ${sceneText}. `;
        if (styleText) p += `Photographic style: ${styleText}. `;
        if (opts.campaignVision) p += `Campaign vision: ${opts.campaignVision}. `;
        if (opts.edits) p += `${opts.edits}. `;
        p += `Shot: ${shot}, consistent with the campaign theme. ` +
          'Authentic imperfect real human skin with visible pores and natural texture, NOT airbrushed, ' +
          'NOT plastic, sharp in-focus face. Natural realistic fabric drape. Semi-iPhone photo quality, ' +
          'soft natural light, slight real-camera grain, looks like a real photograph.';

        const rawUrl = await falPost(FAL_FLUX2, {
          prompt: p,
          image_urls: refs,
          image_size: 'portrait_4_3',
          output_format: 'png',
          safety_tolerance: '5',
        }).then(j => (j.images || [])[0]?.url);
        if (!rawUrl) { errors.push(`${shot}: render failed`); continue; }

        const url = await upscale(rawUrl);
        out.push(url);
      } catch (e) {
        errors.push(`${shot}: ${String(e.message || e)}`);
      }
    }
    if (!out.length) throw new Error(errors.join(' | ') || 'campaign produced no images');
    res.json({ success: true, images: out, ...(errors.length ? { warnings: errors } : {}) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    files.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  }
});

// ---- BRAND MODEL: generate a reusable model face from the picker, return its URL ----
app.post('/api/brand-model', async (req, res) => {
  try {
    const m = req.body.model || {};
    const prompt = `Full-body photo of ${modelDescription(m)} standing head to toe, ENTIRE body visible from head to feet, ` +
      `front-facing relaxed standing pose, neutral expression, wearing plain neutral fitted clothing, ` +
      `clean light-grey studio backdrop, even soft lighting. ${QUALITY_BASE}`;
    const url = await genModel(prompt, m.seed);
    if (!url) throw new Error('model generation failed');
    res.json({ success: true, image: url, seed: m.seed || null });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- standalone upscale ----
app.post('/api/upscale', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'image url required' });
    res.json({ success: true, image: await upscale(image) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`ThreadGen backend on :${PORT} (fal=${!!FAL_KEY}) pipeline=flux2-garment-v8`));
