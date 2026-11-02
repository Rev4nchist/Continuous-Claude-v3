/**
 * kanban-client -- the browser half of the lane board's Priorities kanban.
 *
 * render-board.mjs inlines this file into the page, after the source text of
 * placeLanes (kanban-place.mjs), which this file calls as a global. It is plain
 * ES5 on purpose: no build step, and the generator embeds it as text.
 *
 * The server draws every card in its default column first, so the page is
 * complete with no script. This file then (1) asks the artifact `db` capability
 * for Dave's saved order, (2) re-places the cards, and (3) saves his moves.
 *
 * Saved doc, `kanban/board`:
 *   { columns: { now: [id], next: [id], later: [id], waiting: [id] }, updatedAt: ISO }
 *
 * Rules this file keeps:
 *  - First paint never waits on the db.
 *  - The cards are editable only after the saved order loaded. A save made
 *    from a board that never loaded would overwrite his order with defaults.
 *  - One write at a time, only when the order changed, debounced 800 ms.
 *  - No localStorage.
 */
(function () {
  var COLS = ['now', 'next', 'later', 'waiting'];
  var LABEL = { now: 'Now', next: 'Next', later: 'Later', waiting: 'Waiting on Dave' };
  var DOC_PATH = 'kanban/board';
  var SAVE_DELAY = 800;
  var LOAD_TIMEOUT = 10000;

  var board = document.getElementById('kb-board');
  var dataEl = document.getElementById('kb-data');
  if (!board || !dataEl) return;

  var LANES = [];
  try { LANES = JSON.parse(dataEl.textContent || '[]'); } catch (e) { LANES = []; }

  var statusEl = document.getElementById('kb-status');
  var liveEl = document.getElementById('kb-live');
  var mq = window.matchMedia ? window.matchMedia('(max-width:720px)') : { matches: false };

  var cards = {};
  var lists = {};
  var colEls = {};
  var counts = {};
  var cols = { now: [], next: [], later: [], waiting: [] };
  var db = null;
  var editable = false;
  var lastSaved = null;
  var saveTimer = null;
  var inflight = false;
  var again = false;
  var dragId = null;
  var placeholder = null;

  Array.prototype.forEach.call(board.querySelectorAll('.kb-card'), function (el) { cards[el.getAttribute('data-id')] = el; });
  Array.prototype.forEach.call(board.querySelectorAll('.kcol'), function (el) {
    var k = el.getAttribute('data-col') || 'progress';
    colEls[k] = el;
    lists[k] = el.querySelector('.kb-list');
    counts[k] = el.querySelector('.kb-count');
  });

  function key(c) { return JSON.stringify([c.now, c.next, c.later, c.waiting]); }
  function copyCols() { return { now: cols.now.slice(), next: cols.next.slice(), later: cols.later.slice(), waiting: cols.waiting.slice() }; }
  function pick(p) { return { now: p.now, next: p.next, later: p.later, waiting: p.waiting }; }
  function errText(e) { return (e && e.message) ? e.message : String(e); }

  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.setAttribute('data-k', kind || 'idle');
  }
  function announce(text) { if (liveEl) liveEl.textContent = text; }

  // ---------------------------------------------------------------- render

  function render() {
    COLS.forEach(function (name) {
      var list = lists[name];
      var ids = cols[name];
      ids.forEach(function (id, i) {
        var el = cards[id];
        if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
        el.setAttribute('data-col', name);
        el.querySelector('.kb-rank').textContent = String(i + 1);
        el.querySelector('.kb-to').value = name;
        el.querySelector('.kb-up').disabled = !editable || i === 0;
        el.querySelector('.kb-dn').disabled = !editable || i === ids.length - 1;
      });
      colEls[name].setAttribute('data-n', String(ids.length));
      counts[name].textContent = String(ids.length);
    });
  }

  function setEditable(on) {
    editable = on;
    board.classList.toggle('kb-on', on);
    Array.prototype.forEach.call(board.querySelectorAll('.kb-grip'), function (g) { g.setAttribute('draggable', on ? 'true' : 'false'); });
    Array.prototype.forEach.call(board.querySelectorAll('.kb-to'), function (s) { s.disabled = !on; });
    render();
  }

  // ------------------------------------------------------------------ moves

  function locate(id) {
    for (var i = 0; i < COLS.length; i++) {
      var at = cols[COLS[i]].indexOf(id);
      if (at >= 0) return { col: COLS[i], at: at };
    }
    return null;
  }

  function moveCard(id, toCol, toIndex) {
    var from = locate(id);
    if (!from) return;
    cols[from.col].splice(from.at, 1);
    var dest = cols[toCol];
    var at = Math.max(0, Math.min(toIndex, dest.length));
    dest.splice(at, 0, id);
    if (from.col === toCol && from.at === at) { render(); return; }
    render();
    announce(id + ' moved to ' + LABEL[toCol] + ', rank ' + (at + 1) + ' of ' + dest.length);
    changed();
  }

  function focusAfter(id, sel) {
    var el = cards[id];
    if (!el) return;
    var target = el.querySelector(sel);
    if (!target || target.disabled) target = el.querySelector('.kb-to');
    if (target) target.focus();
  }

  function expandColumn(name) {
    var el = colEls[name];
    if (!el || !el.classList.contains('kb-collapsed')) return;
    el.classList.remove('kb-collapsed');
    syncHeads();
  }

  board.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var more = t.closest('.kb-more');
    if (more) {
      var card = more.closest('.kb-card');
      var detail = document.getElementById(more.getAttribute('aria-controls'));
      var open = detail.hidden;
      detail.hidden = !open;
      card.classList.toggle('kb-open', open);
      more.setAttribute('aria-expanded', String(open));
      more.textContent = open ? 'Hide details' : 'Details';
      return;
    }
    var head = t.closest('.kb-head');
    if (head) {
      if (!mq.matches) return;
      var col = head.closest('.kcol');
      col.classList.toggle('kb-collapsed');
      syncHeads();
      return;
    }
    var btn = t.closest('.kb-up, .kb-dn');
    if (btn && editable && !btn.disabled) {
      var c = btn.closest('.kb-card');
      var id = c.getAttribute('data-id');
      var pos = locate(id);
      if (!pos) return;
      var isUp = btn.classList.contains('kb-up');
      moveCard(id, pos.col, pos.at + (isUp ? -1 : 1));
      focusAfter(id, isUp ? '.kb-up' : '.kb-dn');
    }
  });

  board.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains('kb-to') || !editable) return;
    var id = t.closest('.kb-card').getAttribute('data-id');
    var to = t.value;
    if (COLS.indexOf(to) < 0) return;
    expandColumn(to);
    moveCard(id, to, cols[to].length);
    focusAfter(id, '.kb-to');
  });

  function syncHeads() {
    Array.prototype.forEach.call(board.querySelectorAll('.kcol'), function (el) {
      var shut = mq.matches && el.classList.contains('kb-collapsed');
      el.querySelector('.kb-head').setAttribute('aria-expanded', String(!shut));
    });
  }
  if (mq.addEventListener) mq.addEventListener('change', syncHeads);
  if (mq.matches) {
    ['next', 'later', 'waiting'].forEach(function (n) { colEls[n].classList.add('kb-collapsed'); });
  }
  syncHeads();

  // ------------------------------------------------------------ drag and drop

  function dropIndex(list, y) {
    var items = list.querySelectorAll('.kb-card:not(.kb-dragging)');
    for (var i = 0; i < items.length; i++) {
      var r = items[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return { at: i, before: items[i] };
    }
    return { at: items.length, before: null };
  }

  function hideDrop() {
    if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
    Array.prototype.forEach.call(board.querySelectorAll('.kb-over'), function (el) { el.classList.remove('kb-over'); });
  }

  function clearDrag() {
    hideDrop();
    Array.prototype.forEach.call(board.querySelectorAll('.kb-dragging'), function (el) { el.classList.remove('kb-dragging'); });
    dragId = null;
  }

  function dropTarget(e) {
    var t = e.target;
    var col = t && t.closest ? t.closest('.kcol') : null;
    var name = col ? col.getAttribute('data-col') : null;
    return name && COLS.indexOf(name) >= 0 ? col : null;
  }

  board.addEventListener('dragstart', function (e) {
    var t = e.target;
    var grip = t && t.closest ? t.closest('.kb-grip') : null;
    if (!grip || !editable) { e.preventDefault(); return; }
    var card = grip.closest('.kb-card');
    dragId = card.getAttribute('data-id');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragId); } catch (err) { /* some browsers refuse */ }
    try { e.dataTransfer.setDragImage(card, 16, 16); } catch (err2) { /* optional */ }
    // Style after the browser has taken its drag image.
    setTimeout(function () { card.classList.add('kb-dragging'); }, 0);
  });

  board.addEventListener('dragover', function (e) {
    if (!dragId) return;
    var col = dropTarget(e);
    if (!col) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    Array.prototype.forEach.call(board.querySelectorAll('.kb-over'), function (el) { if (el !== col) el.classList.remove('kb-over'); });
    col.classList.add('kb-over');
    var list = col.querySelector('.kb-list');
    if (!placeholder) { placeholder = document.createElement('li'); placeholder.className = 'kb-ph'; placeholder.setAttribute('aria-hidden', 'true'); }
    var where = dropIndex(list, e.clientY);
    list.insertBefore(placeholder, where.before);
  });

  board.addEventListener('dragleave', function (e) {
    if (!dragId) return;
    var rel = e.relatedTarget;
    if (!rel || !board.contains(rel)) hideDrop();
  });

  board.addEventListener('drop', function (e) {
    if (!dragId) return;
    var col = dropTarget(e);
    if (!col) { clearDrag(); return; }
    e.preventDefault();
    var list = col.querySelector('.kb-list');
    var where = dropIndex(list, e.clientY);
    var id = dragId;
    var name = col.getAttribute('data-col');
    clearDrag();
    moveCard(id, name, where.at);
  });

  board.addEventListener('dragend', clearDrag);

  // ------------------------------------------------------------------- save

  function changed() {
    if (key(cols) === lastSaved && !inflight) {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      setStatus('Saved', 'ok');
      return;
    }
    setStatus('Saving…', 'warn');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DELAY);
  }

  function flush() {
    saveTimer = null;
    if (!db) return;
    if (inflight) { again = true; return; }
    var sent = key(cols);
    if (sent === lastSaved) { setStatus('Saved', 'ok'); return; }
    inflight = true;
    var payload = { columns: copyCols(), updatedAt: new Date().toISOString() };
    var p;
    try { p = Promise.resolve(db.doc(DOC_PATH).set(payload)); } catch (e) { p = Promise.reject(e); }
    p.then(function () {
      inflight = false;
      lastSaved = sent;
      if (again || key(cols) !== lastSaved) {
        again = false;
        if (!saveTimer) flush();
        return;
      }
      setStatus('Saved ' + new Date().toTimeString().slice(0, 5), 'ok');
    }, function (err) {
      inflight = false;
      again = false;
      setStatus('Save failed: ' + errText(err) + '. Move a card to try again.', 'crit');
    });
  }

  // Do not lose a move to a tab that closes inside the debounce window.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && saveTimer) { clearTimeout(saveTimer); flush(); }
  });

  // ------------------------------------------------------------------- load

  var answered = false;
  var loadTimer = setTimeout(function () {
    if (!answered) setStatus('Board order not loaded', 'warn');
  }, LOAD_TIMEOUT);

  function readOnly(text, kind) {
    answered = true;
    clearTimeout(loadTimer);
    setStatus(text, kind || 'idle');
  }

  function docOf(snap) {
    var exists = typeof snap.exists === 'function' ? snap.exists() : snap.exists;
    if (!exists) return null;
    return typeof snap.data === 'function' ? snap.data() : snap.data;
  }

  function applyRemote(snap) {
    if (dragId || saveTimer || inflight) return;
    var placed = pick(placeLanes(docOf(snap), LANES));
    if (key(placed) === key(cols)) return;
    cols = placed;
    lastSaved = key(cols);
    render();
    setStatus('Updated from another device', 'ok');
  }

  function subscribe() {
    try {
      db.doc(DOC_PATH).onSnapshot(function (snap) { try { applyRemote(snap); } catch (e) { /* keep the page alive */ } });
    } catch (e) { /* live updates are optional */ }
  }

  function boot() {
    var claude = window.claude;
    if (!claude || typeof claude.use !== 'function') {
      readOnly('Read-only: the saved order is not available here. Showing the default order.');
      return;
    }
    var p;
    try { p = Promise.resolve(claude.use('db')); } catch (e) { p = Promise.reject(e); }
    p.then(function (handle) {
      if (!handle) { readOnly('Read-only: sign in to save an order. Showing the default order.'); return null; }
      db = handle;
      return Promise.resolve(db.doc(DOC_PATH).get()).then(function (snap) {
        var doc = docOf(snap);
        cols = pick(placeLanes(doc, LANES));
        lastSaved = key(cols);
        answered = true;
        clearTimeout(loadTimer);
        render();
        setEditable(true);
        setStatus(doc ? 'Saved order loaded' : 'No saved order yet. Showing the default order.', doc ? 'ok' : 'idle');
        subscribe();
      });
    }).catch(function (err) {
      readOnly('Board order not loaded: ' + errText(err), 'warn');
    });
  }

  cols = pick(placeLanes(null, LANES));
  render();
  setEditable(false);
  setStatus('Loading saved order…', 'idle');
  boot();
})();
