// Лоу-фай радио: музыка сочиняется прямо в браузере (Web Audio), без чужих песен.
(() => {
  const btn = document.getElementById('lofi-btn');
  const label = document.getElementById('lofi-label');
  if (!btn) return;
  let ac, master, playing = false, timer, step = 0, bar = 0, prog, rootMidi, nextTime;

  const PROGS = [
    [[0, 3, 7, 10], [5, 8, 12, 15], [10, 14, 17, 21], [3, 7, 10, 14]],   // i7 iv7 VII7 III7
    [[2, 5, 9, 12], [7, 11, 14, 17], [0, 4, 7, 11], [9, 12, 16, 19]],    // ii7 V7 Imaj7 vi7
    [[0, 4, 7, 11], [9, 12, 16, 19], [5, 9, 12, 16], [7, 11, 14, 17]],   // Imaj7 vi7 IVmaj7 V7
  ];
  const NAMES = ['Дождь за окном', 'Ночной город', 'Шахматы в 2 часа ночи', 'Сиреневые облака', 'Код и чай', 'Тихий гараж'];
  const hz = m => 440 * Math.pow(2, (m - 69) / 12);

  function init() {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    master = ac.createGain(); master.gain.value = 0.55;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
    master.connect(lp).connect(ac.destination);
    // винил: тихий шум с щелчками
    const len = ac.sampleRate * 2, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.012 + (Math.random() < 0.0004 ? (Math.random() - .5) * 0.5 : 0);
    const vinyl = ac.createBufferSource(); vinyl.buffer = buf; vinyl.loop = true;
    const vg = ac.createGain(); vg.gain.value = 0.6; vinyl.connect(vg).connect(master); vinyl.start();
  }
  function newSong() {
    prog = PROGS[Math.floor(Math.random() * PROGS.length)];
    rootMidi = 50 + Math.floor(Math.random() * 7);
    label.textContent = '♪ ' + NAMES[Math.floor(Math.random() * NAMES.length)];
  }
  function chord(t, notes) {
    notes.forEach((n, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = i === 0 ? 'triangle' : 'sine'; o.frequency.value = hz(rootMidi + n);
      o.detune.value = (Math.random() - .5) * 12;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.07, t + 0.08 + i * 0.03); g.gain.exponentialRampToValueAtTime(0.001, t + 2.3);
      o.connect(g).connect(master); o.start(t + i * 0.03); o.stop(t + 2.4);
    });
  }
  function bass(t, n) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.value = hz(rootMidi - 12 + n);
    g.gain.setValueAtTime(0.22, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    o.connect(g).connect(master); o.start(t); o.stop(t + 1);
  }
  function kick(t) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
    g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(master); o.start(t); o.stop(t + 0.32);
  }
  function noise(t, dur, vol, freq) {
    const b = ac.createBuffer(1, ac.sampleRate * dur, ac.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = b; f.type = 'highpass'; f.frequency.value = freq;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g).connect(master); s.start(t);
  }
  function melody(t, notes) {
    if (Math.random() < 0.55) return;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'triangle'; o.frequency.value = hz(rootMidi + 12 + notes[Math.floor(Math.random() * notes.length)]);
    g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    o.connect(g).connect(master); o.start(t); o.stop(t + 0.65);
  }
  const STEP = 60 / 78 / 2; // 78 BPM, восьмые
  function schedule() {
    while (nextTime < ac.currentTime + 0.3) {
      const swing = step % 2 ? STEP * 0.18 : 0, t = nextTime + swing, c = prog[bar % 4];
      if (step === 0) { chord(t, c); bass(t, c[0]); }
      if (step === 5) bass(t, c[0] + (Math.random() < .5 ? 7 : 0));
      if (step === 0 || step === 5) kick(t);
      if (step === 2 || step === 6) noise(t, 0.18, 0.12, 1200);
      noise(t, 0.04, step % 2 ? 0.025 : 0.04, 7000);
      melody(t, c);
      nextTime += STEP; step = (step + 1) % 8;
      if (step === 0) { bar++; if (bar % 16 === 0) newSong(); }
    }
  }
  btn.addEventListener('click', async () => {
    if (!ac) init();
    if (playing) { playing = false; clearInterval(timer); await ac.suspend(); btn.textContent = '▶'; return; }
    await ac.resume();
    if (!prog) newSong();
    nextTime = ac.currentTime + 0.1; playing = true; btn.textContent = '⏸';
    timer = setInterval(schedule, 100);
  });
})();
