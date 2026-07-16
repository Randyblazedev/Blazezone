import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { writeFileSync, existsSync, readFileSync } from 'fs';

const app = express();
const PORT = process.env.PORT || 3002;
const TMDB_KEY = '484366b7235bc8db84aba0f9e3b1bec6';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── TMDB Search ────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  try {
    const { q, type = 'movie', page = 1 } = req.query;
    if (!q) return res.status(400).json({ error: 'Query required' });
    const { data } = await axios.get(`https://api.themoviedb.org/3/search/${type === 'all' ? 'multi' : type}`, {
      params: { api_key: TMDB_KEY, query: q, page }
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Resolve Stream URL (vidsrc → m3u8) ─────────────────
app.get('/api/stream', async (req, res) => {
  try {
    const { tmdb, type = 'movie', season, episode } = req.query;
    if (!tmdb) return res.status(400).json({ error: 'tmdb ID required' });

    // 1. Get embed page
    const embedPath = type === 'tv'
      ? `https://vidsrc.me/embed/tv?tmdb=${tmdb}&season=${season || 1}&episode=${episode || 1}`
      : `https://vidsrc.me/embed/movie?tmdb=${tmdb}`;

    const embed = await axios.get(embedPath, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    // 2. Extract /rcp/ URL
    const rcpMatch = embed.data.match(/cloudorchestranova\.com\/rcp\/[^"']+/);
    if (!rcpMatch) return res.status(404).json({ error: 'No stream source found' });
    const rcpUrl = `https://${rcpMatch[0]}`;

    // 3. Get /rcp/ page → /prorcp/
    const rcpPage = await axios.get(rcpUrl, {
      headers: { 'Referer': 'https://vsembed.ru/', 'User-Agent': 'Mozilla/5.0' }
    });
    const prorcpMatch = rcpPage.data.match(/src:\s*'(\/prorcp\/[^']+)'/);
    if (!prorcpMatch) return res.status(404).json({ error: 'No prorcp found' });
    const prorcpUrl = `https://cloudorchestranova.com${prorcpMatch[1]}`;

    // 4. Get /prorcp/ page → master_urls
    const prorcpPage = await axios.get(prorcpUrl, {
      headers: { 'Referer': 'https://cloudorchestranova.com/', 'User-Agent': 'Mozilla/5.0' }
    });
    const masterMatch = prorcpPage.data.match(/master_urls\s*=\s*"([^"]+)"/);
    if (!masterMatch) return res.status(404).json({ error: 'No master_urls' });
    const masterTemplate = masterMatch[1];

    // 5. Get JWT token
    const { data: token } = await axios.get('https://peregrinepalaver.space/generate.php');

    // 6. Build final m3u8 URL
    const streamUrl = masterTemplate
      .replace(/__TOKEN__/g, token)
      .replace(/__TOKENPG__/g, token)
      .split(' or ')[0];

    res.json({ streamUrl, token, type: 'hls' });
  } catch (e) {
    console.error('Stream resolve error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Proxy m3u8 segments ───────────────────────────────
app.get('/api/proxy/*', async (req, res) => {
  try {
    const url = req.params[0] + (req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '');
    const fullUrl = url.startsWith('http') ? url : `https://${url}`;
    const { data, headers } = await axios.get(fullUrl, {
      headers: {
        'Referer': 'https://cloudorchestranova.com/',
        'User-Agent': 'Mozilla/5.0'
      },
      responseType: 'stream'
    });
    if (headers['content-type']) res.set('Content-Type', headers['content-type']);
    res.set('Access-Control-Allow-Origin', '*');
    data.pipe(res);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─── Player Page ───────────────────────────────────────
app.get('/player', (req, res) => {
  const { url, title } = req.query;
  if (!url) return res.status(400).send('Missing stream URL');
  res.send(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title || 'BlazeZone'} — Ad-Free</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;color:#fff;font-family:system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column}
.video-wrapper{flex:1;display:flex;align-items:center;justify-content:center;background:#000;position:relative}
video{width:100%;max-height:90vh;outline:none}
.controls{display:flex;gap:12px;padding:16px;background:#111;align-items:center;flex-wrap:wrap}
.controls button,.controls a{padding:10px 20px;border:none;border-radius:8px;background:#e50914;color:#fff;font-weight:600;cursor:pointer;text-decoration:none;font-size:14px}
.controls button:hover,.controls a:hover{background:#ff1a25}
.controls .info{color:#888;font-size:13px;flex:1}
.status{padding:12px;text-align:center;font-size:14px}
.status.loading{color:#ffd600}
.status.error{color:#e50914}
.status.ready{color:#4caf50}
</style>
</head><body>
<div class="video-wrapper">
  <video id="player" controls autoplay></video>
</div>
<div class="controls">
  <div class="info" id="info">Loading stream...</div>
  <button onclick="toggleFullscreen()">⛶ Fullscreen</button>
  <a id="downloadBtn" href="#" download="${title || 'video'}.mp4" style="display:none">⬇ Download</a>
</div>
<div class="status loading" id="status">Initializing player...</div>

<script>
const streamUrl = '${url.replace(/'/g, "\\'")}';
const player = document.getElementById('player');
const status = document.getElementById('status');
const info = document.getElementById('info');
const downloadBtn = document.getElementById('downloadBtn');

async function initPlayer() {
  if (Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(streamUrl);
    hls.attachMedia(player);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      status.className = 'status ready';
      status.textContent = '✓ Stream ready';
      info.textContent = 'Ad-Free | HLS';
      player.play();
    });
    hls.on(Hls.Events.ERROR, (e, data) => {
      if (data.fatal) {
        status.className = 'status error';
        status.textContent = '✗ Stream error. Try another source.';
      }
    });
  } else if (player.canPlayType('application/vnd.apple.mpegurl')) {
    player.src = streamUrl;
    status.className = 'status ready';
    status.textContent = '✓ Stream ready';
  }

  // Download via proxy
  downloadBtn.style.display = 'inline-block';
  downloadBtn.href = '/api/download?url=' + encodeURIComponent(streamUrl) + '&title=' + encodeURIComponent('${title || 'video'}');
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.body.requestFullscreen();
}

initPlayer();
</script>
</body></html>`);
});

// ── Download endpoint ──────────────────────────────────
app.get('/api/download', async (req, res) => {
  try {
    const { url, title } = req.query;
    if (!url) return res.status(400).send('Missing URL');
    res.set('Content-Disposition', `attachment; filename="${(title || 'video').replace(/[^a-zA-Z0-9]/g, '_')}.mp4"`);
    res.set('Content-Type', 'video/mp4');
    const resp = await axios.get(url, {
      headers: { 'Referer': 'https://cloudorchestranova.com/', 'User-Agent': 'Mozilla/5.0' },
      responseType: 'stream'
    });
    resp.data.pipe(res);
  } catch (e) {
    res.status(502).send('Download failed: ' + e.message);
  }
});

// ── AI Tutor ────────────────────────────────────────
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || '';

app.post('/api/tutor', async (req, res) => {
  try {
    const { message, username, mode } = req.body;
    if (!message) return res.json({ reply: 'Say something! 😊' });
    
    const isCodeReview = mode !== 'football' && (message.includes('```') || message.includes('Review this code') || message.includes('review'));
    let systemPrompt;
    
    if (mode === 'football') {
      systemPrompt = 'You are Blaze Predict, a football prediction AI for BlazePredict (randyblazedev.github.io/Blazepredict). You analyze football matches using real form data. Stay neutral and sensible — give balanced analysis with both teams strengths and weaknesses. Mention probability percentages. Avoid over-hyping or being biased. If you lack data, say so. You were built by RandyBlazedev. Keep responses clear and informative.';
    } else {
      systemPrompt = isCodeReview
        ? 'You are a strict but HELPFUL code reviewer for BlazeWebGuide beginners. Rules: 1) If code is wrong/empty, reply FAIL then: explain what error is AND show the correct solution code. 2) If code is correct, reply PASS with brief encouragement. 3) Always start with PASS or FAIL. 4) When FAILing, always include the correct code example so the student can learn. 5) Be clear and educational.'
        : 'You are Blaze, the AI assistant for BlazeWebGuide (blazewebguide.vercel.app). The platform was created by RandyBlazedev (github.com/Randyblazedev), a self-taught developer who built this to help others learn web development. You know everything about the platform: Users can sign in with a username, choose from 4 levels (Beginner, Intermediate, Advanced, Pro), complete lessons with coding challenges, earn certificates with verifiable IDs, and track progress. You help with code, platform navigation, and general chat. Keep responses concise and warm.';
    }
    
    // Try multiple models in order, fallback if one fails
    const models = mode === 'football'
      ? ['deepseek/deepseek-chat:free', 'google/gemma-4-26b-a4b-it:free', 'qwen/qwen3-coder:free', 'openrouter/free']
      : ['google/gemma-4-26b-a4b-it:free', 'qwen/qwen3-coder:free', 'openrouter/free'];
    let reply = null;
    
    for (const model of models) {
      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + OPENROUTER_KEY,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://blazewebguide.vercel.app',
            'X-Title': 'BlazeWebGuide'
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: username ? 'My name is ' + username + '. ' + message : message }
            ],
            max_tokens: isCodeReview ? 150 : 200
          })
        });
        
        const data = await response.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
          reply = data.choices[0].message.content;
          break; // Success, stop trying
        }
      } catch (modelError) {
        console.log('Model ' + model + ' failed, trying next');
      }
    }
    
    if (!reply) reply = isCodeReview ? 'PASS Looks good!' : 'Hmm, I had trouble with that one. Can you rephrase?';
    res.json({ reply });
  } catch (e) {
    console.error('Tutor error:', e.message);
    res.json({ reply: 'My brain glitched! Give me another try? 😅' });
  }
});

// Old keyword-matching system removed — replaced by OpenRouter API call above

app.listen(PORT, '0.0.0.0', () => {
  console.log(`BlazeZone Upgrade Server running on port ${PORT}`);
  console.log(`Player: http://localhost:${PORT}/player?url=STREAM_URL&title=Movie`);
});
