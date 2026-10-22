/* ═══════════════════════════════════════════════════════════════
   Contorno — transforma uma máscara (pixels 0/1) em polígonos.
   Usado em dois lugares:
   ─ Ensinar a IA: a diferença entre o pallet vazio e o quadro com a
     peça vira o CONTORNO da peça (não um retângulo).
   ─ Câmera: a IA de contorno devolve uma máscara por peça; aqui ela
     vira o polígono desenhado na tela.
   ═══════════════════════════════════════════════════════════════ */
window.Contorno = (function () {
  // 8 vizinhos em sentido horário, começando pelo oeste
  const DX = [-1, -1, 0, 1, 1, 1, 0, -1], DY = [0, -1, -1, -1, 0, 1, 1, 1];

  /* borda externa da região "dentro(x,y)" que começa em (sx,sy) — o 1º pixel dela na varredura */
  function tracar(dentro, sx, sy, W, H) {
    const pts = [[sx, sy]];
    let px = sx, py = sy, bx = sx - 1, by = sy;   // veio do oeste (fora)
    const lim = (W + H) * 8;
    for (let it = 0; it < lim; it++) {
      let ib = 0; for (let k = 0; k < 8; k++) if (px + DX[k] === bx && py + DY[k] === by) { ib = k; break; }
      let achou = false;
      for (let k = 1; k <= 8; k++) {
        const d = (ib + k) % 8, nx = px + DX[d], ny = py + DY[d];
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && dentro(nx, ny)) {
          const a = (ib + k - 1) % 8; bx = px + DX[a]; by = py + DY[a];
          px = nx; py = ny; achou = true; break;
        }
      }
      if (!achou) break;                         // pixel isolado
      if (px === sx && py === sy) break;         // deu a volta
      pts.push([px, py]);
    }
    return pts;
  }

  /* Ramer–Douglas–Peucker: tira pontos quase em linha reta (eps em pixels) */
  function simplificar(pts, eps) {
    if (pts.length < 4) return pts.slice();
    // polígono fechado: corta no ponto mais longe do 1º e simplifica as duas metades
    let far = 0, dm = -1; for (let i = 1; i < pts.length; i++) { const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2; if (d > dm) { dm = d; far = i; } }
    const rdp = (a) => {
      if (a.length < 3) return a;
      const [x1, y1] = a[0], [x2, y2] = a[a.length - 1], L = Math.hypot(x2 - x1, y2 - y1) || 1e-9;
      let im = 0, dmx = 0;
      for (let i = 1; i < a.length - 1; i++) { const d = Math.abs((y2 - y1) * a[i][0] - (x2 - x1) * a[i][1] + x2 * y1 - y2 * x1) / L; if (d > dmx) { dmx = d; im = i; } }
      if (dmx <= eps) return [a[0], a[a.length - 1]];
      const e = rdp(a.slice(0, im + 1)), f = rdp(a.slice(im));
      return e.slice(0, -1).concat(f);
    };
    const m1 = rdp(pts.slice(0, far + 1)), m2 = rdp(pts.slice(far).concat([pts[0]]));
    return m1.slice(0, -1).concat(m2.slice(0, -1));
  }

  /* regiões (componentes 4-conexos) de uma máscara W×H → [{ x0,y0,x1,y1, area, pts }]
     pts em pixels (centro do pixel), já simplificado. */
  function regioes(mask, W, H, minArea, eps) {
    const N = W * H, lab = new Int32Array(N), fila = new Int32Array(N), out = [];
    let id = 0;
    for (let s = 0; s < N; s++) {
      if (!mask[s] || lab[s]) continue;
      id++; let h = 0, q = 0, x0 = W, x1 = 0, y0 = H, y1 = 0, area = 0;
      fila[q++] = s; lab[s] = id;
      while (h < q) {
        const c = fila[h++]; area++; const x = c % W, y = (c / W) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && mask[c - 1] && !lab[c - 1]) { lab[c - 1] = id; fila[q++] = c - 1; }
        if (x < W - 1 && mask[c + 1] && !lab[c + 1]) { lab[c + 1] = id; fila[q++] = c + 1; }
        if (y > 0 && mask[c - W] && !lab[c - W]) { lab[c - W] = id; fila[q++] = c - W; }
        if (y < H - 1 && mask[c + W] && !lab[c + W]) { lab[c + W] = id; fila[q++] = c + W; }
      }
      if (area < (minArea || 1)) continue;
      const meu = id, sx = s % W, sy = (s / W) | 0;
      const borda = tracar((x, y) => lab[y * W + x] === meu, sx, sy, W, H).map(p => [p[0] + 0.5, p[1] + 0.5]);
      out.push({ x0, y0, x1, y1, area, pts: simplificar(borda, eps == null ? 1 : eps) });
    }
    return out;
  }

  /* a maior região de uma máscara (ou null) */
  function maior(mask, W, H, eps) {
    const r = regioes(mask, W, H, 1, eps); if (!r.length) return null;
    return r.sort((a, b) => b.area - a.area)[0];
  }

  /* ponto dentro do polígono (pts normalizados) */
  function dentro(pts, x, y) {
    let d = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi) d = !d;
    }
    return d;
  }
  function caixaDe(pts) {
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys); return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  function retangulo(c) { return [[c.x, c.y], [c.x + c.w, c.y], [c.x + c.w, c.y + c.h], [c.x, c.y + c.h]]; }

  /* envoltória convexa (junta pedaços da mesma peça num contorno só) */
  function envoltoria(pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return p;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], hi = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
    return lo.slice(0, -1).concat(hi.slice(0, -1));
  }

  return { tracar, simplificar, regioes, maior, dentro, caixaDe, retangulo, envoltoria };
})();
