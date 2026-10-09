// Змейка в сиреневом стиле: стрелки/WASD или свайпы, рекорд хранится в браузере.
(() => {
  const canvas = document.getElementById('snake');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('snake-score');
  const bestEl = document.getElementById('snake-best');
  const startBtn = document.getElementById('snake-start');
  const N = 20;
  let snake, dir, nextDir, food, score, timer, running = false;

  let best = 0;
  try { best = +localStorage.getItem('snake-best') || 0; } catch (e) {}
  bestEl.textContent = best;

  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function reset() {
    snake = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
    dir = nextDir = { x: 1, y: 0 };
    score = 0; scoreEl.textContent = 0;
    placeFood();
  }
  function placeFood() {
    do { food = { x: Math.floor(Math.random() * N), y: Math.floor(Math.random() * N) }; }
    while (snake.some(s => s.x === food.x && s.y === food.y));
  }
  function start() {
    reset(); running = true; startBtn.textContent = '↺ Заново';
    clearInterval(timer); timer = setInterval(step, 110);
    canvas.focus();
  }
  function gameOver() {
    running = false; clearInterval(timer);
    if (score > best) { best = score; bestEl.textContent = best; try { localStorage.setItem('snake-best', best); } catch (e) {} }
    draw(true);
  }
  function step() {
    dir = nextDir;
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    if (head.x < 0 || head.y < 0 || head.x >= N || head.y >= N || snake.some(s => s.x === head.x && s.y === head.y)) return gameOver();
    snake.unshift(head);
    if (head.x === food.x && head.y === food.y) { score++; scoreEl.textContent = score; placeFood(); }
    else snake.pop();
    draw();
  }
  function draw(over) {
    const c = canvas.width / N;
    ctx.fillStyle = css('--board-bg') || '#17142a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffd166';
    ctx.beginPath(); ctx.arc((food.x + .5) * c, (food.y + .5) * c, c * .35, 0, Math.PI * 2); ctx.fill();
    snake.forEach((s, i) => {
      ctx.fillStyle = i === 0 ? css('--text') : css('--accent');
      ctx.globalAlpha = i === 0 ? 1 : Math.max(.45, 1 - i / (snake.length + 6));
      ctx.beginPath(); ctx.roundRect(s.x * c + 1, s.y * c + 1, c - 2, c - 2, c * .3); ctx.fill();
    });
    ctx.globalAlpha = 1;
    if (over) {
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
      ctx.font = `bold ${c * 1.4}px Segoe UI, sans-serif`; ctx.fillText('Игра окончена', canvas.width / 2, canvas.height / 2 - c * .4);
      ctx.font = `${c * .8}px Segoe UI, sans-serif`; ctx.fillText('Счёт: ' + score, canvas.width / 2, canvas.height / 2 + c);
    }
  }
  function turn(x, y) {
    if (!running) return;
    if (x === -dir.x && y === -dir.y) return;
    nextDir = { x, y };
  }
  const keys = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0] };
  canvas.addEventListener('keydown', e => { const k = keys[e.code]; if (k) { e.preventDefault(); turn(...k); } else if (e.code === 'Space' && !running) { e.preventDefault(); start(); } });
  let t0 = null;
  canvas.addEventListener('touchstart', e => { t0 = e.touches[0]; }, { passive: true });
  canvas.addEventListener('touchend', e => {
    if (!t0) return; const t = e.changedTouches[0], dx = t.clientX - t0.clientX, dy = t.clientY - t0.clientY;
    if (Math.max(Math.abs(dx), Math.abs(dy)) > 20) Math.abs(dx) > Math.abs(dy) ? turn(Math.sign(dx), 0) : turn(0, Math.sign(dy));
    t0 = null;
  });
  canvas.addEventListener('click', () => { if (!running) start(); });
  startBtn.addEventListener('click', start);
  reset(); draw();
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = 'bold 22px Segoe UI, sans-serif';
  ctx.fillText('Нажми «Играть»', canvas.width / 2, canvas.height / 2);
})();
