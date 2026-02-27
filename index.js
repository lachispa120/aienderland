import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import Groq from 'groq-sdk';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const token = process.env.DISCORD_TOKEN;
const groqKey = process.env.GROQ_API_KEY;

if (!token || !groqKey) {
  console.error('Faltan credenciales en .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const groq = new Groq({ apiKey: groqKey });

const STATS = { startedAt: Date.now(), total: 0, success: 0, errors: 0, latencies: [] };
const MAX_LAT_SAMPLES = 50;
function avg(arr) { return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0; }

// Rotación de APIs Groq
function collectGroqKeysFromEnv() {
  const list = [];
  const rawList = (process.env.GROQ_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  list.push(...rawList);
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (k === 'GROQ_API_KEY' || /^GROQ_API_KEY_\d+$/i.test(k)) {
      list.push(String(v).trim());
    }
  }
  // Unificar y filtrar formato
  const seen = new Set();
  const out = [];
  for (const key of list) {
    if (!key || seen.has(key)) continue;
    if (!key.startsWith('gsk_')) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
const GROQ_KEYS = collectGroqKeysFromEnv();
const groqClients = new Map();
function getGroqForKey(k) {
  let c = groqClients.get(k);
  if (!c) {
    c = new Groq({ apiKey: k });
    groqClients.set(k, c);
  }
  return c;
}
const groqStates = GROQ_KEYS.map(k => ({ key: k, cooldownUntil: 0, disabled: false }));
let groqCursor = 0;
function nextGroqKeyIndex() {
  if (groqStates.length === 0) return -1;
  const now = Date.now();
  for (let i = 0; i < groqStates.length; i++) {
    const idx = (groqCursor + i) % groqStates.length;
    const s = groqStates[idx];
    if (!s.disabled && now >= s.cooldownUntil) {
      groqCursor = (idx + 1) % groqStates.length;
      return idx;
    }
  }
  return -1;
}

console.log("Intentando conectar a Discord...");

client.login(process.env.DISCORD_TOKEN).then(() => {
    console.log(`✅ Bot conectado con éxito como: ${client.user.tag}`);
}).catch((error) => {
    console.error("❌ ERROR AL CONECTAR A DISCORD:");
    console.error(error.message);
    if (error.message.includes("Used disallowed intents")) {
        console.error("👉 SOLUCIÓN: Tenés que activar los Privileged Intents en el Discord Developer Portal.");
    } else if (error.message.includes("An invalid token was provided")) {
        console.error("👉 SOLUCIÓN: El DISCORD_TOKEN en Render está mal copiado o expiró.");
    }
});

// Fuentes de contenido (precios y reglas)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
function readTextRel(relPath) {
  try {
    return readFileSync(join(__dirname, relPath), 'utf8');
  } catch (e) {
    console.warn(`No se pudo leer ${relPath}: ${e.message}`);
    return '';
  }
}
const RANGOS_INFO = readTextRel('precios_rangos.txt');
const REGLAS_VANILLA = readTextRel('reglas vanilla.txt');
const REGLAS_SEMI = readTextRel('reglas semianarquico.txt');

const GEMINI_KEYS = (process.env.GEMINI_KEYS || process.env.GEMINI_KEY || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const DEFAULT_RPM_LIMIT = 15;
const USER_COOLDOWN_MS = 15_000;
const GLOBAL_COOLDOWN_MS = 3_000;

const keyStates = GEMINI_KEYS.map(k => ({
  key: k,
  cooldownUntil: 0,
  perMinute: [],
  lastModel: null,
  lastApiVersion: null,
}));
let keyIndex = 0;

const genAIClients = new Map();
function getGenAIForKey(k) {
  let c = genAIClients.get(k);
  if (!c) {
    c = new GoogleGenerativeAI(k);
    genAIClients.set(k, c);
  }
  return c;
}

function nextAvailableKeyIndex() {
  if (keyStates.length === 0) return -1;
  const now = Date.now();
  for (let i = 0; i < keyStates.length; i++) {
    const idx = (keyIndex + i) % keyStates.length;
    if (now >= keyStates[idx].cooldownUntil) {
      keyIndex = (idx + 1) % keyStates.length;
      return idx;
    }
  }
  return -1;
}

let lastModelUsed = null;
let lastApiVersionUsed = null;
let nextRetryAtTS = 0;

const perUserCooldown = new Map(); // userId -> timestamp
let lastGlobalAt = 0;

const cache = new Map(); // normalized question -> { answer, ts }
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 10;

async function generateWithFallback(prompt, keyEntry) {
  const apiVersions = ['v1', 'v1beta'];
  const prefer = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro', 'gemini-1.0-pro', 'gemini-1.5-flash-001', 'gemini-1.5-flash-latest', 'gemini-1.5-pro-001'];

  const client = getGenAIForKey(keyEntry.key);

  // Try cached pick first
  if (keyEntry.lastModel && keyEntry.lastApiVersion) {
    try {
      const mdl = client.getGenerativeModel({ model: keyEntry.lastModel }, { apiVersion: keyEntry.lastApiVersion });
      return await mdl.generateContent(prompt);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      const is404 = (e && e.status === 404) || msg.includes('not found') || msg.includes('not supported for generateContent');
      const is429 = (e && e.status === 429) || msg.includes('Too Many Requests') || msg.includes('Quota');
      if (is429) throw e;
      if (!is404) throw e;
      // else fall through to discovery
    }
  }

  for (const apiVersion of apiVersions) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/${apiVersion}/models?key=${encodeURIComponent(keyEntry.key)}`);
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`ListModels ${apiVersion} ${r.status} ${r.statusText} ${text}`);
      }
      const data = await r.json();
      const models = Array.isArray(data.models) ? data.models : [];
      const support = models.filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'));
      const byName = prefer.find(p => support.some(m => (m.name && m.name.endsWith(`/${p}`)) || m.name === p));
      const pick = byName || (support[0] && (support[0].name.split('/').pop()));
      if (!pick) continue;
      const mdl = client.getGenerativeModel({ model: pick }, { apiVersion });
      try {
        const out = await mdl.generateContent(prompt);
        keyEntry.lastModel = pick;
        keyEntry.lastApiVersion = apiVersion;
        return out;
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        const is404 = (e && e.status === 404) || msg.includes('not found') || msg.includes('is not found') || msg.includes('not supported for generateContent');
        const is429 = (e && e.status === 429) || msg.includes('Too Many Requests') || msg.includes('Quota');
        if (is404) continue;
        if (is429) throw e;
        throw e;
      }
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      const is404 = (e && e.status === 404) || msg.includes('not found') || msg.includes('is not found') || msg.includes('not supported for generateContent');
      if (!is404) {
        throw e;
      }
    }
  }
  const err = new Error('No se encontró un modelo compatible para generateContent en v1 ni v1beta');
  err.status = 404;
  throw err;
}

function parseRetryDelaySeconds(err) {
  if (err && Array.isArray(err.errorDetails)) {
    for (const d of err.errorDetails) {
      if (d && (d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo') && typeof d.retryDelay === 'string') {
        const m = d.retryDelay.match(/(\d+)/);
        if (m) return Math.min(60, Math.max(1, parseInt(m[1], 10)));
      }
    }
  }
  const msg = String(err && err.message ? err.message : err || '');
  const m2 = msg.match(/retry in (\d+(\.\d+)?)s/i);
  if (m2) return Math.min(60, Math.max(1, Math.ceil(parseFloat(m2[1]))));
  return 0;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseQuotaType(err) {
  let type = 'unknown';
  if (err && Array.isArray(err.errorDetails)) {
    for (const d of err.errorDetails) {
      if (d && d['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure' && Array.isArray(d.violations)) {
        for (const v of d.violations) {
          const qid = String((v && v.quotaId) || '');
          if (qid.toLowerCase().includes('day')) type = 'per_day';
        }
      }
    }
  }
  if (type === 'unknown') {
    const delay = parseRetryDelaySeconds(err);
    if (delay > 0 && delay <= 60) type = 'per_minute';
  }
  return type;
}

const instruccionesEnderland =
  'Hablá directo, sin vueltas: soná como admin copado, no como bot. Usá modismos argentinos (che, mirá, capo, posta, fijate). Formato scannable: marcá en **negrita** lo importante.\n' +
  'Datos rápidos:\n' +
  '- **IP:** Play.enderland.org\n' +
  '- **Bedrock:** puerto **25581**\n' +
  '- **Versiones:** 1.16.x a 1.21.4 (no superiores)\n' +
  '- **Modalidades:** Semi‑Anarchy, Vanilla, Skyblock, OneBlock\n' +
  '- **Soporte:** abrí ticket en <#1468130126356283600>\n' +
  '- **Tienda:** enderland.org (siempre hay ofertas)\n' +
  'Estilo de respuesta:\n' +
  '- Evitá arrancar con “Bienvenido/a”. Sé breve y claro, como charla entre players.\n' +
  '- Usá **negritas** para IP, versiones y soporte; no metas paja.\n' +
  'Compra (resumen): Elegí el producto → carrito → verificá modalidad/regalo → poné tu **USERNAME o ID de Discord** → “Generar pedido” → aceptá la invitación al ticket. Si no se crea solo, abrilo en <#1468130126356283600>.\n' +
  '\nRangos y precios (usá como fuente, no vuelques todo de una):\n' +
  RANGOS_INFO +
  '\nSi la consulta es general sobre rangos, primero preguntá: “¿de qué rango querés saber?”. Si piden un rango puntual, respondé solo ese rango con precios (mensual y permanente) y beneficios, en bullets y con **negritas** en los montos.\n' +
  '\nReglas por modalidad (usá como referencia y devolvé solo la modalidad pedida):\n' +
  '--- REGLAS VANILLA ---\n' +
  REGLAS_VANILLA +
  '\n--- REGLAS SEMI‑ANÁRQUICO ---\n' +
  REGLAS_SEMI +
  '\n\nConversión de precios y métodos de pago:\n' +
  '- Regla de Oro: 1 USD = **1550 ARS** (Enderland).\n' +
  '- Cálculo:\n' +
  '  1) Tomá el precio en ARS (el que diga el usuario o el que veas en la tienda).\n' +
  '  2) Dividilo por 1550 para obtener el valor en USD.\n' +
  '  3) Multiplicá esos USD por la tasa del país del usuario.\n' +
  '- Tasas de referencia (1 USD equivale a):\n' +
  '  • Perú (PEN): 3.75 | Uruguay (UYU): 38.70 | Chile (CLP): 960 | México (MXN): 17.20 | Colombia (COP): 3950 | Bolivia (BOB): 6.90 | Paraguay (PYG): 7400\n' +
  '- Métodos de pago:\n' +
  '  • Perú: tarjetas locales o **Global66**.\n' +
  '  • Argentina: **Transferencia CBU/CVU** y billeteras virtuales.\n' +
  '  • Latam (Global): Tarjetas (Visa, Mastercard, AmEx), Apps (Belo, PayPal, Global66), Cripto (BTC, ETH, USDT).\n' +
  '- Estructura de respuesta sugerida (no la muestres literal):\n' +
  '  • Para el rango [Nombre]:\n' +
  '    – Precio en Argentina: **[ARS] ARS**.\n' +
  '    – Precio en USD: **$[USD]** (dólar a 1550 ARS).\n' +
  '    – Precio en tu moneda ([País]): **[Local] [Moneda]**.\n' +
  '  • ¿Cómo pagar? Según [País]: [método recomendado] + tarjetas, Belo/PayPal/Global66 y cripto.\n' +
  '  • Link: **enderland.org**\n' +
  '- Si el usuario no da el precio en ARS, pedilo amablemente antes de convertir.\n' +
  '- Hacé respuestas únicas, claras y ordenadas en secciones; no repitas info innecesaria.';

function chunkText(text, max = 1900) {
  const parts = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + line + '\n').length > max) {
      if (current) parts.push(current);
      if (line.length > max) {
        let start = 0;
        while (start < line.length) {
          parts.push(line.slice(start, start + max));
          start += max;
        }
        current = '';
      } else {
        current = line + '\n';
      }
    } else {
      current += line + '\n';
    }
  }
  if (current.trim().length) parts.push(current.trim());
  return parts;
}

client.on('clientready', () => {
  console.log(`Bot conectado como ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const ALLOWED_CHANNEL_ID = '1475967861833994331';
  if (message.channelId !== ALLOWED_CHANNEL_ID) return;
  const content = message.content.trim();
  const STAFF_ROLE_ID = '1468130937681477776';
  const isStaff = !!message.member && message.member.roles && message.member.roles.cache.has(STAFF_ROLE_ID);
  if (content.toLowerCase().startsWith('!quota')) return;
  if (content.toLowerCase().startsWith('!status')) {
    if (!isStaff) return;
    const upMs = Date.now() - (STATS.startedAt || Date.now());
    const upMin = Math.floor(upMs / 60000);
    const avgMs = avg(STATS.latencies);
    const lastMs = STATS.latencies.length ? STATS.latencies[STATS.latencies.length - 1] : 0;
    const msg = [
      `Uptime: ${upMin}m`,
      `Modelo: llama-3.3-70b-versatile`,
      `Total: ${STATS.total} | OK: ${STATS.success} | Err: ${STATS.errors}`,
      `Latencia: avg ${avgMs}ms | última ${lastMs}ms`,
      `Cache: ${cache.size}/${CACHE_MAX} | TTL: ${Math.round(CACHE_TTL_MS/60000)}m`,
      `Cooldown usuario: ${Math.round(USER_COOLDOWN_MS/1000)}s`,
      `Canal: ${ALLOWED_CHANNEL_ID}`
    ].join('\n');
    await message.reply(msg);
    return;
  }
  if (content.toLowerCase().startsWith('!keys')) {
    if (!isStaff) return;
    if (!groqStates.length) {
      await message.reply('No hay claves GROQ configuradas.');
      return;
    }
    const now = Date.now();
    const lines = groqStates.map((s, i) => {
      const wait = Math.max(0, Math.ceil((s.cooldownUntil - now) / 1000));
      const mask = s.key.slice(-4).padStart(s.key.length, '*');
      const status = s.disabled ? 'deshabilitada' : (wait > 0 ? `cooldown ${wait}s` : 'ok');
      return `GROQ#${i + 1} ${mask} | ${status}`;
    });
    await message.reply(lines.join('\n'));
    return;
  }
  if (content.toLowerCase().startsWith('!addgroqkey ')) {
    if (!isStaff) return;
    const newKey = content.slice('!addgroqkey '.length).trim();
    if (!newKey || !newKey.startsWith('gsk_')) {
      await message.reply('Formato inválido. Uso: !addgroqkey gsk_xxx (solo STAFF)');
      return;
    }
    // Evitar duplicados exactos
    if (groqStates.some(s => s.key === newKey)) {
      await message.reply('Esa clave ya está cargada.');
      return;
    }
    groqStates.push({ key: newKey, cooldownUntil: 0, disabled: false });
    const mask = newKey.slice(-4).padStart(newKey.length, '*');
    await message.reply(`Clave agregada: ${mask}. Usaremos rotación en esta sesión.`);
    return;
  }
  if (content.toLowerCase().startsWith('!rmgroqkey ')) {
    if (!isStaff) return;
    const token = content.slice('!rmgroqkey '.length).trim();
    if (!token) {
      await message.reply('Uso: !rmgroqkey <últimos 4 o clave completa>');
      return;
    }
    const before = groqStates.length;
    for (let i = groqStates.length - 1; i >= 0; i--) {
      const s = groqStates[i];
      if (s.key === token || s.key.endsWith(token)) {
        groqStates.splice(i, 1);
      }
    }
    if (groqStates.length === before) {
      await message.reply('No encontré una clave que coincida.');
    } else {
      await message.reply('Clave(s) removida(s).');
    }
    return;
  }
  if (!content.toLowerCase().startsWith('!ai')) return;

  // Global cooldown
  const nowTs = Date.now();
  if (!isStaff) {
    if (nowTs - lastGlobalAt < GLOBAL_COOLDOWN_MS) {
      const rem = Math.ceil((GLOBAL_COOLDOWN_MS - (nowTs - lastGlobalAt)) / 1000);
      await message.reply(`Tranca, dame ${rem}s y te contesto.`);
      return;
    }
    // Per-user cooldown
    const lastUserTs = perUserCooldown.get(message.author.id) || 0;
    if (nowTs - lastUserTs < USER_COOLDOWN_MS) {
      const rem = Math.ceil((USER_COOLDOWN_MS - (nowTs - lastUserTs)) / 1000);
      await message.reply(`Che ${message.member?.displayName || ''}, esperá ${rem}s entre preguntas.`);
      return;
    }
  }

  const query = content.slice(3).trim();
  if (!query) {
    await message.reply('Uso: !ai [pregunta]');
    return;
  }

  // Cache check
  const keyQ = query.toLowerCase().trim();
  const cached = cache.get(keyQ);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    const partsCached = chunkText(cached.answer);
    for (const part of partsCached) {
      await message.reply(part);
    }
    return;
  }

  let typingTimer;
  try {
    await message.channel.sendTyping();
    typingTimer = setInterval(() => {
      message.channel.sendTyping().catch(() => {});
    }, 9000);

    const promptCompleto =
      `Instrucciones: ${instruccionesEnderland}\n\n` +
      'Responde en español rioplatense, claro y directo. Cuando corresponda, recordá la IP, versiones soportadas y el canal de soporte.\n' +
      `Pregunta del usuario: ${query}`;

    // Envío a Groq con rotación de keys
    let textGroq = '';
    let tried = 0;
    const attempts = [];
    while (tried < Math.max(1, groqStates.length)) {
      const idx = nextGroqKeyIndex();
      if (idx === -1) break;
      const s = groqStates[idx];
      tried++;
      const t0 = Date.now();
      try {
        const client = getGroqForKey(s.key);
        const completion = await client.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: instruccionesEnderland + '\nResponde en español rioplatense, claro y directo. Usá **negritas** en datos importantes y no vuelques toda la info de rangos salvo que te pidan un rango puntual.' },
            { role: 'user', content: query }
          ],
          temperature: 0.7
        });
        textGroq = completion?.choices?.[0]?.message?.content || '';
        if (!textGroq || !textGroq.trim().length) {
          throw new Error('Texto vacío desde Groq');
        }
        const dt = Date.now() - t0;
        STATS.total += 1;
        STATS.success += 1;
        STATS.latencies.push(dt);
        if (STATS.latencies.length > MAX_LAT_SAMPLES) STATS.latencies.shift();
        break;
      } catch (e) {
        STATS.total += 1;
        STATS.errors += 1;
        const msg = String(e && e.message ? e.message : e);
        const isRate = msg.toLowerCase().includes('rate') || msg.includes('429') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('insufficient');
        attempts.push({ key: `***${s.key.slice(-4)}`, err: msg.slice(0, 80) });
        if (isRate) {
          s.cooldownUntil = Date.now() + 60_000;
          continue;
        }
        // Si es otro error (auth, etc.), deshabilitamos la key
        s.disabled = true;
        continue;
      }
    }
    if (!textGroq) {
      console.error('Intentos de claves Groq:', attempts);
      await message.reply('Che, se me cortó el cable, probá de nuevo en un toque.');
      return;
    }
    const partsFast = chunkText(textGroq);
    for (const part of partsFast) {
      await message.reply(part);
    }
    cache.set(keyQ, { answer: textGroq, ts: Date.now() });
    if (cache.size > CACHE_MAX) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    if (!isStaff) {
      perUserCooldown.set(message.author.id, Date.now());
    }
    return;
    // update cooldowns (no cooldown for staff)
    if (!isStaff) {
      lastGlobalAt = Date.now();
      perUserCooldown.set(message.author.id, Date.now());
    }
  } catch (err) {
    console.error('--- ERROR DETALLADO ---', err);
    if (!groqKey) {
      console.error('Variable de entorno GROQ_API_KEY no definida o vacía');
    }
    await message.reply('Che, se me cortó el cable, probá de nuevo en un toque.');
  } finally {
    if (typingTimer) clearInterval(typingTimer);
  }
});

client.login(token);

// Servidor HTTP mínimo (para Render Web Service)
const port = Number(process.env.PORT || 0);
if (port) {
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Enderland bot running');
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`Health server listening on 0.0.0.0:${port}`);
  });
}
