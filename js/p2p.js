// Emparejar tus propios dispositivos: sincroniza TODA la biblioteca entre ellos.
import { Mesh, hostCode, joinCode, cancelPairing, rand, isDevice } from './mesh.js';

const load = () => { try { return JSON.parse(localStorage.getItem('pb.p2p')); } catch { return null; } };
const save = (g) => (g ? localStorage.setItem('pb.p2p', JSON.stringify(g)) : localStorage.removeItem('pb.p2p'));

export const p2p = {
  mesh: null,
  message: '',
  onState: () => {},

  get group() { return load(); },
  get paired() { return !!load()?.peers?.length; },
  get online() { return this.mesh?.online || 0; },

  say(m) { this.message = m; this.onState(); },

  /** Este dispositivo muestra un código y espera al otro. confirm(nombre) decide si se acepta. */
  host({ onCode, confirm }) {
    return hostCode({
      onCode,
      confirm,
      offer: () => {
        const g = load() || { secret: rand(24), device: rand(6), peers: [] };
        save(g);
        return { t: 'paired', kind: 'personal', secret: g.secret, device: g.device, peers: g.peers };
      },
      onJoined: (m) => {
        const g = load();
        if (!g.peers.includes(m.device)) g.peers.push(m.device);
        save(g);
        setTimeout(() => this.start(), 500);
      },
    });
  },

  /** Este dispositivo escribe el código que muestra el otro. */
  async join(code) {
    await joinCode(code, {
      name: '',
      accept: (m) => {
        if (m.kind === 'space') throw new Error('Ese código es de un grupo o documento compartido. Úsalo en «Grupos → Unirme con un código».');
        if (!m.secret || !isDevice(m.device)) throw new Error('Respuesta no válida.');
        const device = load()?.device || rand(6);
        const peers = [...new Set([m.device, ...(m.peers || [])])].filter((x) => x !== device && isDevice(x));
        save({ secret: m.secret, device, peers });
        return { t: 'joined', device };
      },
    });
    this.start();
  },

  cancelPairing(quiet) { cancelPairing(quiet); },

  unpair() {
    this.stop();
    save(null);
    this.say('');
  },

  stop() {
    this.mesh?.stop();
    this.mesh = null;
  },

  async start() {
    const g = load();
    this.stop();
    if (!g?.peers?.length) return this.onState();
    const mesh = (this.mesh = new Mesh({
      prefix: 'pb',
      secret: g.secret,
      device: g.device,
      peers: () => load()?.peers || [],
      filter: () => true,
      hello: () => ({ peers: load()?.peers || [] }),
      onAuth: (c, hello) => {
        const cur = load();
        if (!cur) return false;
        const peers = [...new Set([...cur.peers, c.remote, ...(Array.isArray(hello?.peers) ? hello.peers : [])])]
          .filter((x) => x !== cur.device && isDevice(x));
        if (peers.length !== cur.peers.length) save({ ...cur, peers });
      },
      onChange: () => this.onState(),
      onSay: (t) => this.say(t),
    }));
    await mesh.start();
  },
};
