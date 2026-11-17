// Espacios compartidos: un documento compartido o un grupo de estudio (hasta 4 personas).
// Cada espacio tiene su propio secreto: quien entra solo ve los documentos de ese espacio.
import { store, newId } from './store.js';
import { Mesh, hostCode, joinCode, cancelPairing, rand, isDevice } from './mesh.js';

export const MAX_MEMBERS = 4;

const read = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const load = () => read('pb.spaces', []);
const save = (list) => localStorage.setItem('pb.spaces', JSON.stringify(list));

/** Identidad de este dispositivo dentro de los grupos. */
export const me = {
  get device() {
    let d = localStorage.getItem('pb.devId');
    if (!isDevice(d)) { d = rand(6); localStorage.setItem('pb.devId', d); }
    return d;
  },
  get name() { return localStorage.getItem('pb.name') || ''; },
  set name(v) {
    localStorage.setItem('pb.name', String(v || '').trim().slice(0, 40));
    spaces.restartAll();
  },
};

/** Color estable para cada persona. */
export function personHue(device) {
  let h = 2166136261;
  for (const ch of String(device)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return Math.round(((h % 1000) * 137.508) % 360);
}

function mergeMembers(a, b) {
  const m = new Map();
  for (const x of [...(a || []), ...(b || [])]) {
    if (!isDevice(x?.device)) continue;
    const prev = m.get(x.device);
    m.set(x.device, { device: x.device, name: String(x.name || prev?.name || '').slice(0, 40) });
  }
  return [...m.values()];
}

export const spaces = {
  meshes: new Map(),
  onState: () => {},

  list() { return load(); },
  get(id) { return load().find((s) => s.id === id) || null; },
  forDoc(doc) { return doc?.space ? this.get(doc.space) : null; },
  docs(id) { return store.visible().filter((d) => d.space === id); },

  update(id, fn) {
    const list = load();
    const i = list.findIndex((s) => s.id === id);
    if (i < 0) return null;
    list[i] = fn(list[i]) || list[i];
    save(list);
    return list[i];
  },

  emit() {
    this.onState();
    store.emit('presence');
  },

  /** Personas en línea del espacio de un documento, y quién lo tiene abierto. */
  presence(docId) {
    const d = store.docs.get(docId);
    const s = this.forDoc(d);
    if (!s) return null;
    const mesh = this.meshes.get(s.id);
    const online = new Map((mesh?.people() || []).map((p) => [p.device, p]));
    return {
      space: s,
      people: s.members.filter((m) => m.device !== me.device).map((m) => ({
        ...m,
        name: online.get(m.device)?.name || m.name,
        online: online.has(m.device),
        here: online.get(m.device)?.viewing === docId,
        hue: personHue(m.device),
      })),
    };
  },

  online(id) { return this.meshes.get(id)?.online || 0; },

  // ---------- crear y compartir ----------
  create(kind, name, docId) {
    const s = {
      id: newId(), secret: rand(24), kind, name: String(name || '').trim().slice(0, 60) || 'Grupo de estudio',
      members: [{ device: me.device, name: me.name }], left: [], createdAt: Date.now(),
    };
    save([...load(), s]);
    if (docId) this.addDoc(docId, s.id);
    this.emit();
    return s;
  },

  async addDoc(docId, spaceId) {
    const d = store.docs.get(docId);
    if (!d) return;
    d.space = spaceId;
    d.updatedAt = Date.now();
    await store.saveDoc(d);
    this.emit();
  },

  /** Invitar: muestra un código. confirm(nombre) decide si entra esa persona. */
  invite(id, { onCode, confirm }) {
    return hostCode({
      onCode,
      confirm,
      offer: () => {
        const s = this.get(id);
        if (!s) return { t: 'no' };
        if (s.members.length >= MAX_MEMBERS) return { t: 'full' };
        return {
          t: 'paired', kind: 'space',
          space: { id: s.id, secret: s.secret, kind: s.kind, name: s.name, createdAt: s.createdAt },
          members: this.withMe(s.members),
        };
      },
      onJoined: (m) => {
        const s = this.update(id, (x) => ({
          ...x,
          members: mergeMembers(this.withMe(x.members), [{ device: m.device, name: m.name }]),
          left: (x.left || []).filter((d) => d !== m.device),
        }));
        if (s) {
          const mesh = this.meshes.get(id);
          if (mesh?.peer) mesh.dial(); else this.startSpace(s);
        }
        this.emit();
      },
    });
  },

  async join(code) {
    let joined;
    await joinCode(code, {
      name: me.name,
      accept: (m) => {
        if (m.kind !== 'space') throw new Error('Ese código es para emparejar dispositivos propios. Úsalo en «Sincronizar → Tengo un código».');
        const sp = m.space;
        if (!sp?.id || !sp.secret) throw new Error('Respuesta no válida.');
        const members = mergeMembers(m.members, [{ device: me.device, name: me.name }]);
        const list = load().filter((x) => x.id !== sp.id);
        joined = { id: sp.id, secret: sp.secret, kind: sp.kind === 'doc' ? 'doc' : 'group', name: String(sp.name || '').slice(0, 60), members, left: [], createdAt: sp.createdAt || Date.now() };
        save([...list, joined]);
        return { t: 'joined', device: me.device, name: me.name };
      },
    });
    this.startSpace(joined);
    this.emit();
    return joined;
  },

  cancelInvite() { cancelPairing(); },

  /** Salir de un espacio: los documentos se quedan como copia personal. */
  async leave(id) {
    const s = this.get(id);
    if (!s) return;
    const mesh = this.meshes.get(id);
    mesh?.broadcast({ t: 'leave', device: me.device });
    await new Promise((r) => setTimeout(r, 300));
    mesh?.stop();
    this.meshes.delete(id);
    save(load().filter((x) => x.id !== id));
    for (const d of store.docs.values()) {
      if (d.space !== id) continue;
      if (d.deleted) { await store.purgeDoc(d.id); continue; }
      d.space = undefined;
      d.updatedAt = Date.now();
      await store.saveDoc(d);
    }
    this.emit();
  },

  withMe(members) {
    return mergeMembers(members, [{ device: me.device, name: me.name }]);
  },

  // ---------- conexión ----------
  start() {
    for (const s of load()) this.startSpace(s);
  },

  restartAll() {
    for (const s of load()) {
      this.update(s.id, (x) => ({ ...x, members: this.withMe(x.members) }));
      if (this.meshes.has(s.id)) this.startSpace(this.get(s.id));
    }
  },

  stopAll() {
    for (const m of this.meshes.values()) m.stop();
    this.meshes.clear();
  },

  startSpace(s) {
    this.meshes.get(s.id)?.stop();
    this.meshes.delete(s.id);
    if (!s.members.some((m) => m.device !== me.device)) return; // nadie más todavía
    const id = s.id;
    const mesh = new Mesh({
      prefix: 'pbs',
      secret: s.secret,
      device: me.device,
      name: () => me.name,
      peers: () => (this.get(id)?.members || []).map((m) => m.device).filter((d) => d !== me.device),
      filter: (d) => d.space === id,
      adopt: (meta) => (meta?.id ? { ...meta, space: id } : null),
      hello: () => {
        const cur = this.get(id);
        return { members: cur ? this.withMe(cur.members) : [], left: cur?.left || [], spaceName: cur?.name };
      },
      onAuth: (c, hello) => {
        const cur = this.get(id);
        if (!cur || (cur.left || []).includes(c.remote)) return false;
        const left = [...new Set([...(cur.left || []), ...(Array.isArray(hello?.left) ? hello.left : [])])].filter((d) => d !== me.device);
        let members = mergeMembers(this.withMe(cur.members), Array.isArray(hello?.members) ? hello.members : []);
        members = mergeMembers(members, [{ device: c.remote, name: c.name }]).filter((m) => !left.includes(m.device));
        this.update(id, (x) => ({ ...x, members, left }));
        setTimeout(() => { mesh.dial(); this.emit(); }, 50);
      },
      onMessage: (c, m) => {
        if (m.t === 'leave' && m.device === c.remote) {
          this.update(id, (x) => ({
            ...x,
            members: x.members.filter((p) => p.device !== c.remote),
            left: [...new Set([...(x.left || []), c.remote])],
          }));
          mesh.drop(c.remote);
          this.emit();
        }
      },
      onChange: () => this.emit(),
      onSay: (t) => { this.message = t; this.emit(); },
    });
    this.meshes.set(id, mesh);
    mesh.start().catch((e) => console.warn('space', e));
  },
};
