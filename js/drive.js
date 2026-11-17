// Sincronización con Google Drive (carpeta "Paperbook").
// Usa el permiso mínimo "drive.file": la app solo ve los archivos que ella misma crea.
import { store, mergeAnn, emptyAnn } from './store.js';
import { makeThumb } from './viewer.js';
import { indexSoon } from './search.js';
import { GOOGLE_CLIENT_ID } from './config.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = 'Paperbook';
const SYNCED = ['title', 'type', 'mime', 'folder', 'createdAt', 'updatedAt', 'size', 'sourceUrl', 'pages', 'paper', 'tags', 'space', 'deleted'];

const ls = {
  get: (k) => localStorage.getItem('pb.' + k),
  set: (k, v) => (v == null ? localStorage.removeItem('pb.' + k) : localStorage.setItem('pb.' + k, v)),
};

class AuthError extends Error {}

/** Presente solo en la app de escritorio: inicio de sesión por el navegador del sistema. */
const native = window.paperbookNative;

export const drive = {
  state: 'off', // off | idle | syncing | error | auth
  message: '',
  lastSync: +ls.get('lastSync') || 0,
  onState: () => {},

  get clientId() { return ls.get('clientId') || GOOGLE_CLIENT_ID || ''; },
  set clientId(v) { ls.set('clientId', v || null); },
  get clientSecret() { return ls.get('clientSecret') || ''; },
  set clientSecret(v) { ls.set('clientSecret', v || null); },
  get connected() { return !!ls.get('connected') && !!this.clientId; },

  setState(state, message = '') {
    this.state = state;
    this.message = message;
    this.onState();
  },

  init() {
    this.setState(this.connected ? 'idle' : 'off');
  },

  // ----- autenticación (Google Identity Services) -----
  loadGis() {
    return (this.gis ??= new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = res;
      s.onerror = () => { this.gis = null; rej(new Error('No se pudo cargar el inicio de sesión de Google (¿sin conexión?).')); };
      document.head.append(s);
    }));
  },

  token() {
    try {
      const t = JSON.parse(ls.get('token'));
      if (t && t.exp > Date.now() + 60_000) return t.t;
    } catch {}
    return null;
  },

  async requestToken(interactive = false) {
    if (native) {
      const cfg = { clientId: this.clientId, clientSecret: this.clientSecret };
      let r;
      try {
        r = interactive ? await native.oauth.login(cfg) : await native.oauth.token(cfg);
      } catch (e) {
        throw new AuthError(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      }
      if (!r?.access_token) throw new AuthError('Vuelve a conectar con Google Drive.');
      ls.set('token', JSON.stringify({ t: r.access_token, exp: Date.now() + r.expires_in * 1000 }));
      return r.access_token;
    }
    await this.loadGis();
    return new Promise((res, rej) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: SCOPE,
        callback: (r) => {
          if (r.error) return rej(new AuthError(r.error_description || r.error));
          ls.set('token', JSON.stringify({ t: r.access_token, exp: Date.now() + r.expires_in * 1000 }));
          res(r.access_token);
        },
        error_callback: (e) => rej(new AuthError(e?.message || 'Inicio de sesión cancelado.')),
      });
      client.requestAccessToken({ prompt: '' });
    });
  },

  /** Debe llamarse desde un clic del usuario (abre la ventana de Google). */
  async connect() {
    if (!this.clientId) throw new Error('Falta el ID de cliente de Google.');
    await this.requestToken(true);
    ls.set('connected', '1');
    this.setState('idle');
    return this.sync();
  },

  disconnect() {
    native?.oauth.logout();
    const t = this.token();
    if (t && window.google?.accounts) google.accounts.oauth2.revoke(t, () => {});
    for (const k of ['token', 'connected', 'folderId']) ls.set(k, null);
    this.setState('off');
  },

  // ----- API -----
  async req(url, opts = {}) {
    const t = this.token();
    if (!t) throw new AuthError('Sesión de Google caducada.');
    const r = await fetch(url, { ...opts, headers: { ...opts.headers, Authorization: 'Bearer ' + t } });
    if (r.status === 401) { ls.set('token', null); throw new AuthError('Sesión de Google caducada.'); }
    if (!r.ok) {
      let msg = `Drive respondió ${r.status}`;
      try { msg = (await r.json()).error?.message || msg; } catch {}
      const err = new Error(msg);
      err.status = r.status;
      throw err;
    }
    return r;
  },

  async folder() {
    let id = ls.get('folderId');
    if (id) return id;
    const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const found = await (await this.req(`${API}/files?q=${q}&fields=files(id)&orderBy=createdTime`)).json();
    id = found.files?.[0]?.id;
    if (!id) {
      const made = await (await this.req(`${API}/files?fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
      })).json();
      id = made.id;
    }
    ls.set('folderId', id);
    return id;
  },

  async list(folderId) {
    const out = [];
    let pageToken = '';
    do {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
      const r = await (await this.req(
        `${API}/files?q=${q}&pageSize=1000&fields=nextPageToken,files(id,name,modifiedTime,appProperties)` +
        (pageToken ? `&pageToken=${pageToken}` : ''))).json();
      out.push(...(r.files || []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  },

  /** Crea o actualiza un archivo. Devuelve { id, modifiedTime }. */
  async upload(meta, blob, fileId) {
    const fields = 'fields=id,modifiedTime';
    const base = fileId ? `${UPLOAD}/files/${fileId}` : `${UPLOAD}/files`;
    const method = fileId ? 'PATCH' : 'POST';
    const mime = blob.type || 'application/octet-stream';
    if (blob.size <= 4.5e6) {
      const b = 'pb' + Math.random().toString(36).slice(2);
      const body = new Blob([
        `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
        `--${b}\r\nContent-Type: ${mime}\r\n\r\n`, blob, `\r\n--${b}--`,
      ]);
      return (await this.req(`${base}?uploadType=multipart&${fields}`, {
        method, headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body,
      })).json();
    }
    // archivos grandes: subida reanudable en dos pasos
    const start = await this.req(`${base}?uploadType=resumable&${fields}`, {
      method,
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime },
      body: JSON.stringify(meta),
    });
    const loc = start.headers.get('Location');
    if (!loc) throw new Error('Drive no devolvió la dirección de subida.');
    return (await this.req(loc, { method: 'PUT', headers: { 'Content-Type': mime }, body: blob })).json();
  },

  download: async function (fileId) {
    return (await this.req(`${API}/files/${fileId}?alt=media`)).blob();
  },

  async remove(fileId) {
    try { await this.req(`${API}/files/${fileId}`, { method: 'DELETE' }); } catch (e) { if (e.status !== 404) throw e; }
  },

  // ----- sincronización -----
  schedule(ms = 4000) {
    if (!this.connected) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync().catch(() => {}), ms);
  },

  async sync() {
    if (!this.connected) return;
    if (this.running) { this.again = true; return this.running; }
    if (!navigator.onLine) return this.setState('error', 'Sin conexión. Se sincronizará al volver a estar en línea.');
    this.setState('syncing');
    this.running = (async () => {
      try {
        if (!this.token()) await this.requestToken();
        await this.syncOnce();
        this.lastSync = Date.now();
        ls.set('lastSync', this.lastSync);
        this.setState('idle');
      } catch (e) {
        console.warn('sync', e);
        if (e instanceof AuthError) this.setState('auth', 'Vuelve a conectar con Google Drive.');
        else {
          if (e.status === 404) ls.set('folderId', null);
          this.setState('error', e.message || 'Error de sincronización.');
        }
        throw e;
      } finally {
        this.running = null;
        if (this.again) { this.again = false; this.schedule(1500); }
      }
    })();
    return this.running;
  },

  async syncOnce() {
    const folderId = await this.folder();
    const remote = new Map();
    for (const f of await this.list(folderId)) {
      const id = f.appProperties?.pbId;
      if (!id) continue;
      const r = remote.get(id) || {};
      r[f.appProperties.kind === 'meta' ? 'meta' : 'content'] = f;
      remote.set(id, r);
    }

    const ids = new Set([...remote.keys(), ...store.docs.keys()]);
    let failures = 0, lastErr;
    for (const id of ids) {
      try {
        await this.syncDoc(id, remote.get(id) || {}, folderId);
      } catch (e) {
        if (e instanceof AuthError) throw e;
        failures++;
        lastErr = e;
        console.warn('sync doc', id, e);
      }
    }
    if (failures) throw new Error(`${failures} documento(s) no se pudieron sincronizar: ${lastErr.message}`);
  },

  async syncDoc(id, R, folderId) {
    let L = store.docs.get(id);

    // 1) traer cambios remotos y fusionarlos
    if (R.meta && (!L || L.drive?.metaTime !== R.meta.modifiedTime)) {
      const rj = JSON.parse(await (await this.download(R.meta.id)).text());
      if (!L) {
        if (rj.doc.deleted) return;
        L = { id, ...rj.doc, noBlob: rj.doc.type !== 'canvas', rev: 0, dirty: false };
        await store.putAnn(id, rj.ann || emptyAnn());
      } else {
        const wasDirty = L.dirty;
        if ((rj.doc.updatedAt || 0) > (L.updatedAt || 0)) {
          for (const k of ['title', 'folder', 'paper', 'tags', 'space', 'updatedAt']) L[k] = rj.doc[k];
        }
        L.pages = Math.max(L.pages || 0, rj.doc.pages || 0) || undefined;
        L.deleted = L.deleted || rj.doc.deleted || undefined;
        if (!L.deleted) {
          const merged = mergeAnn(await store.getAnn(id), rj.ann);
          await store.putAnn(id, merged, { replaced: true });
        }
        L.dirty = wasDirty;
      }
      L.drive = { ...L.drive, metaId: R.meta.id, metaTime: R.meta.modifiedTime };
      await store.saveDoc(L, { local: true });
    }
    if (!L) return; // contenido huérfano en Drive: se ignora

    // 2) documento eliminado
    if (L.deleted) {
      if (R.content) await this.remove(R.content.id);
      if (!R.meta && !L.drive?.metaId) return localStorage.getItem('pb.p2p') ? undefined : store.purgeDoc(id);
      await store.delBlob(id);
      await store.delAnn(id);
      await store.delText(id);
      if (L.dirty || !R.meta) await this.pushMeta(L, null, folderId, R);
      return;
    }

    // 3) contenido (PDF / imagen / HTML): se sube una vez, se descarga si falta
    if (L.type !== 'canvas') {
      if (R.content && L.noBlob) {
        const blob = await this.download(R.content.id);
        const typed = blob.type === L.mime ? blob : new Blob([blob], { type: L.mime });
        await store.putBlob(id, typed);
        L.noBlob = false;
        L.thumb = await makeThumb(L.type, typed);
        L.drive = { ...L.drive, contentId: R.content.id };
        await store.saveDoc(L, { local: true });
        indexSoon(L);
      } else if (!R.content && !L.noBlob) {
        const blob = await store.getBlob(id);
        if (blob) {
          const up = await this.upload({
            name: fileName(L), parents: [folderId], appProperties: { pbId: id, kind: 'content' },
          }, new Blob([blob], { type: L.mime || blob.type }));
          L.drive = { ...L.drive, contentId: up.id };
          await store.saveDoc(L, { local: true });
        }
      }
    }

    // 4) metadatos + anotaciones
    if (L.dirty || !R.meta) await this.pushMeta(L, await store.getAnn(id), folderId, R);
  },

  async pushMeta(L, ann, folderId, R) {
    const rev = L.rev;
    const doc = {};
    for (const k of SYNCED) if (L[k] != null) doc[k] = L[k];
    const body = new Blob([JSON.stringify({ v: 1, doc, ann })], { type: 'application/json' });
    const fileId = R.meta?.id || L.drive?.metaId;
    const meta = fileId
      ? { name: `${L.title}.paperbook.json` }
      : { name: `${L.title}.paperbook.json`, parents: [folderId], appProperties: { pbId: L.id, kind: 'meta' } };
    let up;
    try {
      up = await this.upload(meta, body, fileId);
    } catch (e) {
      if (e.status !== 404 || !fileId) throw e;
      L.drive = { ...L.drive, metaId: undefined, metaTime: undefined };
      up = await this.upload({ name: meta.name, parents: [folderId], appProperties: { pbId: L.id, kind: 'meta' } }, body);
    }
    L.drive = { ...L.drive, metaId: up.id, metaTime: up.modifiedTime };
    if (L.rev === rev) L.dirty = false;
    await store.saveDoc(L, { local: true });
  },
};

function fileName(d) {
  const ext = { pdf: '.pdf', web: '.html' }[d.type] || ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[d.mime] || '');
  return d.title.toLowerCase().endsWith(ext) ? d.title : d.title + ext;
}
