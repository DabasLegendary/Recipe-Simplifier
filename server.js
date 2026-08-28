require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '15mb' })); // generous limit for base64 images
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_WORKSPACE_ID = process.env.ANTHROPIC_WORKSPACE_ID; // optional, only needed for identity-linked keys
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You extract recipes and convert them into a structured "flow tree" JSON format used to render an ingredient-flow matrix chart (the kind where ingredients merge together step by step, e.g. "melt" -> "mix" -> "mix" -> "fold in" -> "bake").

Return ONLY valid JSON, no markdown fences, no commentary, no explanation. Schema:

{
  "title": "Recipe name",
  "prep_steps": ["Short setup instructions, e.g. 'Butter and flour an 8x8-in pan.'", "Preheat oven to 350F (170C)."],
  "tree": <node>
}

A <node> is either:
- a string: an ingredient with its amount, written exactly like "4 oz (115 g) unsalted butter"
- an object: { "op": "short lowercase action label like 'mix', 'melt', 'whisk', 'fold in', 'combine', 'knead'", "children": [ <node>, <node>, ... ] }

Rules:
- children arrays list ingredients/sub-steps in the order they are used, top to bottom.
- Build a nested merge tree: ingredients that combine together at the same step share a parent op node. That parent can then be merged further with other ingredients/groups at the NEXT step, becoming a child of a new op node — continue nesting until everything converges into ONE final root node.
- The root node is always the final combining/cooking step (e.g. bake, cook, chill, assemble). Put temperature and time info in its "op" text using \\n for line breaks, e.g. "bake\\n350F (170C)\\n30 to 40 min".
- Keep op labels short (1-3 words) except the root, which can include temp/time on separate lines.
- If you cannot find a real recipe in the input, return exactly: {"error": "No recipe could be found in the provided input."}
- Output nothing but the JSON object.`;

function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Most recipe sites embed structured Schema.org "Recipe" data as JSON-LD so
// Google/Pinterest can render rich recipe cards. It's meant to be machine-read,
// so it's a far more reliable (and less scraping-adjacent) way to get recipe
// content than parsing rendered HTML.
function extractRecipeJsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    try {
      let json = JSON.parse(block[1].trim());
      const candidates = Array.isArray(json) ? json : (json['@graph'] || [json]);
      const recipe = candidates.find(item => {
        const type = item['@type'];
        return type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
      });
      if (recipe) return JSON.stringify(recipe).slice(0, 15000);
    } catch (e) {
      // not valid JSON in this block, skip it
    }
  }
  return null;
}

app.post('/api/build-matrix', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY. Set it in your environment and restart the server.' });
  }

  try {
    const { type, image, text, url } = req.body || {};
    let userContent;

    if (type === 'image') {
      if (!image || !image.base64 || !image.mediaType) {
        return res.status(400).json({ error: 'Missing image data.' });
      }
      userContent = [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
        { type: 'text', text: 'Extract the recipe from this image and return the JSON flow-tree as instructed.' }
      ];
    } else if (type === 'text') {
      if (!text || !text.trim()) {
        return res.status(400).json({ error: 'Missing recipe text.' });
      }
      userContent = 'Extract the recipe from this text and return the JSON flow-tree as instructed:\n\n' + text.slice(0, 20000);
    } else if (type === 'url') {
      if (!url) {
        return res.status(400).json({ error: 'Missing URL.' });
      }
      let pageText;
      try {
        const pageRes = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RecipeMatrixBot/1.0; +https://example.com)' }
        });
        if (!pageRes.ok) throw new Error('status ' + pageRes.status);
        const html = await pageRes.text();
        const structured = extractRecipeJsonLd(html);
        pageText = structured || stripHtmlToText(html).slice(0, 15000);
        if (pageText.length < 40) throw new Error('empty page');
      } catch (e) {
        return res.status(422).json({ error: "Couldn't fetch that URL (the site may be blocking automated requests). Try pasting the recipe text instead." });
      }
      userContent = 'Extract the recipe from this page content and return the JSON flow-tree as instructed:\n\n' + pageText;
    } else {
      return res.status(400).json({ error: 'Invalid request type.' });
    }

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION
    };
    if (ANTHROPIC_WORKSPACE_ID) {
      headers['anthropic-workspace-id'] = ANTHROPIC_WORKSPACE_ID;
    }

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('Anthropic API error:', apiRes.status, errText);
      return res.status(502).json({ error: 'The recipe service failed to respond. Please try again in a moment.' });
    }

    const data = await apiRes.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) {
      return res.status(502).json({ error: 'No response text returned.' });
    }

    const clean = textBlock.text
      .trim()
      .replace(/^```json/i, '')
      .replace(/^```/, '')
      .replace(/```$/, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      return res.status(502).json({ error: 'Could not parse a valid recipe from the response.' });
    }

    return res.json(parsed);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Recipe Matrix backend running on port ${PORT}`));
