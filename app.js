(() => {
  'use strict';

  /* ------------------------------------------------------------------------
     Constants & storage keys
     ------------------------------------------------------------------------ */

  const KEYS = {
    settings: 'pomodoro.settings.v1',
    stats: 'pomodoro.stats.v1',
    theme: 'pomodoro.theme',
    task: 'pomodoro.task.v1',
  };

  const DEFAULT_SETTINGS = Object.freeze({
    focus: 25,
    shortBreak: 5,
    longBreak: 15,
    interval: 4,
    autoStartBreaks: false,
    autoStartFocus: false,
    sound: true,
    notifications: false,
  });

  const MODE_META = {
    focus: { label: '专注', running: '专注中', ready: '准备开始' },
    shortBreak: { label: '短休息', running: '短休息中', ready: '休息时间' },
    longBreak: { label: '长休息', running: '长休息中', ready: '休息时间' },
  };

  const ONE_MINUTE = 60 * 1000;

  /* ------------------------------------------------------------------------
     Elements
     ------------------------------------------------------------------------ */

  const $ = (id) => document.getElementById(id);

  const els = {
    body: document.body,
    card: document.querySelector('.timer-card'),
    modeButtons: Array.from(document.querySelectorAll('.mode-button')),
    time: $('timeDisplay'),
    status: $('timerStatusText'),
    hint: $('timerHint'),
    start: $('startButton'),
    startLabel: $('startLabel'),
    reset: $('resetButton'),
    skip: $('skipButton'),
    task: $('taskInput'),
    dots: $('sessionDots'),
    caption: $('sessionCaption'),
    todayCount: $('todayCount'),
    todayMinutes: $('todayMinutes'),
    todayState: $('todayState'),
    cycleText: $('cycleText'),
    themeToggle: $('themeToggle'),
    settingsButton: $('settingsButton'),
    dialog: $('settingsDialog'),
    form: $('settingsForm'),
    settingsClose: $('settingsClose'),
    settingsCancel: $('settingsCancel'),
    focusMinutes: $('focusMinutes'),
    shortBreakMinutes: $('shortBreakMinutes'),
    longBreakMinutes: $('longBreakMinutes'),
    intervalRounds: $('intervalRounds'),
    autoStartBreaks: $('autoStartBreaks'),
    autoStartFocus: $('autoStartFocus'),
    soundEnabled: $('soundEnabled'),
    notificationsEnabled: $('notificationsEnabled'),
    toast: $('toast'),
    srAnnounce: $('srAnnounce'),
  };

  /* ------------------------------------------------------------------------
     State
     ------------------------------------------------------------------------ */

  let settings = loadSettings();
  let stats = loadStats();

  const timer = {
    mode: 'focus',
    running: false,
    started: false,
    totalMs: 0,
    remainingMs: 0,
    endAt: 0,
    cycle: 0,
    sessionMinutes: DEFAULT_SETTINGS.focus,
  };

  let audioContext = null;
  let tickTimer = 0;
  let finishTimer = 0;
  let toastTimer = 0;

  /* ------------------------------------------------------------------------
     Utilities
     ------------------------------------------------------------------------ */

  function clampInt(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  }

  function readStorage(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      /* Private mode or storage full: the timer still works for this visit. */
    }
  }

  function minutesToMs(minutes) {
    return Math.round(minutes * ONE_MINUTE);
  }

  function formatTime(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function todayKey() {
    const now = new Date();
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
  }

  function sanitizeSettings(input = {}) {
    return {
      focus: clampInt(input.focus, 1, 120, DEFAULT_SETTINGS.focus),
      shortBreak: clampInt(input.shortBreak, 1, 60, DEFAULT_SETTINGS.shortBreak),
      longBreak: clampInt(input.longBreak, 1, 90, DEFAULT_SETTINGS.longBreak),
      interval: clampInt(input.interval, 2, 8, DEFAULT_SETTINGS.interval),
      autoStartBreaks: Boolean(input.autoStartBreaks),
      autoStartFocus: Boolean(input.autoStartFocus),
      sound: input.sound !== false,
      notifications: Boolean(input.notifications),
    };
  }

  function loadSettings() {
    try {
      const raw = readStorage(KEYS.settings);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS };
      return sanitizeSettings({ ...DEFAULT_SETTINGS, ...parsed });
    } catch (error) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function loadStats() {
    const fallback = { date: todayKey(), completed: 0, minutes: 0 };
    try {
      const raw = readStorage(KEYS.stats);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.date !== fallback.date) return fallback;
      return {
        date: fallback.date,
        completed: Math.max(0, Math.floor(Number(parsed.completed) || 0)),
        minutes: Math.max(0, Math.floor(Number(parsed.minutes) || 0)),
      };
    } catch (error) {
      return fallback;
    }
  }

  function saveStats() {
    writeStorage(KEYS.stats, JSON.stringify(stats));
  }

  function ensureTodayStats() {
    if (stats.date === todayKey()) return;
    stats = { date: todayKey(), completed: 0, minutes: 0 };
    saveStats();
  }

  /* ------------------------------------------------------------------------
     Rendering
     ------------------------------------------------------------------------ */

  function updateTitle() {
    const time = formatTime(timer.remainingMs);
    let title;
    if (timer.running) {
      title = `${time} · ${MODE_META[timer.mode].running} · 番茄钟`;
    } else if (timer.started) {
      title = `${time} · 已暂停 · 番茄钟`;
    } else {
      title = '番茄钟 · 专注计时器';
    }
    if (document.title !== title) document.title = title;
  }

  function renderTime() {
    const text = formatTime(timer.remainingMs);
    if (els.time.textContent !== text) els.time.textContent = text;
    els.time.setAttribute('aria-label', `剩余时间 ${text}`);
    updateTitle();
  }

  function renderStatus() {
    const meta = MODE_META[timer.mode];
    const status = timer.running ? meta.running : timer.started ? '已暂停' : meta.ready;
    if (els.status.textContent !== status) els.status.textContent = status;
    els.body.classList.toggle('is-running', timer.running);
  }

  function renderControls() {
    els.start.dataset.running = String(timer.running);
    const label = timer.running ? '暂停' : timer.started ? '继续' : '开始';
    if (els.startLabel.textContent !== label) els.startLabel.textContent = label;
    els.start.setAttribute(
      'aria-label',
      timer.running ? '暂停计时' : timer.started ? '继续计时' : '开始计时'
    );
    els.start.setAttribute('aria-pressed', String(timer.running));
  }

  function renderSession() {
    const total = settings.interval;
    const done = Math.min(timer.cycle, total);
    const isFocus = timer.mode === 'focus';

    els.dots.replaceChildren();
    for (let index = 0; index < total; index += 1) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      if (index < done) dot.classList.add('is-done');
      else if (isFocus && index === done) dot.classList.add('is-current');
      els.dots.appendChild(dot);
    }
    els.dots.setAttribute('aria-label', `本轮已完成 ${done} / ${total} 轮专注`);

    let hint;
    let caption;
    if (isFocus) {
      hint = `第 ${Math.min(done + 1, total)} 轮 / 共 ${total} 轮`;
      caption =
        done + 1 >= total
          ? `完成本轮后，长休息 ${settings.longBreak} 分钟`
          : `完成本轮后，休息 ${settings.shortBreak} 分钟`;
    } else if (timer.mode === 'longBreak') {
      hint = `已完成 ${total} 轮 · 长休息`;
      caption = `长休息 ${settings.longBreak} 分钟，新一轮即将开始`;
    } else {
      hint = done > 0 ? `已完成 ${done} 轮 · 短休息` : '短休息';
      caption = `休息 ${settings.shortBreak} 分钟，然后继续专注`;
    }

    if (els.hint.textContent !== hint) els.hint.textContent = hint;
    if (els.caption.textContent !== caption) els.caption.textContent = caption;
  }

  function renderStats() {
    ensureTodayStats();
    els.todayCount.textContent = String(stats.completed);
    els.todayMinutes.textContent = `${stats.minutes} 分钟`;
    els.todayState.textContent = timer.running
      ? timer.mode === 'focus'
        ? '专注中'
        : '休息中'
      : timer.started
        ? '已暂停'
        : '待开始';
    els.cycleText.textContent = `${Math.min(timer.cycle, settings.interval)} / ${settings.interval}`;
  }

  function renderModeButtons() {
    els.modeButtons.forEach((button) => {
      const active = button.dataset.mode === timer.mode;
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function renderAll() {
    els.body.dataset.mode = timer.mode;
    renderModeButtons();
    renderTime();
    renderStatus();
    renderControls();
    renderSession();
    renderStats();
  }

  /* ------------------------------------------------------------------------
     Feedback helpers
     ------------------------------------------------------------------------ */

  function announce(message) {
    els.srAnnounce.textContent = '';
    window.setTimeout(() => {
      els.srAnnounce.textContent = message;
    }, 40);
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      els.toast.classList.remove('is-visible');
    }, 2600);
  }

  function flashCard() {
    els.card.classList.remove('is-complete');
    void els.card.offsetWidth;
    els.card.classList.add('is-complete');
    window.setTimeout(() => els.card.classList.remove('is-complete'), 950);
  }

  function ensureAudio() {
    if (!settings.sound) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!audioContext) audioContext = new AudioCtx();
      if (audioContext.state === 'suspended') audioContext.resume();
    } catch (error) {
      audioContext = null;
    }
  }

  function chime() {
    if (!settings.sound) return;
    ensureAudio();
    if (!audioContext) return;
    try {
      const start = audioContext.currentTime + 0.02;
      [523.25, 659.25, 783.99].forEach((frequency, index) => {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const at = start + index * 0.16;
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.16, at + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
        oscillator.connect(gain).connect(audioContext.destination);
        oscillator.start(at);
        oscillator.stop(at + 0.95);
      });
    } catch (error) {
      /* Audio is a nice-to-have; never break the timer because of it. */
    }
  }

  function notify(title, body) {
    if (!settings.notifications) return;
    if (!('Notification' in window) || window.Notification.permission !== 'granted') return;
    try {
      new window.Notification(title, {
        body,
        icon: 'assets/favicon.svg',
        tag: 'pomodoro-timer',
      });
    } catch (error) {
      /* Notifications are optional. */
    }
  }

  /* ------------------------------------------------------------------------
     Timer engine
     ------------------------------------------------------------------------ */

  function clearTimers() {
    if (tickTimer) {
      window.clearInterval(tickTimer);
      tickTimer = 0;
    }
    if (finishTimer) {
      window.clearTimeout(finishTimer);
      finishTimer = 0;
    }
  }

  function loadMode(mode) {
    const nextMode = MODE_META[mode] ? mode : 'focus';
    clearTimers();
    timer.mode = nextMode;
    timer.running = false;
    timer.started = false;
    timer.totalMs = minutesToMs(settings[nextMode]);
    timer.remainingMs = timer.totalMs;
    timer.sessionMinutes = settings[nextMode];
    renderAll();
  }

  function startTimer({ silent = false } = {}) {
    if (timer.running) return;
    if (timer.remainingMs <= 0) {
      timer.remainingMs = timer.totalMs;
      timer.started = false;
    }
    timer.endAt = Date.now() + timer.remainingMs;
    timer.running = true;
    timer.started = true;
    ensureAudio();
    clearTimers();
    tickTimer = window.setInterval(tick, 200);
    finishTimer = window.setTimeout(() => {
      if (timer.running) finishSession();
    }, timer.remainingMs + 60);
    renderAll();
    if (!silent) announce(`${MODE_META[timer.mode].label}计时开始`);
  }

  function pauseTimer() {
    if (!timer.running) return;
    const remaining = timer.endAt - Date.now();
    if (remaining <= 0) {
      finishSession();
      return;
    }
    timer.remainingMs = remaining;
    timer.running = false;
    clearTimers();
    renderAll();
    announce('计时已暂停');
  }

  function resetTimer() {
    clearTimers();
    timer.running = false;
    timer.started = false;
    timer.totalMs = minutesToMs(settings[timer.mode]);
    timer.remainingMs = timer.totalMs;
    timer.sessionMinutes = settings[timer.mode];
    renderAll();
    announce('计时已重置');
  }

  function toggleTimer() {
    if (timer.running) pauseTimer();
    else startTimer();
  }

  function tick() {
    if (!timer.running) return;
    const remaining = timer.endAt - Date.now();
    if (remaining <= 0) {
      timer.remainingMs = 0;
      finishSession();
      return;
    }
    timer.remainingMs = remaining;
    renderTime();
  }

  function finishSession() {
    if (!timer.running) return;
    timer.running = false;
    timer.remainingMs = 0;
    clearTimers();

    const finished = timer.mode;
    flashCard();
    chime();

    if (finished === 'focus') {
      timer.cycle = Math.min(timer.cycle + 1, settings.interval);
      ensureTodayStats();
      stats.completed += 1;
      stats.minutes += timer.sessionMinutes;
      saveStats();

      const task = els.task.value.trim();
      notify('番茄完成 🍅', task ? `「${task}」完成一轮，去休息一下。` : '干得漂亮，去休息一下。');
      announce('专注完成，休息时间到');
      showToast('番茄完成 🍅 休息一下吧');

      const nextMode = timer.cycle >= settings.interval ? 'longBreak' : 'shortBreak';
      loadMode(nextMode);
      if (settings.autoStartBreaks) startTimer({ silent: true });
    } else {
      if (finished === 'longBreak') timer.cycle = 0;
      notify('休息结束 ☀️', '准备好开始下一轮专注了吗？');
      announce('休息结束，开始专注吧');
      showToast('休息结束，准备好再开始');
      loadMode('focus');
      if (settings.autoStartFocus) startTimer({ silent: true });
    }
  }

  function skipSession() {
    clearTimers();
    timer.running = false;
    const skipped = timer.mode;
    if (skipped === 'focus') {
      loadMode('shortBreak');
      showToast('已跳过本轮专注');
      announce('已跳过专注，进入短休息');
    } else {
      if (skipped === 'longBreak') timer.cycle = 0;
      loadMode('focus');
      showToast('已跳过休息');
      announce('已跳过休息');
    }
  }

  /* ------------------------------------------------------------------------
     Settings & theme
     ------------------------------------------------------------------------ */

  function syncSettingsForm() {
    els.focusMinutes.value = String(settings.focus);
    els.shortBreakMinutes.value = String(settings.shortBreak);
    els.longBreakMinutes.value = String(settings.longBreak);
    els.intervalRounds.value = String(settings.interval);
    els.autoStartBreaks.checked = settings.autoStartBreaks;
    els.autoStartFocus.checked = settings.autoStartFocus;
    els.soundEnabled.checked = settings.sound;
    els.notificationsEnabled.checked = settings.notifications;
  }

  function openSettings() {
    syncSettingsForm();
    if (typeof els.dialog.showModal === 'function') {
      els.dialog.showModal();
    } else {
      els.dialog.setAttribute('open', '');
    }
  }

  function closeSettings() {
    if (typeof els.dialog.close === 'function') {
      els.dialog.close();
    } else {
      els.dialog.removeAttribute('open');
    }
  }

  function readSettingsForm() {
    return {
      focus: Number(els.focusMinutes.value),
      shortBreak: Number(els.shortBreakMinutes.value),
      longBreak: Number(els.longBreakMinutes.value),
      interval: Number(els.intervalRounds.value),
      autoStartBreaks: els.autoStartBreaks.checked,
      autoStartFocus: els.autoStartFocus.checked,
      sound: els.soundEnabled.checked,
      notifications: els.notificationsEnabled.checked,
    };
  }

  function applySettings(next) {
    settings = sanitizeSettings(next);
    writeStorage(KEYS.settings, JSON.stringify(settings));
    if (timer.cycle > settings.interval) timer.cycle = settings.interval;
    if (!timer.running && !timer.started) {
      timer.totalMs = minutesToMs(settings[timer.mode]);
      timer.remainingMs = timer.totalMs;
      timer.sessionMinutes = settings[timer.mode];
    }
    syncSettingsForm();
    renderAll();
    showToast(timer.running || timer.started ? '设置已保存，下一轮生效' : '设置已保存');
  }

  async function handleSettingsSubmit(event) {
    event.preventDefault();
    if (!els.form.reportValidity()) return;

    const next = sanitizeSettings(readSettingsForm());

    if (next.notifications) {
      if (!('Notification' in window)) {
        next.notifications = false;
        showToast('当前浏览器不支持桌面通知');
      } else if (window.Notification.permission !== 'granted') {
        let permission = 'denied';
        try {
          permission = await window.Notification.requestPermission();
        } catch (error) {
          permission = 'denied';
        }
        if (permission !== 'granted') {
          next.notifications = false;
          showToast('未获得通知权限，已关闭桌面通知');
        }
      }
    }

    applySettings(next);
    closeSettings();
  }

  function currentTheme() {
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  }

  function setTheme(theme, persist = true) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    if (persist) writeStorage(KEYS.theme, next);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'dark' ? '#100e0d' : '#fbf4ec');
    els.themeToggle.setAttribute('aria-label', next === 'dark' ? '切换到浅色模式' : '切换到深色模式');
    els.themeToggle.setAttribute('aria-pressed', String(next === 'light'));
  }

  function toggleTheme() {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  }

  function restoreTask() {
    const saved = readStorage(KEYS.task);
    if (typeof saved === 'string' && saved.trim()) {
      els.task.value = saved.slice(0, 80);
    }
  }

  /* ------------------------------------------------------------------------
     Events
     ------------------------------------------------------------------------ */

  function handleKeydown(event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.matches('input, textarea, select') || target.isContentEditable);
    if (typing || els.dialog.open) return;

    if (event.code === 'Space') {
      if (target instanceof HTMLElement && target.closest('button, a')) return;
      event.preventDefault();
      toggleTimer();
      return;
    }

    const key = event.key.toLowerCase();
    if (key === 'r') {
      event.preventDefault();
      resetTimer();
    } else if (key === 's') {
      event.preventDefault();
      skipSession();
    }
  }

  function bindEvents() {
    els.start.addEventListener('click', toggleTimer);
    els.reset.addEventListener('click', resetTimer);
    els.skip.addEventListener('click', skipSession);

    els.modeButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const mode = button.dataset.mode;
        if (!MODE_META[mode] || mode === timer.mode) return;
        loadMode(mode);
        announce(`切换到${MODE_META[mode].label}`);
      });
    });

    els.themeToggle.addEventListener('click', toggleTheme);
    els.settingsButton.addEventListener('click', openSettings);
    els.settingsClose.addEventListener('click', closeSettings);
    els.settingsCancel.addEventListener('click', closeSettings);
    els.form.addEventListener('submit', handleSettingsSubmit);

    els.dialog.addEventListener('click', (event) => {
      if (event.target === els.dialog) closeSettings();
    });

    els.task.addEventListener('input', () => {
      writeStorage(KEYS.task, els.task.value);
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) tick();
    });

    document.addEventListener('keydown', handleKeydown);
  }

  /* ------------------------------------------------------------------------
     Init
     ------------------------------------------------------------------------ */

  function init() {
    timer.totalMs = minutesToMs(settings.focus);
    timer.remainingMs = timer.totalMs;
    timer.sessionMinutes = settings.focus;
    restoreTask();
    syncSettingsForm();
    setTheme(currentTheme(), false);
    bindEvents();
    renderAll();
  }

  init();
})();
