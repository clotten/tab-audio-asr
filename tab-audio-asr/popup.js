/**
 * popup.js —— 界面层：只管显示和发指令，不碰音频。
 * 采集/编码/请求都在 offscreen.js 里，所以关掉这个弹窗也不会中断转录。
 */

import { makeToneWav } from './lib/wav.js';
import { GLOSSARY_FORMAT_HINT } from './lib/glossary.js';
import { videoKeyOf } from './lib/videokey.js';
import { readAudioFile, removeAudioFile } from './lib/audiofile.js';

const DEFAULTS = {
  apiKey: '',
  model: 'Qwen/Qwen3-ASR-1.7B',
  baseUrl: 'https://api.siliconflow.cn/v1',
  segmentSeconds: 20,
  maxChunkMs: 10000,
  mutePlayback: false,
  saveAudio: false,
  sileroVad: true,
  incrementalAsr: true,
  correctModel: 'Qwen/Qwen2.5-7B-Instruct',
  glossary: '',
  prescanRate: 1.5,
  subtitle: { enabled: true, fontSize: 15 }
};

const ACTIVE = new Set(['starting', 'recording', 'stopping']);

const el = (id) => document.getElementById(id);

let settings = { ...DEFAULTS };
let session = null;
let lastProbe = null;
let lastMediaUrl = '';
let activeTab = null;
let ticker = null;
let busy = false;

/* ------------------------------ 初始化 ------------------------------ */

init();

async function init() {
  const stored = await chrome.storage.local.get(['asrSettings', 'asrSession']);
  settings = { ...DEFAULTS, ...(stored.asrSettings || {}) };
  session = stored.asrSession || null;

  fillForm();
  bindEvents();
  await loadActiveTab();
  await reconcileStaleSession();
  render();

  // 有没有被覆盖的旧稿，决定「恢复上一份」显不显示
  await refreshHistory();
  await refreshLibrary();

  // 打开弹窗就装"播放器请求钩子"：B 站换集会重新拉 playurl，
  // 只有挂钩那次请求才拿得到当前视频的真音轨（__playinfo__ 永不更新）。
  chrome.runtime.sendMessage({ type: 'INSTALL_MEDIA_HOOK' }).then((r) => mlog('钩子注入：' + (r?.ok ? r.state || 'ok' : '失败 ' + (r?.error || '')))).catch(() => {});


  if (!settings.apiKey) showTab('cfg');

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.asrSession) {
      session = changes.asrSession.newValue || null;
      render();
    }
    if (changes.asrSettings && !document.activeElement?.matches('input')) {
      settings = { ...DEFAULTS, ...(changes.asrSettings.newValue || {}) };
      fillForm();
    }
  });
}

/* ------------------------------ 标签页 ------------------------------ */

let currentTab = 'run';

/** 切换标签页（原来靠 <details> 往下展开，用户觉得难用） */
function showTab(name) {
  currentTab = name === 'cfg' || name === 'lib' ? name : 'run';
  for (const btn of document.querySelectorAll('.tabs .tab')) {
    btn.classList.toggle('active', btn.dataset.tab === currentTab);
  }
  for (const page of document.querySelectorAll('.tabPage')) {
    page.classList.toggle('active', page.dataset.page === currentTab);
  }
}
function bindEvents() {
  el('toggleBtn').addEventListener('click', () => (isActive() ? stop() : start()));
  for (const btn of document.querySelectorAll('.tabs .tab')) {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  }
  el('saveBtn').addEventListener('click', async () => {
    const next = readForm();
    if (!next.apiKey) return note('API Key 不能为空。', 'err');
    const ok = await ensureHostPermission(next.baseUrl);
    await saveSettings(next);
    if (!ok) return note('设置已保存，但没拿到该接口域名的访问权限，请求会被浏览器拦。', 'err');
    note('已保存。', 'ok');
  });
  el('testBtn').addEventListener('click', testApi);
  el('vadTestBtn').addEventListener('click', vadSelftest);
  el('probeBtn').addEventListener('click', probeMedia);
  el('ingestBtn').addEventListener('click', ingestFromPage);
  el('copyBtn').addEventListener('click', copyAll);
  el('txtBtn').addEventListener('click', exportTxt);
  el('srtBtn').addEventListener('click', exportSrt);
  el('resetBtn').addEventListener('click', resetSession);
  el('historyBtn').addEventListener('click', restoreHistory);
  el('libLoadBtn').addEventListener('click', loadFromLibrary);
  el('libDelBtn').addEventListener('click', removeFromLibrary);
  el('showDocPanelBtn').addEventListener('click', showPanel);
  el('showLivePanelBtn').addEventListener('click', showPanel);
  el('refineBtn').addEventListener('click', refineAll);
  el('saveAudioBtn').addEventListener('click', saveRecording);
  el('prescanBtn').addEventListener('click', startPrescan);
  el('demoBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('demo/test-page.html') });
  });

  // 字幕开关要"立刻"生效：内容脚本监听 storage 变化，这里直接存
  el('subtitleFontSize').addEventListener('change', () => saveSettings(readForm()));
  el('mutePlayback').addEventListener('change', () => saveSettings(readForm()));
  el('saveAudio').addEventListener('change', () => saveSettings(readForm()));
  el('sileroVad').addEventListener('change', () => saveSettings(readForm()));
  el('incrementalAsr').addEventListener('change', () => saveSettings(readForm()));
  el('glossary').addEventListener('change', () => saveSettings(readForm()));
  el('correctModel').addEventListener('change', () => saveSettings(readForm()));
  el('prescanRate').addEventListener('change', () => saveSettings(readForm()));
}

/* 「校正全文」按钮已移除（用户只需要「整段提取」自动带的纠错和「离线精校」）；
   后端 CORRECT_ALL 仍保留给 离线精校 内部使用。 */

/* ------------------------------ 离线精校 ------------------------------ */

async function refineAll() {
  showTab('lib');
  setNoteSink('live');
  const name = session?.diag?.audioFile;
  if (!name) {
    return note('这次没有保存音频，无法精校：开始录制前要勾「同时保存音频」。', 'err');
  }
  if (!settings.apiKey) {
    showTab('cfg');
    return note('先填 API Key。', 'err');
  }

  const btn = el('refineBtn');
  btn.disabled = true;
  btn.textContent = '精校中…';
  note('离线精校中：按 20 秒上下文重新识别，再整段纠错。可能要几分钟，期间别关弹窗。');

  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'REFINE' });
  } catch (err) {
    res = { ok: false, error: String(err?.message || err) };
  }

  btn.disabled = false;
  btn.textContent = '离线精校';

  if (!res?.ok) return note(`精校失败：${res?.error || '未知错误'}`, 'err');

  const extra = res.correction
    ? `，纠错又改动了 ${res.correction.changed} 句`
    : res.correctionError
      ? `，但纠错没跑完：${res.correctionError}`
      : '';
  note(`精校完成：${res.segments} 句${extra}`, 'ok');

  const { asrSession } = await chrome.storage.local.get('asrSession');
  session = asrSession || session;
  render();
}

/* ------------------------------ 保存音频 ------------------------------ */

async function saveRecording() {
  showTab('lib');
  const name = session?.diag?.audioFile;
  if (!name) {
    return note('这次没有保存音频：开始录制前要勾上「同时保存音频」。', 'err');
  }

  const btn = el('saveAudioBtn');
  btn.disabled = true;
  try {
    const file = await readAudioFile(name);
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    note(`已开始下载 ${name}（${(file.size / 1048576).toFixed(1)} MB）`, 'ok');
  } catch (err) {
    note(`读取音频失败：${err?.message || err}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------ 整段预扫 ------------------------------ */

/**
 * 预扫：让视频从 0 开始按倍速静音播放一遍，专门生成整段字幕。
 * 注意这不是"偷偷提前"——视频是真的在快进，只是不放声音。
 */
async function startPrescan() {
  setNoteSink('live');
  const next = readForm();
  if (!next.apiKey) {
    showTab('cfg');
    return note('请先填写 API Key。', 'err');
  }
  if (!activeTab?.id) return note('没有拿到当前标签页。', 'err');

  const settingsForPrescan = { ...next, mutePlayback: true };
  await saveSettings(settingsForPrescan);

  busy = true;
  el('toggleBtn').disabled = true;
  el('prescanHint').textContent = '启动中…';

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'START',
      tabId: activeTab.id,
      settings: settingsForPrescan
    });
  } catch (err) {
    res = { ok: false, error: String(err?.message || err) };
  }

  busy = false;
  el('toggleBtn').disabled = false;

  if (!res?.ok) {
    el('prescanHint').textContent = '';
    return note(res?.error || '预扫启动失败', 'err');
  }

  // 交给页面里的脚本：拉回开头 + 设倍速 + 播放
  await chrome.storage.local.set({
    prescanCommand: { at: Date.now(), rate: settingsForPrescan.prescanRate }
  });

  el('prescanHint').textContent = `已按 ${settingsForPrescan.prescanRate}x 静音预扫`;
  note('预扫已开始：视频会自动跳回开头并静音快进，播完自动停止。', 'ok');
}

/* ------------------------------ 当前标签页 ------------------------------ */

async function loadActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  if (!tab) {
    el('tabTitle').textContent = '—';
    el('tabMedia').textContent = '—';
    return;
  }

  el('tabTitle').textContent = tab.title || tab.url || '未命名标签页';
  el('tabTitle').title = tab.url || '';

  const media = await scanMedia(tab.id);
  renderMedia(tab, media);
}

async function scanMedia(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const videos = [...document.querySelectorAll('video')].map((v) => ({
          paused: v.paused,
          muted: v.muted,
          time: Math.round(v.currentTime || 0)
        }));
        const audios = [...document.querySelectorAll('audio')];
        return {
          videos,
          audios: audios.length,
          audible: audios.some((a) => !a.paused)
        };
      }
    });
    return results?.[0]?.result ?? null;
  } catch {
    // chrome:// 等页面不允许注入脚本，正常现象
    return null;
  }
}

function renderMedia(tab, media) {
  const parts = [];
  if (media) {
    if (media.videos?.length) {
      const playing = media.videos.filter((v) => !v.paused).length;
      parts.push(`video ×${media.videos.length}（播放中 ${playing}）`);
    }
    if (media.audios) parts.push(`audio ×${media.audios}`);
    if (!parts.length) parts.push('未发现 video/audio');
  } else {
    parts.push('无法探测（页面受限）');
  }

  if (tab.audible) parts.push('标签页正在发声');
  else if (!isActive()) parts.push('当前静音');

  el('tabMedia').textContent = parts.join(' · ');

  if (!isActive() && media && !media.videos?.some((v) => !v.paused) && !media.audible && !tab.audible) {
    el('hint').textContent = '提示：这个标签页现在没在播放声音，先按播放再开始录制。';
  } else if (!isActive()) {
    el('hint').textContent = '录制期间插件会接管标签页声音并回放，你照常听即可。';
  }
}

/* ------------------------------ 渲染 ------------------------------ */

function isActive() {
  return !!session && ACTIVE.has(session.status);
}

/**
 * 存储里写着"录制中"，但后台页面其实已经没了（浏览器重启、页面被回收、
 * 上次崩溃）——这种时候必须把状态改成已停止，否则 UI 会永远卡在计时中。
 */
async function reconcileStaleSession() {
  if (!session || !ACTIVE.has(session.status)) return;

  let alive = false;
  try {
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'PING' });
    alive = !!res?.ok;
  } catch {
    alive = false;
  }
  if (alive) return;

  session = {
    ...session,
    status: 'stopped',
    stoppedAt: session.stoppedAt || Date.now(),
    stopReason: '后台采集进程已退出'
  };
  await chrome.storage.local.set({ asrSession: session });
}

/** 提取中时主按钮变成「取消整段提取」，否则用户没有出口 */
function updateIngestButton() {
  const ing = !!session?.diag?.ingesting;
  const btn = el('ingestBtn');
  if (!btn || btn.disabled) return;
  btn.textContent = ing ? '取消整段提取' : '整段提取';
  btn.classList.toggle('danger', ing);
}

function render() {
  const status = session?.status || 'idle';
  const active = isActive();

  const dot = el('statusDot');
  const pill = el('statusPill');

  const map = {
    idle: ['空闲', ''],
    starting: ['启动中', 'rec'],
    recording: ['录制中', 'rec'],
    stopping: ['收尾中', 'rec'],
    stopped: ['已停止', 'ok'],
    error: ['出错', 'err']
  };
  const [text, cls] = map[status] || map.idle;

  dot.className = 'dot' + (cls === 'rec' ? ' rec' : cls === 'err' ? ' err' : '');
  pill.className = 'pill' + (cls ? ' ' + cls : '');
  pill.textContent = text;

  const btn = el('toggleBtn');
  const staticDoc = session?.diag?.source === 'url' || !!session?.diag?.ingestUrl;
  btn.textContent = active ? '停止' : staticDoc ? '开始转录' : status === 'stopped' || status === 'error' ? '重新开始' : '开始转录';
  btn.classList.toggle('stop', active);
  btn.disabled = busy;

  const audioName = session?.diag?.audioFile;
  const saveBtn = el('saveAudioBtn');
  saveBtn.disabled = !audioName;
  saveBtn.title = audioName ? `下载 ${audioName}` : '这次没有保存音频（开始前要勾「同时保存音频」）';

  const refineBtn = el('refineBtn');
  refineBtn.disabled = !audioName || !!session?.diag?.refining;
  refineBtn.title = audioName
    ? '用保存的 WAV 按 20 秒上下文重新识别一遍（准得多，但耗时几分钟）'
    : '需要先勾「同时保存音频」并录一次';

  renderTimer();
  updateIngestButton();
  renderProgress();
  renderTranscript();

  if (active) startTicker();
  else stopTicker();
}

function renderTimer() {
  // 整段提取的会话没有录制时长，显示稿子覆盖的时长更有意义
  if (session?.diag?.source === 'url' || session?.diag?.ingestUrl) {
    const items = (session.segments || []).filter((s) => s.status === 'done');
    const last = items[items.length - 1];
    const cover = last ? (last.startMs || 0) + (last.durationMs || 0) : session.diag.ingestDurationMs || 0;
    el('timer').textContent = clock(cover);
    return;
  }
  const ms = elapsedOf(session);
  el('timer').textContent = clock(ms);
}

function elapsedOf(s) {
  if (!s?.startedAt) return 0;
  const end = s.stoppedAt || Date.now();
  return Math.max(0, end - s.startedAt);
}

function clock(ms) {
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function renderProgress() {
  const box = el('progress');
  if (!session) {
    box.className = 'meta';
    box.textContent = '尚未开始';
    return;
  }

  const bits = [];
  bits.push(`已转写 ${session.done || 0} 句`);
  if (session.pending) bits.push(`进行中 ${session.pending} 句`);
  if (session.failed) bits.push(`失败 ${session.failed} 句`);
  if (session.skipped) bits.push(`跳过 ${session.skipped} 段静音`);
  if (session.diag?.mode) bits.push(session.diag.mode === 'pcm' ? '实时通路' : '分段通路');
  if (session.diag?.vad) {
    bits.push(
      session.diag.vad === 'silero' ? 'Silero VAD' : session.diag.vad === 'loading' ? 'Silero 加载中…' : '能量 VAD'
    );
  }
  if (session.diag?.ingesting) {
    const phase = { download: '下载中', decode: '解码中', transcribe: '转写中' }[session.diag.ingestPhase] || session.diag.ingestPhase;
    bits.push(`整段提取：${phase} ${session.diag.ingestDone || 0} 段`);
  } else if (session.diag?.ingestPhase === 'done') {
    bits.push(`整段提取完成：${(session.segments || []).length} 句 / ${Math.round((session.diag.ingestMs || 0) / 1000)}s`);
  } else if (session.diag?.ingestPhase === 'error') {
    bits.push(`整段提取失败：${session.diag.ingestError}`);
  }  if (session.diag?.vadError) bits.push(`VAD 回退：${session.diag.vadError}`);
  if (session.diag?.silent) bits.push('⚠ 捕获静音（页面可能被暂停/静音）');

  box.className = 'meta';
  if (session.lastError) {
    box.textContent = `${bits.join(' · ')} —— ${session.lastError}`;
    box.classList.add('err');
  } else {
    box.textContent = bits.join(' · ');
  }
}

function renderTranscript() {
  const box = el('transcript');
  const segs = session?.segments || [];

  const chars = segs.reduce((n, s) => n + (s.text?.length || 0), 0);
  el('counts').textContent = `${session?.done || 0} 句 / ${chars} 字`;

  if (!segs.length) {
    box.innerHTML = '<span class="empty">还没有内容，点上面的「开始转录」。</span>';
    return;
  }

  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 12;
  const frag = document.createDocumentFragment();

  for (const seg of segs) {
    // 纯静音/音乐块不显示，只在统计里算"跳过"
    if (seg.status === 'skipped') continue;

    const div = document.createElement('div');
    div.className = 'seg';

    if (seg.status === 'error') {
      div.classList.add('err');
      div.textContent = `[${clock(seg.startMs || 0)}] 第 ${seg.index + 1} 段失败：${seg.error}`;
    } else if (seg.status === 'done') {
      if (!seg.text) {
        div.classList.add('pending');
        div.textContent = `[${clock(seg.startMs || 0)}] （这一段没有识别出文字）`;
      } else {
        const t = document.createElement('span');
        t.className = 't';
        t.textContent = clock(seg.startMs || 0);
        div.appendChild(t);
        div.appendChild(document.createTextNode(seg.text));
      }
    } else {
      div.classList.add('pending');
      div.textContent = `[${clock(seg.startMs || 0)}] ${seg.status === 'uploading' ? '识别中…' : '排队中…'}`;
    }
    frag.appendChild(div);
  }

  box.replaceChildren(frag);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    renderTimer();
  updateIngestButton();
    renderProgress();
    if (!isActive()) stopTicker();
  }, 500);
}

function stopTicker() {
  clearInterval(ticker);
  ticker = null;
}

/* ------------------------------ 开始 / 停止 ------------------------------ */

async function start() {
  setNoteSink('live');
  const next = readForm();

  if (!next.apiKey) {
    showTab('cfg');
    note('请先填写 API Key（硅基流动控制台 → API 密钥）。', 'err');
    return;
  }

  // 权限请求必须在用户手势的有效期内，所以放在 saveSettings 的 await 之前
  if (!(await ensureHostPermission(next.baseUrl))) {
    note('没拿到该接口域名的访问权限，请求会被浏览器拦截。', 'err');
    return;
  }

  await saveSettings(next);

  if (!activeTab?.id) {
    el('hint').textContent = '没有拿到当前标签页，请重新打开插件。';
    return;
  }

  busy = true;
  el('toggleBtn').disabled = true;
  el('hint').textContent = '正在申请标签页音频…';

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'START',
      tabId: activeTab.id,
      settings: next
    });
  } catch (err) {
    res = { ok: false, error: String(err?.message || err) };
  }

  busy = false;

  if (!res?.ok) {
    el('hint').textContent = res?.error || '启动失败。';
    const { asrSession } = await chrome.storage.local.get('asrSession');
    session = asrSession || session;
    render();
    return;
  }

  el('hint').textContent = '正在录制并实时识别，可以关掉这个弹窗，转录不会中断。';
}

async function stop() {
  setNoteSink('live');
  await chrome.runtime.sendMessage({ type: 'STOP' }).catch(() => {});
  const { asrSession } = await chrome.storage.local.get('asrSession');
  session = asrSession || session;
  render();

  await refreshHistory();
  await refreshLibrary();
  const canRefine = !!session?.diag?.audioFile && !session?.refined;
  el('hint').textContent = canRefine
    ? '已停止。点「离线精校」能按长上下文重跑一遍，比实时准很多。'
    : session?.diag?.audioFile
      ? '已停止。队列里剩下的片段还会继续上传完。'
      : '已停止。下次勾上「同时保存音频」，就能用「离线精校」重跑。';
}

async function resetSession() {
  showTab('lib');
  const name = session?.diag?.audioFile;
  await chrome.runtime.sendMessage({ type: 'RESET' }).catch(() => {});
  if (name) await removeAudioFile(name).catch(() => {});
  session = null;
  render();
  await refreshHistory();
  await refreshLibrary();
  note('已清空（旧稿已存进历史，可点「恢复上一份」找回）。', 'ok');
}

/* ------------------------------ 表单 ------------------------------ */

function fillForm() {
  el('apiKey').value = settings.apiKey || '';
  el('model').value = settings.model || DEFAULTS.model;
  el('baseUrl').value = settings.baseUrl || DEFAULTS.baseUrl;
  el('segmentSeconds').value = settings.segmentSeconds || DEFAULTS.segmentSeconds;
  el('prescanRate').value = settings.prescanRate || DEFAULTS.prescanRate;
  el('correctModel').value = settings.correctModel || DEFAULTS.correctModel;

  // 术语表默认留空（通用）；这里只提示格式，示例在 examples/ 目录
  el('glossary').value = settings.glossary || '';
  el('glossary').placeholder = GLOSSARY_FORMAT_HINT;

  const sub = { ...DEFAULTS.subtitle, ...(settings.subtitle || {}) };
  el('subtitleFontSize').value = sub.fontSize || DEFAULTS.subtitle.fontSize;
  el('mutePlayback').checked = !!settings.mutePlayback;
  el('saveAudio').checked = !!settings.saveAudio;
  el('sileroVad').checked = settings.sileroVad !== false;
  el('incrementalAsr').checked = settings.incrementalAsr !== false;
}

function readForm() {
  const seg = Number(el('segmentSeconds').value) || DEFAULTS.segmentSeconds;
  const fontSize = Number(el('subtitleFontSize').value) || DEFAULTS.subtitle.fontSize;
  const rate = Number(el('prescanRate').value) || DEFAULTS.prescanRate;
  return {
    apiKey: el('apiKey').value.trim(),
    model: el('model').value.trim() || DEFAULTS.model,
    baseUrl: el('baseUrl').value.trim() || DEFAULTS.baseUrl,
    segmentSeconds: Math.min(600, Math.max(10, Math.round(seg))),
    maxChunkMs: settings.maxChunkMs || DEFAULTS.maxChunkMs,
    mutePlayback: el('mutePlayback').checked,
    saveAudio: el('saveAudio').checked,
    sileroVad: el('sileroVad').checked,
    incrementalAsr: el('incrementalAsr').checked,
    correctModel: el('correctModel').value.trim() || DEFAULTS.correctModel,
    glossary: el('glossary').value,
    prescanRate: Math.min(2, Math.max(1, Number(rate.toFixed(1)))),
    subtitle: {
      ...(settings.subtitle || {}),
      // 开关不放在设置页：点「显示字幕」置真，面板右上角 × 置假
      enabled: (settings.subtitle?.enabled ?? true) !== false,
      fontSize: Math.min(48, Math.max(12, Math.round(fontSize)))
    }
  };
}

async function saveSettings(next) {
  settings = { ...next };
  await chrome.storage.local.set({ asrSettings: settings });
}

/** 从媒体地址里取出"像 ID 的那一段"，方便人眼对比两条日志 */
function mediaId(url) {
  try {
    const base = String(url).split('?')[0];
    // B 站：https://…/42955378424/42955378424-1-30280.m4s
    const m = base.match(/\/(\d{5,})[\/-]/);
    if (m) return m[1];
    return base.split('/') .pop();
  } catch {
    return '?';
  }
}

/**
 * 打日志：既进弹窗自己的控制台，也发到页面控制台。
 * 弹窗一关控制台就没了，而页面的控制台能一直留着看，排查时更实用。
 */
function mlog(...args) {
  console.log('[字幕助手]', ...args);
  try {
    chrome.tabs.sendMessage(activeTab?.id ?? 0, { type: 'PAGE_LOG', text: args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') }).catch(() => {});
  } catch {
    /* 页面没注入时忽略 */
  }
}

async function ensureHostPermission(baseUrl) {
  try {
    const origin = new URL(baseUrl).origin + '/*';
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

/* ------------------------------ 整段提取（直链） ------------------------------ */

/**
 * 直链媒体整段提取：不用等播放。
 *
 * 流程：探测拿到直链 → offscreen 下载 → 浏览器解码 → 16k 单声道 → 窗口化转写 → 纠错。
 * 进度靠 session.diag.ingest* 推回来，所以这里只负责发指令和提示。
 */
async function ingestFromPage() {
  setNoteSink('doc');

  // 正在提取时，这个按钮变成"取消"
  if (session?.diag?.ingesting) {
    const res = await chrome.runtime.sendMessage({ type: 'INGEST_CANCEL' }).catch(() => null);
    note(res?.ok ? '已取消整段提取（已经转好的句子保留在「字幕库」页）。' : '取消失败，可能已经跑完。', res?.ok ? 'ok' : 'err');
    const { asrSession } = await chrome.storage.local.get('asrSession');
    session = asrSession || session;
    render();
    return;
  }

  const btn = el('ingestBtn');
  btn.disabled = true;
  btn.textContent = '准备中…';

  try {
    /* --- 1. 先确认探测结果是"这一页"的 ---
     * B 站这类站是单页应用：换视频时 URL 变了但页面没刷新。
     * 兜里的 lastProbe 还是上一个视频的（连带的签名地址也可能已过期），
     * 直接用就会 403，或者更糟：把上一个视频的音频转出来（真实踩过）。 */
    const tabNow = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    const pageUrl = tabNow?.[0]?.url || '';
    const stale = !lastProbe || !lastMediaUrl || (pageUrl && lastProbe.url !== pageUrl);

    if (stale) {
      note(lastProbe ? '页面已经换成别的视频了，重新探测一次…' : '先探测页面，找可下载的媒体链接…');
      const fresh = await refreshProbe();
      if (!fresh.ok) return note('探测失败：' + (fresh.error || '未知'), 'err');
      if (!fresh) {
        return note('这个页面没找到可下载的直链（可能是 MSE/blob:）。\n先用「开始转录」实时录，或者点播放几秒后再点「探测本页媒体」。', 'err');
      }
    }

    mlog('整段提取 · 即将下载ID=' + mediaId(url) + ' · 完整地址=' + url);
    const url = lastMediaUrl;
    if (!url) return note('这个页面没挑出可用的音轨地址：先点播放几秒让播放器真的去取流，再点「探测本页媒体」；\n如果一直挑不出，说明 CDN 拒绝了探测（多半是权限/防盗链），告诉我探测结果里「选用：」那行。', 'err');

    /* --- 2. 下载权限：DNR 的 modifyHeaders 需要目标域名权限，
     * 否则规则被静默忽略 → CDN 收不到 Referer → 403（B 站踩过）。 --- */
    const okPerm = await ensureHostPermission(url);
    if (!okPerm) {
      return note('没拿到媒体域名的访问权限，CDN 会拒绝下载（403）。请在授权提示里点「允许」后重试。', 'err');
    }

    note(`开始整段提取：\n${url.slice(0, 120)}\n下载 → 解码 → 转写，进度会显示在下方。`);

    // 字幕必须按视频隔离：把"这份稿子属于哪个视频"一起传下去，
    // 否则换个视频会照样显示上一个视频的字幕（真实踩过）。
    const videoKey = videoKeyOf({
      href: lastProbe?.url || url,
      duration: lastProbe?.videos?.find((v) => v.duration)?.duration
    });

    const res = await chrome.runtime
      .sendMessage({ type: 'INGEST_URL', url, tabId: activeTab?.id, videoKey })
      .catch((err) => ({
        ok: false,
        error: String(err?.message || err)
      }));

    if (!res?.ok) {
      // cdnHeaders/cdnRules 是排查 403 的关键：规则没装上时，CDN 就收不到 Referer
      const diag = `［Referer 规则：${res?.cdnHeaders ? '已装' : '未装'}（${res?.cdnRules ?? '?'} 条）］`;
      note(`整段提取没能开始：${res?.error || '未知错误'} ${diag}`, 'err');
    } else {
      note('已在后台开始整段提取，可以关掉弹窗，跑完会写进文字稿。');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '整段提取（不用等播放）';
  }
}

/** 从探测报告里挑一个最像"可整段下载"的链接 */
function pickMediaUrl(report) {
  if (!report) return '';
  const first = (arr) => (arr && arr.length ? arr[0].url || arr[0].src || '' : '');

  // 平台播放信息（B 站 __playinfo__ 之类）：直接就是音轨/整段地址，优先级最高
  // 钩子记下的地址若是换集前抓的（stale），宁可不用，让上层重新探测
  const pi = report.playinfo;
  const platform = pi && !pi.stale ? pi.audio || pi.video || '' : '';
  if (platform && /^https?:/i.test(platform)) return platform;
  const tracks = (report.tracks || []).map((t) => t.src).filter(Boolean);

  // 直链 mp4/mp3/m4a 优先；其次 m3u8（后续可做分片拼接）；字幕轨先不算（要单独解析）
  const direct = (report.videos || []).map((v) => v.src).find((s) => /^https?:/i.test(s) && !/\.m3u8|\.mpd/i.test(s));
  return (
    direct ||
    first(report.media?.video) ||
    first(report.media?.audio) ||
    first(report.media?.hls) ||
    first(report.media?.dash) ||
    tracks[0] ||
    ''
  );
}

/* ------------------------------ 显示到页面 ------------------------------ */

/** 把当前稿子显示到视频页面（不重新识别），整段提取完或旧会话都能用 */
async function showPanel() {
  // 面板显示开关已不放在设置页：点「显示字幕」就把它置真
  // （面板右上角 × 会把它置假，等价于"关掉字幕"）
  try {
    const { asrSettings } = await chrome.storage.local.get('asrSettings');
    const sub = { ...(asrSettings?.subtitle || {}), enabled: true };
    await chrome.storage.local.set({ asrSettings: { ...(asrSettings || {}), subtitle: sub } });
  } catch {
    /* 置真失败也不挡注入 */
  }

  const res = await chrome.runtime.sendMessage({ type: 'SHOW_PANEL', tabId: activeTab?.id }).catch((err) => ({
    ok: false,
    error: String(err?.message || err)
  }));
  if (!res?.ok) return note(`显示失败：${res?.error || '这个页面不允许注入'}`, 'err');
  note('已把文字稿显示到页面上。浮窗可拖动、缩放，右上角 × 关闭。', 'ok');
}
/* ------------------------------ 字幕库 ------------------------------ */

let libraryItems = [];

async function refreshLibrary() {
  const res = await chrome.runtime.sendMessage({ type: 'DOC_LIST' }).catch(() => null);
  libraryItems = res?.ok ? res.items || [] : [];

  const sel = el('libSelect');
  if (!sel) return;
  sel.textContent = '';

  if (!libraryItems.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '字幕库（空）';
    sel.appendChild(o);
    return;
  }

  for (const it of libraryItems) {
    const o = document.createElement('option');
    o.value = it.key;
    const when = it.createdAt ? new Date(it.createdAt).toLocaleDateString() : '';
    const title = (it.title || it.key).slice(0, 40);
    o.textContent = `${title} · ${it.count} 句${when ? ` · ${when}` : ''}`;
    sel.appendChild(o);
  }

  // 默认选中当前会话对应的那份
  if (session?.videoKey && libraryItems.some((x) => x.key === session.videoKey)) {
    sel.value = session.videoKey;
  }
}

async function loadFromLibrary() {
  showTab('lib');
  const key = el('libSelect').value;
  if (!key) return note('字幕库是空的：先用「整段提取」跑一次，会自动存进去。', 'err');

  const res = await chrome.runtime.sendMessage({ type: 'DOC_LOAD', key }).catch((err) => ({
    ok: false,
    error: String(err?.message || err)
  }));
  if (!res?.ok) return note(`加载失败：${res?.error || '未知'}`, 'err');

  const { asrSession } = await chrome.storage.local.get('asrSession');
  session = asrSession || session;
  render();
  note(`已从字幕库加载：${res.count} 句${res.title ? `（${res.title.slice(0, 50)}）` : ''}`, 'ok');
}

async function removeFromLibrary() {
  showTab('lib');
  const key = el('libSelect').value;
  if (!key) return note('没有可删的条目。', 'err');

  const res = await chrome.runtime.sendMessage({ type: 'DOC_REMOVE', key }).catch(() => null);
  if (!res?.ok) return note('删除失败。', 'err');

  await refreshLibrary();
  note(`已删除，库里还剩 ${res.total} 份。`, 'ok');
}


/* ------------------------------ 历史稿 ------------------------------ */

/** 有没有被覆盖/清空的旧稿，有就显示「恢复上一份」 */
let historyCount = 0;

async function refreshHistory() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'HISTORY_INFO' });
    historyCount = res?.ok ? res.count || 0 : 0;
  } catch {
    historyCount = 0;
  }
  const btn = el('historyBtn');
  if (!btn) return;
  btn.hidden = historyCount === 0;
  btn.textContent = historyCount > 0 ? `恢复上一份（${historyCount}）` : '恢复上一份';
}

async function restoreHistory() {
  const res = await chrome.runtime.sendMessage({ type: 'RESTORE_HISTORY' }).catch((err) => ({
    ok: false,
    error: String(err?.message || err)
  }));

  if (!res?.ok) {
    note(`恢复失败：${res?.error || '未知'}`, 'err');
    return refreshHistory();
  }

  const { asrSession } = await chrome.storage.local.get('asrSession');
  session = asrSession || session;
  render();
  await refreshHistory();
  await refreshLibrary();
  note(`已恢复上一份稿子：${res.count} 句${res.title ? `（${res.title.slice(0, 60)}）` : ''}`, 'ok');
}

/* ------------------------------ 探测本页媒体 ------------------------------ */

/**
 * 问页面："能不能整段提取？"
 * 结果决定走哪条路：现成字幕 > 直链文件 > HLS/DASH 分片 > 只能实时录。
 */
/**
 * 探测当前页并记住结果，返回 { ok, url, report, error }。
 * 抽成函数是因为两处都要用：点「探测本页媒体」，以及「整段提取」发现结果过期时自动重探。
 * 记住的 lastMediaUrl 只对**这一页**有效——B 站换视频不刷新页面（单页应用），
 * 用旧地址轻则 403，重则把上一个视频的音频转出来（真机踩过）。
 */
async function refreshProbe() {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'PROBE_MEDIA' });
  } catch (err) {
    res = { ok: false, error: String(err?.message || err) };
  }

  if (!res?.ok || !res.report) {
    lastProbe = null;
    lastMediaUrl = '';
    return { ok: false, error: res?.error || '没有返回结果', report: null, url: '' };
  }

  const r = res.report;
  // 平台播放信息（主世界读到的页面 JS 变量）并进报告，后续统一按 report 用
  if (res.playinfo) r.playinfo = res.playinfo;
  lastProbe = r;
  lastMediaUrl = await resolveMediaUrl(r);
  return { ok: true, error: '', report: r, url: lastMediaUrl };
}

/**
 * 决定到底提取哪个地址。
 *
 * 顺序很重要：B 站的 `__playinfo__` 是**首屏服务端渲染的快照，换集永不更新**
 * （实测几个不同视频拿到的是同一个 baseUrl），所以它只能做最后的兜底。
 * 首选是播放器**真去取过的分片**（performance 里抓到的，一定是当前视频的），
 * 再让后台用 HEAD 的 content-type / 体积挑出其中的音轨。
 */
/**
 * 给候选地址打分：明确是音频的最好；同为 video/mp4 时**体积小的当音频**
 * （同一段视频的音轨比画面小一个数量级——B 站实测 970KB vs 4.7MB）。
 */
function scoreCandidates(rows) {
  const score = (x) => {
    if (!x || x.status < 200 || x.status >= 300) return -1;
    if (x.type.startsWith('audio/')) return 100;
    if (/\.(mp3|m4a|aac|ogg|opus|wav)(\?|$)/i.test(x.url || '')) return 90;
    if (x.type.startsWith('video/')) return 50;
    if (/\.(m4s|ts)(\?|$)/i.test(x.url || '')) return 40;
    return 10;
  };
  return (rows || [])
    .map((x) => ({ ...x, score: score(x) }))
    .sort((a, b) => b.score - a.score || (a.size || Infinity) - (b.size || Infinity));
}

async function resolveMediaUrl(report) {
  if (!report) return '';

  // ① B 站：现查播放接口，拿"当前这个视频"的音轨。
  //    （__playinfo__ / __INITIAL_STATE__ 都是首屏快照，SPA 换集后不更新，会转到旧视频）
  try {
    const bili = await chrome.tabs.sendMessage(activeTab?.id ?? 0, { type: 'BILI_AUDIO' });
    if (bili?.ok && bili.audio) {
      report.picked = { url: bili.audio, type: 'bilibili-api', size: 0, score: 999 };
      report.biliCid = bili.cid;
      return bili.audio;
    }
    if (bili && bili.ok === false) report.biliError = bili.error || "未知";
  } catch {
    /* 不是 B 站或内容脚本没注入，继续走通用路径 */
  }

  // ① 钩子抓到的是"当前视频那一次 playurl"里的音轨，最可信
  const hooked = report.playinfo;
  if (hooked && hooked.audio && !hooked.stale && String(hooked.source || '').startsWith('hook')) {
    report.picked = { url: hooked.audio, type: 'hook:' + hooked.source, size: 0, score: 999 };
    return hooked.audio;
  }

  const segments = (report.media?.segment || []).map((s) => s.url || '').filter((u) => /^https?:/i.test(u));
  const direct = (report.videos || [])
    .map((v) => v.src || '')
    .filter((u) => /^https?:/i.test(u) && !/^blob:/i.test(u));
  const candidates = [
    ...segments.slice().reverse(), // 最近的优先
    ...direct,
    ...(report.media?.video || []).map((x) => x.url).filter(Boolean),
    ...(report.media?.audio || []).map((x) => x.url).filter(Boolean)
  ];

  const unique = [...new Set(candidates)].slice(0, 8);
  // 必须在 PICK_MEDIA 之前把域名权限拿到：DNR 的 Referer 规则没有 host 权限会被忽略，
  // 于是 HEAD 直接被 CDN 拒（403），候选全军覆没 → 「选用ID=无」（真机踩过）。
  if (unique.length) await ensureHostPermission(unique[0]).catch(() => false);

  if (unique.length) {
    // 首选：让**页面上下文**（内容脚本）去检查。它发出的请求带页面 Referer，
    // 而且 CDN 对页面开了 CORS（实测 HEAD 200）；B 站的音频和视频常在**不同** CDN
    // 主机上（-01 / -03），逐台申请扩展权限根本不现实。
    let rows = null;
    try {
      const inPage = await chrome.tabs.sendMessage(activeTab?.id ?? 0, { type: 'CHECK_MEDIA', urls: unique });
      if (inPage?.ok) rows = inPage.rows;
    } catch {
      rows = null;
    }

    if (rows) {
      const scored = scoreCandidates(rows);
      const best = scored.find((x) => x.score >= 0);
      if (best) {
        report.picked = { url: best.url, type: best.type, size: best.size, score: best.score };
        return best.url;
      }
      report.pickErrors = scored.slice(0, 4).map((x) => `${x.status || 'x'} ${x.error || ''}`.trim());
    } else {
      // 页面没注入内容脚本时退回后台（后台需要 host 权限 + DNR 补 Referer）
      const picked = await chrome.runtime.sendMessage({ type: 'PICK_MEDIA', urls: unique }).catch(() => null);
      if (picked?.ok && picked.best?.url) {
        report.picked = { url: picked.best.url, type: picked.best.type, size: picked.best.size, score: picked.best.score };
        return picked.best.url;
      }
    }
  }

  // 有分片地址却挑不出音轨 → 说明 HEAD 被 CDN 拒了（多半是权限/防盗链）。
  // 这时**绝不能**回退到 __playinfo__：它是首屏快照，换集后还指着第一个视频，
  // 用它就会"每次都转同一个视频的音频"（真实踩过，比失败更糟）。
  if (segments.length) return '';

  // 完全没有分片时才用平台快照，且必须自证没过期（时长对得上当前 <video>）
  const pi = report.playinfo;
  if (pi && !pi.stale && (pi.audio || pi.video)) return pi.audio || pi.video;

  return '';
}

async function probeMedia() {
  setNoteSink('doc');
  const btn = el('probeBtn');
  btn.disabled = true;
  btn.textContent = '探测中…';
  note('正在检查这个页面能不能整段提取（刚打开页面的话，先点播放几秒再探测更准）…');

  const out = await refreshProbe();

  btn.disabled = false;
  btn.textContent = '探测本页媒体';

  if (!out.ok) return note(`探测失败：${out.error || '未知错误'}`, 'err');

  const r = out.report;
  if (!r) return note('探测没有返回结果（页面可能不允许注入脚本）', 'err');

  const label =
    {
      subtitle: '✅ 页面自带字幕，可直接用（最快、质量最高）',
      hls: '✅ 有 m3u8 播放列表 → 可下载全部分片，播之前就转完',
      dash: '✅ 有 DASH 清单 → 可只下音频分片，播之前就转完',
      direct: '✅ 有直链媒体文件 → 可整段下载后转写',
      mse: '⚠️ 播放器用 MSE + blob:，没有稳定直链 → 只能实时录；但若下面读到平台音轨，就能整段提取',
      unknown: '⚠️ 没抓到媒体请求（先播放几秒再试）'
    }[r.mode] || r.mode;

  const counts = [
    `m3u8 ${(r.media?.hls || []).length}`,
    `mpd ${(r.media?.dash || []).length}`,
    `整段 ${(r.media?.video || []).length + (r.media?.audio || []).length}`,
    `分片 ${(r.media?.segment || []).length}`,
    `字幕轨 ${(r.tracks || []).length}`,
    `<video> ${(r.videos || []).length}`
  ].join(' · ');

  // 读到平台播放信息就明说——这是 MSE 页面唯一的整段提取出路
  const picked = r.picked;
  // 选中的地址（resolveMediaUrl 记在 report.picked 上）：一眼看出挑的是音频还是视频
  mlog(
    '探测完成 · 平台=' + (r.platform || '?'),
    '· 模式=' + (r.mode || '?'),
    '· 分片=' + ((r.media?.segment || []).length),
    '· 选用ID=' + (picked?.url ? mediaId(picked.url) : '无'),
    '· 类型=' + (picked?.type || '?'),
    '· 大小=' + (picked?.size ? Math.round(picked.size / 1048576) + 'MB' : '?')
  );
  const cidLine = r.biliCid ? (" · cid " + r.biliCid) : (r.biliError ? (" · B站接口：" + r.biliError) : "");
  const pickedLine = picked
    ? "\n选用：ID " + mediaId(picked.url) + " · " + (picked.type || "未知类型") + " / " + (picked.size ? Math.round(picked.size / 1048576) + "MB" : "大小未知") + " / 评分 " + picked.score + "\n" + picked.url.slice(0, 120)
    : "";
  const platformAudio = r.playinfo?.audio || r.playinfo?.video || "";
  const platformLine = platformAudio
    ? ` · 平台音轨 ${platformAudio.slice(0, 60)}…（可整段提取）`
    : "";

  const sample = [
    ...(r.media?.hls || []).slice(0, 1),
    ...(r.media?.dash || []).slice(0, 1),
    ...(r.media?.video || []).slice(0, 1),
    ...(r.tracks || []).map((t) => ({ url: t.src }))
  ]
    .map((x) => x.url)
    .filter(Boolean)
    .slice(0, 3);

  const ok = ['subtitle', 'hls', 'dash', 'direct'].includes(r.mode) || !!platformAudio;
  const detail = (r.reasons || []).join('\n');
  note(
    `${r.platform}｜${label}${platformLine}${cidLine}\n计数：${counts}\n${detail}${pickedLine}` +
      (sample.length ? `\n链接：\n${sample.join('\n')}` : ''),
    ok ? 'ok' : 'err'
  );

  console.log('[probe]', r);
}

/* ------------------------------ VAD 自检 ------------------------------ */

async function vadSelftest() {
  const btn = el('vadTestBtn');
  btn.disabled = true;
  btn.textContent = '自检中…';
  note('正在自检 Silero VAD（加载运行时 → 取模型 → 建会话 → 跑一帧）…');

  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'VAD_SELFTEST' });
  } catch (err) {
    res = { ok: false, error: String(err?.message || err), step: 'send' };
  }

  btn.disabled = false;
  btn.textContent = 'VAD 自检';

  if (res?.ok) {
    const mb = (res.modelBytes || 0) / 1048576;
    return note(`VAD 正常：模型 ${mb.toFixed(1)}MB，单帧推理 ${res.inferMs}ms，概率 ${res.prob}`, 'ok');
  }
  note(`VAD 自检失败（卡在 ${res?.step || '?'}）：${res?.error || '未知错误'}`, 'err');
}

/* ------------------------------ 自测接口 ------------------------------ */

async function testApi() {
  const next = readForm();
  if (!next.apiKey) return note('先填 API Key。', 'err');

  if (!(await ensureHostPermission(next.baseUrl))) return note('缺少接口域名权限。', 'err');
  await saveSettings(next);

  note('正在请求接口…', '');

  // 用 2 秒测试音走通整条链路：能返回 200 就说明 key / 模型名 / 网络都通
  const wav = makeToneWav({ seconds: 2, freq: 440 });
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'selftest.wav');
  form.append('model', next.model);

  const url = next.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions';
  const started = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${next.apiKey}` },
      body: form
    });
    const body = await res.text();
    const cost = Date.now() - started;

    if (res.ok) {
      note(`接口正常（${res.status}，${cost}ms）。返回：${body.slice(0, 120)}`, 'ok');
    } else {
      note(`接口返回 ${res.status}（${cost}ms）：${body.slice(0, 200)}`, 'err');
    }
  } catch (err) {
    note(`请求失败：${err?.message || err}`, 'err');
  }
}

/* ------------------------------ 导出 ------------------------------ */

function collectSegments() {
  return (session?.segments || []).filter((s) => s.status === 'done' && s.text);
}

function plainText({ withTime = false } = {}) {
  return collectSegments()
    .map((s) => (withTime ? `[${clock(s.startMs || 0)}] ${s.text}` : s.text))
    .join('\n');
}

async function copyAll() {
  showTab('lib');
  const text = plainText();
  if (!text) return note('还没有可复制的内容。', 'err');
  try {
    await navigator.clipboard.writeText(text);
    note('已复制全文。', 'ok');
  } catch {
    note('复制失败，请用「导出 TXT」。', 'err');
  }
}

function exportTxt() {
  showTab('lib');
  const text = plainText({ withTime: true });
  if (!text) return note('还没有可导出的内容。', 'err');

  const head = [
    `标题：${session?.tabTitle || ''}`,
    `模型：${session?.model || settings.model}`,
    `时长：${clock(elapsedOf(session))}`,
    `导出：${new Date().toLocaleString()}`,
    ''
  ].join('\n');

  download(`${safeName(session?.tabTitle || '转录')}.txt`, head + text, 'text/plain;charset=utf-8');
  note('已导出 TXT。', 'ok');
}

function exportSrt() {
  showTab('lib');
  const segs = collectSegments();
  if (!segs.length) return note('还没有可导出的内容。', 'err');

  const lines = [];
  let n = 0;
  segs.forEach((seg, i) => {
    const start = Math.max(0, seg.startMs || 0);
    const next = segs[i + 1];
    let end = start + (seg.durationMs || 0);
    if (!seg.durationMs) end = start + 3000;
    if (next && next.startMs && end > next.startMs) end = next.startMs;
    if (end <= start) end = start + 1000;

    n += 1;
    lines.push(String(n));
    lines.push(`${srtTime(start)} --> ${srtTime(end)}`);
    lines.push(seg.text);
    lines.push('');
  });

  download(`${safeName(session?.tabTitle || '转录')}.srt`, lines.join('\n'), 'text/plain;charset=utf-8');
  note('已导出 SRT（按分段计时，粒度约为每段秒数）。', 'ok');
}

function srtTime(ms) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  let rest = Math.max(0, Math.round(ms));
  const h = Math.floor(rest / 3600000);
  rest -= h * 3600000;
  const m = Math.floor(rest / 60000);
  rest -= m * 60000;
  const s = Math.floor(rest / 1000);
  rest -= s * 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(rest, 3)}`;
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function safeName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .slice(0, 60)
    .trim() || '转录';
}

/* ------------------------------ 杂项 ------------------------------ */

let noteSink = 'docNote';

/** 指定后续提示显示在哪一组（整段提取 / 实时转录） */
function setNoteSink(which) {
  noteSink = which === 'live' ? 'liveNote' : 'docNote';
}

function note(text, kind = '') {
  // 写到**当前标签页自己的**提示区（转录页 runNote / 设置页 settingsNote）；
  // 之前两页共用一处，导致一条消息两个页面都能看到。
  const box = currentTab === 'cfg' ? el('settingsNote') : currentTab === 'lib' ? el('libNote') : el(noteSink);
  if (box) {
    box.textContent = text;
    box.className = 'note' + (kind ? ' ' + kind : '');
  }

  // 页脚只放短状态，太长就截断，免得把界面撑开
  const hint = el('hint');
  if (hint) hint.textContent = text.length > 70 ? text.slice(0, 70) + '…' : text;
}






















