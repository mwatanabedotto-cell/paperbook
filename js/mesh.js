// Red directa entre dispositivos (WebRTC con PeerJS).
// Sirve tanto para emparejar tus propios dispositivos como para los grupos de estudio.
// Un servidor público de señalización solo ayuda a que los dispositivos se encuentren;
// los documentos viajan cifrados de un dispositivo a otro y no pasan por él.
import { store, mergeAnn } from './store.js';
import { docSig, metaOf, mergeIncoming } from './backup.js';

const CHUNK = 60_000;
const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const rand = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
export const isDevice = (s) => typeof s === 'string' && /^[0-9a-f]{12}$/.test(s);
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

function serverOpts() {
  const s = localStorage.getItem('pb.p2pServer'); // opcional: servidor PeerJS propio
  if (!s) return {};
  const u = new URL(s);
  return { host: u.hostname, port: +u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, secure: u.protocol === 'https:' };
}

let libP;
function lib() {
  return (libP ??= new Promise((res, rej) => {
    if (window.Peer) return res(window.Peer);
    const s = document.createElement('script');
    s.src = 'vendor/peerjs/peerjs.min.js';
    s.onload = () => res(window.Peer);
    s.onerror = () => { libP = null; rej(new Error('No se pudo cargar el módulo de conexión.')); };
    document.head.append(s);
  }));
}

const openPeer = (peer) => new Promise((res, rej) => {
  peer.once('open', () => res(peer));
  peer.once('error', (e) => rej(e));
});

// documento abierto ahora en este dispositivo (para avisar a los demás)
let viewingNow = null;
store.on((t, d) => { if (t === 'view') viewingNow = d.id || null; });

const NO_SERVER = 'No se pudo contactar con el servidor de emparejamiento. Revisa tu conexión.';

// ---------- códigos de 6 cifras ----------
let pairPeer = null, pairReject = null;

export function cancelPairing(quiet) {
  if (!quiet) pairReject?.(new Error('cancelado'));
  pairReject = null;
  pairPeer?.destroy();
  pairPeer = null;
}

/**
 * Muestra un código y espera a que otro dispositivo lo use.
 * confirm(nombre) → bool; offer() → mensaje a enviar ({t:'full'} si no hay sitio); onJoined(respuesta).
 */
export async function hostCode({ onCode, confirm, offer, onJoined }) {
  const Peer = await lib();
  cancelPairing();
  let peer, code;
  for (let i = 0; ; i++) {
    code = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
    try { peer = await openPeer(new Peer('pbpair-' + code, serverOpts())); break; } catch (e) {
      if (e.type !== 'unavailable-id' || i > 4) throw new Error(NO_SERVER);
    }
  }
  pairPeer = peer;
  onCode(code);
  return new Promise((resolve, reject) => {
    pairReject = reject;
    let busy = false;
    peer.on('connection', (conn) => {
      conn.on('data', async (d) => {
        let m; try { m = JSON.parse(d); } catch { return; }
        if (m.t === 'ask') {
          if (busy) return conn.close();
          busy = true;
          const name = String(m.name || '').slice(0, 40);
          if (!(await confirm(name))) {
            conn.send(JSON.stringify({ t: 'no' }));
            busy = false;
            return setTimeout(() => conn.close(), 400);
          }
          const msg = offer();
          conn.send(JSON.stringify(msg));
          if (msg.t !== 'paired') { busy = false; setTimeout(() => conn.close(), 400); }
        } else if (m.t === 'joined' && busy && isDevice(m.device)) {
          onJoined({ ...m, name: String(m.name || '').slice(0, 40) });
          setTimeout(() => { cancelPairing(true); resolve(m); }, 400);
        }
      });
    });
    peer.on('error', () => {});
  });
}

/** Usa el código que muestra otro dispositivo. accept(oferta) → respuesta {t:'joined', …}, o lanza un error. */
export async function joinCode(code, { name, accept }) {
  code = String(code).replace(/\D/g, '');
  if (code.length !== 6) throw new Error('El código tiene 6 cifras.');
  const Peer = await lib();
  cancelPairing();
  let peer;
  try { peer = await openPeer(new Peer(serverOpts())); } catch { throw new Error(NO_SERVER); }
  pairPeer = peer;
  try {
    return await new Promise((resolve, reject) => {
      const bad = () => reject(new Error('Código incorrecto, o el otro dispositivo ya no lo está mostrando.'));
      const timer = setTimeout(() => reject(new Error('No hubo respuesta. Comprueba el código y que el otro dispositivo siga mostrándolo.')), 90_000);
      peer.on('error', (e) => { if (e.type === 'peer-unavailable') bad(); });
      const conn = peer.connect('pbpair-' + code, { reliable: true, serialization: 'raw' });
      conn.on('open', () => conn.send(JSON.stringify({ t: 'ask', name: name || '' })));
      conn.on('data', async (d) => {
        let m; try { m = JSON.parse(d); } catch { return; }
        if (m.t === 'no') return reject(new Error('La otra persona rechazó la solicitud.'));
        if (m.t === 'full') return reject(new Error('El grupo ya está completo (máximo 4 personas).'));
        if (m.t !== 'paired') return;
        clearTimeout(timer);
        let reply;
        try { reply = await accept(m); } catch (e) { return reject(e); }
        conn.send(JSON.stringify(reply));
        setTimeout(() => resolve(m), 400);
      });
    });
  } finally {
    cancelPairing(true);
  }
}

// ---------- malla de sincronización ----------
/**
 * Una malla une este dispositivo con otros que comparten un secreto.
 * o: { prefix, secret, device, name, peers(), filter(doc), adopt(meta), hello(), onAuth(c, hello),
 *      onMessage(c, m), onChange(), onSay(text) }
 */
export class Mesh {
  constructor(o) {
    this.o = o;
    this.conns = new Map(); // dispositivo → conexión autenticada
    this.all = new Set();
    this.viewing = null;
  }

  get online() { return this.conns.size; }
  people() {
    return [...this.conns.values()].map((c) => ({ device: c.remote, name: c.name, viewing: c.viewing || null }));
  }
  has(id) { const L = store.docs.get(id); return !!L && !!this.o.filter(L); }
  say(t) { this.o.onSay?.(t); }
  changed() { this.o.onChange?.(); store.emit('presence'); }

  stop() {
    this.run = (this.run || 0) + 1;
    clearInterval(this.timer);
    clearTimeout(this.it);
    this.off?.();
    this.off = null;
    for (const c of this.all) try { c.conn.close(); } catch {}
    this.all.clear();
    this.conns.clear();
    this.peer?.destroy();
    this.peer = null;
  }

  async start() {
    this.stop();
    const run = this.run;
    this.sess = rand(8); // identifica esta sesión: una conexión nueva reemplaza a una vieja
    if (!window.crypto?.subtle) return;
    const Peer = await lib();
    const gid = (await sha256(this.o.secret)).slice(0, 24);
    if (run !== this.run) return;
    this.gid = gid;
    const peer = (this.peer = new Peer(`${this.o.prefix}-${gid}-${this.o.device}`, serverOpts()));
    peer.on('open', () => this.dial());
    peer.on('connection', (conn) => this.setup(conn, false));
    peer.on('error', (e) => {
      if (e.type === 'unavailable-id') this.say('Paperbook ya está abierto en otra pestaña de este dispositivo.');
    });
    this.timer = setInterval(() => {
      if (this.peer !== peer || peer.destroyed) return;
      if (peer.disconnected) peer.reconnect(); else this.dial();
    }, 20_000);
    this.off = store.on((type, d) => {
      if (type === 'change') {
        clearTimeout(this.it);
        this.it = setTimeout(() => { for (const c of this.conns.values()) this.sendIndex(c); }, 1500);
      } else if (type === 'ops' && this.has(d.id)) {
        this.broadcast({ t: 'ops', id: d.id, add: d.add, del: d.del });
      } else if (type === 'live' && this.has(d.id)) {
        this.broadcast({ t: 'live', id: d.id, key: d.key, s: d.s });
      } else if (type === 'view') {
        this.viewing = d.id && this.has(d.id) ? d.id : null;
        this.broadcast({ t: 'view', id: this.viewing });
      }
    });
    this.viewing = viewingNow && this.has(viewingNow) ? viewingNow : null;
    this.changed();
  }

  dial() {
    if (!this.peer?.open) return;
    for (const c of this.all) if (!c.ok && Date.now() - c.at > 15_000) { try { c.conn.close(); } catch {} this.all.delete(c); }
    for (const id of this.o.peers()) {
      if (id === this.o.device || this.conns.has(id) || [...this.all].some((c) => c.target === id)) continue;
      this.setup(this.peer.connect(`${this.o.prefix}-${this.gid}-${id}`, { reliable: true, serialization: 'raw' }), true, id);
    }
  }

  /** Cierra la conexión con un dispositivo (por ejemplo, si salió del grupo). */
  drop(device) {
    for (const c of this.all) if (c.remote === device || c.target === device) { try { c.conn.close(); } catch {} }
  }

  setup(conn, dialed, target) {
    const c = { conn, dialed, target, ok: false, at: Date.now(), nonce: rand(16), q: Promise.resolve(), hq: Promise.resolve(), pending: new Map(), rx: null };
    this.all.add(c);
    const hello = () => this.sendJSON(c, { t: 'hello', device: this.o.device, name: this.o.name?.() || '', nonce: c.nonce, sess: this.sess, ...this.o.hello?.() });
    if (conn.open) hello(); else conn.on('open', hello);
    conn.on('data', (d) => this.onData(c, d));
    const gone = () => {
      this.all.delete(c);
      if (this.conns.get(c.remote) === c) {
        this.conns.delete(c.remote);
        store.emit('remoteLive', { from: c.remote, s: null });
        this.say('');
        this.changed();
      }
    };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  // ----- transporte: cabecera JSON + trozos binarios, en orden -----
  enqueue(c, fn) {
    c.q = c.q.then(fn).catch((e) => console.warn('mesh send', e));
    return c.q;
  }
  async frame(c, head, blob) {
    if (!c.conn.open) throw new Error('conexión cerrada');
    c.conn.send(JSON.stringify({ ...head, n: blob.size }));
    for (let o = 0; o < blob.size; o += CHUNK) {
      while (c.conn.dataChannel?.bufferedAmount > 2e6) await sleep(25);
      if (!c.conn.open) throw new Error('conexión cerrada');
      c.conn.send(await blob.slice(o, o + CHUNK).arrayBuffer());
    }
  }
  sendJSON(c, obj) {
    return this.enqueue(c, () => this.frame(c, { k: 'j' }, new Blob([JSON.stringify(obj)])));
  }
  sendBlob(c, id, blob) {
    return this.enqueue(c, () => this.frame(c, { k: 'b', id, mime: blob.type }, blob));
  }
  broadcast(obj) {
    for (const c of this.conns.values()) this.sendJSON(c, obj);
  }

  onData(c, data) {
    if (typeof data === 'string') {
      let head; try { head = JSON.parse(data); } catch { return; }
      c.rx = { head, parts: [], got: 0 };
    } else if (c.rx) {
      c.rx.parts.push(data);
      c.rx.got += data.byteLength;
      if (c.rx.head.k === 'b' && c.rx.head.n > 2e6) {
        const title = c.pending.get(c.rx.head.id)?.doc?.title || 'documento';
        const pct = Math.floor((c.rx.got / c.rx.head.n) * 100);
        if (pct !== c.rx.pct) { c.rx.pct = pct; this.say(`Recibiendo «${title}»… ${pct}%`); }
      }
    } else return;
    if (c.rx.got < (c.rx.head.n || 0)) return;
    const { head, parts } = c.rx;
    c.rx = null;
    c.hq = c.hq.then(async () => {
      if (head.k === 'j') return this.handle(c, JSON.parse(await new Blob(parts).text()));
      if (head.k === 'b' && c.ok) return this.gotBlob(c, head, new Blob(parts, { type: head.mime || '' }));
    }).catch((e) => console.warn('mesh recv', e));
  }

  // ----- protocolo -----
  async handle(c, m) {
    const o = this.o;
    if (m.t === 'hello') {
      if (!isDevice(m.device) || m.device === o.device) return c.conn.close();
      c.remote = m.device;
      c.name = String(m.name || '').slice(0, 40);
      c.sess = String(m.sess || '');
      c.hello = m;
      return this.sendJSON(c, { t: 'auth', mac: await hmac(o.secret, m.nonce + '|' + o.device) });
    }
    if (m.t === 'auth') {
      if (!c.remote || m.mac !== await hmac(o.secret, c.nonce + '|' + c.remote)) return c.conn.close();
      // si los dos se llamaron a la vez, se conserva la conexión que inició el id menor
      const old = this.conns.get(c.remote);
      if (old && old !== c && old.sess !== c.sess) {
        // el otro dispositivo se reconectó: la conexión vieja ya no sirve
        try { old.conn.close(); } catch {}
        this.all.delete(old);
        this.conns.delete(c.remote);
      } else if (old && old !== c) {
        const mineWins = o.device < c.remote;
        const keep = c.dialed === mineWins ? c : old;
        const dropIt = keep === c ? old : c;
        try { dropIt.conn.close(); } catch {}
        this.all.delete(dropIt);
        if (keep !== c) return;
      }
      if (o.onAuth?.(c, c.hello) === false) return c.conn.close();
      c.ok = true;
      this.conns.set(c.remote, c);
      this.say('');
      this.changed();
      if (this.viewing) this.sendJSON(c, { t: 'view', id: this.viewing });
      return this.sendIndex(c);
    }
    if (!c.ok) return;

    if (m.t === 'index') {
      for (const r of m.docs || []) {
        const L = store.docs.get(r.id);
        if (r.deleted) { if (L && !L.deleted && o.filter(L)) await this.deleteLocal(L); continue; }
        if (L?.deleted) continue;
        if (!L) {
          if (r.hasBlob || r.type === 'canvas') this.sendJSON(c, { t: 'get', id: r.id, blob: !!r.hasBlob });
          continue;
        }
        if (!o.filter(L)) continue;
        const needBlob = !!(L.noBlob && r.hasBlob);
        if (needBlob || r.sig !== docSig(L, await store.getAnn(L.id))) this.sendJSON(c, { t: 'get', id: r.id, blob: needBlob });
      }
    } else if (m.t === 'get') {
      const L = store.docs.get(m.id);
      if (!L || L.deleted || !o.filter(L)) return;
      const blob = m.blob && L.type !== 'canvas' && !L.noBlob ? await store.getBlob(L.id) : null;
      this.sendJSON(c, { t: 'doc', doc: metaOf(L), ann: await store.getAnn(L.id), blob: !!blob });
      if (blob) this.sendBlob(c, L.id, new Blob([blob], { type: L.mime || blob.type }));
    } else if (m.t === 'doc') {
      const meta = o.adopt ? o.adopt(m.doc) : m.doc;
      const L = store.docs.get(meta?.id);
      if (!meta || (L && !o.filter(L))) return;
      if (m.blob) c.pending.set(meta.id, { ...m, doc: meta }); // el contenido llega en el siguiente bloque
      else await mergeIncoming(meta, m.ann, null);
    } else if (m.t === 'ops') {
      const L = store.docs.get(m.id);
      if (!L || L.deleted || !o.filter(L)) return;
      const strokes = {};
      for (const e of m.add || []) if (e?.s?.id && e.key != null) (strokes[e.key] ||= []).push(e.s);
      const removed = {};
      for (const id of m.del || []) removed[id] = Date.now();
      await store.putAnn(L.id, mergeAnn(await store.getAnn(L.id), { v: 1, strokes, removed }), { replaced: true });
      this.touch(L);
    } else if (m.t === 'live') {
      if (this.has(m.id)) store.emit('remoteLive', { id: m.id, from: c.remote, name: c.name, key: m.key, s: m.s || null });
    } else if (m.t === 'view') {
      c.viewing = typeof m.id === 'string' ? m.id : null;
      store.emit('presence');
    } else {
      o.onMessage?.(c, m);
    }
  }

  /** Guarda el documento tras recibir trazos en vivo (agrupado, para no escribir a cada trazo). */
  touch(L) {
    this.touches ||= new Map();
    clearTimeout(this.touches.get(L.id));
    this.touches.set(L.id, setTimeout(() => {
      this.touches.delete(L.id);
      const cur = store.docs.get(L.id);
      if (cur && !cur.deleted) store.saveDoc(cur);
    }, 1200));
  }

  async gotBlob(c, head, blob) {
    const m = c.pending.get(head.id);
    if (!m) return;
    c.pending.delete(head.id);
    await mergeIncoming(m.doc, m.ann, blob);
    this.say('');
  }

  async sendIndex(c) {
    const docs = [];
    for (const d of store.docs.values()) {
      if (!this.o.filter(d)) continue;
      if (d.deleted) { docs.push({ id: d.id, deleted: true }); continue; }
      docs.push({ id: d.id, type: d.type, hasBlob: d.type !== 'canvas' && !d.noBlob, sig: docSig(d, await store.getAnn(d.id)) });
    }
    return this.sendJSON(c, { t: 'index', docs });
  }

  async deleteLocal(L) {
    L.deleted = true;
    L.updatedAt = Date.now();
    L.thumb = null;
    await Promise.all([store.delBlob(L.id), store.delAnn(L.id), store.delText(L.id)]);
    await store.saveDoc(L);
  }
}
