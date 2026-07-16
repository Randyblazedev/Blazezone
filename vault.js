// ── Blaze Vault API ──────────────────────────────────────
// Self-exclusion savings backend
// Works with Flutterwave (test mode by default)
// Replace keys below with your real Flutterwave keys

const VAULT_DATA_PATH = '/home/bwg_data/vaults.json';
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY || 'FLWSECK_TEST-xxxxxxxxxxxx';
const FLW_PUBLIC_KEY = process.env.FLW_PUBLIC_KEY || 'FLWPUBK_TEST-xxxxxxxxxxxx';

function loadVaults() {
  try {
    if (existsSync(VAULT_DATA_PATH)) {
      return JSON.parse(readFileSync(VAULT_DATA_PATH, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return { users: {}, vaults: [] };
}

function saveVaults(data) {
  writeFileSync(VAULT_DATA_PATH, JSON.stringify(data, null, 2));
}

// Create a vault (initiates payment)
app.post('/api/vault/create', async (req, res) => {
  try {
    const { username, name, amount, duration, goal, phone } = req.body;
    if (!username || !name || !amount || !duration || !phone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (amount < 1000) return res.status(400).json({ error: 'Minimum 1,000 FCFA' });

    const data = loadVaults();
    const vaultId = 'VLT-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,5).toUpperCase();

    const vault = {
      id: vaultId,
      username,
      name,
      amount: parseInt(amount),
      goal: goal || 'General',
      phone,
      duration: parseInt(duration),
      createdAt: new Date().toISOString(),
      unlockAt: new Date(Date.now() + parseInt(duration) * 30 * 86400000).toISOString(),
      status: 'pending', // pending → locked → unlocked
      paymentRef: null,
      txRef: null
    };

    if (!data.users[username]) data.users[username] = { username, vaults: [] };
    data.users[username].vaults.push(vaultId);
    data.vaults.push(vault);
    saveVaults(data);

    // In test mode, auto-confirm payment
    const isTest = FLW_SECRET_KEY.includes('TEST') || FLW_SECRET_KEY.includes('xxxxx');
    if (isTest) {
      vault.status = 'locked';
      vault.paymentRef = 'TEST-REF-' + vaultId;
      vault.txRef = 'TEST-TX-' + vaultId;
      saveVaults(data);
      return res.json({ success: true, vault, testMode: true, message: 'Test vault created! Funds are locked.' });
    }

    // Real Flutterwave payment would go here
    res.json({ success: true, vault, message: 'Vault created. Complete payment to lock funds.' });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get user vaults
app.get('/api/vault/list', (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'Username required' });

    const data = loadVaults();
    const userVaults = data.vaults.filter(v => v.username === username);

    // Auto-update status for unlocked vaults
    const now = Date.now();
    userVaults.forEach(v => {
      if (v.status === 'locked' && now >= new Date(v.unlockAt).getTime()) {
        v.status = 'unlocked';
      }
    });
    saveVaults(data);

    const totalLocked = userVaults.filter(v => v.status === 'locked').reduce((s, v) => s + v.amount, 0);
    const totalUnlocked = userVaults.filter(v => v.status === 'unlocked').reduce((s, v) => s + v.amount, 0);

    res.json({
      vaults: userVaults,
      stats: {
        totalLocked,
        totalUnlocked,
        activeCount: userVaults.filter(v => v.status === 'locked').length,
        completedCount: userVaults.filter(v => v.status === 'unlocked').length
      }
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Withdraw from an unlocked vault
app.post('/api/vault/withdraw', async (req, res) => {
  try {
    const { vaultId, username } = req.body;
    if (!vaultId || !username) return res.status(400).json({ error: 'Missing fields' });

    const data = loadVaults();
    const vault = data.vaults.find(v => v.id === vaultId && v.username === username);

    if (!vault) return res.status(404).json({ error: 'Vault not found' });
    if (vault.status !== 'unlocked') return res.status(400).json({ error: 'Vault is still locked' });

    // In test mode, just mark as withdrawn
    const isTest = FLW_SECRET_KEY.includes('TEST') || FLW_SECRET_KEY.includes('xxxxx');
    if (isTest) {
      vault.status = 'withdrawn';
      saveVaults(data);
      return res.json({ success: true, message: `${vault.amount.toLocaleString()} FCFA withdrawn to ${vault.phone}`, testMode: true });
    }

    // Real payout via Flutterwave would go here
    vault.status = 'withdrawn';
    saveVaults(data);
    res.json({ success: true, message: 'Withdrawal initiated to ' + vault.phone });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Flutterwave webhook (for real payments)
app.post('/api/vault/webhook', (req, res) => {
  const event = req.body;
  if (event.event === 'charge.completed' && event.data) {
    const data = loadVaults();
    const vault = data.vaults.find(v => v.txRef === event.data.tx_ref);
    if (vault && vault.status === 'pending') {
      vault.status = 'locked';
      vault.paymentRef = event.data.id;
      saveVaults(data);
    }
  }
  res.sendStatus(200);
});

// Health check
app.get('/api/vault/health', (req, res) => {
  const data = loadVaults();
  res.json({
    status: 'ok',
    totalVaults: data.vaults.length,
    totalUsers: Object.keys(data.users).length,
    mode: FLW_SECRET_KEY.includes('TEST') || FLW_SECRET_KEY.includes('xxxxx') ? 'test' : 'live'
  });
});

console.log('Blaze Vault API loaded');
