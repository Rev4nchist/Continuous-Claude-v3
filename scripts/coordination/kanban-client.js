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
 * Also, per card (the data contract is in the lane-board PR):
 *   `cards/<laneId>`  { status?, note?, question?, updatedAt, syncedAt?, syncResult? }
 *       The page writes status/note/question/updatedAt, changed fields only,
 *       with update (set only to create the doc). The sync writes syncedAt.
 *   `plain/<laneId>`  { text, sourceHash, createdAt }
 *       A cached Plain English answer, reused only while sourceHash matches
 *       the card's data-hash.
 *
 * Rules this file keeps:
 *  - First paint never waits on the db.
 *  - The cards are movable only after the saved order loaded. A save made
 *    from a board that never loaded would overwrite his order with defaults.
 *  - One write at a time, only when the order changed, debounced 800 ms.
 *  - Card fields are editable only after the card docs loaded.
 *  - Plain English: one call per card at a time, never retried, answer shown
 *    with textContent.
 *  - No localStorage.
 *
 * Globals inlined ahead of this file by render-board.mjs: placeLanes, isPending,
 * syncState, cardDiff, plainPrompt (all from kanban-place.mjs).
 */
(function () {
  var COLS = ['now', 'next', 'later', 'waiting'];
  var LABEL = { now: 'Now', next: 'Next', later: 'Later', waiting: 'Waiting on Dave' };
  var DOC_PATH = 'kanban/board';
  var CARDS = 'cards';
  var PLAIN = 'plain';
  var SAVE_DELAY = 800;
  var LOAD_TIMEOUT = 10000;

  var board = document.getElementById('kb-board');
  var dataEl = document.getElementById('kb-data');
  if (!board || !dataEl) return;

  var LANES = [];
  try { LANES = JSON.parse(dataEl.textContent || '[]'); } catch (e) { LANES = []; }
  var LANE_BY_ID = {};
  LANES.forEach(function (l) { LANE_BY_ID[l.id] = l; });

  var statusEl = document.getElementById('kb-status');
  var orderEl = document.getElementById('kb-order');
  var liveEl = document.getElementById('kb-live');
  var mq = window.matchMedia ? window.matchMedia('(max-width:720px)') : { matches: false };

  // Card docs and the per-card edit and Plain English state.
  var boardDoc = null;
  var cardDocs = {};
  var cardsState = 'wait';
  var cardsWhy = '';
  var dbWhy = '';
  var saving = {};
  var plainBusy = {};
  var sampleFn = null;

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
    var sv = t.closest('.kb-save');
    if (sv) { saveCard(sv.closest('.kb-card').getAttribute('data-id')); return; }
    var pl = t.closest('.kb-plain');
    if (pl) { plainClick(pl); return; }
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

  board.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.closest || !t.closest('.kb-edit')) return;
    var id = t.closest('.kb-card').getAttribute('data-id');
    setSaved(id, '', 'idle');
    paintEdit(id);
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
      boardDoc = { columns: payload.columns, updatedAt: payload.updatedAt };
      showOrder();
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


  // ------------------------------------------------------- order sync chip

  function showOrder() {
    if (orderEl) orderEl.hidden = !(boardDoc && isPending(boardDoc));
  }

  // ------------------------------------------------------------ card editing

  function hasKeys(o) {
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) return true;
    return false;
  }

  function part(id, sel) { return cards[id] ? cards[id].querySelector(sel) : null; }

  function readForm(id) {
    var st = part(id, '.kb-st');
    return { status: st ? st.value : '', note: part(id, '.kb-note').value, question: part(id, '.kb-q').value };
  }

  function stateOf(id) { return LANE_BY_ID[id] ? LANE_BY_ID[id].state : ''; }

  function changesOf(id) { return cardDiff(cardDocs[id] || null, readForm(id), stateOf(id)); }

  function two(n) { return n < 10 ? '0' + n : String(n); }

  function stamp(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var hm = two(d.getHours()) + ':' + two(d.getMinutes());
    var t = new Date();
    var same = d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
    return same ? hm : two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + hm;
  }

  // Fill the form from the saved doc. `keep` names fields with unsaved edits; they stay.
  function fillForm(id, keep) {
    var d = cardDocs[id] || {};
    var state = stateOf(id);
    var st = part(id, '.kb-st');
    if (st && state !== 'active' && !keep.status) {
      var four = ['backlog', 'ready', 'blocked', 'done'];
      st.value = four.indexOf(d.status) >= 0 ? d.status : (four.indexOf(state) >= 0 ? state : '');
    }
    if (!keep.note) part(id, '.kb-note').value = typeof d.note === 'string' ? d.note : '';
    if (!keep.question) part(id, '.kb-q').value = typeof d.question === 'string' ? d.question : '';
  }

  function paintSync(id) {
    var chip = part(id, '.kb-sync');
    if (!chip) return;
    var s = syncState(cardDocs[id]);
    if (s.kind === 'none') { chip.hidden = true; chip.textContent = ''; return; }
    chip.hidden = false;
    chip.setAttribute('data-k', s.kind);
    chip.textContent = s.kind === 'pending' ? 'Not yet synced' : 'Synced ' + stamp(s.at) + (s.result ? ' · ' + s.result : '');
  }

  function whyOff() {
    if (!db) return dbWhy || 'Loading card notes…';
    if (cardsState === 'wait') return 'Loading card notes…';
    if (cardsState === 'off') return cardsWhy;
    return '';
  }

  function setSaved(id, text, kind) {
    var el = part(id, '.kb-saved');
    if (!el) return;
    el.textContent = text;
    el.setAttribute('data-k', kind || 'idle');
  }

  function paintEdit(id) {
    var on = !!db && cardsState === 'ready';
    var active = stateOf(id) === 'active';
    var st = part(id, '.kb-st');
    if (st) st.disabled = !on || active;
    part(id, '.kb-note').disabled = !on;
    part(id, '.kb-q').disabled = !on;
    part(id, '.kb-save').disabled = !on || !!saving[id] || !hasKeys(changesOf(id));
    part(id, '.kb-why').textContent = whyOff();
  }

  function paintAll() {
    Object.keys(cards).forEach(paintEdit);
  }

  function applyCards(snap) {
    var next = {};
    (snap.docs || []).forEach(function (d) { next[d.id] = typeof d.data === 'function' ? d.data() : d.data; });
    Object.keys(cards).forEach(function (id) {
      // A field with unsaved edits keeps them; the others follow the saved doc.
      var keep = changesOf(id);
      if (next[id]) cardDocs[id] = next[id]; else delete cardDocs[id];
      fillForm(id, keep);
      paintSync(id);
    });
    cardsState = 'ready';
    paintAll();
  }

  function cardsOff(why) {
    cardsState = 'off';
    cardsWhy = why;
    paintAll();
  }

  function subscribeCards() {
    var timer = setTimeout(function () {
      if (cardsState === 'wait') cardsOff('Card notes not loaded. Editing is off.');
    }, LOAD_TIMEOUT);
    function fail(err) {
      clearTimeout(timer);
      cardsOff('Card notes not loaded: ' + errText(err) + '. Editing is off.');
    }
    try {
      db.collection(CARDS).onSnapshot(function (snap) {
        clearTimeout(timer);
        try { applyCards(snap); } catch (e) { /* keep the page alive */ }
      }, fail);
    } catch (e) { fail(e); }
  }

  function attempt(fn) {
    return new Promise(function (resolve) { resolve(fn()); });
  }

  // update when the doc exists (it keeps syncedAt); set only to create it.
  // A stale view of "exists" is checked against a fresh read before any set.
  function writeCard(ref, payload, known) {
    function viaRead() {
      return attempt(function () { return ref.get(); }).then(function (snap) {
        return docOf(snap) ? ref.update(payload) : ref.set(payload);
      });
    }
    if (!known) return viaRead();
    return attempt(function () { return ref.update(payload); }).then(null, function (e) {
      if (e && e.code === 'invalid_argument') return viaRead();
      throw e;
    });
  }

  function saveCard(id) {
    if (!db || cardsState !== 'ready' || saving[id]) return;
    var changes = changesOf(id);
    if (!hasKeys(changes)) return;
    var payload = {};
    Object.keys(changes).forEach(function (k) { payload[k] = changes[k]; });
    payload.updatedAt = new Date().toISOString();
    var known = !!cardDocs[id];
    saving[id] = true;
    setSaved(id, 'Saving…', 'warn');
    paintEdit(id);
    attempt(function () { return writeCard(db.collection(CARDS).doc(id), payload, known); }).then(function () {
      saving[id] = false;
      var merged = {};
      var old = cardDocs[id] || {};
      Object.keys(old).forEach(function (k) { merged[k] = old[k]; });
      Object.keys(payload).forEach(function (k) { merged[k] = payload[k]; });
      cardDocs[id] = merged;
      paintSync(id);
      setSaved(id, 'Saved ' + stamp(payload.updatedAt), 'ok');
      paintEdit(id);
    }, function (err) {
      saving[id] = false;
      setSaved(id, 'Save failed: ' + errText(err) + '. Try again.', 'crit');
      paintEdit(id);
    });
  }

  // ----------------------------------------------------------- Plain English

  function setPlainVisible(on) {
    Array.prototype.forEach.call(board.querySelectorAll('.kb-plain'), function (b) { b.hidden = !on; });
    if (!on) {
      Array.prototype.forEach.call(board.querySelectorAll('.kb-plain-out'), function (o) { o.hidden = true; });
    }
  }

  function bootSample(claude) {
    var p;
    try { p = Promise.resolve(claude.use('sample')); } catch (e) { p = Promise.reject(e); }
    p.then(function (fn) {
      if (typeof fn !== 'function') return;
      sampleFn = fn;
      setPlainVisible(true);
    }, function () { /* the buttons stay hidden */ });
  }

  function showPlainOut(out, text, kind, src) {
    out.hidden = false;
    out.textContent = text;
    out.setAttribute('data-k', kind);
    if (src) out.setAttribute('data-src', src); else out.removeAttribute('data-src');
  }

  function cachedPlain(id, hash) {
    if (!db) return Promise.resolve('');
    return attempt(function () { return db.collection(PLAIN).doc(id).get(); }).then(function (snap) {
      var d = docOf(snap);
      return d && d.sourceHash === hash && typeof d.text === 'string' ? d.text : '';
    }, function () { return ''; });
  }

  function neighbours(id) {
    var list = cards[id].closest('.kb-list');
    var ids = [];
    Array.prototype.forEach.call(list.querySelectorAll('.kb-card'), function (el) {
      var other = el.getAttribute('data-id');
      if (other !== id) ids.push(other);
    });
    return ids;
  }

  function plainClick(btn) {
    var card = btn.closest('.kb-card');
    var id = card.getAttribute('data-id');
    var out = document.getElementById(btn.getAttribute('aria-controls'));
    if (plainBusy[id] || !sampleFn) return;
    if (!out.hidden && out.getAttribute('data-k') === 'ok') {
      out.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      return;
    }
    var hash = card.getAttribute('data-hash') || '';
    plainBusy[id] = true;
    btn.disabled = true;
    btn.setAttribute('aria-expanded', 'true');
    showPlainOut(out, 'Thinking…', 'idle');

    function release() { plainBusy[id] = false; btn.disabled = false; }
    function fail(err) {
      var code = err && err.code;
      if (code === 'not_granted') { sampleFn = null; setPlainVisible(false); }
      else if (code === 'rate_limited') showPlainOut(out, 'Try again in a minute.', 'warn');
      else showPlainOut(out, 'Could not explain this: ' + errText(err), 'crit');
      release();
    }

    cachedPlain(id, hash).then(function (text) {
      if (text) { showPlainOut(out, text, 'ok', 'cache'); release(); return null; }
      var ask = plainPrompt(LANE_BY_ID[id], neighbours(id));
      return attempt(function () { return sampleFn(ask, { modelTier: 'quick' }); }).then(function (r) {
        var answer = r && typeof r.text === 'string' ? r.text.trim() : '';
        if (!answer) throw new Error('empty answer');
        showPlainOut(out, answer, 'ok', 'sample');
        if (!db) { release(); return; }
        var doc = { text: answer, sourceHash: hash, createdAt: new Date().toISOString() };
        return attempt(function () { return db.collection(PLAIN).doc(id).set(doc); }).then(release, release);
      }, fail);
    }).then(null, fail);
  }

  // ------------------------------------------------------------------- load

  var answered = false;
  var loadTimer = setTimeout(function () {
    if (answered) return;
    setStatus('Board order not loaded', 'warn');
    if (!db && !dbWhy) { dbWhy = 'Read-only: card notes not loaded.'; paintAll(); }
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
    boardDoc = docOf(snap);
    showOrder();
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
      dbWhy = 'Read-only: editing is not available here.';
      readOnly('Read-only: the saved order is not available here. Showing the default order.');
      paintAll();
      return;
    }
    bootSample(claude);
    var p;
    try { p = Promise.resolve(claude.use('db')); } catch (e) { p = Promise.reject(e); }
    p.then(function (handle) {
      if (!handle) {
        dbWhy = 'Read-only: sign in to edit this card.';
        readOnly('Read-only: sign in to save an order. Showing the default order.');
        paintAll();
        return null;
      }
      db = handle;
      subscribeCards();
      return Promise.resolve(db.doc(DOC_PATH).get()).then(function (snap) {
        var doc = docOf(snap);
        boardDoc = doc;
        showOrder();
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
      if (!db) { dbWhy = 'Read-only: card notes not loaded.'; paintAll(); }
      readOnly('Board order not loaded: ' + errText(err), 'warn');
    });
  }

  cols = pick(placeLanes(null, LANES));
  render();
  setEditable(false);
  paintAll();
  setStatus('Loading saved order…', 'idle');
  boot();
})();
