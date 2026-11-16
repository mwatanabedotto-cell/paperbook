// Paperbook de escritorio (Windows / Linux): empaqueta la app web en una ventana propia.
const { app, BrowserWindow, protocol, net, shell, ipcMain, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const WWW = fs.existsSync(path.join(__dirname, 'www')) ? path.join(__dirname, 'www') : path.join(__dirname, '..');
const ORIGIN = 'app://paperbook';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.html': 'text/html', '.htm': 'text/html' };

let win = null;
let pendingFiles = [];

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

// ---------- archivos abiertos con "Abrir con" ----------
function filesFromArgv(argv) {
  return argv.slice(1).filter((a) => !a.startsWith('-') && TYPES[path.extname(a).toLowerCase()] && fs.existsSync(a));
}
function queueFiles(paths) {
  for (const p of paths) {
    try {
      pendingFiles.push({ name: path.basename(p), type: TYPES[path.extname(p).toLowerCase()], data: fs.readFileSync(p) });
    } catch {}
  }
  if (pendingFiles.length) win?.webContents.send('files:ready');
}
ipcMain.handle('files:take', () => {
  const f = pendingFiles;
  pendingFiles = [];
  return f;
});

// ---------- descarga de páginas web sin restricciones del navegador ----------
ipcMain.handle('net:fetch', async (_e, url) => {
  if (!/^https?:\/\//i.test(String(url))) throw new Error('URL no válida');
  const r = await net.fetch(url, { signal: AbortSignal.timeout(25000), credentials: 'omit' });
  const body = await r.arrayBuffer();
  if (body.byteLength > 40e6) throw new Error('Archivo demasiado grande');
  return { ok: r.ok, status: r.status, type: r.headers.get('content-type') || '', body };
});

// ---------- Google OAuth (navegador del sistema + redirección local, con PKCE) ----------
const tokenFile = () => path.join(app.getPath('userData'), 'drive-token');
function saveRefresh(t) {
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(t) : Buffer.from('plain:' + t);
  fs.writeFileSync(tokenFile(), data, { mode: 0o600 });
}
function loadRefresh() {
  try {
    const b = fs.readFileSync(tokenFile());
    if (b.subarray(0, 6).toString() === 'plain:') return b.subarray(6).toString();
    return safeStorage.decryptString(b);
  } catch {
    return null;
  }
}
async function tokenRequest(params) {
  const r = await net.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || 'Google rechazó la solicitud');
  return j;
}
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

ipcMain.handle('oauth:login', async (_e, { clientId, clientSecret }) => {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const server = http.createServer();
  await new Promise((res, rej) => server.once('error', rej).listen(0, '127.0.0.1', res));
  const redirect = `http://127.0.0.1:${server.address().port}`;
  try {
    const code = await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('Tiempo de espera agotado. Inténtalo de nuevo.')), 5 * 60_000);
      server.on('request', (req, resp) => {
        const u = new URL(req.url, redirect);
        if (!u.searchParams.has('code') && !u.searchParams.has('error')) { resp.writeHead(404).end(); return; }
        const ok = u.searchParams.get('state') === state && u.searchParams.has('code');
        resp.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        resp.end(`<!doctype html><meta charset="utf-8"><title>Paperbook</title><body style="font:18px system-ui;padding:15vh 24px;text-align:center">${ok ? 'Conectado. Ya puedes cerrar esta pestaña y volver a Paperbook.' : 'No se pudo conectar. Vuelve a Paperbook e inténtalo de nuevo.'}</body>`);
        clearTimeout(timer);
        ok ? res(u.searchParams.get('code')) : rej(new Error(u.searchParams.get('error') || 'Respuesta no válida'));
      });
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
        code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
      }).toString();
      shell.openExternal(auth.toString());
    });
    const t = await tokenRequest({
      code, client_id: clientId, client_secret: clientSecret || '', redirect_uri: redirect,
      grant_type: 'authorization_code', code_verifier: verifier,
    });
    if (t.refresh_token) saveRefresh(t.refresh_token);
    win?.focus();
    return { access_token: t.access_token, expires_in: t.expires_in };
  } finally {
    server.close();
  }
});

ipcMain.handle('oauth:token', async (_e, { clientId, clientSecret }) => {
  const refresh = loadRefresh();
  if (!refresh) return null;
  try {
    const t = await tokenRequest({ client_id: clientId, client_secret: clientSecret || '', refresh_token: refresh, grant_type: 'refresh_token' });
    return { access_token: t.access_token, expires_in: t.expires_in };
  } catch (e) {
    if (/invalid_grant|revoked|expired/i.test(e.message)) { fs.rmSync(tokenFile(), { force: true }); return null; }
    throw e;
  }
});

ipcMain.handle('oauth:logout', () => fs.rmSync(tokenFile(), { force: true }));

// ---------- ventana ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 420, minHeight: 500,
    backgroundColor: '#f4f1ea', autoHideMenuBar: true,
    icon: path.join(WWW, 'icons', 'icon-512.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN + '/')) e.preventDefault();
  });
  win.loadURL(ORIGIN + '/index.html');
  win.on('closed', () => { win = null; });
}

app.on('second-instance', (_e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  queueFiles(filesFromArgv(argv));
});

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    let p = decodeURIComponent(new URL(req.url).pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.normalize(path.join(WWW, p));
    if (!file.startsWith(WWW + path.sep)) return new Response('Prohibido', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  Menu.setApplicationMenu(null);
  queueFiles(filesFromArgv(process.argv));
  createWindow();
});

app.on('window-all-closed', () => app.quit());
