/**
 * GROUPE NEO — Watcher externe v2
 * ===============================
 * Surveille tous les sites du groupe toutes les 3 min
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
// critical: true → alerte au 1er échec (sites avec clients réels)
// critical: false → alerte après 2 échecs consécutifs (sites secondaires)
// healthPath: chemin de healthcheck spécifique (sinon racine)

const SITES = [
  // === CRITIQUES (clients réels) ===
  { name: 'WIN WIN',          url: 'https://www.winwin.swiss/api/health',     critical: true,  expectJson: true  },
  { name: 'Tournepage',       url: 'https://tournepage.ch/api/health',        critical: true,  expectJson: true  },
  { name: 'SwissRH',          url: 'https://www.swissrh.ch',                  critical: true  },
  { name: 'DevisPro',         url: 'https://www.devispro.ch',                 critical: true  },
  { name: 'Soluris',          url: 'https://www.soluris.ch',                  critical: true  },
  { name: 'STAR-MIX',         url: 'https://www.star-mix.ch',                 critical: true  },
  { name: 'Boom Contact',     url: 'https://boom.contact',                    critical: true  },
  { name: 'Placio',           url: 'https://www.placio.ch',                   critical: true  },
  { name: 'PEPs Digital',     url: 'https://www.peps.digital',                critical: true  },

  // === IMPORTANTS (utilisateurs réguliers) ===
  { name: 'Immo Cool',        url: 'https://immocool.ch',                     critical: false },
  { name: 'Horlogis',         url: 'https://www.horlogis.ch',                 critical: false },
  { name: 'Planneo',          url: 'https://plan.winwin.swiss',               critical: false },
  { name: 'PepsStart',        url: 'https://www.pepsstart.ch',                critical: false },
  { name: 'PEPs Solutions',   url: 'https://www.pepssolutions.digital',       critical: false },
  { name: 'PEPs Swiss',       url: 'https://peps.swiss',                      critical: false },
  { name: 'Matcho',           url: 'https://www.matcho.digital',              critical: false },
  { name: 'J\'VAIS Cool',     url: 'https://www.jvais.cool',                  critical: false },
  { name: 'J\'VAIS Digital',  url: 'https://www.jvais.digital',               critical: false },
  { name: 'MonEasy',          url: 'https://www.moneasy.ch',                  critical: false },
  { name: 'Mekano',           url: 'https://www.mekano.ch',                   critical: false },
  { name: 'CCTSwiss',         url: 'https://www.cctswiss.ch',                 critical: false },
  { name: 'PepsAva',          url: 'https://www.pepsava.com',                 critical: false },
  { name: 'JuraiTax',         url: 'https://www.juraitax.ch',                 critical: false },
  { name: 'Neukomm Group',    url: 'https://www.neukomm-group.ch',            critical: false },
  { name: 'Taix',             url: 'https://www.taix.ch',                     critical: false },
  { name: 'Talentis',         url: 'https://talentis.winwin.swiss',           critical: false },
  { name: 'Durabilis',        url: 'https://durabilis.winwin.swiss',          critical: false },
];

const INTERVAL_MS  = 3 * 60 * 1000;  // 3 minutes (avant: 5)
const TIMEOUT_MS   = 12000;          // 12 secondes (avant: 10)
const ALERT_PHONE  = process.env.ALERT_PHONE  || '+41795792500';
const ALERT_EMAIL  = process.env.ALERT_EMAIL  || 'olivier.neukomm@bluewin.ch';
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_PHONE_NUMBER || '+41325391250';
const RESEND_KEY   = process.env.RESEND_API_KEY;

// ── État en mémoire ───────────────────────────────────────────────────────────
const state = {};
SITES.forEach(s => {
  state[s.name] = { up: true, since: new Date(), consecutiveFails: 0, alerted: false, lastCheck: null, lastCode: null };
});

// ── Checks ────────────────────────────────────────────────────────────────────
function checkSite(site) {
  return new Promise((resolve) => {
    const mod     = site.url.startsWith('https') ? https : http;
    let body      = '';
    const timeout = setTimeout(() => {
      if (req && !req.destroyed) req.destroy();
      resolve({ ok: false, code: 'TIMEOUT' });
    }, TIMEOUT_MS);

    const req = mod.get(site.url, {
      headers: { 'User-Agent': 'NEO-Watcher/2.0' },
      rejectUnauthorized: false,
    }, (res) => {
      res.on('data', (chunk) => { if (body.length < 4096) body += chunk; });
      res.on('end', () => {
        clearTimeout(timeout);
        const ok = res.statusCode >= 200 && res.statusCode < 400;

        // Validation supplémentaire si JSON attendu
        if (ok && site.expectJson) {
          try {
            const json = JSON.parse(body);
            if (json.status === 'ok' || json.ok === true || json.success === true) {
              return resolve({ ok: true, code: res.statusCode, body: json });
            }
            return resolve({ ok: false, code: `${res.statusCode}_BAD_JSON`, body: json });
          } catch (e) {
            return resolve({ ok: false, code: `${res.statusCode}_NO_JSON`, error: e.message });
          }
        }

        resolve({ ok, code: res.statusCode });
      });
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
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const req = https.request({
      hostname: 'api.twilio.com',
      path:     `/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      method:   'POST',
      headers:  { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    }, (res) => { res.resume(); console.log(`[SMS] Envoyé (${res.statusCode}): ${message.substring(0, 60)}`); resolve(); });
    req.on('error', (e) => { console.error('[SMS] Erreur:', e.message); resolve(); });
    req.write(body.toString());
    req.end();
  });
}

// ── Email Resend ──────────────────────────────────────────────────────────────
function sendEmail(subject, html) {
  if (!RESEND_KEY) { console.log('[EMAIL] Resend non configuré — skip'); return Promise.resolve(); }
  const payload = JSON.stringify({
    from: 'NEO Watcher <contact@winwin.swiss>',
    to: [ALERT_EMAIL],
    subject,
    html,
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers:  {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => { res.resume(); console.log(`[EMAIL] Envoyé (${res.statusCode}): ${subject}`); resolve(); });
    req.on('error', (e) => { console.error('[EMAIL] Erreur:', e.message); resolve(); });
    req.write(payload);
    req.end();
  });
}

// ── Alertes ───────────────────────────────────────────────────────────────────
async function alertDown(site, result) {
  const now = new Date().toLocaleString('fr-CH', { timeZone: 'Europe/Zurich' });
  const tag = site.critical ? '🔴 CRITIQUE' : '🟠 ALERTE';
  console.error(`[ALERT] ${tag} DOWN: ${site.name} (${result.code})`);

  await sendSMS(`NEO Watcher: ${site.name} DOWN ${site.critical ? '(CRITIQUE)' : ''} — Code ${result.code} — ${now}`);

  await sendEmail(
    `${tag} — ${site.name} est DOWN`,
    `<div style="font-family:sans-serif;max-width:520px;">
      <div style="background:${site.critical?'#DC2626':'#F59E0B'};color:white;padding:16px 20px;border-radius:10px 10px 0 0;">
        <h2 style="margin:0;">${tag} — Site DOWN</h2>
      </div>
      <div style="background:#FEF2F2;padding:20px;border-radius:0 0 10px 10px;border:1px solid #FECACA;">
        <p><strong>Site :</strong> ${site.name}</p>
        <p><strong>URL :</strong> <a href="${site.url}">${site.url}</a></p>
        <p><strong>Code :</strong> ${result.code}</p>
        <p><strong>Niveau :</strong> ${site.critical ? 'Critique (alerte immédiate)' : 'Important (après 2 échecs consécutifs)'}</p>
        <p><strong>Heure :</strong> ${now}</p>
        <p style="color:#666;font-size:12px;margin-top:16px;">NEO Watcher v2 — Groupe NEO</p>
      </div>
    </div>`
  );
}

async function alertRecovery(site, downMinutes) {
  const now = new Date().toLocaleString('fr-CH', { timeZone: 'Europe/Zurich' });
  const duration = downMinutes < 60 ? `${Math.round(downMinutes)} min` : `${(downMinutes / 60).toFixed(1)} h`;
  console.log(`[ALERT] ✅ RÉTABLI: ${site.name} (down ${duration})`);

  await sendSMS(`NEO Watcher: ${site.name} de retour UP ✅ (était down ${duration})`);

  await sendEmail(
    `✅ RÉTABLI — ${site.name}`,
    `<div style="font-family:sans-serif;max-width:520px;">
      <div style="background:#059669;color:white;padding:16px 20px;border-radius:10px 10px 0 0;">
        <h2 style="margin:0;">✅ Site rétabli</h2>
      </div>
      <div style="background:#F0FDF4;padding:20px;border-radius:0 0 10px 10px;border:1px solid #BBF7D0;">
        <p><strong>Site :</strong> ${site.name}</p>
        <p><strong>URL :</strong> <a href="${site.url}">${site.url}</a></p>
        <p><strong>Durée du downtime :</strong> ${duration}</p>
        <p><strong>Rétabli à :</strong> ${now}</p>
        <p style="color:#666;font-size:12px;margin-top:16px;">NEO Watcher v2 — Groupe NEO</p>
      </div>
    </div>`
  );
}

// ── Boucle principale ─────────────────────────────────────────────────────────
async function runChecks() {
  const results = [];
  for (const site of SITES) {
    const result = await checkSite(site);
    const s = state[site.name];
    const wasUp = s.up;
    s.lastCheck = new Date();
    s.lastCode = result.code;

    if (result.ok) {
      if (!wasUp && s.alerted) {
        const downMinutes = (Date.now() - s.since.getTime()) / 60000;
        await alertRecovery(site, downMinutes);
      }
      s.up = true;
      s.consecutiveFails = 0;
      s.alerted = false;
      if (!wasUp) s.since = new Date();
    } else {
      s.consecutiveFails++;
      s.up = false;
      if (wasUp) s.since = new Date();
      console.error(`[CHECK] ❌ ${site.name}: ${result.code} (échec #${s.consecutiveFails})`);
      const threshold = site.critical ? 1 : 2;
      if (s.consecutiveFails >= threshold && !s.alerted) {
        s.alerted = true;
        await alertDown(site, result);
      }
    }
    results.push({ name: site.name, url: site.url, ok: result.ok, code: result.code, critical: site.critical });
  }

  const upCount = results.filter(r => r.ok).length;
  const downCount = results.filter(r => !r.ok).length;
  const now = new Date().toLocaleString('fr-CH', { timeZone: 'Europe/Zurich' });
  console.log(`[CHECK] ${now} — ${upCount}/${SITES.length} UP${downCount > 0 ? ` | ⚠️ ${downCount} DOWN` : ' ✅'}`);
  return results;
}

// ── Démarrage ─────────────────────────────────────────────────────────────────
console.log('🔭 NEO Watcher v2 démarré');
console.log(`   Sites surveillés: ${SITES.length} (${SITES.filter(s => s.critical).length} critiques)`);
console.log(`   Intervalle: ${INTERVAL_MS / 60000} min`);
console.log(`   Alerte SMS: ${ALERT_PHONE}`);
console.log(`   Alerte Email: ${ALERT_EMAIL}`);

runChecks();
setInterval(runChecks, INTERVAL_MS);

// ── Serveur HTTP ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const status = Object.entries(state).map(([name, s]) => {
      const site = SITES.find(x => x.name === name);
      return {
        name,
        up: s.up,
        critical: site ? site.critical : false,
        consecutiveFails: s.consecutiveFails,
        lastCode: s.lastCode,
        since: s.since,
        downMinutes: !s.up ? Math.round((Date.now() - s.since.getTime()) / 60000) : 0,
      };
    });
    const allUp = status.every(s => s.up);
    res.writeHead(allUp ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: allUp,
      version: '2.0',
      sites: status,
      checked: SITES.length,
      down: status.filter(s => !s.up).length,
      criticalDown: status.filter(s => !s.up && s.critical).length,
      ts: new Date().toISOString(),
    }, null, 2));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`🌐 Status: http://localhost:${PORT}/health`);
});
