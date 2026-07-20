'use strict';

/* ============================================================
   ProAgri Tickets Admin — SPA
   Board (kanban) + Calendar (month grid) + Detail drawer.
   No framework, no build step. Requires /config.js loaded first.
   ============================================================ */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
var state = {
  tickets:         [],          // all tickets from GET /api/tickets
  view:            'board',     // 'board' | 'calendar' | 'overview'
  calYear:         new Date().getFullYear(),
  calMonth:        new Date().getMonth(), // 0-indexed
  openId:          null,        // ticket id in detail drawer
  draggingId:      null,        // id of card being dragged
  loading:         true,
  error:           null,
  overviewContent: null,        // cached overview markdown
  overviewLoading: false,
};

// Agri360 base URL for building attachment URLs (set by /config.js).
var agri360Base = (window.APP_CONFIG && window.APP_CONFIG.agri360Base) || 'https://agri360.proagrihub.com';

// Board mode: '/managers' shows only manager-channel tickets with 3 traffic-light
// columns; everything else is the main (dev) board with the original 4 columns.
var IS_MANAGER_BOARD = location.pathname.indexOf('/managers') === 0;

// Cached manager list (for the assignee dropdown on the manager board).
var managersList = null;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
var $ = function (id) { return document.getElementById(id); };

var els = {
  main:          $('main'),
  loading:       $('loading-state'),
  errorState:    $('error-state'),
  boardView:     $('board-view'),
  calView:       $('calendar-view'),
  overviewView:  $('overview-view'),
  btnBoard:      $('btn-board'),
  btnCalendar:   $('btn-calendar'),
  btnOverview:   $('btn-overview'),
  btnNew:        $('btn-new'),
  userName:      $('user-name'),
  drawer:        $('detail-drawer'),
  drawerOverlay: $('drawer-overlay'),
  drawerTitle:   $('drawer-title'),
  drawerBody:    $('drawer-body'),
  drawerClose:   $('drawer-close'),
  modalOverlay:  $('modal-overlay'),
  modalClose:    $('modal-close'),
  modalCancel:   $('modal-cancel'),
  modalSubmit:   $('modal-submit'),
  newForm:       $('new-ticket-form'),
  toastContainer: $('toast-container'),
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', function () {
  if (IS_MANAGER_BOARD) {
    document.body.classList.add('managers-board');
    document.title = 'ProAgri Tickets — Managers';
  }
  setupEventListeners();
  loadTickets();
});

function setupEventListeners() {
  // View toggle
  els.btnBoard.addEventListener('click',    function () { switchView('board'); });
  els.btnCalendar.addEventListener('click', function () { switchView('calendar'); });
  els.btnOverview.addEventListener('click', function () { switchView('overview'); });

  // New ticket button
  els.btnNew.addEventListener('click', openNewModal);

  // Drawer close
  els.drawerClose.addEventListener('click',   closeDrawer);
  els.drawerOverlay.addEventListener('click', closeDrawer);

  // Modal close/cancel
  els.modalClose.addEventListener('click',  closeModal);
  els.modalCancel.addEventListener('click', closeModal);
  els.modalOverlay.addEventListener('click', function (e) {
    if (e.target === els.modalOverlay) closeModal();
  });

  // New ticket form submit
  els.newForm.addEventListener('submit', submitNewTicket);

  // Keyboard: Escape closes drawer / modal
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!els.modalOverlay.classList.contains('hidden')) { closeModal(); return; }
    if (!els.drawer.classList.contains('hidden'))       { closeDrawer(); }
  });
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------
async function loadTickets() {
  setLoading(true);
  // Scope to the board's channel: manager board sees only manager tickets,
  // main board only dev tickets. (server.js proxies the query through.)
  var channel = IS_MANAGER_BOARD ? 'manager' : 'dev';
  try {
    var res  = await fetch('/api/tickets?channel=' + channel);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    state.tickets = data.tickets || [];
    state.error   = null;
  } catch (err) {
    state.error = 'Could not load tickets: ' + err.message;
  } finally {
    setLoading(false);
    render();
  }
}

// Fetch (and cache) the manager list for the assignee dropdown. Managers rarely
// change, so we cache after the first successful load. Returns [] on failure.
async function loadManagers() {
  if (managersList) return managersList;
  try {
    var res  = await fetch('/api/tickets/managers');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    managersList = data.managers || [];
  } catch (err) {
    managersList = [];
  }
  return managersList;
}

function setLoading(on) {
  state.loading = on;
  els.loading.classList.toggle('hidden', !on);
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------
function switchView(view) {
  state.view = view;
  els.btnBoard.classList.toggle('active',    view === 'board');
  els.btnCalendar.classList.toggle('active', view === 'calendar');
  els.btnOverview.classList.toggle('active', view === 'overview');
  render();
}

function render() {
  els.errorState.classList.add('hidden');
  els.boardView.classList.add('hidden');
  els.calView.classList.add('hidden');
  els.overviewView.classList.add('hidden');

  if (state.error) {
    els.errorState.classList.remove('hidden');
    els.errorState.textContent = state.error;
    return;
  }
  if (state.loading) return;

  if (state.view === 'board') {
    els.boardView.classList.remove('hidden');
    renderBoard();
  } else if (state.view === 'calendar') {
    els.calView.classList.remove('hidden');
    renderCalendar();
  } else {
    els.overviewView.classList.remove('hidden');
    renderOverview();
  }
}

// ---------------------------------------------------------------------------
// Board view
// ---------------------------------------------------------------------------
// Column set depends on the board. The manager board uses 3 traffic-light
// columns; the main (dev) board keeps the original 4. Every place that needs
// the status set (board render, drawer status select, calendar day modal)
// reads from COLUMNS so nothing hardcodes the 4.
var COLUMNS = IS_MANAGER_BOARD
  ? [
      { status: 'open',        label: 'Open' },
      { status: 'in_progress', label: 'In Progress' },
      { status: 'done',        label: 'Done' },
    ]
  : [
      { status: 'new',         label: 'New' },
      { status: 'triage',      label: 'Triage' },
      { status: 'in_progress', label: 'In Progress' },
      { status: 'done',        label: 'Done' },
    ];

function renderBoard() {
  var html = '<div class="board">';
  COLUMNS.forEach(function (col) {
    var cards = state.tickets.filter(function (t) { return t.status === col.status; });
    html += buildColumn(col, cards);
  });
  html += '</div>';
  els.boardView.innerHTML = html;

  // Wire DnD
  els.boardView.querySelectorAll('.ticket-card').forEach(function (card) {
    card.addEventListener('click',      onCardClick);
    card.addEventListener('dragstart',  onDragStart);
    card.addEventListener('dragend',    onDragEnd);
  });
  els.boardView.querySelectorAll('.col-cards').forEach(function (zone) {
    zone.addEventListener('dragover',   onDragOver);
    zone.addEventListener('dragleave',  onDragLeave);
    zone.addEventListener('drop',       onDrop);
  });
}

function buildColumn(col, cards) {
  var cardsHtml = cards.length
    ? cards.map(buildCard).join('')
    : '<div class="col-empty">No tickets</div>';

  return (
    '<div class="board-col" data-status="' + col.status + '">' +
      '<div class="col-header">' +
        '<span class="col-title">' + col.label + '</span>' +
        '<span class="col-count">' + cards.length + '</span>' +
      '</div>' +
      '<div class="col-cards" data-status="' + col.status + '">' +
        cardsHtml +
      '</div>' +
    '</div>'
  );
}

function buildCard(t) {
  var deadlineBadge = t.deadline ? buildDeadlineBadge(t.deadline) : '';
  var completedBadge = (t.status === 'done' && t.completedAt) ? buildCompletedBadge(t.completedAt) : '';
  var attachCount   = t.attachmentCount || 0;
  var attIcon = attachCount
    ? '<span class="attachment-badge"><svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8 4a3 3 0 00-3 3v4a5 5 0 0010 0V7a1 1 0 112 0v4a7 7 0 11-14 0V7a5 5 0 0110 0v4a3 3 0 11-6 0V7a1 1 0 012 0v4a1 1 0 102 0V7a3 3 0 00-3-3z" clip-rule="evenodd"/></svg>' + attachCount + '</span>'
    : '';

  return (
    '<div class="ticket-card" draggable="true" data-id="' + t.id + '">' +
      '<div class="card-top">' +
        '<span class="card-title">' + esc(t.title || '#' + t.id) + '</span>' +
        '<span class="card-id">#' + t.id + '</span>' +
      '</div>' +
      '<div class="card-meta">' +
        buildTypeBadge(t.type) +
        buildPriorityPill(t.priority) +
        (t.aiCategory ? '<span class="badge badge-ai">' + esc(t.aiCategory) + '</span>' : '') +
        deadlineBadge +
        completedBadge +
      '</div>' +
      '<div class="card-footer">' +
        '<span class="card-submitter">' +
          (t.submitterName ? 'raised by ' + esc(t.submitterName) : '') +
          (t.assigneeName ? '<span class="card-assignee">&rarr; ' + esc(t.assigneeName) + '</span>' : '') +
        '</span>' +
        attIcon +
      '</div>' +
    '</div>'
  );
}

// ---------------------------------------------------------------------------
// DnD
// ---------------------------------------------------------------------------
function onCardClick(e) {
  // Don't open drawer if we just finished a drag.
  if (state.draggingId != null) return;
  var id = parseInt(e.currentTarget.dataset.id, 10);
  openDrawer(id);
}

function onDragStart(e) {
  state.draggingId = parseInt(e.currentTarget.dataset.id, 10);
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(state.draggingId));
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  // Clear drag-over highlights.
  document.querySelectorAll('.col-cards.drag-over').forEach(function (el) {
    el.classList.remove('drag-over');
  });
  // Delay clearing draggingId so the click handler ignores the mouseup.
  setTimeout(function () { state.draggingId = null; }, 50);
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}

function onDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

async function onDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  var targetStatus = e.currentTarget.dataset.status;
  var id = state.draggingId;
  if (!id || !targetStatus) return;

  var ticket = state.tickets.find(function (t) { return t.id === id; });
  if (!ticket || ticket.status === targetStatus) return;

  // Optimistic update.
  var oldStatus    = ticket.status;
  ticket.status    = targetStatus;
  renderBoard();

  try {
    var res = await fetch('/api/tickets/' + id, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status: targetStatus }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    // Sync with server response.
    Object.assign(ticket, data.ticket);
    renderBoard();
    toast('Status updated', 'success');
  } catch (err) {
    // Revert.
    ticket.status = oldStatus;
    renderBoard();
    toast('Could not update status: ' + err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Calendar view
// ---------------------------------------------------------------------------
var MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];
var DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function renderCalendar() {
  var y = state.calYear;
  var m = state.calMonth;

  var header =
    '<div class="calendar-header">' +
      '<button class="cal-nav-btn" id="cal-prev" aria-label="Previous month">' +
        '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>' +
      '</button>' +
      '<h2>' + MONTH_NAMES[m] + ' ' + y + '</h2>' +
      '<button class="cal-nav-btn" id="cal-next" aria-label="Next month">' +
        '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg>' +
      '</button>' +
    '</div>';

  var weekdaysHtml = DAY_NAMES.map(function (d) {
    return '<div class="cal-weekday">' + d + '</div>';
  }).join('');

  // Build day grid.
  var firstDay  = new Date(y, m, 1).getDay(); // 0=Sun
  var daysInMonth = new Date(y, m + 1, 0).getDate();
  var today     = new Date();
  var todayStr  = isoDate(today);

  // Map tickets to day numbers in this month. A done ticket lands on the day
  // it was completed (completedAt); everything else lands on its deadline.
  // So the calendar shows both what's coming up and what actually got done when.
  var byDay = {};
  function placeOn(d, entry) {
    if (isNaN(d.getTime())) return;
    if (d.getFullYear() !== y || d.getMonth() !== m) return;
    var day = d.getDate();
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(entry);
  }
  state.tickets.forEach(function (t) {
    if (t.status === 'done' && t.completedAt) {
      placeOn(new Date(t.completedAt), { t: t, kind: 'done' });
    } else if (t.deadline) {
      placeOn(new Date(t.deadline + 'T00:00:00'), { t: t, kind: 'deadline' });
    }
  });

  var daysHtml = '';
  // Prefix cells from previous month.
  var prevDaysInMonth = new Date(y, m, 0).getDate();
  for (var i = 0; i < firstDay; i++) {
    var prevDay = prevDaysInMonth - firstDay + i + 1;
    daysHtml += '<div class="cal-day other-month"><div class="cal-day-num">' + prevDay + '</div></div>';
  }
  // This month's cells.
  for (var day = 1; day <= daysInMonth; day++) {
    var dateStr = y + '-' + pad2(m + 1) + '-' + pad2(day);
    var isToday = dateStr === todayStr;
    var dayTickets = byDay[day] || [];
    var maxShow = 3;
    var visible = dayTickets.slice(0, maxShow);
    var extra   = dayTickets.length - maxShow;

    var chipsHtml = visible.map(function (entry) {
      var t = entry.t;
      var label = esc(t.title || '#' + t.id);
      if (entry.kind === 'done') {
        return (
          '<div class="cal-ticket-chip cal-chip-done" data-id="' + t.id + '" title="Done: ' + label + '">' +
            '<svg class="chip-check" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>' +
            label +
          '</div>'
        );
      }
      var dot = priorityColor(t.priority);
      return (
        '<div class="cal-ticket-chip" data-id="' + t.id + '" title="' + label + '">' +
          '<span class="chip-dot" style="background:' + dot + '"></span>' +
          label +
        '</div>'
      );
    }).join('');

    if (extra > 0) chipsHtml += '<div class="cal-more">+' + extra + ' more</div>';

    daysHtml += (
      '<div class="cal-day' + (isToday ? ' today' : '') + '" data-date="' + dateStr + '">' +
        '<div class="cal-day-num">' + day + '</div>' +
        chipsHtml +
      '</div>'
    );
  }
  // Suffix cells to fill last row.
  var totalCells = firstDay + daysInMonth;
  var remaining  = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (var j = 1; j <= remaining; j++) {
    daysHtml += '<div class="cal-day other-month"><div class="cal-day-num">' + j + '</div></div>';
  }

  els.calView.innerHTML =
    header +
    '<div class="calendar-grid-wrap">' +
      '<div class="cal-weekdays">' + weekdaysHtml + '</div>' +
      '<div class="cal-body">' + daysHtml + '</div>' +
    '</div>';

  // Wire navigation.
  $('cal-prev').addEventListener('click', function () {
    if (state.calMonth === 0) { state.calMonth = 11; state.calYear--; }
    else state.calMonth--;
    renderCalendar();
  });
  $('cal-next').addEventListener('click', function () {
    if (state.calMonth === 11) { state.calMonth = 0; state.calYear++; }
    else state.calMonth++;
    renderCalendar();
  });

  // Wire ticket chips.
  els.calView.querySelectorAll('.cal-ticket-chip[data-id]').forEach(function (chip) {
    chip.addEventListener('click', function (e) {
      e.stopPropagation();
      openDrawer(parseInt(chip.dataset.id, 10));
    });
  });

  // Wire day cells: clicking a day (or its "+N more") opens a modal listing
  // ALL that day's tickets. A chip click is handled above (and stops here),
  // so it opens the drawer directly. Empty days do nothing.
  els.calView.querySelectorAll('.cal-day:not(.other-month)').forEach(function (cell) {
    cell.addEventListener('click', function () {
      var numEl = cell.querySelector('.cal-day-num');
      var dayNum = numEl ? parseInt(numEl.textContent, 10) : NaN;
      var dayEntries = byDay[dayNum] || [];
      if (!dayEntries.length) return;
      openDayModal(cell.dataset.date, dayEntries);
    });
  });
}

// Modal listing every ticket on a single calendar day. `entries` are
// { t, kind } wrappers — kind 'done' means it landed here by completion date.
function openDayModal(dateStr, entries) {
  // Derive labels from the active column set so this isn't hardcoded to 4.
  var statusLabels = {};
  COLUMNS.forEach(function (c) { statusLabels[c.status] = c.label; });
  var heading = dateStr;
  var d = new Date(dateStr + 'T00:00:00');
  if (!isNaN(d.getTime())) {
    heading = DAY_NAMES[d.getDay()] + ', ' + MONTH_NAMES[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  var rows = entries.map(function (entry) {
    var t = entry.t;
    var statusKey = t.status || 'new';
    var statusTxt = statusLabels[statusKey] || statusKey;
    var dateBadge = entry.kind === 'done'
      ? '<span class="badge badge-completed">Done ' + esc(isoDate(new Date(t.completedAt))) + '</span>'
      : (t.deadline ? '<span class="badge badge-deadline">Due ' + esc(t.deadline) + '</span>' : '');
    var meta =
      '<span class="day-row-status status-' + esc(statusKey) + '">' + esc(statusTxt) + '</span>' +
      buildPriorityPill(t.priority) +
      dateBadge;
    return (
      '<button class="day-row" type="button" data-id="' + t.id + '">' +
        '<span class="day-row-title">' + esc(t.title || '#' + t.id) + '</span>' +
        '<span class="day-row-meta">' + meta + '</span>' +
      '</button>'
    );
  }).join('');

  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay day-modal-overlay';
  overlay.innerHTML =
    '<div class="modal day-modal" role="dialog" aria-modal="true" aria-labelledby="day-modal-title">' +
      '<div class="modal-header">' +
        '<h2 id="day-modal-title">' + esc(heading) + ' · ' + entries.length + ' ticket' + (entries.length === 1 ? '' : 's') + '</h2>' +
        '<button class="modal-close" id="day-modal-close" type="button" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="modal-body day-modal-body">' + rows + '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  function close() {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) close();
  });
  overlay.querySelector('#day-modal-close').addEventListener('click', close);
  overlay.querySelectorAll('.day-row[data-id]').forEach(function (row) {
    row.addEventListener('click', function () {
      close();
      openDrawer(parseInt(row.dataset.id, 10));
    });
  });
}

// ---------------------------------------------------------------------------
// System Overview view
// ---------------------------------------------------------------------------
async function renderOverview() {
  // Show cached content immediately while (re)fetching.
  if (state.overviewContent) {
    displayOverview(state.overviewContent, state.overviewUpdatedAt);
  } else {
    els.overviewView.innerHTML = '<div class="loading-center"><div class="spinner"></div><p>Loading overview…</p></div>';
  }

  if (state.overviewLoading) return;
  state.overviewLoading = true;

  try {
    var res  = await fetch('/api/overview');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    var ov   = data.overview || {};
    state.overviewContent   = ov.content   || '';
    state.overviewUpdatedAt = ov.updatedAt || null;
    displayOverview(state.overviewContent, state.overviewUpdatedAt);
  } catch (err) {
    if (!state.overviewContent) {
      els.overviewView.innerHTML = '<div class="error-center">Could not load overview: ' + esc(err.message) + '</div>';
    }
    // If we had cached content, keep it displayed; toast the error.
    else { toast('Overview refresh failed: ' + err.message, 'error'); }
  } finally {
    state.overviewLoading = false;
  }
}

function displayOverview(content, updatedAt) {
  var updatedLine = updatedAt
    ? '<p class="overview-updated">Last updated: ' + esc(new Date(updatedAt).toLocaleString()) + '</p>'
    : '';
  els.overviewView.innerHTML =
    '<div class="overview-wrap">' +
      '<div class="overview-header">' +
        '<h2 class="overview-title">System Overview</h2>' +
        updatedLine +
        '<button id="overview-refresh" class="btn-secondary">Refresh</button>' +
      '</div>' +
      '<pre class="overview-pre">' + esc(content) + '</pre>' +
    '</div>';
  $('overview-refresh').addEventListener('click', function () {
    state.overviewContent = null; // force re-fetch + re-display
    renderOverview();
  });
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------
async function openDrawer(id) {
  state.openId = id;
  els.drawer.classList.remove('hidden');
  els.drawerOverlay.classList.remove('hidden');
  requestAnimationFrame(function () { els.drawer.classList.add('open'); });

  // Show spinner while loading detail.
  els.drawerTitle.textContent = 'Loading…';
  els.drawerBody.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';

  try {
    var res  = await fetch('/api/tickets/' + id);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    // Manager board: make sure the assignee options are available first.
    if (IS_MANAGER_BOARD) await loadManagers();
    renderDrawer(data.ticket);
  } catch (err) {
    els.drawerTitle.textContent = 'Error';
    els.drawerBody.innerHTML = '<div class="error-center">Could not load ticket: ' + esc(err.message) + '</div>';
  }
}

function closeDrawer() {
  els.drawer.classList.remove('open');
  els.drawerOverlay.classList.add('hidden');
  setTimeout(function () {
    els.drawer.classList.add('hidden');
    state.openId = null;
  }, 260);
}

function renderDrawer(t) {
  els.drawerTitle.textContent = t.title || ('Ticket #' + t.id);

  var attachments = t.attachments || [];
  var screenshots = attachments.filter(function (a) { return a.kind === 'screenshot'; });
  var voiceFiles  = attachments.filter(function (a) { return a.kind === 'voice'; });
  var files       = attachments.filter(function (a) { return a.kind !== 'screenshot' && a.kind !== 'voice'; });

  var ctx    = t.context || {};
  var ctxUser = ctx.user || {};

  // ── Editable meta fields ──────────────────────────────────
  // Status options track the active board's column set (3 vs 4).
  var statusOptions = COLUMNS.map(function (c) {
    return { value: c.status, label: c.label };
  });
  var priorityOptions = [
    { value: 'low',    label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high',   label: 'High' },
    { value: 'urgent', label: 'Urgent' },
  ];

  var html = '';

  // Meta grid with editable status/priority/deadline.
  html += '<div class="drawer-meta-grid">';
  html += '<div class="drawer-field">';
  html += '<label for="dr-status">Status</label>';
  html += '<select id="dr-status">' + statusOptions.map(function (o) {
    return '<option value="' + o.value + '"' + (t.status === o.value ? ' selected' : '') + '>' + o.label + '</option>';
  }).join('') + '</select>';
  html += '</div>';

  html += '<div class="drawer-field">';
  html += '<label for="dr-priority">Priority</label>';
  html += '<select id="dr-priority">' + priorityOptions.map(function (o) {
    return '<option value="' + o.value + '"' + (t.priority === o.value ? ' selected' : '') + '>' + o.label + '</option>';
  }).join('') + '</select>';
  html += '</div>';

  html += '<div class="drawer-field">';
  html += '<label for="dr-deadline">Deadline</label>';
  html += '<input id="dr-deadline" type="date" value="' + esc(t.deadline || '') + '" />';
  html += '</div>';

  // Assignee — manager board only. Options = Unassigned + one per manager.
  if (IS_MANAGER_BOARD) {
    var currentAssignee = (t.assigneeId != null) ? String(t.assigneeId) : '';
    html += '<div class="drawer-field">';
    html += '<label for="dr-assignee">Assignee</label>';
    html += '<select id="dr-assignee">';
    html += '<option value=""' + (currentAssignee === '' ? ' selected' : '') + '>Unassigned</option>';
    (managersList || []).forEach(function (m) {
      var val = String(m.id);
      html += '<option value="' + esc(val) + '"' + (currentAssignee === val ? ' selected' : '') + '>' + esc(m.name || m.email || ('#' + val)) + '</option>';
    });
    html += '</select>';
    html += '</div>';
  }

  html += '<div class="drawer-field">';
  html += '<label>Type</label>';
  html += '<div>' + buildTypeBadge(t.type) + '</div>';
  html += '</div>';

  if (t.completedAt) {
    html += '<div class="drawer-field">';
    html += '<label>Completed</label>';
    html += '<div>' + esc(isoDate(new Date(t.completedAt))) + '</div>';
    html += '</div>';
  }

  html += '</div>'; // .drawer-meta-grid

  // Save button.
  html += '<div class="drawer-save-row"><button id="dr-save" class="btn-primary">Save changes</button></div>';

  html += '<hr class="divider" />';

  // Body / description.
  html += '<div>';
  html += '<div class="drawer-section-title">Description</div>';
  html += '<div class="drawer-body-text">' + esc(t.body || '') + '</div>';
  html += '</div>';

  // Submitter + context.
  if (t.submitterName || ctx.url) {
    html += '<div>';
    html += '<div class="drawer-section-title">Submitted by</div>';
    html += '<div class="context-block">';
    if (t.submitterName) html += '<div><span class="context-label">Name: </span>' + esc(t.submitterName) + '</div>';
    if (ctx.url) {
      // If the widget captured an appState snapshot, build the link to carry it
      // to Agri360 via ?tkt_restore= so the app restores the exact screen. The
      // encoding here MUST stay the exact inverse of the Agri360 decoder:
      //   JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(decodeURIComponent(p)), c=>c.charCodeAt(0))))
      // Old tickets / embed submissions carry no appState → fall back to ctx.url.
      var pageHref = ctx.url;
      if (ctx.appState && typeof ctx.appState === 'object') {
        var _base = (window.APP_CONFIG && window.APP_CONFIG.agri360Base) || '';
        if (_base) {
          var _enc = encodeURIComponent(btoa(String.fromCharCode.apply(null, new TextEncoder().encode(JSON.stringify(ctx.appState)))));
          pageHref = _base.replace(/\/$/, '') + '/?tkt_restore=' + _enc;
        }
      }
      html += '<div><span class="context-label">Page: </span><a href="' + esc(pageHref) + '" target="_blank" rel="noopener">Open the page</a></div>';
    }
    if (t.pageSlug) html += '<div><span class="context-label">Slug: </span>' + esc(t.pageSlug) + '</div>';
    if (ctx.viewport) html += '<div><span class="context-label">Viewport: </span>' + esc(ctx.viewport.w) + '×' + esc(ctx.viewport.h) + '</div>';
    if (ctx.userAgent) html += '<div><span class="context-label">UA: </span>' + esc(ctx.userAgent) + '</div>';
    html += '</div>';
    html += '</div>';
  }

  // AI block.
  if (t.aiSummary || t.aiCategory || t.aiPriority) {
    html += '<div class="ai-block">';
    html += '<h4>AI triage</h4>';
    if (t.aiSummary) html += '<p>' + esc(t.aiSummary) + '</p>';
    html += '<div class="ai-meta">';
    if (t.aiCategory) html += '<span class="badge badge-ai">' + esc(t.aiCategory) + '</span>';
    if (t.aiPriority) html += buildPriorityPill(t.aiPriority);
    html += '</div>';
    html += '</div>';
  }

  // Screenshots gallery.
  if (screenshots.length) {
    html += '<div>';
    html += '<div class="drawer-section-title">Screenshots (' + screenshots.length + ')</div>';
    html += '<div class="screenshots-gallery">';
    screenshots.forEach(function (a) {
      var src = agri360Base + a.url;
      html += (
        '<div class="screenshot-thumb" data-src="' + esc(src) + '" title="' + esc(a.filename || '') + '">' +
          '<img src="' + esc(src) + '" alt="' + esc(a.filename || 'screenshot') + '" loading="lazy" />' +
        '</div>'
      );
    });
    html += '</div>';
    html += '</div>';
  }

  // Voice recordings.
  if (voiceFiles.length) {
    html += '<div>';
    html += '<div class="drawer-section-title">Voice notes (' + voiceFiles.length + ')</div>';
    html += '<div class="voice-list">';
    voiceFiles.forEach(function (a) {
      var src = esc(agri360Base + a.url);
      html += (
        '<div class="voice-item">' +
          '<span class="voice-label">' + esc(a.filename || 'voice note') + '</span>' +
          '<audio class="voice-audio" controls preload="metadata" src="' + src + '"></audio>' +
        '</div>'
      );
    });
    html += '</div>';
    html += '</div>';
  }

  // Clarification thread.
  var clarification = t.clarification;
  if (clarification && clarification.length) {
    html += '<div>';
    html += '<div class="drawer-section-title">Clarification</div>';
    html += '<div class="clarification-thread">';
    clarification.forEach(function (round) {
      // Assistant message bubble.
      if (round.assistantMessage) {
        html += '<div class="clarif-bubble clarif-assistant">' + esc(round.assistantMessage) + '</div>';
      }
      // Questions with selected answers (if answered).
      var answers = round.answers || [];
      var answerMap = {};
      answers.forEach(function (ans) { answerMap[ans.id] = ans.selected || []; });

      var questions = round.questions || [];
      if (questions.length) {
        html += '<div class="clarif-questions">';
        questions.forEach(function (q) {
          html += '<div class="clarif-question">';
          html += '<div class="clarif-q-text">' + esc(q.question) + '</div>';
          var selected = answerMap[q.id] || [];
          if (selected.length) {
            // Show the selected answers as chips.
            html += '<div class="clarif-answers">';
            selected.forEach(function (sel) {
              html += '<span class="clarif-answer-chip">' + esc(sel) + '</span>';
            });
            html += '</div>';
          } else if (q.options && q.options.length) {
            // No answer yet — show greyed-out options.
            html += '<div class="clarif-answers clarif-unanswered">';
            q.options.forEach(function (opt) {
              html += '<span class="clarif-option-chip">' + esc(opt) + '</span>';
            });
            html += '</div>';
          }
          html += '</div>'; // .clarif-question
        });
        html += '</div>'; // .clarif-questions
      }
    });
    html += '</div>'; // .clarification-thread
    html += '</div>';
  }

  // File attachments.
  if (files.length) {
    html += '<div>';
    html += '<div class="drawer-section-title">Attachments (' + files.length + ')</div>';
    html += '<div class="file-list">';
    files.forEach(function (a) {
      html += (
        '<a class="file-item" href="' + esc(agri360Base + a.url) + '" target="_blank" rel="noopener" download>' +
          '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8 4a3 3 0 00-3 3v4a5 5 0 0010 0V7a1 1 0 112 0v4a7 7 0 11-14 0V7a5 5 0 0110 0v4a3 3 0 11-6 0V7a1 1 0 012 0v4a1 1 0 102 0V7a3 3 0 00-3-3z" clip-rule="evenodd"/></svg>' +
          esc(a.filename || 'attachment') +
        '</a>'
      );
    });
    html += '</div>';
    html += '</div>';
  }

  // Danger zone — permanent delete.
  html += '<hr class="divider" />';
  html += '<div class="danger-zone">';
  html += '<div class="danger-zone-label">Danger zone</div>';
  html += '<button id="dr-delete" class="btn-danger" type="button">Delete ticket</button>';
  html += '</div>';

  els.drawerBody.innerHTML = html;

  // Screenshot lightbox.
  els.drawerBody.querySelectorAll('.screenshot-thumb').forEach(function (thumb) {
    thumb.addEventListener('click', function () {
      openLightbox(thumb.dataset.src);
    });
  });

  // Voice players: force MediaRecorder webm blobs (whose header reports
  // duration === Infinity) to compute their real length so the player shows
  // the true duration instead of 0:00 until you press play.
  els.drawerBody.querySelectorAll('audio.voice-audio').forEach(function (au) {
    au.addEventListener('loadedmetadata', function () {
      if (!isFinite(au.duration)) { au.currentTime = 1e7; }
    });
    au.addEventListener('durationchange', function () {
      if (isFinite(au.duration) && au.currentTime !== 0) { au.currentTime = 0; }
    });
  });

  // Save button handler.
  $('dr-save').addEventListener('click', function () {
    saveDrawerChanges(t.id);
  });

  // Delete button handler.
  $('dr-delete').addEventListener('click', function () {
    confirmDeleteTicket(t.id);
  });
}

async function saveDrawerChanges(id) {
  var statusEl   = $('dr-status');
  var priorityEl = $('dr-priority');
  var deadlineEl = $('dr-deadline');

  var payload = {
    status:   statusEl.value,
    priority: priorityEl.value,
    deadline: deadlineEl.value || null,
  };

  // Manager board: include the assignee (empty string → null = Unassigned).
  if (IS_MANAGER_BOARD) {
    var assigneeEl = $('dr-assignee');
    if (assigneeEl) payload.assignee_id = assigneeEl.value ? assigneeEl.value : null;
  }

  var btn = $('dr-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    var res = await fetch('/api/tickets/' + id, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();

    // Update in state.
    var idx = state.tickets.findIndex(function (t) { return t.id === id; });
    if (idx !== -1) Object.assign(state.tickets[idx], data.ticket);

    toast('Changes saved', 'success');
    // Re-render background view.
    if (state.view === 'board') renderBoard();
    else if (state.view === 'calendar') renderCalendar();
  } catch (err) {
    toast('Save failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save changes';
  }
}

// ---------------------------------------------------------------------------
// Delete ticket (in-app confirm, no blocking dialogs)
// ---------------------------------------------------------------------------
function confirmDeleteTicket(id) {
  // Build an in-app confirmation modal that matches the app's styling.
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay confirm-overlay';
  overlay.innerHTML =
    '<div class="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">' +
      '<div class="modal-header">' +
        '<h2 id="confirm-title">Delete ticket</h2>' +
      '</div>' +
      '<div class="modal-body">' +
        '<p class="confirm-text">Delete this ticket permanently? This cannot be undone.</p>' +
        '<div class="confirm-error hidden" id="confirm-error"></div>' +
        '<div class="modal-footer">' +
          '<button class="btn-secondary" id="confirm-cancel" type="button">Cancel</button>' +
          '<button class="btn-danger" id="confirm-delete" type="button">Delete</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  function close() {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) close();
  });
  overlay.querySelector('#confirm-cancel').addEventListener('click', close);
  overlay.querySelector('#confirm-delete').addEventListener('click', function () {
    deleteTicket(id, overlay, close);
  });
}

async function deleteTicket(id, overlay, close) {
  var btn    = overlay.querySelector('#confirm-delete');
  var cancel = overlay.querySelector('#confirm-cancel');
  var errEl  = overlay.querySelector('#confirm-error');

  errEl.classList.add('hidden');
  btn.disabled = true;
  cancel.disabled = true;
  btn.textContent = 'Deleting…';

  try {
    var res = await fetch('/api/tickets/' + id, { method: 'DELETE' });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    // Remove from state and refresh the views.
    state.tickets = state.tickets.filter(function (t) { return t.id !== id; });
    close();
    closeDrawer();
    render();
    toast('Ticket deleted', 'success');
  } catch (err) {
    errEl.textContent = 'Could not delete ticket: ' + err.message;
    errEl.classList.remove('hidden');
    btn.disabled = false;
    cancel.disabled = false;
    btn.textContent = 'Delete';
  }
}

// ---------------------------------------------------------------------------
// Screenshot lightbox (inline, no library)
// ---------------------------------------------------------------------------
function openLightbox(src) {
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:600;display:flex;align-items:center;justify-content:center;padding:16px;cursor:zoom-out';
  var img = document.createElement('img');
  img.src = src;
  img.style.cssText = 'max-width:100%;max-height:100%;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,.5)';
  overlay.appendChild(img);
  overlay.addEventListener('click', function () { document.body.removeChild(overlay); });
  document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// New ticket modal
// ---------------------------------------------------------------------------
function openNewModal() {
  els.newForm.reset();
  els.modalOverlay.classList.remove('hidden');
}

function closeModal() {
  els.modalOverlay.classList.add('hidden');
}

async function submitNewTicket(e) {
  e.preventDefault();
  var form = e.currentTarget;
  var message = form.querySelector('[name="message"]').value.trim();
  if (!message) {
    toast('Description is required', 'error');
    return;
  }

  var payload = { message: message };
  var title   = form.querySelector('[name="title"]').value.trim();
  if (title)    payload.title    = title;
  payload.type     = form.querySelector('[name="type"]').value;
  payload.priority = form.querySelector('[name="priority"]').value;
  var deadline = form.querySelector('[name="deadline"]').value;
  if (deadline) payload.deadline = deadline;

  var btn = els.modalSubmit;
  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    var res = await fetch('/api/tickets', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();

    // Prepend new ticket to state.
    state.tickets.unshift(data.ticket);
    closeModal();
    render();
    toast('Ticket created', 'success');

    // Open the new ticket's drawer.
    if (data.ticket && data.ticket.id) {
      setTimeout(function () { openDrawer(data.ticket.id); }, 150);
    }
  } catch (err) {
    toast('Could not create ticket: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create ticket';
  }
}

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------
function toast(msg, type) {
  var el = document.createElement('div');
  el.className = 'toast toast-' + (type || 'success');
  el.textContent = msg;
  els.toastContainer.appendChild(el);
  setTimeout(function () {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(function () { el.parentNode && el.parentNode.removeChild(el); }, 350);
  }, 3000);
}

// ---------------------------------------------------------------------------
// Badge / pill helpers
// ---------------------------------------------------------------------------
function buildTypeBadge(type) {
  var t   = type || 'other';
  var cls = 'badge badge-type-' + t;
  return '<span class="' + cls + '">' + esc(t) + '</span>';
}

function buildPriorityPill(priority) {
  var p   = priority || 'medium';
  var cls = 'badge pill-' + p;
  return '<span class="' + cls + '">' + esc(p) + '</span>';
}

function buildDeadlineBadge(deadline) {
  var today = isoDate(new Date());
  var cls   = 'badge badge-deadline';
  if (deadline < today)  cls += ' overdue';
  if (deadline === today) cls += ' today';
  return '<span class="' + cls + '">Due ' + esc(deadline) + '</span>';
}

function buildCompletedBadge(completedAt) {
  return '<span class="badge badge-completed">Done ' + esc(isoDate(new Date(completedAt))) + '</span>';
}

function priorityColor(priority) {
  var map = {
    low:    '#9ca3af',
    medium: '#2563eb',
    high:   '#d97706',
    urgent: '#dc2626',
  };
  return map[priority] || '#9ca3af';
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function esc(str) {
  return String(str || '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

function isoDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}
