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
let conversationMemory = {};

const aiResponses = {
  greeting: [
    [/\b(hi|hello|hey|sup|yo|howdy|good morning|good evening|hey there)\b/i, "Hey there! 👋 I'm Blaze, your web dev tutor. What are you learning today?"],
    [/\b(how are you|how's it going|what's up|wassup)\b/i, "Doing great! Ready to help you code better. What's on your mind?"],
  ],
  thanks: [
    [/\b(thanks|thank you|thx|appreciate)\b/i, "You're welcome! 😊 Keep building and learning. Anything else I can help with?"],
  ],
  about: [
    [/\b(who are you|what are you|tell me about)\b/i, "I'm Blaze — your personal AI tutor for BlazeWebGuide! I help you learn web dev: HTML, CSS, JS, React, Node, Git, and more. Ask me anything!"],
    [/\b(what can you do|help me|how can you)\b/i, "I can explain concepts, debug code, give examples, suggest projects, and guide your learning. Just ask!"],
  ],
  html: [
    [/\b(html|tag|element|div|heading|paragraph|anchor|img)\b/i, "HTML structures web content with tags. Key elements: headings `<h1>-<h6>`, paragraphs `<p>`, links `<a>`, images `<img>`, containers `<div>`, `<span>`. Use semantic tags like `<header>`, `<nav>`, `<main>` for better accessibility. Need help with any specific tag?"],
  ],
  css: [
    [/\b(css|style|styling|flexbox|grid|layout|responsive|animation)\b/i, "CSS makes HTML look good! Key concepts: selectors (`.class`, `#id`), box model (content → padding → border → margin), flexbox (1D layout), grid (2D layout). Use `box-sizing: border-box` for predictable sizing. Want me to dive into any CSS topic?"],
  ],
  js: [
    [/\b(javascript|js|function|variable|promise|async|await|fetch|dom|array|object)\b/i, "JavaScript adds interactivity! Core concepts: variables (`const`/`let`), functions (arrow too!), DOM manipulation, events, promises/async for APIs. Start with basics then move to DOM → events → fetch. What part interests you?"],
  ],
  react: [
    [/\b(react|component|state|hook|jsx|props|useState|useEffect)\b/i, "React is a component-based UI library. Each component returns JSX (HTML-like syntax). `useState` manages data, `useEffect` handles side effects. Props pass data from parent to child. Want to build something in React?"],
  ],
  git: [
    [/\b(git|github|commit|push|pull|branch|merge|clone)\b/i, "Git tracks code changes! Basic flow: `git add .` → `git commit -m 'msg'` → `git push`. Use branches to work on features: `git checkout -b feature-name`. Merge back when done. Need help with a specific git problem?"],
  ],
  general: [
    [/\b(motivate|motivation|stuck|overwhelmed|difficult|hard|frustrated)\b/i, "Learning web dev IS challenging, but you've got this! 💪\n\nTips: 1) Focus on one thing at a time. 2) Build small projects. 3) It's OK to struggle — every dev has been there. 4) Take breaks. 5) Ask questions.\n\nWhat are you working on right now?"],
    [/\b(project|idea|build|create|make|suggest)\b/i, "Building projects is how you level up! 🚀\n\n**Beginner:** Portfolio site, todo app, weather app\n**Intermediate:** Blog platform, e-commerce page, chat app\n**Advanced:** Full-stack social app, real-time collab tool\n\nWhat's your current skill level? I'll suggest the perfect project!"],
    [/\b(learn|study|course|roadmap|path|beginner|start)\b/i, "Great that you're starting your learning journey! Here's a roadmap:\n\n1️⃣ **HTML** (1-2 weeks) — Structure, forms, semantic tags\n2️⃣ **CSS** (2-3 weeks) — Styling, layouts, responsive\n3️⃣ **JavaScript** (4-6 weeks) — Logic, DOM, APIs\n4️⃣ **Git** (1 week) — Version control\n5️⃣ **React/Node** (6-8 weeks) — Modern stack\n\nStart with BlazeWebGuide's Beginner level! Each lesson builds on the last. 🎯"],
  ],
  casual: [
    [/\b(weather|movie|music|game|food|sport|hobby)\b/i, "That sounds fun! 😊 When I'm not helping devs learn, I'm thinking about code. But I can definitely chat about that too! What else are you into?"],
    [/\b(bye|goodbye|see you|later|cya)\b/i, "Catch you later! Keep coding and learning. I'm always here when you need help. 🚀"],
    [/\b(yes|yeah|yep|sure|okay|ok)\b/i, "Awesome! What do you want to learn about specifically? I can dive deep into any web dev topic. 😊"],
    [/\b(no|nah|nope|not really)\b/i, "No problem! Just let me know when you need help with something. I'm here for you!"],
  ]
};

const fallbacks = [
  "I can help with HTML, CSS, JavaScript, React, Git, Node.js, and more! What topic interests you?",
  "Tell me what you're working on and I'll help you figure it out. 😊",
  "I specialize in web development. Got a coding question or just want to chat?",
  "Ask me anything about web dev! I explain concepts, debug code, and suggest projects."
];

app.post('/api/tutor', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.json({ reply: 'Say something! 😊' });
    const msg = message.trim().toLowerCase();
    
    let reply = null;
    for (const [, responses] of Object.entries(aiResponses)) {
      for (const [pattern, response] of responses) {
        if (pattern.test(msg)) { reply = response; break; }
      }
      if (reply) break;
    }
    
    if (!reply) reply = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    
    res.json({ reply });
  } catch (e) {
    res.json({ reply: 'My brain glitched! Can you repeat that? 😅' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`BlazeZone Upgrade Server running on port ${PORT}`);
  console.log(`Player: http://localhost:${PORT}/player?url=STREAM_URL&title=Movie`);
});
