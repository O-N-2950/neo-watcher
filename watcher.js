/**
 * GROUPE NEO — Watcher externe
 * ============================
 * Surveille tous les sites du groupe toutes les 5 min
 * Alerte par SMS (Twilio) + Email (Resend) si un site est down
 * Alerte de rétablissement quand le site revient
 *
 * Variables Railway requises:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 *   RESEND_API_KEY
 *   ALERT_PHONE    → +41795792500
 *   ALERT_EMAIL    → olivier.neukomm@bluewin.ch
 *   PORT           → 3000
 */

const https = require('https');
const http  = require('http');

// ── Configuration ────────────────────────────────────────────────────────────

const SITES = [
  { name: 'WIN WIN',          url: 'https://www.winwin.swiss/api/health', critical: true  },
  { name: 'boom.contact',     url: 'https://www.boom.contact',            critical: true  },
  { name: 'devispro.ch',      url: 'https://www.devispro.ch',             critical: true  },
  { name: 'swissrh.ch',       url: 'https://www.swissrh.ch',              critical: false },
  { name: 'peps.digital',     url: 'https://www.peps.digital',            critical: false },
  { name: 'soluris.ch',       url: 'https://www.soluris.ch',              critical: false },
  { name: 'tournepage.ch',    url: 'https://www.tournepage.ch',           critical: false },
  { name: 'jvais.cool',       url: 'https://www.jvais.cool',              critical: false },
  { name: 'pepssolutions',    url: 'https://www.pepssolutions.digital',   critical: false },
  { name: 'neukomm-group.ch', url: 'https://www.neukomm-group.ch',        critical: false },
  { name: 'pepsstart.ch',     url: 'https://pepsstart.ch',                critical: false },
  { name: 'moneasy.ch',       url: 'https://www.moneasy.ch',              critical: false },
  { name: 'mekano.ch',        url: 'https://www.mekano.ch',               critical: false },
  { name: 'horlogis.ch',      url: 'https://www.horlogis.ch',             critical: false },
];

const INTERVAL_MS     = 5 * 60 * 1000; // 5 minutes
const TIMEOUT_MS      = 10000;          // 10 secondes
const ALERT_PHONE     = process.env.ALERT_PHONE  || '+41795792500';
const ALERT_EMAIL     = process.env.ALERT_EMAIL  || 'olivier.neukomm@bluewin.ch';
const TWILIO_SID      = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM     = process.env.TWILIO_PHONE_NUMBER || '+41325391250';
const RESEND_KEY      = process.env.RESEND_API_KEY;

// ── État en mémoire ───────────────────────────────────────────────────────────
const state = {}; // { [name]: { up: bool, since: Date, consecutiveFails: number, alerted: bool } }
SITES.forEach(s => {
  state[s.name] = { up: true, since: new Date(), consecutiveFails: 0, alerted: false };
});

// ── Checks ────────────────────────────────────────────────────────────────────
function checkSite(site) {
  return new Promise((resolve) => {
    const mod     = site.url.startsWith('https') ? https : http;
    const timeout = setTimeout(() => { req.destroy(); resolve({ ok: false, code: 'TIMEOUT' }); }, TIMEOUT_MS);

    const req = mod.get(site.url, {
      headers: { 'User-Agent': 'NEO-Watcher/1.0' },
      rejectUnauthorized: false, // accepte les certs invalides (swissrh en cours de renouvellement)
    }, (res) => {
      clearTimeout(timeout);
      res.resume(); // drain
      const ok = res.statusCode < 500;
      resolve({ ok, code: res.statusCode });
    });

    req.on('error', (e) => {
      clearTimeout(timeout);
      resolve({ ok: false, code: e.code || 'ERROR', error: e.message });
    });
  });
}

// ── SMS Twilio ────────────────────────────────────────────────────────────────
function sendSMS(message) {
  if (!TWILIO_SID || !TWILIO_TOKEN) {
    console.log('[SMS] Twilio non configuré — skip');
    return Promise.resolve();
  }
  const body = new URLSearchParams({ To: ALERT_PHONE, From: TWILIO_FROM, Body: message });
  return new Promise((resolve) => {
    const auth    = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const options = {
      hostname: 'api.twilio.com',
      path:     `/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      method:   'POST',
      headers:  { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    };
    const req = https.request(options, (res) => {
      res.resume();
      console.log(`[SMS] Envoyé (${res.statusCode}): ${message.substring(0, 60)}`);
      resolve();
    });
    req.on('error', (e) => { console.error('[SMS] Erreur:', e.message); resolve(); });
    req.write(body.toString());
    req.end();
  });
}

// ── Email Resend ──────────────────────────────────────────────────────────────
function sendEmail(subject, html) {
  if (!RESEND_KEY) {
    console.log('[EMAIL] Resend non configuré — skip');
    return Promise.resolve();
  }
  const payload = JSON.stringify({
    from: 'NEO Watcher <contact@winwin.swiss>',
    to: [ALERT_EMAIL],
    subject,
    html,
  });
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers:  {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      res.resume();
      console.log(`[EMAIL] Envoyé (${res.statusCode}): ${subject}`);
      resolve();
    });
    req.on('error', (e) => { console.error('[EMAIL] Erreur:', e.message); resolve(); });
    req.write(payload);
    req.end();
  });
}

// ── Alertes ───────────────────────────────────────────────────────────────────
async function alertDown(site, result) {
  const now = new Date().toLocaleString('fr-CH', { timeZone: 'Europe/Zurich' });
  const msg = `🚨 ${site.name} DOWN\n${site.url}\nCode: ${result.code}\n${now}`;

  console.error(`[ALERT] 🚨 DOWN: ${site.name} (${result.code})`);

  await sendSMS(`WIN WIN Watcher: ${site.name} est DOWN ! Code: ${result.code} — ${now}`);

  await sendEmail(
    `🚨 ALERTE — ${site.name} est DOWN`,
    `<div style="font-family:sans-serif;max-width:500px;">
      <div style="background:#DC2626;color:white;padding:16px 20px;border-radius:10px 10px 0 0;">
        <h2 style="margin:0;">🚨 Site DOWN</h2>
      </div>
      <div style="background:#FEF2F2;padding:20px;border-radius:0 0 10px 10px;border:1px solid #FECACA;">
        <p><strong>Site :</strong> ${site.name}</p>
        <p><strong>URL :</strong> <a href="${site.url}">${site.url}</a></p>
        <p><strong>Code :</strong> ${result.code}</p>
        <p><strong>Heure :</strong> ${now}</p>
        <p style="color:#666;font-size:12px;">NEO Watcher — Groupe Neukomm</p>
      </div>
    </div>`
  );
}

async function alertRecovery(site, downMinutes) {
  const now = new Date().toLocaleString('fr-CH', { timeZone: 'Europe/Zurich' });
  const duration = downMinutes < 60
    ? `${Math.round(downMinutes)} min`
    : `${(downMinutes / 60).toFixed(1)}h`;

  console.log(`[ALERT] ✅ RÉTABLI: ${site.name} (était down ${duration})`);

  await sendSMS(`WIN WIN Watcher: ${site.name} est de nouveau UP ✅ (était down ${duration})`);

  await sendEmail(
    `✅ RÉTABLI — ${site.name}`,
    `<div style="font-family:sans-serif;max-width:500px;">
      <div style="background:#059669;color:white;padding:16px 20px;border-radius:10px 10px 0 0;">
        <h2 style="margin:0;">✅ Site rétabli</h2>
      </div>
      <div style="background:#F0FDF4;padding:20px;border-radius:0 0 10px 10px;border:1px solid #BBF7D0;">
        <p><strong>Site :</strong> ${site.name}</p>
        <p><strong>URL :</strong> <a href="${site.url}">${site.url}</a></p>
        <p><strong>Durée du downtime :</strong> ${duration}</p>
        <p><strong>Rétabli à :</strong> ${now}</p>
        <p style="color:#666;font-size:12px;">NEO Watcher — Groupe Neukomm</p>
      </div>
    </div>`
  );
}

// ── Boucle principale ─────────────────────────────────────────────────────────
async function runChecks() {
  const results = [];

  for (const site of SITES) {
    const result = await checkSite(site);
    const s      = state[site.name];
    const wasUp  = s.up;

    if (result.ok) {
      // Site UP
      if (!wasUp && s.alerted) {
        // Rétablissement
        const downMinutes = (Date.now() - s.since.getTime()) / 60000;
        await alertRecovery(site, downMinutes);
      }
      s.up               = true;
      s.consecutiveFails = 0;
      s.alerted          = false;
      if (!wasUp) s.since = new Date();
    } else {
      // Site DOWN
      s.consecutiveFails++;
      s.up = false;
      if (wasUp) s.since = new Date();

      console.error(`[CHECK] ❌ ${site.name}: ${result.code} (échec #${s.consecutiveFails})`);

      // Alerter après 2 échecs consécutifs (= 10 min) pour éviter les faux positifs
      // Pour les sites critiques: alerter après 1 seul échec
      const threshold = site.critical ? 1 : 2;
      if (s.consecutiveFails >= threshold && !s.alerted) {
        s.alerted = true;
        await alertDown(site, result);
      }
    }

    results.push({ name: site.name, url: site.url, ok: result.ok, code: result.code, critical: site.critical });
  }

  const upCount   = results.filter(r => r.ok).length;
  const downCount = results.filter(r => !r.ok).length;
  const now       = new Date().toLocaleString('fr-CH', { timeZone: 'Europe/Zurich' });

  console.log(`[CHECK] ${now} — ${upCount}/${SITES.length} sites UP${downCount > 0 ? ` | ⚠️ ${downCount} DOWN` : ' ✅'}`);
  return results;
}

// ── Démarrage ─────────────────────────────────────────────────────────────────
console.log('🔭 NEO Watcher démarré');
console.log(`   Sites surveillés: ${SITES.length}`);
console.log(`   Intervalle: ${INTERVAL_MS / 60000} min`);
console.log(`   Alerte SMS: ${ALERT_PHONE}`);
console.log(`   Alerte Email: ${ALERT_EMAIL}`);

// Premier check immédiat
runChecks();

// Check toutes les 5 min
setInterval(runChecks, INTERVAL_MS);

// ── Serveur HTTP minimal (Railway exige un port) ──────────────────────────────
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const status = Object.entries(state).map(([name, s]) => ({
      name,
      up: s.up,
      consecutiveFails: s.consecutiveFails,
      since: s.since,
    }));
    const allUp = status.every(s => s.up);
    res.writeHead(allUp ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: allUp,
      sites: status,
      checked: SITES.length,
      down: status.filter(s => !s.up).length,
      ts: new Date().toISOString(),
    }, null, 2));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`🌐 Status page: http://localhost:${PORT}/health`);
});
