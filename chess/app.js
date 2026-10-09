import { Chess } from './vendor/chess.esm.js';

const CLASS_LABELS = {
  best: 'Лучший ход',
  excellent: 'Отличный ход',
  good: 'Хороший ход',
  inaccuracy: 'Неточность',
  mistake: 'Ошибка',
  blunder: 'Зевок',
};
const CATS = ['best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder'];
// Only these classes are worth showing an alternative move for — "good"/"excellent"
// are already fine choices in practice, so suggesting a marginally different one
// is noise, not useful feedback.
const SUBOPTIMAL_CLASSES = new Set(['inaccuracy', 'mistake', 'blunder']);

const PIECE_NAME = { p: 'пешку', n: 'коня', b: 'слона', r: 'ладью', q: 'ферзя', k: 'короля' };
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function ruPlural(n, one, few, many) {
  n = Math.abs(n);
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return few;
  return many;
}

// ---------- DOM refs ----------
const boardEl = document.getElementById('board');
const topPlayerLabel = document.getElementById('topPlayerLabel');
const bottomPlayerLabel = document.getElementById('bottomPlayerLabel');
const evalBarFill = document.getElementById('evalBarFill');
const evalBarLabel = document.getElementById('evalBarLabel');
const moveCommentEl = document.getElementById('moveComment');
const engineStatusEl = document.getElementById('engineStatus');
const moveListEl = document.getElementById('moveList');
const accuracySummaryEl = document.getElementById('accuracySummary');
const openingNameEl = document.getElementById('openingName');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
const btnAnalyzeAll = document.getElementById('btnAnalyzeAll');
const depthSelect = document.getElementById('depthSelect');
const usernameInput = document.getElementById('usernameInput');
const btnLoadGames = document.getElementById('btnLoadGames');
const userHint = document.getElementById('userHint');
const gameList = document.getElementById('gameList');
const pgnInput = document.getElementById('pgnInput');
const btnLoadPgn = document.getElementById('btnLoadPgn');
const btnStart = document.getElementById('btnStart');
const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');
const btnEnd = document.getElementById('btnEnd');
const btnPlay = document.getElementById('btnPlay');
const btnFlip = document.getElementById('btnFlip');
const voiceToggle = document.getElementById('voiceToggle');
const voiceRate = document.getElementById('voiceRate');
const voiceSelect = document.getElementById('voiceSelect');
const exploreBar = document.getElementById('exploreBar');
const boardHint = document.getElementById('boardHint');
const evalGraphEl = document.getElementById('evalGraph');
const tabTrainer = document.getElementById('tabTrainer');
const tabStats = document.getElementById('tabStats');
const trainerTabBtn = document.getElementById('trainerTabBtn');

// ---------- App state ----------
const state = {
  game: null,       // { headers, sanMoves, fens, verbose, userColor }
  analysis: null,   // { whiteCp, mateIn, bestUci, moveClass, moveLoss, depth }
  currentPly: 0,
  flipped: false,
  playing: false,
  playTimer: null,
  analyzing: false,
  voiceEnabled: false,
  // 'game' — просмотр партии; 'explore' — свой вариант поверх позиции;
  // 'trainer' — задача из собственной ошибки. Клики по доске ведут себя по-разному.
  mode: 'game',
  explore: null,
  trainer: null,
  loadedGames: null, // { games, username } — последняя загрузка с chess.com, для статистики
};

// ---------- Stockfish engine wrapper ----------
class Engine {
  constructor(path) {
    this.worker = new Worker(path);
    this._lastInfo = null;
    this._pending = null;
    this._readyResolve = null;
    this.readyPromise = new Promise((resolve) => { this._readyResolve = resolve; });
    this.worker.onmessage = (e) => this._onLine(e.data);
    this.worker.onerror = (e) => console.error('Engine error:', e.message);
    this._send('uci');
  }

  _send(cmd) { this.worker.postMessage(cmd); }

  _onLine(line) {
    if (typeof line !== 'string') return;
    if (line === 'uciok') {
      this._send('isready');
      return;
    }
    if (line === 'readyok') {
      if (this._readyResolve) { this._readyResolve(); this._readyResolve = null; }
      return;
    }
    if (line.startsWith('info') && line.includes(' score ')) {
      this._lastInfo = parseInfoLine(line);
      return;
    }
    if (line.startsWith('bestmove')) {
      const parts = line.split(' ');
      const bestmove = parts[1];
      if (this._pending) {
        const { resolve } = this._pending;
        const info = this._lastInfo;
        this._pending = null;
        resolve({ bestmove, info });
      }
    }
  }

  ready() { return this.readyPromise; }

  analyze(fen, depth) {
    return this.ready().then(() => new Promise((resolve) => {
      this._lastInfo = null;
      this._pending = { resolve };
      this._send('position fen ' + fen);
      this._send('go depth ' + depth);
    }));
  }
}

function parseInfoLine(line) {
  const tokens = line.split(' ');
  let depth = null, scoreType = null, scoreVal = null, pv = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'depth') depth = parseInt(tokens[i + 1], 10);
    if (tokens[i] === 'score') { scoreType = tokens[i + 1]; scoreVal = parseInt(tokens[i + 2], 10); }
    if (tokens[i] === 'pv') { pv = tokens.slice(i + 1); break; }
  }
  return { depth, scoreType, scoreVal, pv };
}

function evalFromInfo(info, stm) {
  if (!info || info.scoreVal === null || info.scoreVal === undefined) {
    return { whiteCp: 0, mateIn: null };
  }
  if (info.scoreType === 'mate') {
    const m = info.scoreVal; // relative to side to move
    const mateInWhite = stm === 'w' ? m : -m;
    const bigCp = m > 0 ? (100000 - m) : (-100000 - m);
    return { whiteCp: stm === 'w' ? bigCp : -bigCp, mateIn: mateInWhite };
  }
  const cp = info.scoreVal;
  return { whiteCp: stm === 'w' ? cp : -cp, mateIn: null };
}

const engine = new Engine('vendor/stockfish-nnue-16-single.js');
engine.ready().then(() => {
  engineStatusEl.textContent = 'Движок готов (Stockfish)';
  engineStatusEl.classList.add('ready');
});

// ---------- Opening book (theory move detection) ----------
// Bundled from lichess-org/chess-openings (public domain-ish, MIT-licensed data)
// so early moves that are just known theory ("book") don't get run through the
// engine-loss classifier — 1.e4 and 1.d4 are both fine, and treating either as
// a "mistake" relative to the other is exactly the kind of noise that makes
// engine-based analysis feel absurd for well-known opening moves.
let openingTrie = { children: new Map(), name: null, eco: null };

async function loadOpeningBook() {
  try {
    const res = await fetch('vendor/openings.json');
    const entries = await res.json();
    const root = { children: new Map(), name: null, eco: null };
    for (const e of entries) {
      let node = root;
      for (const mv of e.moves) {
        if (!node.children.has(mv)) node.children.set(mv, { children: new Map(), name: null, eco: null });
        node = node.children.get(mv);
      }
      node.name = e.name;
      node.eco = e.eco;
    }
    openingTrie = root;
  } catch (err) {
    console.warn('Opening book unavailable:', err);
  }
}
const openingBookReady = loadOpeningBook();

// Walks the game's moves through the trie: bookPly is how many opening plies
// are still "known theory" (even if unnamed at that exact ply — it's on the
// path to a named line), name/eco are from the deepest NAMED entry passed.
function detectBook(sanMoves) {
  let node = openingTrie;
  let bookPly = 0;
  let name = null;
  let eco = null;
  for (let i = 0; i < sanMoves.length; i++) {
    const next = node.children.get(sanMoves[i]);
    if (!next) break;
    node = next;
    bookPly = i + 1;
    if (node.name) { name = node.name; eco = node.eco; }
  }
  return { bookPly, name, eco };
}

function renderOpeningName() {
  const info = state.game && state.game.bookInfo;
  if (!info || !info.name) {
    openingNameEl.classList.add('hidden');
    openingNameEl.innerHTML = '';
    return;
  }
  openingNameEl.classList.remove('hidden');
  openingNameEl.innerHTML = `📖 <span class="eco">${info.eco}</span>${info.name}`;
}

// ---------- Forced moves ----------
// A position with exactly one legal move can't be judged for quality — there
// was no choice to praise or blame. Purely rules-based (chess.js), no engine
// needed, so like book moves this is known the instant a PGN is parsed.
function computeForcedFlags(fens, N) {
  const forced = new Array(N).fill(false);
  for (let k = 1; k <= N; k++) {
    try {
      forced[k - 1] = new Chess(fens[k - 1]).moves().length === 1;
    } catch (e) { /* ignore, leave as not-forced */ }
  }
  return forced;
}

// ---------- Speech (voice narration) ----------
// Uses the browser's built-in speech synthesis — no network, no API keys.
let cachedVoices = [];

function refreshVoiceList() {
  const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  if (!voices.length) return;
  cachedVoices = voices;
  const ruVoices = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith('ru'));
  // Local OS voices (e.g. macOS's "Милена") are compact and sound noticeably
  // robotic. Browsers often also expose a network voice (Chrome's "Google
  // русский") that's synthesized server-side and sounds far more natural —
  // put those first and default to one when nothing's been picked yet.
  const list = (ruVoices.length ? ruVoices : voices)
    .slice()
    .sort((a, b) => Number(a.localService) - Number(b.localService));
  const prevValue = voiceSelect.value;
  voiceSelect.innerHTML = '';
  list.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})${v.localService ? '' : ' — сетевой, естественнее'}`;
    voiceSelect.appendChild(opt);
  });
  if (prevValue && list.some((v) => v.name === prevValue)) {
    voiceSelect.value = prevValue;
  } else if (list.length) {
    voiceSelect.value = list[0].name;
  }
}

if (window.speechSynthesis) {
  refreshVoiceList();
  window.speechSynthesis.onvoiceschanged = refreshVoiceList;
}

// Turns the HTML comment (with <span class="tag"> and <br>) into a clean sentence
// for speech — strips markup but keeps the words, including the classification tag.
function htmlToSpeechText(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html.replace(/<br\s*\/?>/gi, ' ');
  return tmp.textContent.replace(/\s+/g, ' ').trim();
}

function stopSpeech() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

// Speaks `text` and returns the utterance (so callers like autoplay can hook `onend`).
function speak(text) {
  if (!state.voiceEnabled || !text || !window.speechSynthesis) return null;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = 'ru-RU';
  utt.rate = parseFloat(voiceRate.value || '1');
  const chosen = cachedVoices.find((v) => v.name === voiceSelect.value);
  if (chosen) utt.voice = chosen;
  // Network voices (nicer-sounding, e.g. Chrome's "Google русский") are
  // synthesized server-side and can occasionally fail (offline, blocked,
  // Chrome's remote-synthesis permission not yet granted) — fall back to a
  // local voice once so the user still hears something instead of silence.
  // Uses addEventListener rather than .onerror so it doesn't clash with
  // callers (autoplay) that set their own .onerror on the returned utterance.
  utt.addEventListener('error', () => {
    if (chosen && !chosen.localService) {
      const local = cachedVoices.find((v) => v.lang === chosen.lang && v.localService);
      if (local) {
        const retry = new SpeechSynthesisUtterance(text);
        retry.lang = 'ru-RU';
        retry.rate = utt.rate;
        retry.voice = local;
        window.speechSynthesis.speak(retry);
      }
    }
  });
  window.speechSynthesis.speak(utt);
  return utt;
}

// ---------- Player labels (who's playing which side) ----------
// Shows White/Black names above/below the board (swapped when flipped) and marks
// whichever one is "you" — either auto-detected from the chess.com username, or
// set by clicking a label directly (useful for the paste-PGN flow, where we have
// no username to match against).
function buildPlayerLabelContent(color, headers, userColor) {
  const name = color === 'w' ? (headers.White || 'Белые') : (headers.Black || 'Чёрные');
  const elo = color === 'w' ? headers.WhiteElo : headers.BlackElo;
  const isYou = userColor === color;
  const dot = `<span class="pl-dot ${color === 'w' ? 'white' : 'black'}"></span>`;
  const ratingHtml = elo ? `<span class="pl-rating">(${elo})</span>` : '';
  const youHtml = isYou ? '<span class="pl-you">вы</span>' : '';
  return `<span class="pl-side">${dot}<span>${name}</span>${ratingHtml}</span>${youHtml}`;
}

function renderPlayerLabels() {
  if (!state.game) {
    topPlayerLabel.innerHTML = '';
    bottomPlayerLabel.innerHTML = '';
    return;
  }
  const headers = state.game.headers || {};
  const userColor = state.game.userColor;
  const topColor = state.flipped ? 'w' : 'b';
  const bottomColor = state.flipped ? 'b' : 'w';
  topPlayerLabel.innerHTML = buildPlayerLabelContent(topColor, headers, userColor);
  let bottomHtml = buildPlayerLabelContent(bottomColor, headers, userColor);
  if (!userColor) bottomHtml += '<span class="pl-hint">нажмите на свою сторону</span>';
  bottomPlayerLabel.innerHTML = bottomHtml;
}

function setUserColor(color) {
  if (!state.game) return;
  state.game.userColor = color;
  state.flipped = color === 'b';
  renderPlayerLabels();
  goToPly(state.currentPly);
}

topPlayerLabel.addEventListener('click', () => {
  if (!state.game) return;
  setUserColor(state.flipped ? 'w' : 'b');
});
bottomPlayerLabel.addEventListener('click', () => {
  if (!state.game) return;
  setUserColor(state.flipped ? 'b' : 'w');
});

// ---------- Board rendering ----------
function pieceGlyph(ch) {
  const map = { p: '♟', r: '♜', n: '♞', b: '♝', q: '♛', k: '♚' };
  // U+FE0E forces text presentation instead of emoji presentation, so CSS color
  // actually applies (macOS/Chrome otherwise renders these as colored emoji glyphs
  // that ignore `color`, making white and black pieces look identical).
  return map[ch.toLowerCase()] + '︎';
}

function squareCenter(square, flip) {
  const file = square.charCodeAt(0) - 97;
  const rank = parseInt(square[1], 10) - 1;
  let col = file, row = 7 - rank;
  if (flip) { col = 7 - file; row = rank; }
  return { x: col * 60 + 30, y: row * 60 + 30 };
}

function drawArrow(fromSq, toSq, flip) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', '480');
  svg.setAttribute('height', '480');
  svg.style.position = 'absolute';
  svg.style.top = '0';
  svg.style.left = '0';
  svg.style.pointerEvents = 'none';
  svg.innerHTML = '<defs><marker id="arrowhead" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">' +
    '<path d="M0,0 L8,4 L0,8 z" fill="rgba(255,170,0,0.9)"/></marker></defs>';
  const p1 = squareCenter(fromSq, flip);
  const p2 = squareCenter(toSq, flip);
  const line = document.createElementNS(svgNS, 'line');
  line.setAttribute('x1', p1.x);
  line.setAttribute('y1', p1.y);
  line.setAttribute('x2', p2.x);
  line.setAttribute('y2', p2.y);
  line.setAttribute('stroke', 'rgba(255,170,0,0.9)');
  line.setAttribute('stroke-width', '6');
  line.setAttribute('marker-end', 'url(#arrowhead)');
  svg.appendChild(line);
  boardEl.appendChild(svg);
}

function drawBoard(fen, { flip = false, lastMove = null, arrow = null, selected = null, targets = [], hint = null } = {}) {
  boardEl.innerHTML = '';
  const rows = fen.split(' ')[0].split('/');
  const grid = [];
  for (let r = 0; r < 8; r++) {
    const rowChars = [];
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) {
        for (let k = 0; k < parseInt(ch, 10); k++) rowChars.push(null);
      } else {
        rowChars.push(ch);
      }
    }
    grid.push(rowChars);
  }
  for (let displayRow = 0; displayRow < 8; displayRow++) {
    for (let displayCol = 0; displayCol < 8; displayCol++) {
      let r, f;
      if (!flip) { r = displayRow; f = displayCol; } else { r = 7 - displayRow; f = 7 - displayCol; }
      const file = f, rank = 8 - r;
      const squareName = String.fromCharCode(97 + file) + rank;
      const isLight = (file + rank) % 2 === 1;
      const sq = document.createElement('div');
      sq.className = 'sq ' + (isLight ? 'light' : 'dark');
      sq.dataset.square = squareName;
      const pieceChar = grid[r][f];
      if (pieceChar) {
        const span = document.createElement('span');
        const isWhitePiece = pieceChar === pieceChar.toUpperCase();
        span.className = 'piece ' + (isWhitePiece ? 'white' : 'black');
        span.textContent = pieceGlyph(pieceChar);
        sq.appendChild(span);
      }
      if (lastMove && squareName === lastMove.from) sq.classList.add('highlight-from');
      if (lastMove && squareName === lastMove.to) sq.classList.add('highlight-to');
      if (squareName === selected) sq.classList.add('selected');
      if (squareName === hint) sq.classList.add('hint');
      if (targets.includes(squareName)) sq.classList.add(pieceChar ? 'target-capture' : 'target');
      boardEl.appendChild(sq);
    }
  }
  if (arrow) drawArrow(arrow.from, arrow.to, flip);
}

// ---------- Classification ----------
function classifyLoss(loss) {
  // A few centipawns of "loss" is well within normal search noise between two
  // independent searches (e.g. 1.e4 vs 1.d4 — both objectively excellent, the
  // engine's tiny preference between them isn't a real mistake). Anything this
  // small still counts as the best move in practice.
  if (loss <= 10) return 'best';
  if (loss <= 25) return 'excellent';
  if (loss <= 50) return 'good';
  if (loss <= 100) return 'inaccuracy';
  if (loss <= 250) return 'mistake';
  return 'blunder';
}

// Converts a White-centric centipawn score into White's win probability, using the
// Win%-based accuracy (what lichess uses) saturates hard once a position is
// already heavily decided: the logistic curve is nearly flat out past a few
// pawns of advantage, so a real 2-3 pawn slip barely moves the needle once
// you're already +6 or -6 — a game where the opponent blunders early and you
// just convert would then read as ~95%+, "playing like Magnus Carlsen," which
// is exactly the misleading result a low-rated player would see. Centipawn
// loss doesn't have that blind spot: a pawn of inaccuracy costs the same
// whether the position is balanced or already resolved, so it stays honest
// about the technique actually shown for the rest of the game too.
function moveAccuracyFromLoss(lossCp) {
  return Math.max(0, Math.min(100, 100 * Math.exp(-lossCp / 100)));
}

// Rebuilds the UCI long-algebraic form ("e2e4", "e7e8q") of a played move, so it
// can be compared against the engine's bestmove string directly.
function moveInfoToUci(moveInfo) {
  if (!moveInfo) return null;
  return moveInfo.from + moveInfo.to + (moveInfo.promotion || '');
}

function computeClassification() {
  const { whiteCp, bestUci } = state.analysis;
  const N = state.game.sanMoves.length;
  const bookPly = (state.game.bookInfo && state.game.bookInfo.bookPly) || 0;
  const moveClass = new Array(N).fill(null);
  const moveLoss = new Array(N).fill(0);
  const moveAcc = new Array(N).fill(100);
  for (let k = 1; k <= N; k++) {
    // Known opening theory doesn't get run through engine-loss judging at all —
    // see the "opening book" section for why (two top-tier opening moves being
    // a few centipawns apart isn't a real mistake).
    if (k <= bookPly) {
      moveClass[k - 1] = 'book';
      continue;
    }
    if (state.game.forcedFlags && state.game.forcedFlags[k - 1]) {
      moveClass[k - 1] = 'forced';
      continue;
    }
    const moverIsWhite = k % 2 === 1;
    const before = whiteCp[k - 1];
    const after = whiteCp[k];
    let loss = moverIsWhite ? (before - after) : (after - before);
    if (loss < 0) loss = 0;
    moveLoss[k - 1] = loss;

    // Two independent searches (position before vs. the resulting position) can
    // disagree by a few centipawns purely from search noise, even when the exact
    // same move was played. If the move actually played IS what the engine
    // recommended for that position, always call it "best" rather than trusting
    // that noise — otherwise we'd show a misleading "better move" arrow pointing
    // at the very move that was just played.
    const playedUci = moveInfoToUci(state.game.verbose[k - 1]);
    if (bestUci[k - 1] && playedUci === bestUci[k - 1]) {
      moveLoss[k - 1] = 0;
      moveClass[k - 1] = 'best';
      continue;
    }
    moveClass[k - 1] = classifyLoss(loss);
    moveAcc[k - 1] = moveAccuracyFromLoss(loss);
  }
  state.analysis.moveClass = moveClass;
  state.analysis.moveLoss = moveLoss;
  state.analysis.moveAcc = moveAcc;
}

function averageAccuracy(arr) {
  if (!arr.length) return 100;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function renderAccuracySummary() {
  const { moveClass, moveAcc } = state.analysis;
  const N = moveClass.length;
  const whiteAcc = [], blackAcc = [];
  const counts = { w: {}, b: {} };
  CATS.forEach((c) => { counts.w[c] = 0; counts.b[c] = 0; });
  for (let k = 1; k <= N; k++) {
    if (moveClass[k - 1] === 'book' || moveClass[k - 1] === 'forced') continue; // not judged, don't count them
    const isWhite = k % 2 === 1;
    counts[isWhite ? 'w' : 'b'][moveClass[k - 1]]++;
    (isWhite ? whiteAcc : blackAcc).push(moveAcc[k - 1]);
  }
  const accW = averageAccuracy(whiteAcc);
  const accB = averageAccuracy(blackAcc);
  accuracySummaryEl.classList.remove('hidden');
  const catsRow = (side) => CATS.map((c) => `<span title="${CLASS_LABELS[c]}"><span class="badge ${c}"></span> ${counts[side][c]}</span>`).join(' &nbsp; ');
  accuracySummaryEl.innerHTML = `
    <div class="side"><div>Белые</div><div class="acc-num">${accW.toFixed(1)}%</div><div style="margin-top:6px;font-size:11px">${catsRow('w')}</div></div>
    <div class="side"><div>Чёрные</div><div class="acc-num">${accB.toFixed(1)}%</div><div style="margin-top:6px;font-size:11px">${catsRow('b')}</div></div>
  `;
}

// ---------- Move list ----------
// Book status is known as soon as a PGN is parsed (no engine needed), so a move
// can show its 📖 badge immediately; everything else waits for full analysis.
function getMoveClass(idx) {
  const bookPly = state.game && state.game.bookInfo ? state.game.bookInfo.bookPly : 0;
  if (idx < bookPly) return 'book';
  if (state.game && state.game.forcedFlags && state.game.forcedFlags[idx]) return 'forced';
  return state.analysis ? state.analysis.moveClass[idx] : null;
}

function renderMoveList() {
  moveListEl.innerHTML = '';
  const { sanMoves } = state.game;
  for (let i = 0; i < sanMoves.length; i += 2) {
    const num = i / 2 + 1;
    const numDiv = document.createElement('div');
    numDiv.className = 'mv-num';
    numDiv.textContent = num + '.';
    moveListEl.appendChild(numDiv);
    moveListEl.appendChild(buildMoveCell(sanMoves[i], i + 1, getMoveClass(i)));
    if (sanMoves[i + 1] !== undefined) {
      moveListEl.appendChild(buildMoveCell(sanMoves[i + 1], i + 2, getMoveClass(i + 1)));
    } else {
      moveListEl.appendChild(document.createElement('div'));
    }
  }
  highlightActiveMoveCell();
}

function buildMoveCell(san, ply, classification) {
  const div = document.createElement('div');
  div.className = 'mv';
  div.dataset.ply = String(ply);
  if (classification) {
    const badge = document.createElement('span');
    badge.className = 'badge ' + classification;
    div.appendChild(badge);
  }
  const label = document.createElement('span');
  label.textContent = san;
  div.appendChild(label);
  div.addEventListener('click', () => goToPly(ply));
  return div;
}

function highlightActiveMoveCell() {
  moveListEl.querySelectorAll('.mv.active').forEach((el) => el.classList.remove('active'));
  const el = moveListEl.querySelector(`.mv[data-ply="${state.currentPly}"]`);
  if (el) el.classList.add('active');
}

// ---------- Navigation & comment ----------
function formatEval(whiteCp, mateIn) {
  if (mateIn !== null && mateIn !== undefined) {
    return mateIn > 0 ? `M${mateIn}` : `-M${-mateIn}`;
  }
  const p = whiteCp / 100;
  return (p >= 0 ? '+' : '') + p.toFixed(2);
}

function sanForUciMove(fen, uci) {
  try {
    const c = new Chess(fen);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    const mv = c.move({ from, to, promotion });
    return mv ? mv.san : uci;
  } catch (e) {
    return uci;
  }
}

// Plays out up to maxPlies moves of a UCI move list (an engine PV) on top of `fen`,
// so we can describe concretely what happens next (a hanging piece, a trade, a mate)
// instead of just reporting a centipawn number.
function simulatePv(fen, pv, maxPlies) {
  if (!pv || !pv.length) return [];
  let c;
  try { c = new Chess(fen); } catch (e) { return []; }
  const steps = [];
  const n = Math.min(maxPlies, pv.length);
  for (let i = 0; i < n; i++) {
    const uci = pv[i];
    if (!uci || uci.length < 4) break;
    const from = uci.slice(0, 2), to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    let mv;
    try { mv = c.move({ from, to, promotion }); } catch (e) { break; }
    if (!mv) break;
    steps.push({ san: mv.san, captured: mv.captured || null, to: mv.to, color: mv.color });
  }
  return steps;
}

// Looks at a short continuation (steps[0] is played by the "punishing" side) and
// works out the NET material swing in their favour, not just "was the destination
// square recaptured" — a queen recaptured by a pawn is still a huge win, not a trade.
function describeCaptureSequence(steps) {
  const firstCapIdx = steps.findIndex((s) => s.captured);
  if (firstCapIdx === -1) return null;
  const punisherColor = steps[0].color;
  const firstCap = steps[firstCapIdx];
  let net = 0; // material balance in favour of the punishing side, in pawns
  for (const s of steps) {
    if (!s.captured) continue;
    const val = PIECE_VALUE[s.captured] || 0;
    net += s.color === punisherColor ? val : -val;
  }
  const name = PIECE_NAME[firstCap.captured] || 'фигуру';
  if (net >= 2) {
    return {
      free: true,
      value: net,
      text: `после этого возможен удар ${firstCap.san}, забирающий ${name} — по итогам короткого размена соперник выигрывает материал (≈ ${net} п.)`,
    };
  }
  if (net <= -2) {
    // shouldn't normally happen in a genuine punishment line, but guard anyway
    return null;
  }
  return { free: false, text: `далее следует примерно равноценный размен (начиная с ${firstCap.san})` };
}

function mateNote(mateIn, moverIsWhite) {
  if (mateIn === null || mateIn === undefined) return null;
  const moverDelivers = moverIsWhite ? mateIn > 0 : mateIn < 0;
  const n = Math.abs(mateIn);
  const word = ruPlural(n, 'ход', 'хода', 'ходов');
  return moverDelivers
    ? `здесь есть форсированный мат в ${n} ${word}`
    : `здесь соперник получает форсированный мат в ${n} ${word}`;
}

// What a specific, very common opening move does — both immediately (which
// squares/diagonals/pieces it affects right now) and what it sets up for
// later (development, king safety, future breaks). Keyed by exact SAN since
// in the first handful of moves that's a reliable enough proxy for "what this
// move means" without needing full position analysis.
const OPENING_MOVE_IDEAS = {
  e4: 'сразу берут под контроль центральные поля d5 и f5, открывают диагональ белопольному слону (f1) и линию ферзю — самый прямой путь к быстрому развитию и атаке.',
  e5: 'отвечают в центре тем же — берут под контроль d4 и f4, открывают диагональ своему белопольному слону, не уступая пространство.',
  d4: 'берут под контроль c5 и e5, открывают диагональ чернопольному слону (c1) — более закрытый, позиционный путь, чем 1.e4.',
  d5: 'отвечают в центре тем же — оспаривают поля e4 и c4, открывают диагональ чернопольному слону.',
  c4: 'давят на центральное поле d5 с фланга, не блокируя диагональ слона f1 — более медленная, позиционная игра (английское начало).',
  c5: 'сразу нарушают симметрию и борются за d4 с фланга, не пуская соперника к спокойной игре в центре (сицилианская защита).',
  Nf3: 'развивают коня, берут под контроль e5 и d4, готовят короткую рокировку, пока не определяя пешечную структуру.',
  Nc3: 'давят на центральные поля d5/e4, но со временем это может помешать собственному продвижению пешки c2–c4.',
  Nf6: 'атакуют пешку e4 (если она есть) и берут под контроль центр, не отдавая пространство своими пешками.',
  Nc6: 'защищают пешку e5 и берут под контроль d4 — стандартное развитие в открытых дебютах.',
  Bb5: 'связывают коня c6, косвенно давя на пешку e5 — основная идея испанской партии.',
  Bc4: 'целятся в пункт f7 — самое слабое поле в лагере соперника возле короля (итальянская партия).',
  Bb4: 'связывают коня c3, создавая давление на центр и угрозу сдвоить пешки соперника после размена.',
  Bc5: 'целятся в пункт f2 — слабое поле возле короля белых, симметричный итальянский план чёрных.',
  g3: 'готовят фианкетто: слон выйдет на g2 и будет издалека держать под контролем всю диагональ a8–h1.',
  b3: 'готовят фианкетто ферзевого слона на b2 — давление на длинную диагональ h8–a1.',
  Qh5: 'выводят ферзя рано под удары развития соперника — угрожает пешке, но соперник может выиграть темп, атакуя ферзя своими фигурами.',
  Qh4: 'выводят ферзя рано под удары развития соперника — то же самое предупреждение о потере темпов.',
  'O-O': 'уводят короля в безопасный угол и подключают ладью к игре по центральным линиям в будущем.',
  'O-O-O': 'уводят короля на ферзевый фланг — ладья сразу выходит на центральную линию d, но король может стать мишенью для пешечного штурма.',
  c3: 'готовят продвижение d2–d4 с надёжной поддержкой пешки — типичный план в итальянской партии.',
  c6: 'готовят d5 с поддержкой, не ослабляя структуру — основа защиты Каро-Канн.',
  e6: 'освобождают дорогу слону f8 и ферзю, но временно запирают своего белопольного слона c8 — основа французской защиты.',
  a6: 'делают профилактику против связки или выпада слона на b5 — частый ход в испанской партии.',
};

// Broader strategic idea of the whole opening, shown once its name is known
// (matched by keyword against the detected ECO name — covers the openings
// players actually run into most often).
const OPENING_FAMILY_IDEAS = [
  [/Ruy Lopez|Spanish/i, 'Идея дебюта — давление на коня c6 (а через него на пешку e5) слоном b5 и долгая позиционная борьба за центр.'],
  [/Italian Game|Giuoco Piano|Evans/i, 'Идея дебюта — быстрое развитие с прицелом слона на слабый пункт f7, часто открытая игра в центре.'],
  [/Sicilian/i, 'Несимметричная защита: чёрные уступают контроль над d4 ради игры по полуоткрытой линии c и контратаки на ферзевом фланге.'],
  [/French Defense/i, 'Чёрные строят прочную пешечную цепь e6–d5, ограничивая своего слона c8, но получают крепкую структуру и контригру на ферзевом фланге.'],
  [/Caro-Kann/i, 'Солидная защита: чёрные готовят d5, не запирая слона c8 (в отличие от французской), ценой чуть более пассивной игры.'],
  [/Queen'?s Gambit/i, 'Белые предлагают пешку c4, чтобы отвлечь центральную пешку чёрных и получить перевес в пространстве в центре.'],
  [/King'?s Indian/i, 'Чёрные отдают центр белым, готовя контрудар e5 или f5 и атаку на короля после фианкетто слона g7.'],
  [/Nimzo-Indian/i, 'Чёрные связывают коня c3, готовясь либо сдвоить пешки белых, либо получить двух слонов взамен позиционных уступок.'],
  [/Grünfeld|Gruenfeld/i, 'Чёрные отдают центр, чтобы затем атаковать его фигурами и пешкой c — гипермодернистская стратегия.'],
  [/English Opening/i, 'Гибкое фланговое начало — белые борются за центр полями, а не пешками, часто переходя в закрытые построения.'],
  [/Scandinavian/i, 'Чёрные сразу вскрывают игру, отыгрывая пешку ферзём, но теряют время на его повторные ходы.'],
  [/Pirc|Modern Defense/i, 'Чёрные фианкеттируют слона и позволяют белым занять центр, готовя контрудар позже.'],
  [/Vienna/i, 'Белые готовят f4 или давление на e5, избегая ранних разменов в центре.'],
  [/Scotch/i, 'Белые сразу вскрывают центр ходом d4, стремясь к быстрому развитию и открытой игре.'],
  [/London System/i, 'Белые строят одну и ту же надёжную схему развития почти независимо от ответов соперника.'],
  [/Catalan/i, 'Белые сочетают фианкетто слона g2 с пешечным давлением в центре — долгосрочное позиционное давление по диагонали.'],
  [/Slav Defense/i, 'Чёрные поддерживают d5 пешкой c6, не запирая слона c8 — солидная альтернатива ферзевому гамбиту.'],
  [/Benoni/i, 'Чёрные жертвуют пешечную структуру ради активной фигурной игры и давления по полуоткрытой линии e.'],
  [/Dutch Defense/i, 'Чёрные борются за поле e4 ходом f5, ослабляя своего короля ради фигурной активности.'],
  [/Reti/i, 'Белые откладывают занятие центра пешками, полагаясь на фигуры и фианкетто.'],
  [/Alekhine/i, 'Чёрные провоцируют белых на захват центра пешками, чтобы затем атаковать его фигурами.'],
  [/Wayward Queen/i, 'Ранний выход ферзя нацелен на быструю угрозу, но при точной игре соперника оборачивается потерей темпов.'],
  [/Bird/i, 'Белые захватывают пространство на королевском фланге ходом f4, по структуре напоминая голландскую защиту в цвете белых.'],
];

function describeOpeningMoveMechanics(moveInfo) {
  const specific = OPENING_MOVE_IDEAS[moveInfo.san];
  if (specific) return specific;
  switch (moveInfo.piece) {
    case 'p': return 'меняют пешечную структуру — это определяет, какие поля станут сильными или слабыми на много ходов вперёд.';
    case 'n': return 'развивают коня, включая его в борьбу за центр и освобождая место для будущей рокировки.';
    case 'b': return 'выводят слона на новую диагональ, нацеливаясь на дальние поля в лагере соперника.';
    case 'q': return 'выводят ферзя в игру раньше обычного — сильная фигура, но уязвимая для темпов от развивающихся фигур соперника.';
    case 'r': return 'активизируют ладью по открывающейся линии на будущее.';
    case 'k': return moveInfo.san.startsWith('O-O') ? 'уводят короля в безопасность и подключают ладью к игре.' : 'делают редкий для дебюта ход королём, обычно вынужденный.';
    default: return 'развивают позицию, готовя дальнейшие планы в партии.';
  }
}

function findOpeningFamilyIdea(name) {
  if (!name) return null;
  const hit = OPENING_FAMILY_IDEAS.find(([re]) => re.test(name));
  return hit ? hit[1] : null;
}

function buildBookCommentHtml(p) {
  const moveInfo = state.game.verbose[p - 1];
  const san = state.game.sanMoves[p - 1];
  const moverIsWhite = p % 2 === 1;
  const moverLabel = moverIsWhite ? 'Белые' : 'Чёрные';
  const info = state.game.bookInfo;
  let html = `<span class="tag" style="background:var(--book)">Теория</span> ${moverLabel} сыграли ${san}.<br>`;
  html += `${moverLabel} ${describeOpeningMoveMechanics(moveInfo)}`;
  if (info && info.name) {
    html += `<br>Дебют: <b>${info.eco} ${info.name}</b>.`;
    const idea = findOpeningFamilyIdea(info.name);
    if (idea) html += ` ${idea}`;
  }
  return html;
}

function buildForcedCommentHtml(p) {
  const san = state.game.sanMoves[p - 1];
  const moverIsWhite = p % 2 === 1;
  const moverLabel = moverIsWhite ? 'Белые' : 'Чёрные';
  return `<span class="tag" style="background:var(--forced)">Вынужденный</span> ${moverLabel} сыграли ${san} — единственный легальный ход в этой позиции, вне оценки движка.`;
}

function buildCommentHtml(p, cls, loss) {
  const moveInfo = state.game.verbose[p - 1];
  const san = state.game.sanMoves[p - 1];
  const moverIsWhite = p % 2 === 1;
  const moverLabel = moverIsWhite ? 'Белые' : 'Чёрные';
  const whiteCp = state.analysis.whiteCp[p];
  const mateIn = state.analysis.mateIn[p];
  const mateInBefore = state.analysis.mateIn[p - 1];

  let html = `<span class="tag" style="background:var(--${cls})">${CLASS_LABELS[cls]}</span> `;
  html += `${moverLabel} сыграли ${san}. Оценка: ${formatEval(whiteCp, mateIn)}.<br>`;

  const reasons = [];

  if (moveInfo.captured) {
    reasons.push(`Ход сам по себе берёт ${PIECE_NAME[moveInfo.captured] || 'фигуру'}.`);
  }

  const moverHadMate = mateInBefore !== null && mateInBefore !== undefined &&
    (moverIsWhite ? mateInBefore > 0 : mateInBefore < 0);
  const moverStillMates = mateIn !== null && mateIn !== undefined &&
    (moverIsWhite ? mateIn > 0 : mateIn < 0);
  const moverGetsMated = mateIn !== null && mateIn !== undefined &&
    (moverIsWhite ? mateIn < 0 : mateIn > 0);

  if (cls === 'best' || cls === 'excellent' || cls === 'good') {
    // Explain a good move: it delivers/keeps a forced mate, or it's simply the
    // engine's top pick and nothing concrete needs adding beyond the eval.
    if (moverStillMates) {
      reasons.push(capitalize(mateNote(mateIn, moverIsWhite)) + '.');
    } else if (!moveInfo.captured) {
      reasons.push('Движок считает этот ход одним из сильнейших в позиции — конкретной ошибки соперника здесь нет, просто точная игра.');
    }
  } else {
    // inaccuracy / mistake / blunder — explain the concrete punishment.
    if (moverHadMate && !moverStillMates) {
      reasons.push(capitalize(mateNote(mateInBefore, moverIsWhite)) + ', но этот ход его упускает.');
    } else {
      // pvs[p] is the engine's line for the position AFTER the move, i.e. the
      // opponent's best way to punish it — its first move is what "hangs".
      const punishSteps = simulatePv(state.game.fens[p], state.analysis.pvs[p] || [], 4);
      const punish = describeCaptureSequence(punishSteps);
      const clsWord = cls === 'blunder' ? 'зевок' : cls === 'mistake' ? 'ошибка' : 'неточность';
      if (punish && punish.free) {
        reasons.push(`Это ${clsWord}: ${punish.text}.`);
      } else if (moverGetsMated) {
        reasons.push(capitalize(mateNote(mateIn, moverIsWhite)) + ' — позиция становится форсированно проигранной.');
      } else {
        reasons.push(`Позиция ухудшается примерно на ${(loss / 100).toFixed(2)} пешки — соперник получает более активную игру, хотя прямого материального удара нет.`);
      }
    }

    const bestUciMove = state.analysis.bestUci[p - 1];
    const playedUciMove = moveInfoToUci(moveInfo);
    if (bestUciMove && bestUciMove !== playedUciMove) {
      const bestSan = sanForUciMove(state.game.fens[p - 1], bestUciMove);
      let why;
      if (moverHadMate) {
        why = mateNote(mateInBefore, moverIsWhite);
      } else {
        // Does the recommended move itself win material outright?
        let recCaptured = null;
        try {
          const tmp = new Chess(state.game.fens[p - 1]);
          const recMv = tmp.move({
            from: bestUciMove.slice(0, 2),
            to: bestUciMove.slice(2, 4),
            promotion: bestUciMove.length > 4 ? bestUciMove[4] : undefined,
          });
          recCaptured = recMv ? recMv.captured : null;
        } catch (e) { /* ignore, fall back to generic phrasing */ }
        if (recCaptured) {
          why = `он сразу забирает ${PIECE_NAME[recCaptured] || 'фигуру'}`;
        } else {
          why = `он сохранял перевес — сыгранный ход уступает ему примерно ${(loss / 100).toFixed(2)} пешки`;
        }
      }
      reasons.push(`Точнее было ${bestSan} — ${why}.`);
    }
  }

  html += reasons.join(' ');
  return html;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function updateEvalBarForPly(p) {
  if (!state.analysis) {
    evalBarFill.style.height = '50%';
    evalBarLabel.textContent = '—';
    return;
  }
  const wcp = state.analysis.whiteCp[p];
  const mate = state.analysis.mateIn[p];
  let pct;
  if (mate !== null && mate !== undefined) {
    pct = mate > 0 ? 97 : 3;
  } else {
    const clamped = Math.max(-1000, Math.min(1000, wcp));
    pct = 50 + (clamped / 1000) * 50;
  }
  evalBarFill.style.height = pct + '%';
  evalBarLabel.textContent = formatEval(wcp, mate);
}

function goToPly(p) {
  if (!state.game) return;
  if (state.mode !== 'game') leaveSideMode();
  const N = state.game.sanMoves.length;
  p = Math.max(0, Math.min(N, p));
  state.currentPly = p;
  const fen = state.game.fens[p];
  const lastMove = p > 0 ? state.game.verbose[p - 1] : null;
  let arrow = null;
  let commentHtml = '';
  if (p > 0 && getMoveClass(p - 1) === 'book') {
    commentHtml = buildBookCommentHtml(p);
  } else if (p > 0 && getMoveClass(p - 1) === 'forced') {
    commentHtml = buildForcedCommentHtml(p);
  } else if (state.analysis && p > 0) {
    const cls = state.analysis.moveClass[p - 1];
    const loss = state.analysis.moveLoss[p - 1];
    if (SUBOPTIMAL_CLASSES.has(cls)) {
      const bestUciMove = state.analysis.bestUci[p - 1];
      const playedUci = moveInfoToUci(state.game.verbose[p - 1]);
      // Don't draw an arrow "suggesting" the exact move that was already played.
      if (bestUciMove && bestUciMove !== playedUci) {
        arrow = { from: bestUciMove.slice(0, 2), to: bestUciMove.slice(2, 4) };
      }
    }
    commentHtml = buildCommentHtml(p, cls, loss);
  } else if (p === 0) {
    commentHtml = 'Начальная позиция. Нажмите «Анализировать партию», чтобы получить оценку и классификацию ходов.';
  }
  drawBoard(fen, { flip: state.flipped, lastMove, arrow });
  updateEvalBarForPly(p);
  highlightActiveMoveCell();
  updateGraphMarker();
  moveCommentEl.innerHTML = commentHtml;
  return speak(htmlToSpeechText(commentHtml));
}

// ---------- Full game analysis ----------
async function analyzeAllMoves() {
  if (!state.game || state.analyzing) return;
  state.analyzing = true;
  btnAnalyzeAll.disabled = true;
  progressWrap.classList.remove('hidden');
  const depth = parseInt(depthSelect.value, 10);
  const N = state.game.sanMoves.length;
  const whiteCp = new Array(N + 1).fill(0);
  const mateIn = new Array(N + 1).fill(null);
  const bestUci = new Array(N + 1).fill(null);
  const pvs = new Array(N + 1).fill(null);
  for (let i = 0; i <= N; i++) {
    progressFill.style.width = Math.round((i / (N + 1)) * 100) + '%';
    progressLabel.textContent = `Позиция ${i} из ${N}`;
    const fen = state.game.fens[i];
    const stm = fen.split(' ')[1];
    const { bestmove, info } = await engine.analyze(fen, depth);
    const ev = evalFromInfo(info, stm);
    whiteCp[i] = ev.whiteCp;
    mateIn[i] = ev.mateIn;
    bestUci[i] = bestmove;
    pvs[i] = (info && info.pv) ? info.pv : [];
  }
  state.analysis = { whiteCp, mateIn, bestUci, pvs, depth };
  computeClassification();
  renderMoveList();
  renderAccuracySummary();
  renderEvalGraph();
  collectTrainerPositions();
  recordAccuracyHistory();
  progressWrap.classList.add('hidden');
  btnAnalyzeAll.disabled = false;
  state.analyzing = false;
  goToPly(state.currentPly);
}

// ---------- Loading a game (from PGN text) ----------
// Best-effort guess at which side the user played, by matching the chess.com
// username field against the PGN's White/Black tags (used by the paste-PGN flow,
// which — unlike the "by username" game list — has no explicit color to pass in).
function detectUserColor(headers) {
  const uname = (usernameInput.value || '').trim().toLowerCase();
  if (!uname) return null;
  if ((headers.White || '').toLowerCase() === uname) return 'w';
  if ((headers.Black || '').toLowerCase() === uname) return 'b';
  return null;
}

async function loadGameFromPgn(pgnText, userColor) {
  if (state.analyzing) { alert('Дождитесь окончания текущего анализа.'); return; }
  if (!pgnText || !pgnText.trim()) { alert('PGN пустой.'); return; }
  await openingBookReady;
  try {
    const chess = new Chess();
    chess.loadPgn(pgnText);
    const startFen = chess.header().FEN;
    const replay = startFen ? new Chess(startFen) : new Chess();
    const verboseAll = chess.history({ verbose: true });
    const fens = [replay.fen()];
    const sanMoves = [];
    const verbose = [];
    for (const m of verboseAll) {
      const played = replay.move(m.san);
      fens.push(replay.fen());
      sanMoves.push(played.san);
      verbose.push({
        from: played.from,
        to: played.to,
        captured: played.captured || null,
        promotion: played.promotion || null,
        piece: played.piece,
        color: played.color,
        san: played.san,
      });
    }
    const headers = chess.header();
    if (!userColor) userColor = detectUserColor(headers);
    const bookInfo = detectBook(sanMoves);
    const forcedFlags = computeForcedFlags(fens, sanMoves.length);
    state.game = { headers, sanMoves, fens, verbose, userColor, bookInfo, forcedFlags };
    if (state.mode !== 'game') leaveSideMode();
    state.analysis = null;
    state.currentPly = 0;
    state.flipped = userColor === 'b';
    accuracySummaryEl.classList.add('hidden');
    accuracySummaryEl.innerHTML = '';
    evalGraphEl.classList.add('hidden');
    evalGraphEl.innerHTML = '';
    btnAnalyzeAll.disabled = sanMoves.length === 0;
    renderMoveList();
    renderPlayerLabels();
    renderOpeningName();
    goToPly(0);
  } catch (err) {
    alert('Не удалось разобрать PGN: ' + err.message);
  }
}

// ---------- chess.com fetch ----------
async function loadGamesForUser(username) {
  username = username.trim();
  if (!username) return;
  userHint.textContent = 'Загрузка списка партий…';
  gameList.innerHTML = '';
  try {
    const archRes = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/games/archives`);
    if (!archRes.ok) throw new Error('archives_not_found');
    const archJson = await archRes.json();
    const archives = archJson.archives || [];
    if (!archives.length) {
      userHint.textContent = 'У этого пользователя не найдено партий.';
      return;
    }
    const lastArchives = archives.slice(-2).reverse();
    let allGames = [];
    for (const url of lastArchives) {
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json();
      allGames = allGames.concat(j.games || []);
    }
    allGames.sort((a, b) => (b.end_time || 0) - (a.end_time || 0));
    allGames = allGames.slice(0, 40);
    renderGameList(allGames, username);
    userHint.textContent = `Найдено партий: ${allGames.length}`;
    // Запоминаем ник в браузере вместо того, чтобы держать его в коде страницы.
    try { localStorage.setItem('chess-username', username); } catch (e) { /* приватный режим */ }
    state.loadedGames = { games: allGames, username };
    renderStats();
  } catch (err) {
    userHint.innerHTML = 'Не удалось получить партии автоматически (chess.com мог отклонить запрос из браузера). ' +
      'Откройте партию на chess.com → «Поделиться» → вкладка PGN, скопируйте текст и вставьте во вкладку «Вставить PGN».';
  }
}

function renderGameList(games, username) {
  gameList.innerHTML = '';
  const uNorm = username.toLowerCase();
  for (const g of games) {
    if (!g.pgn) continue;
    const isWhite = (g.white.username || '').toLowerCase() === uNorm;
    const opp = isWhite ? g.black : g.white;
    const whiteWon = g.white.result === 'win';
    const blackWon = g.black.result === 'win';
    let outcome = 'draw';
    if (whiteWon) outcome = isWhite ? 'win' : 'loss';
    else if (blackWon) outcome = isWhite ? 'loss' : 'win';
    const div = document.createElement('div');
    div.className = 'game-item';
    const date = g.end_time ? new Date(g.end_time * 1000).toLocaleDateString('ru-RU') : '';
    const outcomeLabel = outcome === 'win' ? 'Победа' : outcome === 'loss' ? 'Поражение' : 'Ничья';
    div.innerHTML = `<span>${isWhite ? '⚪' : '⚫'} vs ${opp.username} (${opp.rating || '?'})</span>` +
      `<span class="res-${outcome}">${outcomeLabel} · ${date}</span>`;
    div.addEventListener('click', () => {
      gameList.querySelectorAll('.game-item.selected').forEach((el) => el.classList.remove('selected'));
      div.classList.add('selected');
      loadGameFromPgn(g.pgn, isWhite ? 'w' : 'b');
    });
    gameList.appendChild(div);
  }
}

// ---------- Move input on the board ----------
// Общая механика «нажми фигуру — нажми клетку» для режимов «свой ход» и
// «тренажёр». Возвращает сделанный ход (verbose из chess.js) или null.
let boardInput = null; // { fen, selected, flip, onMove, extra }

function legalTargets(fen, from) {
  try { return new Chess(fen).moves({ square: from, verbose: true }).map((m) => m.to); } catch (e) { return []; }
}

function redrawInput() {
  if (!boardInput) return;
  const { fen, selected, flip, extra } = boardInput;
  drawBoard(fen, {
    flip,
    selected,
    targets: selected ? legalTargets(fen, selected) : [],
    ...extra,
  });
}

function startBoardInput(fen, flip, onMove, extra = {}) {
  boardInput = { fen, selected: null, flip, onMove, extra };
  redrawInput();
}

boardEl.addEventListener('click', (e) => {
  const sqEl = e.target.closest('.sq');
  if (!sqEl) return;
  const square = sqEl.dataset.square;
  // В обычном просмотре клик по своей фигуре сразу открывает «свой ход».
  if (state.mode === 'game') {
    if (state.analyzing || state.playing) return;
    const fen = state.game ? state.game.fens[state.currentPly] : new Chess().fen();
    const c = new Chess(fen);
    const pc = c.get(square);
    if (!pc || pc.color !== c.turn()) return;
    enterExplore(fen);
  }
  if (!boardInput) return;
  const c = new Chess(boardInput.fen);
  const pc = c.get(square);
  if (boardInput.selected && boardInput.selected !== square) {
    const from = boardInput.selected;
    const piece = c.get(from);
    const isPromo = piece && piece.type === 'p' && (square[1] === '8' || square[1] === '1');
    let mv = null;
    try { mv = c.move({ from, to: square, promotion: isPromo ? 'q' : undefined }); } catch (err) { mv = null; }
    if (mv) {
      boardInput.selected = null;
      boardInput.onMove(mv, c.fen());
      return;
    }
  }
  boardInput.selected = pc && pc.color === c.turn() && boardInput.selected !== square ? square : null;
  redrawInput();
});

function leaveSideMode() {
  state.mode = 'game';
  state.explore = null;
  state.trainer = null;
  boardInput = null;
  exploreBar.classList.add('hidden');
  exploreBar.innerHTML = '';
  boardHint.classList.remove('hidden');
}

// Движок один, и одновременно он считает одну позицию. Полный анализ партии
// важнее — пока он идёт, свои ходы и тренажёр ждут.
let engineBusy = false;
async function evalPosition(fen, depth) {
  engineBusy = true;
  try {
    const { bestmove, info } = await engine.analyze(fen, depth);
    const ev = evalFromInfo(info, fen.split(' ')[1]);
    return { ...ev, bestmove };
  } finally {
    engineBusy = false;
  }
}

// Потеря в сантипешках с точки зрения сходившей стороны.
function lossForMover(beforeWhiteCp, afterWhiteCp, moverColor) {
  const loss = moverColor === 'w' ? beforeWhiteCp - afterWhiteCp : afterWhiteCp - beforeWhiteCp;
  return Math.max(0, loss);
}

// ---------- Explore: «Попробовать свой ход» ----------
function exploreDepth() {
  return Math.min(parseInt(depthSelect.value, 10), 14);
}

function enterExplore(fen) {
  if (state.playing) stopPlay();
  state.mode = 'explore';
  const baseP = state.currentPly;
  const knownEval = state.analysis && state.game && state.game.fens[baseP] === fen
    ? { whiteCp: state.analysis.whiteCp[baseP], mateIn: state.analysis.mateIn[baseP] }
    : null;
  state.explore = { line: [{ fen, san: null, eval: knownEval, move: null }] };
  boardHint.classList.add('hidden');
  exploreBar.classList.remove('hidden');
  renderExplore('Свой вариант: сделай ход на доске. Движок оценит его и покажет лучший ответ.');
}

function exploreNode() {
  return state.explore.line[state.explore.line.length - 1];
}

function renderExplore(commentHtml, arrow = null) {
  const node = exploreNode();
  const sans = state.explore.line.slice(1).map((n) => n.san);
  startBoardInput(node.fen, state.flipped, onExploreMove, { lastMove: node.move, arrow });
  if (node.eval) updateEvalBar(node.eval.whiteCp, node.eval.mateIn);
  moveCommentEl.innerHTML = commentHtml;
  exploreBar.innerHTML =
    `<span class="explore-line">🧪 Вариант: ${sans.length ? sans.join(' ') : '—'}</span>` +
    '<button id="exReply" title="Сыграть лучший ответ движка">🤖 Ответ движка</button>' +
    '<button id="exUndo">↶ Назад</button>' +
    '<button id="exBack">✕ К партии</button>';
  document.getElementById('exReply').onclick = exploreEngineReply;
  document.getElementById('exUndo').onclick = () => {
    if (state.explore.line.length > 1) state.explore.line.pop();
    renderExplore('Ход отменён. Попробуй другой.');
  };
  document.getElementById('exBack').onclick = () => goToPly(state.currentPly);
}

async function ensureEval(node) {
  if (!node.eval) {
    const ev = await evalPosition(node.fen, exploreDepth());
    node.eval = { whiteCp: ev.whiteCp, mateIn: ev.mateIn };
    node.best = ev.bestmove;
  }
  return node.eval;
}

async function onExploreMove(mv, newFen) {
  if (engineBusy || state.analyzing) { moveCommentEl.textContent = 'Движок ещё думает — секунду…'; return; }
  const prev = exploreNode();
  const node = { fen: newFen, san: mv.san, move: mv, eval: null };
  state.explore.line.push(node);
  renderExplore('Считаю…');
  const before = await ensureEval(prev);
  const ev = await evalPosition(newFen, exploreDepth());
  if (!state.explore || exploreNode() !== node) return; // успели уйти из варианта
  node.eval = { whiteCp: ev.whiteCp, mateIn: ev.mateIn };
  node.best = ev.bestmove;
  const loss = lossForMover(before.whiteCp, node.eval.whiteCp, mv.color);
  const cls = classifyLoss(loss);
  const who = mv.color === 'w' ? 'Белые' : 'Чёрные';
  let html = `<span class="tag" style="background:var(--${cls})">${CLASS_LABELS[cls]}</span> ${who}: ${mv.san}. ` +
    `Оценка: ${formatEval(before.whiteCp, before.mateIn)} → <b>${formatEval(node.eval.whiteCp, node.eval.mateIn)}</b>.`;
  if (loss > 10 && prev.best) html += ` Сильнее было ${sanForUciMove(prev.fen, prev.best)}.`;
  let arrow = null;
  if (ev.bestmove && ev.bestmove !== '(none)') {
    html += `<br>Лучший ответ соперника — <b>${sanForUciMove(newFen, ev.bestmove)}</b> (стрелка на доске).`;
    arrow = { from: ev.bestmove.slice(0, 2), to: ev.bestmove.slice(2, 4) };
  } else if (new Chess(newFen).isCheckmate()) {
    html += '<br>Это мат! 🎉';
  }
  renderExplore(html, arrow);
}

async function exploreEngineReply() {
  if (engineBusy || state.analyzing) return;
  const node = exploreNode();
  if (!node.best) {
    renderExplore('Считаю ответ…');
    await ensureEval(node);
  }
  if (!node.best || node.best === '(none)') { renderExplore('Ходов нет — партия в этой позиции окончена.'); return; }
  const c = new Chess(node.fen);
  const uci = node.best;
  const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
  await onExploreMove(mv, c.fen());
}

function updateEvalBar(wcp, mate) {
  let pct;
  if (mate !== null && mate !== undefined) pct = mate > 0 ? 97 : 3;
  else pct = 50 + (Math.max(-1000, Math.min(1000, wcp)) / 1000) * 50;
  evalBarFill.style.height = pct + '%';
  evalBarLabel.textContent = formatEval(wcp, mate);
}

// ---------- Trainer: задачи из собственных ошибок ----------
// После анализа каждая ошибка/зевок игрока сохраняется как позиция «найди ход
// сильнее». Хранится в localStorage браузера — никуда не отправляется.
const TRAINER_KEY = 'chess-trainer-v1';

function loadTrainer() {
  try {
    const d = JSON.parse(localStorage.getItem(TRAINER_KEY) || 'null');
    if (d && Array.isArray(d.items)) return d;
  } catch (e) { /* ignore */ }
  return { items: [], streak: 0, bestStreak: 0 };
}
function saveTrainer(d) {
  try { localStorage.setItem(TRAINER_KEY, JSON.stringify(d)); } catch (e) { /* ignore */ }
}

function collectTrainerPositions() {
  const d = loadTrainer();
  const { moveClass, bestUci, whiteCp } = state.analysis;
  const { fens, sanMoves, headers, userColor } = state.game;
  let added = 0;
  for (let k = 1; k <= sanMoves.length; k++) {
    const cls = moveClass[k - 1];
    if (cls !== 'mistake' && cls !== 'blunder') continue;
    const mover = k % 2 === 1 ? 'w' : 'b';
    if (userColor && mover !== userColor) continue; // учимся на своих ошибках, не на чужих
    const fen = fens[k - 1];
    if (!bestUci[k - 1] || d.items.some((it) => it.fen === fen)) continue;
    d.items.push({
      fen,
      bestUci: bestUci[k - 1],
      evalBefore: whiteCp[k - 1],
      played: sanMoves[k - 1],
      cls,
      from: `${headers.White || 'Белые'} — ${headers.Black || 'Чёрные'}, ход ${Math.ceil(k / 2)}`,
      solved: false,
    });
    added++;
  }
  saveTrainer(d);
  renderTrainerTab(added);
}

function renderTrainerTab(justAdded = 0) {
  const d = loadTrainer();
  const left = d.items.filter((it) => !it.solved).length;
  trainerTabBtn.textContent = left ? `Тренажёр (${left})` : 'Тренажёр';
  let html = '<p class="hint">Здесь собираются позиции, где ты ошибся. Найди ход сильнее, чем сыграл тогда.</p>';
  if (justAdded) html += `<p class="trainer-new">➕ Из этой партии добавлено задач: ${justAdded}</p>`;
  if (!d.items.length) {
    html += '<p>Пока задач нет. Проанализируй свою партию — ошибки попадут сюда.</p>';
  } else {
    html += `<div class="trainer-stats"><div><b>${left}</b><span>осталось</span></div>` +
      `<div><b>${d.items.length - left}</b><span>решено</span></div>` +
      `<div><b>${d.bestStreak || 0}</b><span>лучшая серия</span></div></div>`;
    html += `<button id="btnTrain" ${left ? '' : 'disabled'}>${left ? '▶ Решать задачи' : 'Все задачи решены 🎉'}</button>`;
    if (!left) html += ' <button id="btnTrainReset" class="secondary">↺ Решать заново</button>';
  }
  tabTrainer.innerHTML = html;
  const b = document.getElementById('btnTrain');
  if (b) b.onclick = startTrainer;
  const r = document.getElementById('btnTrainReset');
  if (r) r.onclick = () => { const dd = loadTrainer(); dd.items.forEach((it) => { it.solved = false; }); saveTrainer(dd); renderTrainerTab(); };
}

function startTrainer() {
  if (state.analyzing) { alert('Дождитесь окончания анализа партии.'); return; }
  if (state.playing) stopPlay();
  const d = loadTrainer();
  const pool = d.items.filter((it) => !it.solved);
  if (!pool.length) { renderTrainerTab(); return; }
  const item = pool[Math.floor(Math.random() * pool.length)];
  state.mode = 'trainer';
  state.trainer = { item, usedHelp: false, done: false };
  boardHint.classList.add('hidden');
  exploreBar.classList.remove('hidden');
  const side = item.fen.split(' ')[1] === 'w' ? 'белых' : 'чёрных';
  renderTrainer(`🎯 <b>Найди ход сильнее.</b> Ход ${side}. В партии (${item.from}) здесь было сыграно <b>${item.played}</b> — ` +
    `${item.cls === 'blunder' ? 'зевок' : 'ошибка'}.`);
}

function renderTrainer(commentHtml, extra = {}) {
  const { item } = state.trainer;
  const flip = item.fen.split(' ')[1] === 'b';
  startBoardInput(item.fen, flip, onTrainerMove, extra);
  updateEvalBar(0, null);
  evalBarLabel.textContent = '?';
  moveCommentEl.innerHTML = commentHtml;
  const d = loadTrainer();
  exploreBar.innerHTML =
    `<span class="explore-line">🔥 Серия: ${d.streak || 0}</span>` +
    '<button id="trHint">💡 Подсказка</button>' +
    '<button id="trShow">👁 Ответ</button>' +
    '<button id="trNext">⏭ Следующая</button>' +
    '<button id="trExit">✕ Выйти</button>';
  document.getElementById('trHint').onclick = () => {
    state.trainer.usedHelp = true;
    renderTrainer(moveCommentEl.innerHTML, { hint: item.bestUci.slice(0, 2) });
  };
  document.getElementById('trShow').onclick = () => {
    state.trainer.usedHelp = true;
    const san = sanForUciMove(item.fen, item.bestUci);
    renderTrainer(`Ответ: <b>${san}</b> (стрелка). Сыграй его на доске, чтобы закрепить.`,
      { arrow: { from: item.bestUci.slice(0, 2), to: item.bestUci.slice(2, 4) } });
  };
  document.getElementById('trNext').onclick = startTrainer;
  document.getElementById('trExit').onclick = () => { leaveSideMode(); if (state.game) goToPly(state.currentPly); else drawBoard(new Chess().fen()); renderTrainerTab(); };
}

async function onTrainerMove(mv, newFen) {
  const t = state.trainer;
  if (!t || t.done) return;
  if (engineBusy) return;
  const { item } = t;
  const uci = mv.from + mv.to + (mv.promotion || '');
  let good = uci === item.bestUci;
  let note = '';
  if (!good) {
    // Ход не совпал с ходом движка — но может быть не хуже. Проверяем.
    moveCommentEl.innerHTML = `Проверяю ${mv.san}…`;
    const ev = await evalPosition(newFen, 12);
    const loss = lossForMover(item.evalBefore, ev.whiteCp, mv.color);
    if (loss <= 40) { good = true; note = ` Движок предпочитал ${sanForUciMove(item.fen, item.bestUci)}, но твой ход почти так же хорош.`; }
    else note = ` Этот ход уступает примерно ${(loss / 100).toFixed(1)} пешки.`;
  }
  const d = loadTrainer();
  const stored = d.items.find((it) => it.fen === item.fen);
  if (good) {
    t.done = true;
    if (stored) stored.solved = true;
    d.streak = t.usedHelp ? 0 : (d.streak || 0) + 1;
    d.bestStreak = Math.max(d.bestStreak || 0, d.streak);
    saveTrainer(d);
    renderTrainerTab();
    renderTrainer(`✅ <b>Верно: ${mv.san}!</b>${note}${t.usedHelp ? '' : ' Серия растёт 🔥'}`,
      { lastMove: mv });
    boardInput.fen = newFen;
    redrawInput();
  } else {
    d.streak = 0;
    saveTrainer(d);
    renderTrainer(`❌ ${mv.san} — не то.${note} Попробуй ещё!`);
  }
}

// ---------- Evaluation graph ----------
// Кривая шансов белых по ходам (как Win% у lichess): у центральной линии —
// равенство, вверху — перевес белых. Точки — ошибки и зевки.
function winPct(cp, mate) {
  if (mate !== null && mate !== undefined) return mate > 0 ? 100 : 0;
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

function renderEvalGraph() {
  const { whiteCp, mateIn, moveClass } = state.analysis;
  const N = whiteCp.length - 1;
  const W = 400, H = 110;
  const x = (i) => (N ? (i / N) * W : 0);
  const y = (i) => H - (winPct(whiteCp[i], mateIn[i]) / 100) * H;
  let d = `M0,${H} `;
  for (let i = 0; i <= N; i++) d += `L${x(i).toFixed(1)},${y(i).toFixed(1)} `;
  d += `L${W},${H} Z`;
  let dots = '';
  for (let k = 1; k <= N; k++) {
    const c = moveClass[k - 1];
    if (c === 'mistake' || c === 'blunder' || c === 'inaccuracy') {
      dots += `<circle cx="${x(k).toFixed(1)}" cy="${y(k).toFixed(1)}" r="${c === 'inaccuracy' ? 2.5 : 4}" fill="var(--${c})"><title>${Math.ceil(k / 2)}${k % 2 ? '.' : '...'} ${state.game.sanMoves[k - 1]} — ${CLASS_LABELS[c]}</title></circle>`;
    }
  }
  evalGraphEl.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" id="evalSvg">` +
    `<rect width="${W}" height="${H}" fill="#3a3a3a"/>` +
    `<path d="${d}" fill="#e8e8e8"/>` +
    `<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="#888" stroke-dasharray="3 3" stroke-width="0.7"/>` +
    `<line id="evalMarker" x1="0" y1="0" x2="0" y2="${H}" stroke="var(--accent)" stroke-width="2"/>` +
    dots + '</svg>' +
    '<div class="graph-caption">Перевес по ходу партии: светлое — белые, тёмное — чёрные. Нажми на график, чтобы перейти к ходу.</div>';
  evalGraphEl.classList.remove('hidden');
  const svg = document.getElementById('evalSvg');
  svg.addEventListener('click', (e) => {
    const r = svg.getBoundingClientRect();
    goToPly(Math.round(((e.clientX - r.left) / r.width) * N));
  });
  updateGraphMarker();
}

function updateGraphMarker() {
  const m = document.getElementById('evalMarker');
  if (!m || !state.game) return;
  const N = state.game.sanMoves.length;
  const xx = N ? (state.currentPly / N) * 400 : 0;
  m.setAttribute('x1', xx);
  m.setAttribute('x2', xx);
}

// ---------- Statistics ----------
const ACC_KEY = 'chess-acc-history-v1';

// Запоминает точность игрока в каждой проанализированной партии, чтобы
// статистика могла показать, как она меняется со временем.
function recordAccuracyHistory() {
  const color = state.game.userColor;
  if (!color) return;
  const { moveClass, moveAcc } = state.analysis;
  const accs = [];
  for (let k = 1; k <= moveClass.length; k++) {
    if ((k % 2 === 1 ? 'w' : 'b') !== color) continue;
    if (moveClass[k - 1] === 'book' || moveClass[k - 1] === 'forced') continue;
    accs.push(moveAcc[k - 1]);
  }
  if (!accs.length) return;
  const h = state.game.headers;
  const key = `${h.Date}|${h.White}|${h.Black}|${h.EndTime || h.Round || ''}`;
  let hist = [];
  try { hist = JSON.parse(localStorage.getItem(ACC_KEY) || '[]'); } catch (e) { /* ignore */ }
  hist = hist.filter((x) => x.key !== key);
  hist.push({ key, date: h.Date || '', acc: averageAccuracy(accs), opp: color === 'w' ? h.Black : h.White });
  try { localStorage.setItem(ACC_KEY, JSON.stringify(hist.slice(-50))); } catch (e) { /* ignore */ }
  renderStats();
}

function openingFromPgn(pgn) {
  const m = /\[ECOUrl "[^"]*\/openings\/([^"]+)"\]/.exec(pgn || '');
  if (!m) return null;
  // «French-Defense-Advance-Nimzowitsch-...» → «French Defense»: для статистики
  // нужно семейство дебюта, иначе каждая партия попадает в свой отдельный вариант.
  // Режем после первого «опорного» слова (Defense, Opening, Game…), иначе берём 2 слова.
  const words = decodeURIComponent(m[1]).split('-');
  const cut = words.findIndex((w) => /^\d|\.\.\./.test(w));
  const name = words.slice(0, cut === -1 ? words.length : cut);
  const anchor = name.findIndex((w, i) => i < 4 && /^(Defense|Opening|Game|Gambit|Attack|System)$/.test(w));
  return name.slice(0, anchor === -1 ? 2 : anchor + 1).join(' ');
}

function sparkline(values, w = 260, h = 50) {
  if (values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 4 - ((v - min) / span) * (h - 8)).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" class="spark"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2"/></svg>` +
    `<div class="spark-range">${min} … ${max}</div>`;
}

function renderStats() {
  let hist = [];
  try { hist = JSON.parse(localStorage.getItem(ACC_KEY) || '[]'); } catch (e) { /* ignore */ }
  let html = '';
  const lg = state.loadedGames;
  if (!lg) {
    html += '<p class="hint">Загрузи партии по нику (первая вкладка) — здесь появится статистика.</p>';
  } else {
    const u = lg.username.toLowerCase();
    const rows = lg.games.filter((g) => g.pgn).map((g) => {
      const isWhite = (g.white.username || '').toLowerCase() === u;
      const me = isWhite ? g.white : g.black;
      const res = me.result === 'win' ? 'win' : ['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'].includes(me.result) ? 'draw' : 'loss';
      return { isWhite, res, rating: me.rating, tc: g.time_class, end: g.end_time || 0, opening: openingFromPgn(g.pgn) };
    });
    const count = (arr, r) => arr.filter((x) => x.res === r).length;
    const line = (arr) => `<span class="res-win">${count(arr, 'win')}</span> / <span class="res-draw">${count(arr, 'draw')}</span> / <span class="res-loss">${count(arr, 'loss')}</span>`;
    const white = rows.filter((r) => r.isWhite), black = rows.filter((r) => !r.isWhite);
    const scorePct = (arr) => arr.length ? Math.round(((count(arr, 'win') + count(arr, 'draw') / 2) / arr.length) * 100) : 0;
    html += `<div class="stats-block"><div class="stats-title">Последние ${rows.length} партий</div>` +
      `<div class="stats-big">${line(rows)}</div><div class="hint">победы / ничьи / поражения · набрано ${scorePct(rows)}% очков</div>` +
      `<div>⚪ Белыми: ${line(white)} (${scorePct(white)}%)</div><div>⚫ Чёрными: ${line(black)} (${scorePct(black)}%)</div></div>`;

    const byOpening = new Map();
    rows.forEach((r) => { if (!r.opening) return; if (!byOpening.has(r.opening)) byOpening.set(r.opening, []); byOpening.get(r.opening).push(r); });
    const top = [...byOpening.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5);
    if (top.length) {
      html += '<div class="stats-block"><div class="stats-title">Любимые дебюты</div>' +
        top.map(([name, arr]) => `<div class="stats-row"><span>${name}</span><span>${arr.length} · ${scorePct(arr)}%</span></div>`).join('') + '</div>';
    }

    const tcCount = {};
    rows.forEach((r) => { tcCount[r.tc] = (tcCount[r.tc] || 0) + 1; });
    const mainTc = Object.keys(tcCount).sort((a, b) => tcCount[b] - tcCount[a])[0];
    const TC = { bullet: 'пуля', blitz: 'блиц', rapid: 'рапид', daily: 'по переписке' };
    const ratings = rows.filter((r) => r.tc === mainTc && r.rating).sort((a, b) => a.end - b.end).map((r) => r.rating);
    if (ratings.length > 1) {
      const diff = ratings[ratings.length - 1] - ratings[0];
      html += `<div class="stats-block"><div class="stats-title">Рейтинг (${TC[mainTc] || mainTc}): ${ratings[ratings.length - 1]} ` +
        `<span class="${diff >= 0 ? 'res-win' : 'res-loss'}">${diff >= 0 ? '+' : ''}${diff}</span></div>${sparkline(ratings)}</div>`;
    }
  }
  if (hist.length) {
    const avg = averageAccuracy(hist.map((x) => x.acc));
    html += `<div class="stats-block"><div class="stats-title">Твоя точность в разобранных партиях: ${avg.toFixed(1)}%</div>` +
      sparkline(hist.map((x) => Math.round(x.acc))) +
      hist.slice(-5).reverse().map((x) => `<div class="stats-row"><span>${x.date} vs ${x.opp || '?'}</span><span>${x.acc.toFixed(1)}%</span></div>`).join('') + '</div>';
  } else {
    html += '<p class="hint">Точность появится после анализа своих партий.</p>';
  }
  tabStats.innerHTML = html;
}

// ---------- Event wiring ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.remove('hidden');
  });
});

btnLoadGames.addEventListener('click', () => loadGamesForUser(usernameInput.value));
usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadGamesForUser(usernameInput.value); });
btnLoadPgn.addEventListener('click', () => loadGameFromPgn(pgnInput.value, null));
btnAnalyzeAll.addEventListener('click', analyzeAllMoves);

btnStart.addEventListener('click', () => goToPly(0));
btnEnd.addEventListener('click', () => goToPly(state.game ? state.game.sanMoves.length : 0));
btnPrev.addEventListener('click', () => goToPly(state.currentPly - 1));
btnNext.addEventListener('click', () => goToPly(state.currentPly + 1));
btnFlip.addEventListener('click', () => { state.flipped = !state.flipped; renderPlayerLabels(); goToPly(state.currentPly); });

function stopPlay() {
  clearTimeout(state.playTimer);
  state.playing = false;
  btnPlay.textContent = '▶';
  stopSpeech();
}

// Advances one ply and schedules the next: if voice is on, waits for the spoken
// comment to finish instead of a fixed delay, so narration never gets cut off.
function playStep() {
  if (!state.playing || !state.game) return;
  const N = state.game.sanMoves.length;
  if (state.currentPly >= N) { stopPlay(); return; }
  const utt = goToPly(state.currentPly + 1);
  if (utt) {
    utt.onend = () => { if (state.playing) playStep(); };
    utt.onerror = () => { if (state.playing) playStep(); };
  } else {
    state.playTimer = setTimeout(playStep, 800);
  }
}

btnPlay.addEventListener('click', () => {
  if (state.playing) { stopPlay(); return; }
  if (!state.game) return;
  state.playing = true;
  btnPlay.textContent = '⏸';
  playStep();
});

voiceToggle.addEventListener('change', () => {
  state.voiceEnabled = voiceToggle.checked;
  if (!state.voiceEnabled) stopSpeech();
});
voiceRate.addEventListener('change', () => stopSpeech());
voiceSelect.addEventListener('change', () => stopSpeech());

// ---------- Init ----------
drawBoard(new Chess().fen(), { flip: false });
try { usernameInput.value = localStorage.getItem('chess-username') || ''; } catch (e) { /* ignore */ }
renderTrainerTab();
renderStats();
