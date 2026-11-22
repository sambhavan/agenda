/**
 * BEACON — Toastmasters Agenda Runner
 * Manages agenda building, run-mode playlist timer, session reporting.
 */

// ==========================================================================
// Role Type Defaults
// ==========================================================================
const ROLE_DEFAULTS = {
  'prepared':   { label: 'Prepared Speech', green: 300, yellow: 360, red: 420 },
  'icebreaker': { label: 'Ice Breaker',     green: 240, yellow: 300, red: 360 },
  'evaluation': { label: 'Evaluation',      green: 120, yellow: 150, red: 180 },
  'topics':     { label: 'Table Topics Spk',green: 60,  yellow: 90,  red: 120 },
  'general':    { label: 'General',         green: null, yellow: null, red: null }, // computed from duration
  'section':    { label: 'Section Break',   green: 0,   yellow: 0,   red: 0 }
};

// ==========================================================================
// Agenda State
// ==========================================================================
let agenda = [];      // Array of item objects
let meetingConfig = loadMeetingConfig();
let sessionLog = [];  // Filled during run mode
let _dragSrcIdx = null;

// ==========================================================================
// Run State
// ==========================================================================
const runState = {
  isRunning: false,
  isPaused: false,
  currentIdx: -1,       // index into agenda (runnable items only via runQueue)
  runQueue: [],         // indices of non-section rows
  startTime: null,
  accumulatedTime: 0,
  elapsedSeconds: 0,
  timerInterval: null,
  wakeLockSentinel: null,
  itemActualStart: null, // Date when current item actually started
};

// ==========================================================================
// DOM References
// ==========================================================================
const $ = id => document.getElementById(id);

// ==========================================================================
// INIT
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  checkWakeLockSupport();
  loadAgendaFromStorage();
  if (agenda.length === 0) buildDefaultAgenda();
  renderAgenda();
  updateMeetingPill();
  bindHeaderButtons();
  bindSettingsModal();
  bindRunControls();
  bindJsonControls();
  bindFullscreen();
  document.addEventListener('keydown', handleKeyPress);
});

// ==========================================================================
// DEFAULT TEMPLATE
// ==========================================================================
function buildDefaultAgenda() {
  const cfg = meetingConfig;
  const startMin = timeStrToMinutes(cfg.meetingStart || '13:30');

  agenda = [
    section('OPENING'),
    item('Gathering / Networking',      'Toastmasters & Guests', 'general',    15),
    item('Sergeant at Arms',            cfg.roles?.saa    || '', 'general',     2),
    item("President's Address",         cfg.roles?.president || '', 'general',  2),
    item("Leader's Address",            '',                       'general',     2),
    item('Group Photo',                 'All',                    'general',     1),
    item('President Introduces TMOD',   cfg.roles?.president || '', 'general',  2),
    item("Day's Programme by TMOD (incl. GE Introduction)", cfg.roles?.tmod || '', 'general', 4),
    item('Introduction of Timer',       '',                       'general',     1),
    item("Timer's Introduction of Role",cfg.roles?.timer  || '', 'general',     2),
    item('Introduction of Ah Counter',  '',                       'general',     1),
    item("Ah Counter's Introduction of Role", cfg.roles?.ah || '', 'general',   2),
    item('Introduction of Grammarian',  '',                       'general',     1),
    item("Grammarian's Introduction of Role (incl. WOD & POD)", cfg.roles?.gram || '', 'general', 2),
    item('Introduction of Listening Master', '',                  'general',     1),
    item("Listening Master's Introduction of Role", cfg.roles?.lm || '', 'general', 2),
    ...preparedSpeechBlock(1, cfg),
    ...preparedSpeechBlock(2, cfg),
    section('TABLE TOPICS'),
    item('Introduction of Table Topics Master', cfg.roles?.tmod || '', 'general', 2),
    item('Table Topics Session',        cfg.roles?.ttm    || '', 'topics',     18),
    section('EVALUATION SESSION'),
    item('Introduction to Evaluation Session', cfg.roles?.ge || '', 'general',  1),
    item('Evaluation of Speech 1',      cfg.roles?.ev1    || '', 'evaluation',  3),
    item('Evaluation of Speech 2',      cfg.roles?.ev2    || '', 'evaluation',  3),
    item("Timer's Report",              cfg.roles?.timer  || '', 'general',     2),
    item("Ah Counter's Report",         cfg.roles?.ah     || '', 'general',     2),
    item("Grammarian's Report",         cfg.roles?.gram   || '', 'general',     2),
    item("Listening Master's Report",   cfg.roles?.lm     || '', 'general',     2),
    item("General Evaluator's Report",  cfg.roles?.ge     || '', 'general',     5),
    section('CLOSING'),
    item('Concluding Remarks by TMOD',  cfg.roles?.tmod   || '', 'general',     4),
    item('Adjournment of the Meeting',  cfg.roles?.president || '', 'general',  1),
  ];

  recalcStartTimes();
  saveAgendaToStorage();
}

function preparedSpeechBlock(num, cfg) {
  const spKey = `sp${num}`;
  const evKey = `ev${num}`;
  const title  = cfg.roles?.[`${spKey}Title`] || `Speech ${num}`;
  const spName = cfg.roles?.[spKey]  || `Speaker ${num}`;
  const evName = cfg.roles?.[evKey]  || `Evaluator ${num}`;
  return [
    section(`PREPARED SPEECH ${num}`),
    item('Introduction of Evaluator',   evName, 'general',  1),
    item('Objective of Speech',         spName, 'general',  1),
    item('Introduction of Speaker',     evName, 'general',  1),
    item(`Prepared Speech ${num}: "${title}"`, spName, 'prepared', 7),
  ];
}

// ==========================================================================
// Item Factories
// ==========================================================================
let _uid = 1;
function uid() { return `item-${Date.now()}-${_uid++}`; }

function item(activity, speaker, role, durationMinutes) {
  const thresholds = computeThresholds(role, durationMinutes);
  return {
    id: uid(), type: 'item',
    activity, speaker, role, durationMinutes,
    green: thresholds.green,
    yellow: thresholds.yellow,
    red: thresholds.red,
    startTime: '--:--'
  };
}

function section(label) {
  return { id: uid(), type: 'section', label, durationMinutes: 0, startTime: '--:--' };
}

function computeThresholds(role, durationMinutes) {
  if (role === 'general') {
    const totalSec = durationMinutes * 60;
    return {
      green:  Math.max(0, totalSec - 30),
      yellow: totalSec,
      red:    totalSec + 30
    };
  }
  const def = ROLE_DEFAULTS[role] || ROLE_DEFAULTS['general'];
  return { green: def.green || 0, yellow: def.yellow || 0, red: def.red || 0 };
}

// ==========================================================================
// Time Calculations
// ==========================================================================
function timeStrToMinutes(str) {
  if (!str) return 0;
  const [h, m] = str.split(':').map(Number);
  return h * 60 + (m || 0);
}

function minutesToTimeStr(totalMins) {
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function recalcStartTimes() {
  let cur = timeStrToMinutes(meetingConfig.meetingStart || '13:30');
  // Find first non-section row's section and start from meeting start
  for (let i = 0; i < agenda.length; i++) {
    const row = agenda[i];
    row.startTime = minutesToTimeStr(cur);
    if (row.type === 'section') {
      // Section breaks: carry current time but don't advance for item sections (zero dur)
      // For TT section we do advance by its durationMinutes
      cur += (row.durationMinutes || 0);
    } else {
      cur += (row.durationMinutes || 0);
    }
  }
}

// ==========================================================================
// RENDER AGENDA TABLE
// ==========================================================================
function renderAgenda() {
  recalcStartTimes();
  const tbody = $('agenda-body');
  tbody.innerHTML = '';
  agenda.forEach((row, idx) => {
    if (row.type === 'section') {
      tbody.appendChild(renderSectionRow(row, idx));
    } else {
      tbody.appendChild(renderItemRow(row, idx));
    }
  });
  saveAgendaToStorage();
}

function renderSectionRow(row, idx) {
  const tr = document.createElement('tr');
  tr.className = 'section-row';
  tr.dataset.idx = idx;
  tr.setAttribute('draggable', true);
  tr.innerHTML = `
    <td class="col-drag drag-handle" title="Drag to reorder">⠿</td>
    <td class="col-start time-cell">${row.startTime}</td>
    <td class="col-dur">
      <div class="dur-stepper">
        <button class="spin-sm" data-action="dur-down" data-idx="${idx}">−</button>
        <input type="number" class="dur-input" value="${row.durationMinutes}" min="0" max="999" data-idx="${idx}" data-field="durationMinutes">
        <button class="spin-sm" data-action="dur-up" data-idx="${idx}">＋</button>
      </div>
    </td>
    <td colspan="4" class="section-label-cell">
      <span class="section-label-text">${escapeHTML(row.label)}</span>
      <input type="text" class="section-label-input hidden" value="${escapeHTML(row.label)}" data-idx="${idx}" data-field="label" placeholder="Section name">
      <button class="edit-label-btn" data-idx="${idx}" title="Edit label">✏️</button>
    </td>
    <td class="col-del"><button class="del-btn" data-idx="${idx}" title="Delete">🗑</button></td>
  `;
  attachRowEvents(tr, idx);
  return tr;
}

function renderItemRow(row, idx) {
  const tr = document.createElement('tr');
  tr.className = 'item-row';
  tr.dataset.idx = idx;
  tr.setAttribute('draggable', true);

  const fmtThresh = (sec) => {
    if (sec === null || sec === undefined) return '';
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const roleOptions = Object.entries(ROLE_DEFAULTS)
    .filter(([k]) => k !== 'section')
    .map(([k, v]) => `<option value="${k}" ${row.role === k ? 'selected' : ''}>${v.label}</option>`)
    .join('');

  tr.innerHTML = `
    <td class="col-drag drag-handle" title="Drag to reorder">⠿</td>
    <td class="col-start time-cell">${row.startTime}</td>
    <td class="col-dur">
      <div class="dur-stepper">
        <button class="spin-sm" data-action="dur-down" data-idx="${idx}">−</button>
        <input type="number" class="dur-input" value="${row.durationMinutes}" min="0" max="999" data-idx="${idx}" data-field="durationMinutes">
        <button class="spin-sm" data-action="dur-up" data-idx="${idx}">＋</button>
      </div>
    </td>
    <td class="col-activity">
      <input type="text" class="cell-input" value="${escapeHTML(row.activity)}" data-idx="${idx}" data-field="activity" placeholder="Activity / Speech title">
    </td>
    <td class="col-speaker">
      <input type="text" class="cell-input" value="${escapeHTML(row.speaker)}" data-idx="${idx}" data-field="speaker" placeholder="Speaker name">
    </td>
    <td class="col-role">
      <select class="cell-select" data-idx="${idx}" data-field="role">${roleOptions}</select>
    </td>
    <td class="col-timing">
      <div class="threshold-row">
        <div class="thresh-group thresh-green">
          <button class="spin-sm thresh-spin" data-action="thresh-down" data-idx="${idx}" data-thr="green">−</button>
          <input type="text" class="thresh-input" value="${fmtThresh(row.green)}" data-idx="${idx}" data-thr="green" placeholder="m:ss">
          <button class="spin-sm thresh-spin" data-action="thresh-up" data-idx="${idx}" data-thr="green">＋</button>
        </div>
        <div class="thresh-group thresh-yellow">
          <button class="spin-sm thresh-spin" data-action="thresh-down" data-idx="${idx}" data-thr="yellow">−</button>
          <input type="text" class="thresh-input" value="${fmtThresh(row.yellow)}" data-idx="${idx}" data-thr="yellow" placeholder="m:ss">
          <button class="spin-sm thresh-spin" data-action="thresh-up" data-idx="${idx}" data-thr="yellow">＋</button>
        </div>
        <div class="thresh-group thresh-red">
          <button class="spin-sm thresh-spin" data-action="thresh-down" data-idx="${idx}" data-thr="red">−</button>
          <input type="text" class="thresh-input" value="${fmtThresh(row.red)}" data-idx="${idx}" data-thr="red" placeholder="m:ss">
          <button class="spin-sm thresh-spin" data-action="thresh-up" data-idx="${idx}" data-thr="red">＋</button>
        </div>
      </div>
    </td>
    <td class="col-del"><button class="del-btn" data-idx="${idx}" title="Delete">🗑</button></td>
  `;
  attachRowEvents(tr, idx);
  return tr;
}

function attachRowEvents(tr, idx) {
  // Drag and drop
  tr.addEventListener('dragstart', onDragStart);
  tr.addEventListener('dragover',  onDragOver);
  tr.addEventListener('drop',      onDrop);
  tr.addEventListener('dragend',   onDragEnd);

  // All inputs & selects
  tr.querySelectorAll('[data-field]').forEach(el => {
    const field = el.dataset.field;
    const rowIdx = parseInt(el.dataset.idx);
    if (el.tagName === 'SELECT') {
      el.addEventListener('change', () => {
        agenda[rowIdx][field] = el.value;
        // Recompute thresholds when role changes
        const thr = computeThresholds(el.value, agenda[rowIdx].durationMinutes);
        agenda[rowIdx].green  = thr.green;
        agenda[rowIdx].yellow = thr.yellow;
        agenda[rowIdx].red    = thr.red;
        renderAgenda();
      });
    } else {
      el.addEventListener('input', () => {
        agenda[rowIdx][field] = field === 'durationMinutes' ? parseInt(el.value) || 0 : el.value;
        if (field === 'durationMinutes' && agenda[rowIdx].role === 'general') {
          const thr = computeThresholds('general', agenda[rowIdx].durationMinutes);
          agenda[rowIdx].green  = thr.green;
          agenda[rowIdx].yellow = thr.yellow;
          agenda[rowIdx].red    = thr.red;
        }
        recalcStartTimes();
        // Update start time cells without full re-render (perf)
        updateStartTimeCells();
        // Update threshold cells if general role changed duration
        if (field === 'durationMinutes') renderAgenda();
        else saveAgendaToStorage();
      });
    }
  });

  // Duration stepper buttons
  tr.querySelectorAll('[data-action^="dur"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx);
      const dir = btn.dataset.action === 'dur-up' ? 1 : -1;
      agenda[i].durationMinutes = Math.max(0, (agenda[i].durationMinutes || 0) + dir);
      if (agenda[i].role === 'general') {
        const thr = computeThresholds('general', agenda[i].durationMinutes);
        agenda[i].green  = thr.green;
        agenda[i].yellow = thr.yellow;
        agenda[i].red    = thr.red;
      }
      renderAgenda();
    });
  });

  // Threshold stepper buttons
  tr.querySelectorAll('[data-action^="thresh"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i   = parseInt(btn.dataset.idx);
      const thr = btn.dataset.thr;  // green|yellow|red
      const dir = btn.dataset.action === 'thresh-up' ? 30 : -30; // 30s increments
      agenda[i][thr] = Math.max(0, (agenda[i][thr] || 0) + dir);
      renderAgenda();
    });
  });

  // Threshold text inputs (parse m:ss)
  tr.querySelectorAll('.thresh-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const i   = parseInt(inp.dataset.idx);
      const thr = inp.dataset.thr;
      agenda[i][thr] = parseThresholdStr(inp.value);
      saveAgendaToStorage();
    });
  });

  // Delete button
  const delBtn = tr.querySelector('.del-btn');
  if (delBtn) {
    delBtn.addEventListener('click', () => {
      agenda.splice(parseInt(delBtn.dataset.idx), 1);
      renderAgenda();
    });
  }

  // Section label edit
  const editLabelBtn = tr.querySelector('.edit-label-btn');
  if (editLabelBtn) {
    editLabelBtn.addEventListener('click', () => {
      const i = parseInt(editLabelBtn.dataset.idx);
      const labelSpan  = tr.querySelector('.section-label-text');
      const labelInput = tr.querySelector('.section-label-input');
      labelSpan.classList.add('hidden');
      labelInput.classList.remove('hidden');
      labelInput.focus();
      labelInput.addEventListener('blur', () => {
        agenda[i].label = labelInput.value;
        renderAgenda();
      }, { once: true });
    });
  }
}

function updateStartTimeCells() {
  recalcStartTimes();
  document.querySelectorAll('.time-cell').forEach((cell, i) => {
    if (agenda[i]) cell.textContent = agenda[i].startTime;
  });
  saveAgendaToStorage();
}

// ==========================================================================
// DRAG & DROP
// ==========================================================================
function onDragStart(e) {
  _dragSrcIdx = parseInt(e.currentTarget.dataset.idx);
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}
function onDrop(e) {
  e.preventDefault();
  const destIdx = parseInt(e.currentTarget.dataset.idx);
  if (_dragSrcIdx === null || _dragSrcIdx === destIdx) return;
  const [moved] = agenda.splice(_dragSrcIdx, 1);
  agenda.splice(destIdx, 0, moved);
  renderAgenda();
}
function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  _dragSrcIdx = null;
}

// ==========================================================================
// HEADER BUTTONS
// ==========================================================================
function bindHeaderButtons() {
  $('btn-settings').addEventListener('click', () => openSettings());
  $('btn-print-agenda').addEventListener('click', printAgenda);
  $('btn-run-agenda').addEventListener('click', startRunMode);
  $('btn-add-item').addEventListener('click', () => {
    agenda.push(item('New Item', '', 'general', 2));
    renderAgenda();
  });
  $('btn-add-section').addEventListener('click', () => {
    agenda.push(section('NEW SECTION'));
    renderAgenda();
  });
  $('btn-add-ps').addEventListener('click', () => {
    // Count existing PS blocks
    const psCount = agenda.filter(r => r.type === 'section' && /^PREPARED SPEECH/i.test(r.label)).length;
    const num = psCount + 1;
    const cfg = meetingConfig;
    const block = preparedSpeechBlock(num, cfg);
    agenda.push(...block);
    renderAgenda();
  });
}

// ==========================================================================
// SETTINGS MODAL
// ==========================================================================
function openSettings() {
  populateSettingsForm();
  $('settings-modal').classList.remove('hidden');
}

function bindSettingsModal() {
  $('btn-close-settings').addEventListener('click', () => $('settings-modal').classList.add('hidden'));
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('settings-modal').addEventListener('click', e => {
    if (e.target === $('settings-modal')) $('settings-modal').classList.add('hidden');
  });

  // Tab switching
  document.querySelectorAll('.modal-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.modal-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      $(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

function populateSettingsForm() {
  const c = meetingConfig;
  const setVal = (id, v) => { const el = $(id); if (el) el.value = v || ''; };
  setVal('cfg-club-name',     c.clubName);
  setVal('cfg-club-number',   c.clubNumber);
  setVal('cfg-area',          c.area);
  setVal('cfg-division',      c.division);
  setVal('cfg-district',      c.district);
  setVal('cfg-meeting-number',c.meetingNumber);
  setVal('cfg-meeting-date',  c.meetingDate);
  setVal('cfg-meeting-start', c.meetingStart);
  setVal('cfg-venue',         c.venue);
  setVal('cfg-theme',         c.theme);
  setVal('cfg-notes',         c.notes);
  // Roles
  const r = c.roles || {};
  setVal('cfg-r-tmod',      r.tmod);
  setVal('cfg-r-president', r.president);
  setVal('cfg-r-ge',        r.ge);
  setVal('cfg-r-saa',       r.saa);
  setVal('cfg-r-timer',     r.timer);
  setVal('cfg-r-gram',      r.gram);
  setVal('cfg-r-ah',        r.ah);
  setVal('cfg-r-lm',        r.lm);
  setVal('cfg-r-ttm',       r.ttm);
  setVal('cfg-r-sp1-title', r.sp1Title);
  setVal('cfg-r-sp1',       r.sp1);
  setVal('cfg-r-ev1',       r.ev1);
  setVal('cfg-r-sp2-title', r.sp2Title);
  setVal('cfg-r-sp2',       r.sp2);
  setVal('cfg-r-ev2',       r.ev2);
  // Officers
  const o = c.officers || {};
  setVal('cfg-o-president', o.president);
  setVal('cfg-o-vpe',       o.vpe);
  setVal('cfg-o-vpm',       o.vpm);
  setVal('cfg-o-vppr',      o.vppr);
  setVal('cfg-o-sec',       o.sec);
  setVal('cfg-o-tres',      o.tres);
  setVal('cfg-o-saa',       o.saa);
}

function saveSettings() {
  const getVal = id => { const el = $(id); return el ? el.value.trim() : ''; };
  meetingConfig = {
    clubName:      getVal('cfg-club-name'),
    clubNumber:    getVal('cfg-club-number'),
    area:          getVal('cfg-area'),
    division:      getVal('cfg-division'),
    district:      getVal('cfg-district'),
    meetingNumber: getVal('cfg-meeting-number'),
    meetingDate:   getVal('cfg-meeting-date'),
    meetingStart:  getVal('cfg-meeting-start'),
    venue:         getVal('cfg-venue'),
    theme:         getVal('cfg-theme'),
    notes:         getVal('cfg-notes'),
    roles: {
      tmod:      getVal('cfg-r-tmod'),
      president: getVal('cfg-r-president'),
      ge:        getVal('cfg-r-ge'),
      saa:       getVal('cfg-r-saa'),
      timer:     getVal('cfg-r-timer'),
      gram:      getVal('cfg-r-gram'),
      ah:        getVal('cfg-r-ah'),
      lm:        getVal('cfg-r-lm'),
      ttm:       getVal('cfg-r-ttm'),
      sp1Title:  getVal('cfg-r-sp1-title'),
      sp1:       getVal('cfg-r-sp1'),
      ev1:       getVal('cfg-r-ev1'),
      sp2Title:  getVal('cfg-r-sp2-title'),
      sp2:       getVal('cfg-r-sp2'),
      ev2:       getVal('cfg-r-ev2'),
    },
    officers: {
      president: getVal('cfg-o-president'),
      vpe:       getVal('cfg-o-vpe'),
      vpm:       getVal('cfg-o-vpm'),
      vppr:      getVal('cfg-o-vppr'),
      sec:       getVal('cfg-o-sec'),
      tres:      getVal('cfg-o-tres'),
      saa:       getVal('cfg-o-saa'),
    }
  };
  saveMeetingConfig();
  recalcStartTimes();
  updateMeetingPill();
  renderAgenda();
  $('settings-modal').classList.add('hidden');
}

function updateMeetingPill() {
  const c = meetingConfig;
  $('pill-club').textContent    = c.clubName    || 'Club Name';
  $('pill-meeting').textContent = c.meetingNumber ? `Meeting #${c.meetingNumber}` : 'Meeting #';
  $('pill-date').textContent    = c.meetingDate  ? formatDisplayDate(c.meetingDate) : 'Date';
  $('pill-time').textContent    = c.meetingStart ? formatTime12(c.meetingStart) : 'Start time';
}

// ==========================================================================
// RUN MODE
// ==========================================================================
function buildRunQueue() {
  // Runnable: all items (not sections). Sections with non-zero duration are skipped in queue
  // but their time is accounted for in schedule.
  return agenda.reduce((q, row, idx) => {
    if (row.type === 'item') q.push(idx);
    return q;
  }, []);
}

function startRunMode() {
  runState.runQueue = buildRunQueue();
  if (runState.runQueue.length === 0) { alert('No items in agenda to run.'); return; }
  sessionLog = [];
  runState.currentIdx = -1;
  showView('timer-view');
  advanceToNext();
}

function advanceToNext() {
  // Log previous item
  if (runState.currentIdx >= 0) {
    const prevAgendaIdx = runState.runQueue[runState.currentIdx];
    const prev = agenda[prevAgendaIdx];
    const actualSecs = runState.elapsedSeconds;
    sessionLog.push({
      activity:       prev.activity,
      speaker:        prev.speaker,
      plannedStart:   prev.startTime,
      actualStart:    runState.itemActualStart,
      plannedMinutes: prev.durationMinutes,
      actualSeconds:  actualSecs,
      status:         actualSecs <= prev.red ? 'On Time' : 'Over Time'
    });
  }

  stopTimerInterval();

  runState.currentIdx++;
  if (runState.currentIdx >= runState.runQueue.length) {
    // Done
    endSession();
    return;
  }

  const agendaIdx = runState.runQueue[runState.currentIdx];
  const cur = agenda[agendaIdx];

  // Setup timer
  runState.isRunning = true;
  runState.isPaused  = false;
  runState.elapsedSeconds  = 0;
  runState.accumulatedTime = 0;
  runState.startTime       = Date.now();
  runState.itemActualStart = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Find section this item belongs to
  const sectionLabel = findSectionFor(agendaIdx);

  // Update overlay
  $('run-section-label').textContent   = sectionLabel;
  $('immersive-speaker-badge').textContent = cur.speaker || cur.activity;
  $('immersive-preset-badge').textContent  = cur.activity;

  updatePlaylistPanel();
  updateRunDisplay(0, cur);
  startTimerInterval(cur);
  updatePauseBtn(false);

  if ($('setting-wake-lock').checked) requestWakeLock();
}

function findSectionFor(itemIdx) {
  for (let i = itemIdx - 1; i >= 0; i--) {
    if (agenda[i].type === 'section') return agenda[i].label;
  }
  return '';
}

function startTimerInterval(item) {
  const isDemoMode = $('setting-demo-mode').checked;
  const tickRate   = isDemoMode ? 1000 / 60 : 1000;

  runState.timerInterval = setInterval(() => {
    if (runState.isPaused) return;
    if (isDemoMode) {
      runState.accumulatedTime += 60 * 1000;
    } else {
      runState.accumulatedTime = Date.now() - runState.startTime;
    }
    runState.elapsedSeconds = Math.floor(runState.accumulatedTime / 1000);
    // On re-pause/resume, we reset startTime, so keep accumulating correctly
    updateRunDisplay(runState.elapsedSeconds, item);
  }, tickRate);
}

function stopTimerInterval() {
  if (runState.timerInterval) {
    clearInterval(runState.timerInterval);
    runState.timerInterval = null;
  }
}

function updateRunDisplay(seconds, item) {
  if (!item) return;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  $('display-time').textContent = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;

  const bg = $('immersive-bg');
  const statusEl = $('speech-status');

  if (!$('setting-show-timer').checked) {
    $('timer-digits-container').classList.add('hidden');
  } else {
    $('timer-digits-container').classList.remove('hidden');
  }

  if (seconds < item.green) {
    bg.className = 'immersive-beacon bg-neutral';
    statusEl.textContent = 'RUNNING';
    statusEl.style.color = 'var(--color-slate-400)';
  } else if (seconds < item.yellow) {
    bg.className = 'immersive-beacon bg-green';
    statusEl.textContent = 'GREEN';
    statusEl.style.color = '#34d399';
  } else if (seconds < item.red) {
    bg.className = 'immersive-beacon bg-yellow';
    statusEl.textContent = 'YELLOW';
    statusEl.style.color = '#fbbf24';
  } else {
    bg.className = 'immersive-beacon bg-red';
    statusEl.textContent = 'OVER TIME';
    statusEl.style.color = '#f87171';
  }
}

function updatePlaylistPanel() {
  const q = runState.runQueue;
  const ci = runState.currentIdx;
  const getLabel = (qIdx) => {
    if (qIdx < 0 || qIdx >= q.length) return '—';
    const a = agenda[q[qIdx]];
    return a ? `${a.startTime} · ${a.activity} (${a.durationMinutes}m)` : '—';
  };
  $('pl-prev-text').textContent = getLabel(ci - 1);
  $('pl-curr-text').textContent = getLabel(ci);
  $('pl-next-text').textContent = getLabel(ci + 1);
}

function bindRunControls() {
  $('btn-pause').addEventListener('click', togglePause);
  $('btn-next-item').addEventListener('click', advanceToNext);
  $('btn-end-session').addEventListener('click', endSession);
}

function togglePause() {
  if (!runState.isRunning) return;
  if (runState.isPaused) {
    runState.isPaused = false;
    runState.startTime = Date.now() - runState.accumulatedTime;
    updatePauseBtn(false);
    $('speech-status').textContent = 'RUNNING';
    if ($('setting-wake-lock').checked) requestWakeLock();
  } else {
    runState.isPaused = true;
    updatePauseBtn(true);
    $('speech-status').textContent = 'PAUSED';
    releaseWakeLock();
  }
}

function updatePauseBtn(paused) {
  const btn = $('btn-pause');
  btn.innerHTML = paused
    ? '<span class="icon">▶️</span> Resume'
    : '<span class="icon">⏸️</span> Pause';
  btn.classList.toggle('btn-secondary', paused);
  btn.classList.toggle('btn-warn', !paused);
}

function endSession() {
  stopTimerInterval();
  releaseWakeLock();
  exitFullscreenMode();
  runState.isRunning = false;

  // Log last item if running
  if (runState.currentIdx >= 0 && runState.currentIdx < runState.runQueue.length) {
    const agendaIdx = runState.runQueue[runState.currentIdx];
    const cur = agenda[agendaIdx];
    sessionLog.push({
      activity:       cur.activity,
      speaker:        cur.speaker,
      plannedStart:   cur.startTime,
      actualStart:    runState.itemActualStart,
      plannedMinutes: cur.durationMinutes,
      actualSeconds:  runState.elapsedSeconds,
      status:         runState.elapsedSeconds <= cur.red ? 'On Time' : 'Over Time'
    });
  }

  $('immersive-bg').className = 'immersive-beacon bg-neutral';
  renderReport();
  showView('report-view');
}

// ==========================================================================
// SESSION REPORT
// ==========================================================================
function renderReport() {
  const tbody = $('report-body');
  tbody.innerHTML = '';

  sessionLog.forEach(entry => {
    const actual = formatSecondsFull(entry.actualSeconds);
    const planned = `${entry.plannedMinutes}:00`;
    const statusClass = entry.status === 'On Time' ? 'tag-qualified' : 'tag-disqualified';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHTML(entry.activity)}</td>
      <td>${escapeHTML(entry.speaker)}</td>
      <td class="mono">${entry.plannedStart}</td>
      <td class="mono">${entry.actualStart}</td>
      <td class="mono">${planned}</td>
      <td class="mono">${actual}</td>
      <td><span class="tag ${statusClass}">${entry.status}</span></td>
    `;
    tbody.appendChild(tr);
  });

  $('btn-download-report').onclick = downloadReportCSV;
  $('btn-back-agenda').onclick = () => {
    showView('agenda-view');
    renderAgenda();
  };
}

function downloadReportCSV() {
  const headers = ['Activity','Speaker','Planned Start','Actual Start','Planned (min)','Actual','Status'];
  const rows = sessionLog.map(e => [
    `"${e.activity}"`, `"${e.speaker}"`,
    e.plannedStart, e.actualStart,
    e.plannedMinutes, formatSecondsFull(e.actualSeconds),
    e.status
  ]);
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  downloadFile(csv, 'session-report.csv', 'text/csv');
}

// ==========================================================================
// JSON IMPORT / EXPORT
// ==========================================================================
function bindJsonControls() {
  $('btn-download-json').addEventListener('click', downloadAgendaJSON);
  $('btn-load-json').addEventListener('click', () => $('json-file-input').click());
  $('json-file-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.agenda && Array.isArray(data.agenda)) {
          agenda = data.agenda;
          if (data.club || data.meeting) {
            meetingConfig = {
              clubName:      data.club?.name       || '',
              clubNumber:    data.club?.number      || '',
              area:          data.club?.area        || '',
              division:      data.club?.division    || '',
              district:      data.club?.district    || '',
              meetingNumber: data.meeting?.number   || '',
              meetingDate:   data.meeting?.date     || '',
              meetingStart:  data.meeting?.startTime|| '',
              venue:         data.meeting?.venue    || '',
              theme:         data.meeting?.theme    || '',
              notes:         data.meeting?.notes    || '',
              roles:         data.meeting?.roles    || {},
              officers:      data.meeting?.officers || {},
            };
            saveMeetingConfig();
          }
          renderAgenda();
          updateMeetingPill();
        } else {
          alert('Invalid JSON: missing "agenda" array.');
        }
      } catch {
        alert('Could not parse JSON file.');
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  });
}

function downloadAgendaJSON() {
  recalcStartTimes();
  const data = {
    schema_version: '1.0',
    club: {
      name:     meetingConfig.clubName,
      number:   meetingConfig.clubNumber,
      area:     meetingConfig.area,
      division: meetingConfig.division,
      district: meetingConfig.district,
    },
    meeting: {
      number:    meetingConfig.meetingNumber,
      date:      meetingConfig.meetingDate,
      startTime: meetingConfig.meetingStart,
      venue:     meetingConfig.venue,
      theme:     meetingConfig.theme,
      notes:     meetingConfig.notes,
      roles:     meetingConfig.roles,
      officers:  meetingConfig.officers,
    },
    agenda
  };
  downloadFile(JSON.stringify(data, null, 2), 'beacon-agenda.json', 'application/json');
}

// ==========================================================================
// PRINT
// ==========================================================================
function printAgenda() {
  recalcStartTimes();
  const c = meetingConfig;
  const r = c.roles    || {};
  const o = c.officers || {};

  // Build agenda rows HTML
  let agendaRowsHtml = '';
  for (const row of agenda) {
    if (row.type === 'section') {
      agendaRowsHtml += `
        <tr class="section-row-print">
          <td colspan="4"><strong>${escapeHTML(row.label)}</strong></td>
        </tr>`;
    } else {
      agendaRowsHtml += `
        <tr>
          <td>${row.startTime}</td>
          <td>${row.durationMinutes}</td>
          <td>${escapeHTML(row.activity)}</td>
          <td>${escapeHTML(row.speaker)}</td>
        </tr>`;
    }
  }

  // Build roles sidebar
  const roleRows = [
    ['TMOD', r.tmod], ['President', r.president], ['General Evaluator', r.ge],
    ['Sergeant at Arms', r.saa], ['Timer', r.timer], ['Grammarian', r.gram],
    ['Ah Counter', r.ah], ['Listening Master', r.lm], ['Table Topics Master', r.ttm],
    [`Speech 1 (${r.sp1Title||'7 min'})`, r.sp1], ['Speech 1 Evaluator', r.ev1],
    [`Speech 2 (${r.sp2Title||'7 min'})`, r.sp2], ['Speech 2 Evaluator', r.ev2],
  ].filter(([, v]) => v).map(([label, val]) =>
    `<tr><td><strong>${label}</strong></td><td>${escapeHTML(val)}</td></tr>`
  ).join('');

  const officerRows = [
    ['President', o.president], ['VP Education', o.vpe], ['VP Membership', o.vpm],
    ['VP Public Relations', o.vppr], ['Secretary', o.sec], ['Treasurer', o.tres],
    ['Sergeant at Arms', o.saa],
  ].filter(([, v]) => v).map(([label, val]) =>
    `<tr><td><strong>${label}</strong></td><td>${escapeHTML(val)}</td></tr>`
  ).join('');

  const sidebarHtml = (roleRows || officerRows) ? `
    <div class="print-sidebar">
      ${roleRows ? `<table class="sidebar-table"><caption><strong>Meeting Roles</strong></caption><tbody>${roleRows}</tbody></table>` : ''}
      ${officerRows ? `<table class="sidebar-table" style="margin-top:12px"><caption><strong>Club Officers</strong></caption><tbody>${officerRows}</tbody></table>` : ''}
    </div>` : '';

  const dateStr  = c.meetingDate ? formatDisplayDate(c.meetingDate) : '';
  const startStr = c.meetingStart ? formatTime12(c.meetingStart) : '';

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Agenda – ${c.clubName || 'Toastmasters'}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 10pt; margin: 10mm; color: #000; }
  h1 { text-align:center; font-size:14pt; margin-bottom:2px; }
  .sub { text-align:center; font-size:9pt; margin-bottom:2px; }
  .meta { text-align:center; font-size:8pt; margin-bottom:4px; }
  .theme { text-align:center; font-style:italic; font-size:9pt; color:#8B0000; margin-bottom:8px; }
  .print-body { display:flex; gap:12px; }
  .print-main { flex:2; }
  .print-sidebar { flex:1; }
  table { width:100%; border-collapse:collapse; font-size:8.5pt; }
  th { background:#ddd; font-weight:bold; padding:3px 5px; border:1px solid #999; text-align:left; }
  td { padding:2px 5px; border:1px solid #ccc; vertical-align:top; }
  .section-row-print td { background:#eee; font-weight:bold; text-align:center; border:1px solid #999; padding:3px; }
  .sidebar-table { width:100%; border-collapse:collapse; font-size:8pt; }
  .sidebar-table caption { font-weight:bold; font-size:9pt; text-align:left; border:1px solid #999; background:#ddd; padding:2px 4px; }
  .sidebar-table td { padding:2px 4px; border:1px solid #ccc; }
  .footer { margin-top:8px; font-size:7.5pt; font-style:italic; text-align:center; }
  @media print { body { margin:8mm; } }
</style>
</head>
<body>
  <h1>${escapeHTML(c.clubName || 'Toastmasters Club')}${c.clubNumber ? ` (#${escapeHTML(c.clubNumber)})` : ''}</h1>
  ${(c.area || c.division || c.district) ? `<div class="sub">AREA ${c.area}, DIVISION ${c.division}, DISTRICT ${c.district}</div>` : ''}
  <div class="meta">
    Meeting #${c.meetingNumber || '—'} &nbsp;|&nbsp;
    Date: ${dateStr || '—'} &nbsp;|&nbsp;
    Time: ${startStr || '—'}
    ${c.venue ? ` &nbsp;|&nbsp; Venue: ${escapeHTML(c.venue)}` : ''}
    ${c.notes ? `<br>${escapeHTML(c.notes)}` : ''}
  </div>
  ${c.theme ? `<div class="theme">Theme: ${escapeHTML(c.theme)}</div>` : ''}
  <div class="print-body">
    <div class="print-main">
      <table>
        <thead><tr><th>Time</th><th>Min</th><th>Activity</th><th>Participants</th></tr></thead>
        <tbody>${agendaRowsHtml}</tbody>
      </table>
    </div>
    ${sidebarHtml}
  </div>
  <div class="footer">Club Mission: The mission of a Toastmasters club is to provide a mutually supportive and positive learning environment in which each member has the opportunity to develop communication and leadership skills, which in turn foster self-confidence and personal growth.</div>
</body>
</html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 500);
}

// ==========================================================================
// VIEW SWITCHING
// ==========================================================================
function showView(viewId) {
  ['agenda-view', 'timer-view', 'report-view'].forEach(id => {
    const el = $(id);
    if (el) {
      el.classList.toggle('view-active', id === viewId);
      el.classList.toggle('view-hidden', id !== viewId);
    }
  });
  // Show/hide header buttons based on view
  const agendaOnly = ['btn-settings','btn-load-json','btn-download-json','btn-print-agenda','btn-add-item','btn-add-section','btn-add-ps','btn-run-agenda'];
  const inAgenda = viewId === 'agenda-view';
  agendaOnly.forEach(id => {
    const el = $(id);
    if (el) el.style.display = inAgenda ? '' : 'none';
  });
}

// ==========================================================================
// WAKE LOCK
// ==========================================================================
function checkWakeLockSupport() {
  const badge = $('wakelock-status');
  if ('wakeLock' in navigator) {
    badge.classList.remove('badge-inactive');
    badge.classList.add('badge-secondary');
    badge.innerHTML = '<span class="badge-dot"></span> Wake Lock: Supported';
  } else {
    badge.innerHTML = '⚠️ Wake Lock: Unsupported';
    const wl = $('setting-wake-lock');
    if (wl) { wl.checked = false; wl.disabled = true; }
  }
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || !$('setting-wake-lock')?.checked) return;
  try {
    runState.wakeLockSentinel = await navigator.wakeLock.request('screen');
    const badge = $('wakelock-status');
    badge.classList.remove('badge-secondary','badge-inactive');
    badge.classList.add('badge-active');
    badge.innerHTML = '<span class="badge-dot"></span> Wake Lock: Active';
    runState.wakeLockSentinel.addEventListener('release', () => {
      badge.classList.remove('badge-active');
      badge.classList.add('badge-secondary');
      badge.innerHTML = '<span class="badge-dot"></span> Wake Lock: Idle';
    });
  } catch(err) {
    console.error('Wake Lock failed:', err);
  }
}

function releaseWakeLock() {
  if (runState.wakeLockSentinel) {
    runState.wakeLockSentinel.release();
    runState.wakeLockSentinel = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (runState.wakeLockSentinel !== null && document.visibilityState === 'visible'
      && runState.isRunning && !runState.isPaused) {
    requestWakeLock();
  }
});

// ==========================================================================
// FULLSCREEN
// ==========================================================================
function bindFullscreen() {
  $('btn-toggle-fullscreen').addEventListener('click', toggleFullscreenMode);
  document.addEventListener('fullscreenchange', handleFullscreenChange);
}

function toggleFullscreenMode() {
  if (!document.fullscreenElement) {
    $('app-container').requestFullscreen().catch(console.error);
  } else {
    exitFullscreenMode();
  }
}
function exitFullscreenMode() {
  if (document.fullscreenElement) document.exitFullscreen();
}
function handleFullscreenChange() {
  const badge = $('fullscreen-badge');
  const btn   = $('btn-toggle-fullscreen');
  if (document.fullscreenElement) {
    badge.classList.replace('badge-secondary','badge-active');
    badge.innerHTML = '🖥️ Immersive Fullscreen';
    btn.innerHTML   = '🖥️ Exit Fullscreen';
  } else {
    badge.classList.replace('badge-active','badge-secondary');
    badge.innerHTML = '🖥️ Window Mode';
    btn.innerHTML   = '🖥️ Fullscreen';
  }
}

// ==========================================================================
// KEYBOARD
// ==========================================================================
function handleKeyPress(e) {
  if (!runState.isRunning) return;
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  if (e.code === 'ArrowRight') { e.preventDefault(); advanceToNext(); }
}

// ==========================================================================
// LOCAL STORAGE
// ==========================================================================
function saveAgendaToStorage() {
  localStorage.setItem('beacon_agenda', JSON.stringify(agenda));
}
function loadAgendaFromStorage() {
  try {
    const raw = localStorage.getItem('beacon_agenda');
    if (raw) agenda = JSON.parse(raw);
  } catch { agenda = []; }
}
function saveMeetingConfig() {
  localStorage.setItem('beacon_meeting_config', JSON.stringify(meetingConfig));
}
function loadMeetingConfig() {
  try {
    const raw = localStorage.getItem('beacon_meeting_config');
    if (raw) return JSON.parse(raw);
  } catch {}
  // defaults
  const today = new Date();
  return {
    clubName: '', clubNumber: '', area: '', division: '', district: '',
    meetingNumber: '', meetingDate: today.toISOString().split('T')[0],
    meetingStart: '13:30', venue: '', theme: '', notes: '',
    roles: {}, officers: {}
  };
}

// ==========================================================================
// HELPERS
// ==========================================================================
function formatSecondsFull(secs) {
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function parseThresholdStr(str) {
  if (!str || !str.includes(':')) return parseInt(str) * 60 || 0;
  const [m, s] = str.split(':').map(Number);
  return (m || 0) * 60 + (s || 0);
}

function formatDisplayDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric', weekday:'long' });
  } catch { return dateStr; }
}

function formatTime12(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h % 12 || 12;
  return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str).replace(/[&<>'"]/g, t => ({
    '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'
  }[t] || t));
}
