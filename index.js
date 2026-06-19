// ThreadGen backend — FAL image-edit proxy for AI clothing campaign generation
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
      if (!process.env[k]) process.env[k] = v;
    }
  }
}
loadEnv();

const FAL_KEY = process.env.FAL_KEY;
const FAL_EDIT = 'https://fal.run/fal-ai/gemini-25-flash-image/edit';
const FAL_UPSCALE = 'https://fal.run/fal-ai/clarity-upscaler';

const app = express();
app.use(cors()); // open during eval; lock to GH Pages origin for production
app.use(express.json({ limit: '25mb' }));

const upload = multer({ dest: '/tmp/threadgen_uploads/' });

// ---- style presets (validated prompts) ----
const STYLES = {
  iphone:     'shot on iPhone, candid real-phone photo realism, natural daylight, true-to-life color',
  vintage:    'vintage 1990s faded film color, soft analog grain, retro editorial mood, slight light leak',
  streetwear: 'streetwear golden-hour urban campaign look, relaxed confident lookbook energy',
  urban:      'gritty urban environment, concrete and city textures, moody overcast tone',
  grainy:     'high-ISO grainy film look, heavy grain, high contrast, raw documentary feel',
  clear:      'crisp clean high-clarity photo, bright even lighting, sharp focus',
  studio:     'professional photography studio, seamless backdrop, soft-box lighting, polished e-commerce look',
};

// Quality base baked under everything (real texture + semi-iphone). Validated.
const QUALITY_BASE =
  'CRITICAL: highly realistic facial skin texture with visible pores, fine lines and natural imperfections, ' +
  'real human skin, NOT smooth, NOT airbrushed, NOT plastic or CGI. Semi-iPhone photo quality, soft natural ' +
  'light, slight real-camera grain, looks like an actual photograph not a render. ';

const PRODUCT_LOCK =
  'Keep the clothing item design, fit, colors and any logo identical to the product reference image. ';

// Build the full prompt from the structured inputs the frontend sends
function buildPrompt({ styles = [], pose = '', edits = '', refsCopy = [], campaignVision = '', shot = '' }) {
  let p = 'A photo of a person wearing exactly this clothing item from the product reference image. ';
  p += QUALITY_BASE + PRODUCT_LOCK;

  const styleText = styles.map(s => STYLES[s]).filter(Boolean).join('; ');
  if (styleText) p += `STYLE: ${styleText}. `;
  if (pose) p += `POSE: ${pose}. `;
  if (refsCopy.length) p += `From the additional reference image(s), copy the ${refsCopy.join(', ')}. `;
  if (campaignVision) p += `CAMPAIGN VISION: ${campaignVision}. `;
  if (shot) p += `SHOT: ${shot}, consistent with the campaign theme. `;
  if (edits) p += `ADDITIONAL EDITS: ${edits}. `;
  return p;
}

async function falEdit(prompt, imageUrls, numImages = 1) {
  const r = await fetch(FAL_EDIT, {
    method: 'POST',
    headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, image_urls: imageUrls, num_images: numImages }),
  });
  if (!r.ok) throw new Error(`FAL edit ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return (j.images || []).map(i => i.url);
}

async function falUpscale(imageUrl) {
  const r = await fetch(FAL_UPSCALE, {
    method: 'POST',
    headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: imageUrl, scale_factor: 2.0, creativity: 0.2, resemblance: 0.9 }),
  });
  if (!r.ok) return imageUrl; // upscale is a bonus; fall back to original
  const j = await r.json();
  return (j.image && j.image.url) || ((j.images || [])[0] || {}).url || imageUrl;
}

// Upload a local file to FAL storage, return a hosted URL the edit model can read
async function uploadToFal(filePath, mime) {
  const buf = fs.readFileSync(filePath);
  // FAL accepts data URIs in image_urls, simplest + no extra storage call
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// ---- health ----
app.get('/api/health', (req, res) => res.json({ status: 'ok', fal: !!FAL_KEY }));

// ---- list styles (frontend builds chips from this) ----
app.get('/api/styles', (req, res) => res.json({ styles: Object.keys(STYLES) }));

// ---- TEST photo: product + optional refs -> 1 image ----
app.post('/api/test-photo', upload.fields([{ name: 'product', maxCount: 1 }, { name: 'refs', maxCount: 4 }]), async (req, res) => {
  const files = [];
  try {
    if (!req.files || !req.files.product) return res.status(400).json({ error: 'product image required' });
    const opts = JSON.parse(req.body.options || '{}');

    const productUrl = await uploadToFal(req.files.product[0].path, req.files.product[0].mimetype);
    files.push(req.files.product[0].path);
    const imageUrls = [productUrl];

    if (req.files.refs) {
      for (const f of req.files.refs) {
        imageUrls.push(await uploadToFal(f.path, f.mimetype));
        files.push(f.path);
      }
    }
    const prompt = buildPrompt(opts);
    const urls = await falEdit(prompt, imageUrls, 1);
    res.json({ success: true, image: urls[0], prompt });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    files.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  }
});

// ---- CAMPAIGN: approved test photo (anchor) + product -> 5 themed shots ----
app.post('/api/campaign', upload.fields([{ name: 'product', maxCount: 1 }, { name: 'approved', maxCount: 1 }]), async (req, res) => {
  const files = [];
  try {
    if (!req.files || !req.files.product || !req.files.approved)
      return res.status(400).json({ error: 'product and approved test image required' });
    const opts = JSON.parse(req.body.options || '{}');

    const approvedUrl = await uploadToFal(req.files.approved[0].path, req.files.approved[0].mimetype);
    const productUrl = await uploadToFal(req.files.product[0].path, req.files.product[0].mimetype);
    files.push(req.files.product[0].path, req.files.approved[0].path);

    const anchor =
      'Use the SAME exact person from the FIRST reference image (same face, features, skin tone, hairstyle) ' +
      'and the SAME clothing item from the second reference (identical design and logo). Identity stays ' +
      'consistent across the shot. ' + QUALITY_BASE;

    const shots = [
      'wide full-body shot',
      'candid mid-action moment',
      'upper-body close-up',
      'three-quarter angle',
      'detail shot of the clothing item',
    ];

    const out = [];
    for (const shot of shots) {
      let p = anchor;
      const styleText = (opts.styles || []).map(s => STYLES[s]).filter(Boolean).join('; ');
      if (styleText) p += `STYLE: ${styleText}. `;
      if (opts.campaignVision) p += `CAMPAIGN VISION: ${opts.campaignVision}. `;
      if (opts.pose) p += `POSE GUIDE: ${opts.pose}. `;
      if (opts.edits) p += `EDITS: ${opts.edits}. `;
      p += `SHOT: ${shot}, consistent with the campaign theme.`;
      const urls = await falEdit(p, [approvedUrl, productUrl], 1);
      out.push(urls[0]);
    }
    res.json({ success: true, images: out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    files.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  }
});

// ---- upscale a chosen image to hi-res before download ----
app.post('/api/upscale', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'image url required' });
    const url = await falUpscale(image);
    res.json({ success: true, image: url });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`ThreadGen backend on :${PORT} (fal=${!!FAL_KEY})`));
