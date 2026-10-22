const { pool } = require('../db');

/** 'HH:MM:SS' → segundos desde a meia-noite */
function paraSegundos(hora) {
  if (!hora) return 0;
  const [h = 0, m = 0, s = 0] = String(hora).split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

/** segundos → 'HH:MM:SS' (dá a volta em 24h) */
function paraHora(segundos) {
  const t = ((Math.round(segundos) % 86400) + 86400) % 86400;
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const s = t % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

/**
 * Um turno pode cruzar a meia-noite (ex.: 22:00 → 06:00).
 * Nesse caso o intervalo de tempo é a união [inicio,24h) ∪ [0,fim).
 */
function horaDentroDoTurno(hora, turno) {
  const t = paraSegundos(hora);
  const ini = paraSegundos(turno.hora_inicio);
  const fim = paraSegundos(turno.hora_fim);
  const tol = (turno.tolerancia_min || 0) * 60;

  if (turno.cruza_meia_noite || fim <= ini) {
    return t >= ini - tol || t <= fim + tol;
  }
  return t >= ini - tol && t <= fim + tol;
}

/** Duração produtiva bruta do turno, em segundos (já lida com meia-noite) */
function duracaoTurnoSeg(turno) {
  const ini = paraSegundos(turno.hora_inicio);
  const fim = paraSegundos(turno.hora_fim);
  return fim > ini ? fim - ini : (86400 - ini) + fim;
}

/** Lista turnos ativos com seus intervalos aninhados */
async function listarTurnos({ apenasAtivos = false } = {}) {
  const filtro = apenasAtivos ? 'WHERE ativo = TRUE' : '';
  const turnos = (await pool.query(
    `SELECT * FROM turnos ${filtro} ORDER BY ordem, codigo`
  )).rows;

  if (!turnos.length) return [];

  const ids = turnos.map(t => t.id);
  const intervalos = (await pool.query(
    `SELECT * FROM turno_intervalos WHERE turno_id = ANY($1::int[]) AND ativo = TRUE
     ORDER BY hora_inicio`,
    [ids]
  )).rows;

  return turnos.map(t => ({
    ...t,
    intervalos: intervalos.filter(i => i.turno_id === t.id)
  }));
}

/** Descobre qual turno ativo cobre determinada hora. Retorna null se nenhum cobrir. */
async function detectarTurno(hora) {
  const turnos = await listarTurnos({ apenasAtivos: true });
  return turnos.find(t => horaDentroDoTurno(hora, t)) || null;
}

/**
 * Calcula os horários de fim de cada ciclo dentro de um turno,
 * pulando os intervalos de descanso e somando o tempo de linha parada.
 *
 * Retorna [{ numero, hora }] até o fim do turno ou até o limite de ciclos.
 */
function calcularCiclos(turno, taktMin, { tempoParadoSeg = 0, limite = 500 } = {}) {
  const passoSeg = Math.max(1, Math.round(Number(taktMin) * 60));
  const iniSeg = paraSegundos(turno.hora_inicio);
  const totalTurno = duracaoTurnoSeg(turno);

  // Intervalos convertidos para "offset a partir do início do turno"
  const pausas = (turno.intervalos || []).map(i => {
    let a = paraSegundos(i.hora_inicio) - iniSeg;
    let b = paraSegundos(i.hora_fim) - iniSeg;
    if (a < 0) a += 86400;
    if (b < 0) b += 86400;
    return { a, b };
  }).filter(p => p.b > p.a).sort((x, y) => x.a - y.a);

  const ciclos = [];
  let offset = tempoParadoSeg;   // relógio, em offset a partir do início do turno

  const pularPausas = (o) => {
    let mudou = true;
    while (mudou) {
      mudou = false;
      for (const p of pausas) {
        if (o > p.a && o < p.b) { o = p.b; mudou = true; }
      }
    }
    return o;
  };

  for (let n = 1; n <= limite; n++) {
    let restante = passoSeg;
    offset = pularPausas(offset);

    // Consome o takt saltando blocos de pausa em O(nº de pausas), não segundo a segundo
    while (restante > 0) {
      const proxima = pausas.find(p => p.a >= offset);
      const ateProxima = proxima ? proxima.a - offset : Infinity;

      if (restante <= ateProxima) {
        offset += restante;
        restante = 0;
      } else {
        restante -= ateProxima;
        offset = proxima.b;
      }

      if (offset >= totalTurno) break;
    }

    if (offset >= totalTurno) {
      ciclos.push({ numero: n, hora: paraHora(iniSeg + totalTurno), fimDeTurno: true });
      break;
    }
    ciclos.push({ numero: n, hora: paraHora(iniSeg + offset), fimDeTurno: false });
  }

  return ciclos;
}

module.exports = {
  paraSegundos,
  paraHora,
  horaDentroDoTurno,
  duracaoTurnoSeg,
  listarTurnos,
  detectarTurno,
  calcularCiclos
};
