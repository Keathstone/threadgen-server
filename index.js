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
const FAL_TRYON   = 'https://fal.run/fal-ai/fashn/tryon/v1.6';             // garment try-on (pixel-accurate)
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
  const realPrefix = 'Candid real photograph, shot on a full-frame camera, 50mm lens, natural lighting, ' +
    'authentic editorial fashion photo. ';
  try {
    const j = await falPost(FAL_GEN, {
      prompt: realPrefix + prompt,
      image_size: 'portrait_4_3',
      num_images: 1,
      guidance_scale: 3.5,
      num_inference_steps: 30,
      enable_safety_checker: true,
      ...(seed != null ? { seed } : {}),
    });
    const u = (j.images || [])[0]?.url;
    if (u) return u;
  } catch (e) { /* fall through to alt */ }
  const j = await falPost(FAL_GEN_ALT, { prompt, aspect_ratio: '3:4', num_images: 1, ...(seed != null ? { seed } : {}) });
  return (j.images || [])[0]?.url;
}

async function tryOn(modelUrl, garmentUrl, category = 'auto') {
  const j = await falPost(FAL_TRYON, {
    model_image: modelUrl,
    garment_image: garmentUrl,
    category,
    garment_photo_type: 'auto',
    mode: 'quality',
    output_format: 'png',
  });
  return (j.images || [])[0]?.url;
}

async function editScene(prompt, imageUrls) {
  const j = await falPost(FAL_EDIT, { prompt, image_urls: imageUrls, num_images: 1 });
  return (j.images || [])[0]?.url;
}

async function upscale(imageUrl) {
  try {
    // Higher creativity + a texture prompt makes the upscaler ADD real skin detail and
    // photographic grain instead of just sharpening the plastic look. This is the
    // final pass on every image, so it's what kills the airbrushed AI face.
    const j = await falPost(FAL_UPSCALE, {
      image_url: imageUrl,
      scale_factor: 2.0,
      creativity: 0.4,
      resemblance: 0.75,
      prompt: 'realistic human skin with visible pores and fine texture, natural photographic film grain, ' +
        'sharp real-camera detail, not smooth, not airbrushed, not plastic',
    });
    return (j.image && j.image.url) || ((j.images || [])[0] || {}).url || imageUrl;
  } catch { return imageUrl; } // upscale is a bonus; never fail the request over it
}

// data-URI a local upload so FAL can read it without a storage round-trip
function toDataUri(filePath, mime) {
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

// ---- health ----
app.get('/api/health', (req, res) => res.json({ status: 'ok', fal: !!FAL_KEY, pipeline: 'tryon-v2' }));
app.get('/api/styles', (req, res) => res.json({ styles: Object.keys(STYLES), scenes: Object.keys(SCENES) }));

// ---- TEST shot: product mockup + model options -> ONE pixel-accurate try-on shot ----
// Flow (v3): generate brand model ALREADY in the desired scene/style (or reuse saved)
//   -> FASHN try-on garment LAST so the logo is never re-rendered -> upscale w/ texture.
// We deliberately do NOT run a post try-on edit pass, because that re-draws the garment
// and destroys the logo + re-smooths skin. Scene/style live in the model prompt instead.
app.post('/api/test-photo', upload.fields([{ name: 'product', maxCount: 1 }, { name: 'modelImg', maxCount: 1 }]), async (req, res) => {
  const files = [];
  try {
    if (!req.files || !req.files.product) return res.status(400).json({ error: 'product image required' });
    const opts = JSON.parse(req.body.options || '{}');

    const garmentUrl = toDataUri(req.files.product[0].path, req.files.product[0].mimetype);
    files.push(req.files.product[0].path);

    const sceneText = opts.scene && SCENES[opts.scene] ? SCENES[opts.scene] : '';
    const styleText = (opts.styles || []).map(s => STYLES[s]).filter(Boolean).join('; ');

    // 1) brand model: reuse a saved model image if provided, else generate it
    //    ALREADY standing in the right scene/style (so no destructive edit later)
    let modelUrl;
    if (req.files.modelImg) {
      modelUrl = toDataUri(req.files.modelImg[0].path, req.files.modelImg[0].mimetype);
      files.push(req.files.modelImg[0].path);
    } else {
      const pose = opts.pose ? opts.pose : 'natural relaxed standing pose';
      let prompt = `Full-body photo of ${modelDescription(opts.model)}, ${pose}, wearing plain neutral fitted clothing. `;
      if (sceneText) prompt += `Setting: ${sceneText}. `;
      else prompt += 'Setting: clean light-grey studio backdrop, even lighting. ';
      if (styleText) prompt += `STYLE: ${styleText}. `;
      if (opts.edits) prompt += `Scene details: ${opts.edits}. `;
      prompt += QUALITY_BASE;
      modelUrl = await genModel(prompt, opts.model && opts.model.seed);
      if (!modelUrl) throw new Error('model generation failed');
    }

    // 2) try-on LAST: warp the ACTUAL garment pixels onto the model (logo/text stay exact)
    let url = await tryOn(modelUrl, garmentUrl, opts.category || 'auto');
    if (!url) throw new Error('try-on failed');

    // 3) forced upscale on every output -> real texture, breaks the plastic look
    url = await upscale(url);

    res.json({ success: true, image: url, modelImage: modelUrl.startsWith('data:') ? null : modelUrl });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    files.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  }
});

// ---- CAMPAIGN: approved anchor + product -> 5 themed shots, same model+garment ----
app.post('/api/campaign', upload.fields([{ name: 'product', maxCount: 1 }, { name: 'approved', maxCount: 1 }]), async (req, res) => {
  const files = [];
  try {
    if (!req.files || !req.files.product || !req.files.approved)
      return res.status(400).json({ error: 'product and approved test image required' });
    const opts = JSON.parse(req.body.options || '{}');

    const approvedUrl = toDataUri(req.files.approved[0].path, req.files.approved[0].mimetype);
    files.push(req.files.approved[0].path, req.files.product[0].path);

    const sceneText = opts.scene && SCENES[opts.scene] ? SCENES[opts.scene] : '';
    const styleText = (opts.styles || []).map(s => STYLES[s]).filter(Boolean).join('; ');

    const shots = [
      'wide full-body shot',
      'candid mid-action moment',
      'upper-body close-up',
      'three-quarter angle',
      'detail shot of the clothing item',
    ];

    const out = [];
    for (const shot of shots) {
      let p = 'Use the SAME exact person (same face, skin tone, hair) and the SAME clothing item ' +
        '(identical design, logo and colors) from the reference image. Identity stays consistent. ';
      if (sceneText) p += `Place them in ${sceneText}. `;
      if (styleText) p += `STYLE: ${styleText}. `;
      if (opts.campaignVision) p += `CAMPAIGN VISION: ${opts.campaignVision}. `;
      if (opts.edits) p += `EDITS: ${opts.edits}. `;
      p += `SHOT: ${shot}, consistent with the campaign theme. ${QUALITY_BASE}`;
      let url = await editScene(p, [approvedUrl]);
      if (url) { url = await upscale(url); out.push(url); }
    }
    res.json({ success: true, images: out });
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
    const prompt = `Full-body studio portrait of ${modelDescription(m)}, front-facing, neutral expression, ` +
      `wearing plain neutral clothing, clean light-grey studio backdrop, even soft lighting. ${QUALITY_BASE}`;
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
app.listen(PORT, () => console.log(`ThreadGen backend on :${PORT} (fal=${!!FAL_KEY}) pipeline=tryon-v2`));
