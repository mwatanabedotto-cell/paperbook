// Motor de tinta: dibujo y detección de trazos.
// Coordenadas normalizadas al ANCHO de la página (x e y divididos por el ancho),
// así las anotaciones escalan igual en cualquier pantalla o nivel de zoom.

const TEXT_LH = 1.25;

function head(ctx, x0, y0, x1, y1, size) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - size * Math.cos(a - 0.45), y1 - size * Math.sin(a - 0.45));
  ctx.lineTo(x1 - size * Math.cos(a + 0.45), y1 - size * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fill();
}

/** Dibuja un trazo. W = ancho de la página en píxeles del lienzo; offY = desplazamiento normalizado. */
export function drawStroke(ctx, s, W, offY = 0) {
  const P = s.p;
  if (!P?.length) return;
  ctx.save();
  ctx.translate(0, -offY * W);
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.strokeStyle = ctx.fillStyle = s.c;
  const lw = Math.max(s.w * W, 0.6);
  ctx.lineWidth = lw;
  const X = (i) => P[i][0] * W;
  const Y = (i) => P[i][1] * W;

  switch (s.t) {
    case 'pen':
    case 'hl': {
      if (s.t === 'hl') ctx.globalAlpha = 0.35;
      if (P.length === 1) {
        ctx.beginPath();
        ctx.arc(X(0), Y(0), lw / 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      const pressure = s.t === 'pen' && P.some((p) => p[2] != null && p[2] !== 0.5);
      if (!pressure) {
        ctx.beginPath();
        ctx.moveTo(X(0), Y(0));
        for (let i = 1; i < P.length - 1; i++) {
          ctx.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2);
        }
        ctx.lineTo(X(P.length - 1), Y(P.length - 1));
        ctx.stroke();
      } else {
        // grosor variable según la presión del lápiz
        let mx = X(0), my = Y(0);
        for (let i = 1; i < P.length; i++) {
          const last = i === P.length - 1;
          const nx = last ? X(i) : (X(i) + X(i + 1)) / 2;
          const ny = last ? Y(i) : (Y(i) + Y(i + 1)) / 2;
          ctx.lineWidth = lw * (0.35 + 1.3 * (P[i][2] ?? 0.5));
          ctx.beginPath();
          ctx.moveTo(mx, my);
          ctx.quadraticCurveTo(X(i), Y(i), nx, ny);
          ctx.stroke();
          mx = nx; my = ny;
        }
      }
      break;
    }
    case 'line':
    case 'arrow': {
      const j = P.length - 1;
      ctx.beginPath();
      ctx.moveTo(X(0), Y(0));
      ctx.lineTo(X(j), Y(j));
      ctx.stroke();
      if (s.t === 'arrow' && j > 0) head(ctx, X(0), Y(0), X(j), Y(j), Math.max(lw * 4, 8));
      break;
    }
    case 'rect': {
      const j = P.length - 1;
      ctx.lineJoin = 'miter';
      ctx.strokeRect(X(0), Y(0), X(j) - X(0), Y(j) - Y(0));
      break;
    }
    case 'ellipse': {
      const j = P.length - 1;
      ctx.beginPath();
      ctx.ellipse((X(0) + X(j)) / 2, (Y(0) + Y(j)) / 2,
        Math.abs(X(j) - X(0)) / 2, Math.abs(Y(j) - Y(0)) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'text': {
      const size = s.w * W;
      ctx.font = `${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.textBaseline = 'top';
      String(s.text || '').split('\n').forEach((line, i) => {
        ctx.fillText(line, X(0), Y(0) + i * size * TEXT_LH + size * 0.12);
      });
      break;
    }
  }
  ctx.restore();
}

/** Caja envolvente normalizada [x0, y0, x1, y1]. */
export function bounds(s) {
  if (s.t === 'text') {
    const lines = String(s.text || '').split('\n');
    const w = Math.max(...lines.map((l) => l.length)) * s.w * 0.6;
    return [s.p[0][0], s.p[0][1], s.p[0][0] + w, s.p[0][1] + lines.length * s.w * TEXT_LH];
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of s.p) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const m = s.w * (s.t === 'arrow' ? 4 : 1);
  return [x0 - m, y0 - m, x1 + m, y1 + m];
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function polyDist(x, y, pts, closed) {
  let d = Infinity;
  const n = pts.length;
  if (n === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]);
  for (let i = 0; i < n - (closed ? 0 : 1); i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    d = Math.min(d, segDist(x, y, a[0], a[1], b[0], b[1]));
  }
  return d;
}

/** ¿El punto (x, y) toca el trazo dentro del radio r? (todo normalizado) */
export function hit(s, x, y, r) {
  const b = bounds(s);
  if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) return false;
  const P = s.p, j = P.length - 1;
  const tol = r + s.w / 2;
  switch (s.t) {
    case 'text':
      return true;
    case 'rect':
      return polyDist(x, y, [P[0], [P[j][0], P[0][1]], P[j], [P[0][0], P[j][1]]], true) <= tol;
    case 'ellipse': {
      const cx = (P[0][0] + P[j][0]) / 2, cy = (P[0][1] + P[j][1]) / 2;
      const rx = Math.abs(P[j][0] - P[0][0]) / 2, ry = Math.abs(P[j][1] - P[0][1]) / 2;
      const pts = [];
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
      }
      return polyDist(x, y, pts, true) <= tol;
    }
    case 'line':
    case 'arrow':
      return polyDist(x, y, [P[0], P[j]], false) <= tol;
    default:
      return polyDist(x, y, P, false) <= tol;
  }
}
