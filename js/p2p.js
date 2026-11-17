// Sincronización directa entre dispositivos emparejados con un código (WebRTC).
// Sin cuentas ni nube: los datos viajan cifrados de un dispositivo al otro. Un servidor
// público de señalización (PeerJS) solo ayuda a que se encuentren; no ve los documentos.
// Solo sincroniza mientras los dos dispositivos tienen Paperbook abierto.
import { store } from './store.js';
import { docSig, metaOf, mergeIncoming } from './backup.js';

const CHUNK = 60_000;
const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const rand = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

const load = () => { try { return JSON.parse(localStorage.getItem('pb.p2p')); } catch { return null; } };
const save = (g) => (g ? localStorage.setItem('pb.p2p', JSON.stringify(g)) : localStorage.removeItem('pb.p2p'));

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

export const p2p = {
  conns: new Map(), // dispositivo remoto → conexión autenticada
  all: new Set(),
  message: '',
  onState: () => {},

  get group() { return load(); },
  get paired() { return !!load()?.peers?.length; },
  get online() { return this.conns.size; },

  say(m) { this.message = m; this.onState(); },

  // ---------- emparejamiento ----------
  /** Este dispositivo muestra un código y espera al otro. */
  async host({ onCode, confirm }) {
    const Peer = await lib();
    this.cancelPairing();
    let peer, code;
    for (let i = 0; ; i++) {
      code = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
      try { peer = await openPeer(new Peer('pbpair-' + code, serverOpts())); break; } catch (e) {
        if (e.type !== 'unavailable-id' || i > 4) throw new Error('No se pudo contactar con el servidor de emparejamiento. Revisa tu conexión.');
      }
    }
    this.pairPeer = peer;
    onCode(code);
    return new Promise((resolve, reject) => {
      this.pairReject = reject;
      let busy = false;
      peer.on('connection', (conn) => {
        conn.on('open', async () => {
          if (busy) return conn.close();
          busy = true;
          if (!(await confirm())) {
            conn.send(JSON.stringify({ t: 'no' }));
            busy = false;
            return setTimeout(() => conn.close(), 400);
          }
          const g = load() || { secret: rand(24), device: rand(6), peers: [] };
          save(g);
          conn.send(JSON.stringify({ t: 'paired', secret: g.secret, device: g.device, peers: g.peers }));
        });
        conn.on('data', (d) => {
          let m; try { m = JSON.parse(d); } catch { return; }
          if (m.t !== 'joined' || !/^[0-9a-f]{12}$/.test(m.device)) return;
          const g = load();
          if (!g.peers.includes(m.device)) g.peers.push(m.device);
          save(g);
          setTimeout(() => { this.cancelPairing(true); this.start(); }, 400);
          resolve();
        });
      });
      peer.on('error', () => {});
    });
  },

  /** Este dispositivo escribe el código que muestra el otro. */
  async join(code) {
    code = String(code).replace(/\D/g, '');
    if (code.length !== 6) throw new Error('El código tiene 6 cifras.');
    const Peer = await lib();
    this.cancelPairing();
    let peer;
    try { peer = await openPeer(new Peer(serverOpts())); } catch {
      throw new Error('No se pudo contactar con el servidor de emparejamiento. Revisa tu conexión.');
    }
    this.pairPeer = peer;
    try {
      await new Promise((resolve, reject) => {
        const bad = () => reject(new Error('Código incorrecto, o el otro dispositivo ya no lo está mostrando.'));
        const timer = setTimeout(() => reject(new Error('No hubo respuesta. Comprueba el código y que el otro dispositivo siga en la pantalla del código.')), 60_000);
        peer.on('error', (e) => { if (e.type === 'peer-unavailable') bad(); });
        const conn = peer.connect('pbpair-' + code, { reliable: true, serialization: 'raw' });
        conn.on('data', (d) => {
          let m; try { m = JSON.parse(d); } catch { return; }
          if (m.t === 'no') return reject(new Error('El otro dispositivo rechazó la conexión.'));
          if (m.t !== 'paired' || !m.secret || !m.device) return;
          clearTimeout(timer);
          const device = load()?.device || rand(6);
          const peers = [...new Set([m.device, ...(m.peers || [])])].filter((x) => x !== device);
          save({ secret: m.secret, device, peers });
          conn.send(JSON.stringify({ t: 'joined', device }));
          setTimeout(resolve, 400);
        });
      });
    } finally {
      this.cancelPairing(true);
    }
    this.start();
  },

  cancelPairing(quiet) {
    if (!quiet) this.pairReject?.(new Error('cancelado'));
    this.pairReject = null;
    this.pairPeer?.destroy();
    this.pairPeer = null;
  },

  unpair() {
    this.stop();
    save(null);
    this.say('');
  },

  // ---------- conexión permanente ----------
  stop() {
    clearInterval(this.timer);
    this.offStore?.();
    for (const c of this.all) try { c.conn.close(); } catch {}
    this.all.clear();
    this.conns.clear();
    this.peer?.destroy();
    this.peer = null;
  },

  async start() {
    const g = load();
    this.stop();
    if (!g?.peers?.length || !window.crypto?.subtle) return this.onState();
    const Peer = await lib();
    this.gid = (await sha256(g.secret)).slice(0, 24);
    const peer = (this.peer = new Peer(`pb-${this.gid}-${g.device}`, serverOpts()));
    peer.on('open', () => this.dial());
    peer.on('connection', (conn) => this.setup(conn, false));
    peer.on('error', (e) => {
      if (e.type === 'unavailable-id') this.say('Paperbook ya está abierto en otra pestaña de este dispositivo.');
    });
    this.timer = setInterval(() => {
      if (this.peer !== peer || peer.destroyed) return;
      if (peer.disconnected) peer.reconnect(); else this.dial();
    }, 20_000);
    let t;
    this.offStore = store.on((type) => {
      if (type !== 'change') return;
      clearTimeout(t);
      t = setTimeout(() => { for (const c of this.conns.values()) this.sendIndex(c); }, 1500);
    });
    this.onState();
  },

  dial() {
    const g = load();
    if (!g || !this.peer?.open) return;
    for (const c of this.all) if (!c.ok && Date.now() - c.at > 15_000) { try { c.conn.close(); } catch {} this.all.delete(c); }
    for (const id of g.peers) {
      if (this.conns.has(id) || [...this.all].some((c) => c.target === id)) continue;
      this.setup(this.peer.connect(`pb-${this.gid}-${id}`, { reliable: true, serialization: 'raw' }), true, id);
    }
  },

  setup(conn, dialed, target) {
    const c = { conn, dialed, target, ok: false, at: Date.now(), nonce: rand(16), q: Promise.resolve(), hq: Promise.resolve(), pending: new Map(), rx: null };
    this.all.add(c);
    const hello = () => this.sendJSON(c, { t: 'hello', device: load().device, nonce: c.nonce, peers: load().peers });
    if (conn.open) hello(); else conn.on('open', hello);
    conn.on('data', (d) => this.onData(c, d));
    const drop = () => {
      this.all.delete(c);
      if (this.conns.get(c.remote) === c) { this.conns.delete(c.remote); this.say(''); }
    };
    conn.on('close', drop);
    conn.on('error', drop);
  },

  // ---------- transporte: cabecera JSON + trozos binarios, en orden ----------
  enqueue(c, fn) {
    c.q = c.q.then(fn).catch((e) => console.warn('p2p send', e));
    return c.q;
  },
  async frame(c, head, blob) {
    if (!c.conn.open) throw new Error('conexión cerrada');
    c.conn.send(JSON.stringify({ ...head, n: blob.size }));
    for (let o = 0; o < blob.size; o += CHUNK) {
      while (c.conn.dataChannel?.bufferedAmount > 2e6) await sleep(25);
      if (!c.conn.open) throw new Error('conexión cerrada');
      c.conn.send(await blob.slice(o, o + CHUNK).arrayBuffer());
    }
  },
  sendJSON(c, obj) {
    return this.enqueue(c, () => this.frame(c, { k: 'j' }, new Blob([JSON.stringify(obj)])));
  },
  sendBlob(c, id, blob) {
    return this.enqueue(c, () => this.frame(c, { k: 'b', id, mime: blob.type }, blob));
  },

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
    }).catch((e) => console.warn('p2p recv', e));
  },

  // ---------- protocolo ----------
  async handle(c, m) {
    const g = load();
    if (!g) return;
    if (m.t === 'hello') {
      if (!/^[0-9a-f]{12}$/.test(m.device) || m.device === g.device) return c.conn.close();
      c.remote = m.device;
      c.hisPeers = Array.isArray(m.peers) ? m.peers : [];
      return this.sendJSON(c, { t: 'auth', mac: await hmac(g.secret, m.nonce + '|' + g.device) });
    }
    if (m.t === 'auth') {
      if (!c.remote || m.mac !== await hmac(g.secret, c.nonce + '|' + c.remote)) return c.conn.close();
      // si ambos se llamaron a la vez, se conserva la conexión que inició el id menor
      const old = this.conns.get(c.remote);
      if (old && old !== c) {
        const mineWins = g.device < c.remote;
        const keep = (c.dialed === mineWins) ? c : old;
        const dropIt = keep === c ? old : c;
        try { dropIt.conn.close(); } catch {}
        this.all.delete(dropIt);
        if (keep !== c) return;
      }
      c.ok = true;
      this.conns.set(c.remote, c);
      const peers = [...new Set([...g.peers, c.remote, ...c.hisPeers])].filter((x) => x !== g.device && /^[0-9a-f]{12}$/.test(x));
      if (peers.length !== g.peers.length) save({ ...g, peers });
      this.say('');
      return this.sendIndex(c);
    }
    if (!c.ok) return;

    if (m.t === 'index') {
      for (const r of m.docs || []) {
        const L = store.docs.get(r.id);
        if (r.deleted) { if (L && !L.deleted) await this.deleteLocal(L); continue; }
        if (L?.deleted) continue;
        if (!L) {
          if (r.hasBlob || r.type === 'canvas') this.sendJSON(c, { t: 'get', id: r.id, blob: !!r.hasBlob });
          continue;
        }
        const needBlob = !!(L.noBlob && r.hasBlob);
        if (needBlob || r.sig !== docSig(L, await store.getAnn(L.id))) this.sendJSON(c, { t: 'get', id: r.id, blob: needBlob });
      }
    } else if (m.t === 'get') {
      const L = store.docs.get(m.id);
      if (!L || L.deleted) return;
      const blob = m.blob && L.type !== 'canvas' && !L.noBlob ? await store.getBlob(L.id) : null;
      this.sendJSON(c, { t: 'doc', doc: metaOf(L), ann: await store.getAnn(L.id), blob: !!blob });
      if (blob) this.sendBlob(c, L.id, new Blob([blob], { type: L.mime || blob.type }));
    } else if (m.t === 'doc') {
      if (m.blob) c.pending.set(m.doc.id, m); // el contenido llega en el siguiente bloque
      else await mergeIncoming(m.doc, m.ann, null);
    }
  },

  async gotBlob(c, head, blob) {
    const m = c.pending.get(head.id);
    if (!m) return;
    c.pending.delete(head.id);
    await mergeIncoming(m.doc, m.ann, blob);
    this.say('');
  },

  async sendIndex(c) {
    const docs = [];
    for (const d of store.docs.values()) {
      if (d.deleted) { docs.push({ id: d.id, deleted: true }); continue; }
      docs.push({ id: d.id, type: d.type, hasBlob: d.type !== 'canvas' && !d.noBlob, sig: docSig(d, await store.getAnn(d.id)) });
    }
    return this.sendJSON(c, { t: 'index', docs });
  },

  async deleteLocal(L) {
    L.deleted = true;
    L.updatedAt = Date.now();
    L.thumb = null;
    await Promise.all([store.delBlob(L.id), store.delAnn(L.id), store.delText(L.id)]);
    await store.saveDoc(L);
  },
};
