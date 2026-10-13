/* Research tracker: the web app (rendering and actions).
   Every rule about states and who may do what lives in core.js (shared with the email digests,
   the tests and, in spirit, firestore.rules). The outline and the two people live in projects.js. */
(function () {
  "use strict";
  const C = window.TrackerCore, PROJECTS = window.TRACKER_PROJECTS || [];
  if (!C || !PROJECTS.length) {
    const s = document.getElementById("statusText");
    if (s) s.textContent = "Some tracker files didn't load. Reload the page.";
    return;
  }
  const { STAGES, S, PHASES, VERIFY, VIDX, pretty } = C;

  /* =================================================================== small helpers */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(k => append(el, k)); return; }
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  function svg(markup) { const t = document.createElement("template"); t.innerHTML = markup.trim(); return t.content.firstChild; }
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode or full: not critical */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };
  const ICON = {
    chev: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    ck: '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.3 5 8.6 9.6 3.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bubble: '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5a1.5 1.5 0 0 1 1.5-1.5h8a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11A1.5 1.5 0 0 1 2.5 9.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>'
  };
  const reduceMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sameEmail = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
  const isTextField = el => !!el && el.matches && el.matches("textarea, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), select");
  // Links people paste: accept http(s) only (a "javascript:" link would run code), add https:// if missing.
  function normalizeUrl(s) {
    s = String(s || "").trim();
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
    try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:" ? u.href : false; } catch (e) { return false; }
  }
  const safeUrl = s => normalizeUrl(s) || null;
  const pctText = p => (p >= 0.99999 ? "100%" : p <= 0 ? "0%" : p < 0.01 ? "<1%" : Math.floor(p * 100) + "%");

  /* =================================================================== state */
  let project = PROJECTS[0], idx = null, backend = null, me = null, role = null;
  let st = C.emptyState(), A = null;
  const got = {};
  let ready = false, accessDenied = false;
  const denied = new Set();   // which parts of the database refused us (tells old rules from a wrong account)
  let view = "today", openItem = null, pendingOpen = null, filter = "all", query = "";
  let expanded = new Set();
  const names = {}, avatars = {};
  const drafts = new Map();          // text typed into inline forms, kept across re-renders
  const openDetails = new Set();     // which <details> are open, kept across re-renders
  const openEdits = new Set();       // which inline editors are open (deliverable text, claim evidence…)
  const els = new Map();             // outline rows by item id
  let built = {}, logForm = null, logLoadedReady = false, weekOffset = 0, logFilter = "mine", lastReport = null;
  let fs = null, auth = null;
  const CFG = window.TRACKER_FIREBASE, EJ = window.TRACKER_EMAILJS;

  const local = () => !!backend && backend.mode === "local";
  const whoAmI = () => (me ? { uid: me.uid, email: me.email } : { uid: "local-" + role });
  const roleOfEmail = email => C.roleOfEmail(project, email);
  const otherLabel = () => (role === "guide" ? "your student" : "your guide");
  const canWrite = () => !!(backend && backend.canWrite && !accessDenied && role);
  const myName = () => (me ? me.name || me.email : role === "guide" ? "Guide (preview)" : "Student (preview)");
  const actor = () => ({ role, by: backend.me, name: myName(), now: Date.now() });
  const itemOf = id => C.itemOf(st, id);

  function resolveNames() {
    const add = x => { if (x && x.by) { if (x.name) names[x.by] = x.name; if (x.photo) avatars[x.by] = x.photo; } };
    for (const c of C.LIST_COLLECTIONS) st[c].forEach(add);
    for (const k in st.items) {
      const it = st.items[k];
      add(it.note); add(it.blocked); add(it.verifyNote);
      if (it.updatedBy && it.updatedName && !names[it.updatedBy]) names[it.updatedBy] = it.updatedName;
    }
  }
  function nameOf(x) {
    if (!x) return "Someone";
    if (C.sameActor(x, whoAmI())) return "You";
    if (local()) return /guide/.test(x.by || x.role || "") ? "Guide (preview)" : "Student (preview)";
    return x.name || names[x.by] || (x.role === "guide" ? "Your guide" : x.role === "student" ? "Your student" : "Someone");
  }
  function avatar(x) {
    const photo = x && (x.photo || avatars[x.by]);
    if (photo && !local()) return h("img", { class: "av", alt: "", referrerpolicy: "no-referrer", src: photo });
    return h("span", { class: "av", "aria-hidden": "true", text: (nameOf(x) || "?").trim().charAt(0).toUpperCase() });
  }
  const stageText = id => C.stageText(st, id);

  /* =================================================================== toasts */
  function toast(text, o) {
    o = o || {};
    const t = h("div", { class: "toast" + (o.error ? " err" : ""), role: o.error ? "alert" : "status" }, h("span", { text }));
    if (o.undo) t.append(h("button", { type: "button", text: "Undo", onclick: () => { t.remove(); o.undo(); } }));
    $("#toasts").append(t);
    setTimeout(() => t.remove(), o.ms || (o.undo ? 8000 : o.error ? 7000 : 3500));
  }
  function fail(err, msg) {
    if (err && err.name === "TransitionError") { toast(err.userMessage, { error: true }); schedule(); return; }
    console.error(err);
    const code = String((err && (err.code || err.message)) || "");
    toast(/permission/i.test(code) ? "Not saved: the database refused it. Check you're signed in with an account on the access list, and that the latest firestore.rules are published."
      : /unavailable|offline|network/i.test(code) ? "Not saved: you seem to be offline. Try again when you're connected."
        : (msg || "That change wasn't saved. Check your connection and try again."), { error: true });
    schedule();
  }
  async function run(fn, msg) {
    if (!canWrite()) { toast(me || !fs ? "This account can't make changes." : "Sign in to make changes.", { error: true }); return false; }
    try { await fn(); return true; } catch (e) { fail(e, msg); return false; }
  }

  /* =================================================================== storage backends
     Both have the same interface: subscribe, applyItem (one item change + its history entry, as a
     transaction), add / update / remove on list collections, setPref. */
  function localBackend(pid) {
    const key = n => "rt:" + pid + ":" + n;
    let H = null;
    const ident = () => ({ by: "local-" + role, email: "", name: myName(), role });
    const newId = c => c[0] + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const legacy = () => { const d = {}; for (const f of C.LEGACY_FIELDS) { const v = LS.get(key(f), null); if (v) d[f] = v; } return d; };
    const push = (col, list) => { LS.set(key(col), list); if (H) H.onCol(col, list); };
    return {
      mode: "local", canWrite: true,
      get me() { return "local-" + role; },
      subscribe(handlers) {
        H = handlers; H.onDoc(legacy());
        for (const c of C.LIST_COLLECTIONS) H.onCol(c, LS.get(key(c), []));
        for (const c of C.MAP_COLLECTIONS) H.onMap(c, LS.get(key(c), {}));
      },
      async applyItem(id, base, compute) {
        const items = LS.get(key("items"), {});
        const r = compute(items[id] ? C.normItem(items[id]) : (base || C.blankItem()));
        if (!r) return null;
        items[id] = C.toDoc(r.item); LS.set(key("items"), items);
        let evs = LS.get(key("events"), []);
        evs.push(Object.assign({ id: newId("e") }, r.event, ident()));
        if (evs.length > 3000) evs = evs.slice(-3000);
        LS.set(key("events"), evs);
        if (H) { H.onMap("items", items); H.onCol("events", evs); }
        return r;
      },
      async add(col, data) {
        let l = LS.get(key(col), []);
        const id = newId(col);
        l.push(Object.assign({}, data, { id }, ident()));
        if (col === "events" && l.length > 3000) l = l.slice(-3000);
        push(col, l);
        return { id };
      },
      async update(col, id, p) { push(col, LS.get(key(col), []).map(x => (x.id === id ? Object.assign({}, x, p) : x))); },
      async remove(col, id) { push(col, LS.get(key(col), []).filter(x => x.id !== id)); },
      async setPref(k, p) { const m = LS.get(key("prefs"), {}); m[k] = p; LS.set(key("prefs"), m); if (H) H.onMap("prefs", m); },
      stop() { H = null; }
    };
  }
  function firebaseBackend(pid, db, user) {
    const ref = db.collection("trackers").doc(pid);
    const who = () => ({ by: user.uid, email: user.email || "", name: user.name || user.email || "", photo: user.photo || "", role });
    let unsub = [];
    return {
      mode: "live", me: user.uid, canWrite: true,
      subscribe(H) {
        unsub.push(ref.onSnapshot(s => H.onDoc((s.exists && s.data()) || {}), e => H.onError(e, "project")));
        for (const c of C.LIST_COLLECTIONS) {
          const q = c === "events" ? ref.collection(c).orderBy("at", "desc").limit(3000) : ref.collection(c).orderBy("at");
          unsub.push(q.onSnapshot(s => H.onCol(c, s.docs.map(d => Object.assign({ id: d.id }, d.data()))), e => H.onError(e, c)));
        }
        for (const c of C.MAP_COLLECTIONS)
          unsub.push(ref.collection(c).onSnapshot(s => { const m = {}; s.docs.forEach(d => { m[d.id] = d.data(); }); H.onMap(c, m); }, e => H.onError(e, c)));
      },
      // Reads the item as the server has it, applies the move, and writes the item and its history
      // entry together. If someone else changed it a moment ago, the move is re-checked against that.
      applyItem(id, base, compute) {
        const iref = ref.collection("items").doc(id), eref = ref.collection("events").doc();
        return db.runTransaction(async tx => {
          const snap = await tx.get(iref);
          const r = compute(snap.exists ? C.normItem(snap.data()) : (base || C.blankItem()));
          if (!r) return null;
          tx.set(iref, C.toDoc(r.item));
          tx.set(eref, Object.assign({}, r.event, { by: user.uid, email: user.email || "", name: user.name || user.email || "", role }));
          return r;
        });
      },
      add(col, data) {
        const extra = col === "deliverables" ? { by: user.uid, email: user.email || "", name: user.name || user.email || "", role } : who();
        return ref.collection(col).add(Object.assign({}, data, extra));
      },
      update(col, id, p) { return ref.collection(col).doc(id).update(p); },
      remove(col, id) { return ref.collection(col).doc(id).delete(); },
      setPref(k, p) { return ref.collection("prefs").doc(k).set(p); },
      stop() { unsub.forEach(u => u()); unsub = []; }
    };
  }
  const H = {
    onDoc(d) { st.legacy = d || {}; got.doc = true; changed(); },
    onCol(c, list) { st[c] = list; got[c] = true; if (c === "deliverables") reindex(); changed(); },
    onMap(c, m) { st[c] = m || {}; got[c] = true; changed(); },
    onError(err, what) {
      console.error("Firestore refused " + (what || "a read") + ":", err);
      if (err && /permission/i.test(String(err.code || err.message))) { accessDenied = true; denied.add(what || "?"); setStatus("ro", "No access for this account"); }
      else setStatus("ro", "Live updates stopped. Reload the page to reconnect.");
      schedule();
    }
  };
  // Deliverables your guide adds change the outline itself: rebuild it only when its shape changed.
  function reindex() {
    const next = C.buildIndex(project, st.deliverables);
    if (idx && next.signature === idx.signature) return;
    idx = next;
    built.outline = false;
    if (built.manuscript && built.manuscript.refreshPicker) built.manuscript.refreshPicker();
    if (openItem && !idx.nodes.has(openItem)) openItem = null;
  }
  function changed() {
    const was = ready;
    ready = !!got.doc && C.COLLECTIONS.every(c => got[c]);
    if (ready && !was && backend && backend.mode === "live") setStatus("live", "Shared · " + (me.name || me.email));
    schedule();
  }

  /* =================================================================== rendering pipeline */
  let pending = false, deferred = false;
  function schedule() {
    if (pending) return;
    pending = true;
    (window.requestAnimationFrame || setTimeout)(() => { pending = false; render(); });
  }
  // Re-render without losing what someone is typing: fields carry data-key, their text lives in
  // `drafts`, and focus + caret are put back afterwards. Date pickers carry data-defer instead.
  function withFocus(container, fn) {
    const ae = document.activeElement;
    const key = ae && container.contains(ae) && ae.dataset ? ae.dataset.key : null;
    let sel = null;
    if (key) { try { sel = [ae.selectionStart, ae.selectionEnd]; } catch (e) { sel = null; } }
    fn();
    if (!key || (document.activeElement && document.activeElement !== document.body && container.contains(document.activeElement))) return;
    const el = container.querySelector('[data-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
    if (el) { el.focus({ preventScroll: true }); if (sel && sel[0] != null) { try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text field */ } } }
  }
  const VIEWS = ["today", "outline", "meetings", "log", "manuscript"];
  const VIEW_RENDER = { today: renderToday, outline: renderOutline, meetings: renderMeetings, log: renderLog, manuscript: renderManuscript };
  function render() {
    if (!idx) return;
    resolveNames();
    A = C.analyze(idx, st, { now: Date.now(), me: whoAmI(), role: role || "student" });
    renderHeader();
    const g = gateState();
    gateEl.hidden = !g;
    for (const s of $$(".view")) s.hidden = !!g || s.id !== "view-" + view;
    if (g) { renderGate(g); return; }
    const root = $("#view-" + view);
    const ae = document.activeElement;
    if (ae && root.contains(ae) && ae.hasAttribute && ae.hasAttribute("data-defer")) { deferred = true; return; }
    deferred = false;
    withFocus(root, () => VIEW_RENDER[view](root));
    if (pendingOpen && ready) { const id = pendingOpen; pendingOpen = null; openNode(id); }
  }
  document.addEventListener("focusout", () => { if (deferred) setTimeout(schedule, 0); });

  const gateEl = h("section", { class: "signed-out", id: "gate", hidden: true });
  function gateState() {
    if (fs && !me) return "signedout";
    if (fs && me && !role) return "norole";
    if (accessDenied) return "denied";
    if (!ready) return "loading";
    return null;
  }
  function renderGate(g) {
    gateEl.textContent = "";
    gateEl.className = g === "loading" ? "loading" : "signed-out";
    if (g === "loading") { gateEl.textContent = "Loading the tracker…"; return; }
    if (g === "signedout") {
      gateEl.append(h("h2", { text: "Sign in to open the shared tracker" }),
        h("p", { class: "muted", text: "Use your institute Google account. You and your guide see the same live data, each with your own role." }),
        h("button", { class: "btn primary", type: "button", text: "Sign in with Google", onclick: signIn }));
      return;
    }
    gateEl.append(h("h2", { text: "This account can't open the tracker" }),
      h("p", { class: "muted", text: "Signed in as " + (me && me.email) + ". " + (g === "norole"
        ? "Only the student and the guide listed for this project can open it. If you have more than one Google account, switch to your institute one."
        : denied.has("project") ? "The database refused this account entirely. Check that it's one of the two addresses in firestore.rules, then publish the rules again."
          : "The database let this account in but refused " + [...denied].join(", ") + ". That means the rules published in Firebase are older than this version of the site: open Firebase console → Firestore Database → Rules, paste the whole of firestore.rules from the repository, and click Publish. Then reload.") }),
      h("div", { class: "formbtns", style: "justify-content:center" },
        h("button", { class: "btn primary", type: "button", text: "Use another account", onclick: switchAccount }),
        h("button", { class: "btn", type: "button", text: "Sign out", onclick: () => auth && auth.signOut() })));
  }

  /* =================================================================== header, tabs, routing */
  function setStatus(kind, text) { const s = $("#status"); s.className = "status " + kind; $("#statusText").textContent = text; }
  function setBadge(name, n, title) { const b = $("#badge-" + name); if (!b) return; b.hidden = !n; b.textContent = n ? String(n) : ""; if (title) b.title = title; }
  function renderHeader() {
    const rb = $("#roleBadge");
    rb.hidden = !role; rb.textContent = role === "guide" ? "Guide" : role === "student" ? "Student" : "";
    rb.className = "rolebadge " + (role || "");
    const pv = $("#rolePreview");
    pv.hidden = !local();
    if (local()) $$("button", pv).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.role === role)));
    const pillars = $("#pillars"), show = view === "outline" && !gateState();
    pillars.hidden = !show;
    if (show) renderPillars(pillars);
    if (!gateState()) {
      setBadge("today", role === "guide" ? A.awaitingReview.length + A.needsDiscussion.length + A.withGuide.decisions.length
        : A.withStudent.changes.length + A.withStudent.discuss.length + A.withStudent.decisions.length, "Things waiting for you");
      setBadge("meetings", A.pendingMeetings.filter(m => !C.sameActor(m, whoAmI())).length + (A.nextMeeting && C.dayDiff(A.nextMeeting.at, A.now) === 0 ? 1 : 0), "Needs your reply, or a meeting today");
      setBadge("manuscript", A.staleClaims.length, "Claims resting on changed evidence");
    }
    const n = !gateState() ? (role === "guide" ? A.withGuide.reviews.length + A.withGuide.discuss.length + A.withGuide.decisions.length + A.withGuide.comments.length
      : A.withStudent.changes.length + A.withStudent.comments.length + A.withStudent.decisions.length) : 0;
    document.title = (n ? "(" + n + ") " : "") + project.name + " · Research tracker";
  }
  function renderPillars(box) {
    box.textContent = "";
    for (const p of A.pillars) {
      const segs = PHASES.filter(ph => p.counts[ph.key]);
      box.append(h("div", { class: "pstat" },
        h("span", { class: "pstat-name", text: pretty(p.node.title) }),
        h("div", { class: "stackbar", role: "img", "aria-label": PHASES.map(ph => p.counts[ph.key] + " " + ph.label.toLowerCase()).join(", ") },
          segs.map(ph => h("i", { class: "ph-" + ph.key, style: "flex-grow:" + p.counts[ph.key], title: ph.label + ": " + p.counts[ph.key] }))),
        h("span", { class: "pstat-sum", text: p.counts.approved + " of " + p.total + " approved" })));
    }
  }
  function setView(v, o) {
    if (VIEWS.indexOf(v) < 0) v = defaultView();
    view = v;
    LS.set("rt:view:" + project.id + ":" + role, v);
    for (const t of $$(".tab")) { const on = t.dataset.view === v; t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1; }
    if (!(o && o.keepHash)) writeHash();
    render();
    if (o && o.focus) $("#main").focus({ preventScroll: true });
  }
  function writeHash() {
    const want = "#" + view + (view === "outline" && openItem ? "/" + encodeURIComponent(openItem) : "");
    if (location.hash !== want) { try { history.replaceState(null, "", want); } catch (e) { location.hash = want; } }
  }
  function defaultView() { const v = LS.get("rt:view:" + project.id + ":" + role, null); return VIEWS.indexOf(v) >= 0 ? v : "today"; }
  function applyRoute() {
    const raw = decodeURIComponent(location.hash.slice(1)), parts = raw.split("/"), item = parts.slice(1).join("/");
    const v = parts[0] === "guide" ? "today" : parts[0];
    if (VIEWS.indexOf(v) >= 0) {
      if (v === "outline" && item) { pendingOpen = item; view = "outline"; setView("outline", { keepHash: true }); }
      else setView(v);
    } else setView(defaultView());
  }
  window.addEventListener("hashchange", applyRoute);
  $("#tabs").addEventListener("click", ev => { const t = ev.target.closest(".tab"); if (t) setView(t.dataset.view); });
  $("#tabs").addEventListener("keydown", ev => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft" && ev.key !== "Home" && ev.key !== "End") return;
    const tabs = $$(".tab"), i = tabs.findIndex(t => t.dataset.view === view);
    const j = ev.key === "Home" ? 0 : ev.key === "End" ? tabs.length - 1 : (i + (ev.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    ev.preventDefault(); setView(tabs[j].dataset.view); tabs[j].focus();
  });

  /* =================================================================== shared view parts */
  function chip(text, tone, title) { return h("span", { class: "chip" + (tone ? " " + tone : ""), text, title: title || null }); }
  function stagePill(id) { return h("span", { class: "spill ph-" + C.phaseOf(st, id), text: stageText(id) }); }
  function verifyChip(id, always) {
    const v = itemOf(id).verify;
    if (v === "unchecked" && !always) return null;
    return h("span", { class: "chip vchip v-" + v, text: VERIFY[VIDX[v]].short, title: "Verification: " + VERIFY[VIDX[v]].label + ". " + VERIFY[VIDX[v]].help });
  }
  function card(title, count, body, o) {
    o = o || {};
    return h("section", { class: "card" + (o.wide ? " wide" : "") + (o.focus ? " focus" : ""), "aria-label": title },
      h("header", { class: "card-h" }, h("h3", { text: title }),
        count == null ? null : h("span", { class: "count" + (count ? (o.hot ? " hot" : "") : " zero"), text: String(count) })),
      body);
  }
  function ilist(rows, empty) { return rows.length ? h("ul", { class: "ilist" }, rows) : h("p", { class: "empty", text: empty }); }
  function irow(o) {
    return h("li", { class: "irow" },
      o.rank ? h("span", { class: "rank", text: String(o.rank), "aria-hidden": "true" }) : null,
      h("div", { class: "irow-main" },
        o.open ? h("button", { class: "ilink", type: "button", text: o.title, onclick: o.open }) : h("span", { class: "itext", text: o.title }),
        o.chips && o.chips.filter(Boolean).length ? h("span", { class: "chips" }, o.chips.filter(Boolean)) : null,
        o.sub ? h("div", { class: "isub", text: o.sub }) : null,
        o.quote ? h("div", { class: "iquote", text: C.clip(o.quote, 280) }) : null,
        o.extra || null),
      o.actions && o.actions.length ? h("div", { class: "iacts" }, o.actions) : null);
  }
  function fold(key, summary, content, cls) {
    const d = h("details", { class: cls || "fold" }, h("summary", { text: summary }), content);
    if (openDetails.has(key)) d.open = true;
    d.addEventListener("toggle", () => { if (d.open) openDetails.add(key); else openDetails.delete(key); });
    return d;
  }
  function btn(text, onclick, cls, title) { return h("button", { class: "btn small" + (cls ? " " + cls : ""), type: "button", text, onclick, title: title || null }); }
  const opener = (id, sec) => () => openNode(id, sec);
  async function copyText(text, what) {
    try { await navigator.clipboard.writeText(text); toast((what || "Text") + " copied."); }
    catch (e) {
      const ta = h("textarea", { style: "position:fixed;top:-1000px;opacity:0" }); ta.value = text; document.body.append(ta); ta.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch (e2) { ok = false; }
      ta.remove(); toast(ok ? (what || "Text") + " copied." : "Couldn't copy here. Use Download instead.", { error: !ok });
    }
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type: (type || "text/plain") + ";charset=utf-8" });
    const a = h("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  // An inline note box that opens under a button (for review notes, reasons, verification downgrades).
  function noteForm(key, o) {
    const dr = drafts.get(key) || { open: false, text: "" };
    const ta = h("textarea", { rows: "2", "aria-label": o.label, placeholder: o.placeholder || "", dataset: { key }, maxlength: "1500" });
    ta.value = dr.text;
    const send = h("button", { class: "btn small " + (o.sendCls || "primary"), type: "button", text: o.sendText });
    const form = h("div", { class: "rc-form", hidden: !dr.open }, ta, h("div", { class: "formbtns" },
      h("button", { class: "btn ghost small", type: "button", text: "Cancel", onclick: () => { drafts.delete(key); form.hidden = true; ta.value = ""; } }), send));
    ta.addEventListener("input", () => { dr.text = ta.value; drafts.set(key, dr); ta.classList.remove("invalid"); });
    ta.addEventListener("keydown", ev => { if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); send.click(); } });
    send.onclick = async () => {
      const text = ta.value.trim();
      if (o.required && !text) { ta.classList.add("invalid"); ta.focus(); return; }
      send.disabled = true;
      const ok = await o.onSend(text);
      send.disabled = false;
      if (ok) drafts.delete(key);
    };
    return { form, open: () => { dr.open = true; drafts.set(key, dr); form.hidden = false; ta.focus(); } };
  }
  // Review buttons for the guide, used in the item panel and in the review view.
  function reviewControls(id) {
    const it = itemOf(id), can = C.actionsFor(it, role);
    const wrap = h("div", { class: "rc" });
    const changes = noteForm("chg:" + id, { label: "What needs to change", placeholder: "What needs to change? (required)", sendText: it.review === "approved" ? "Reopen and request changes" : "Send change request",
      required: true, sendCls: "warn", onSend: t => act(id, "changes", { note: t }) });
    const discuss = noteForm("dsc:" + id, { label: "What to discuss", placeholder: "What would you like to discuss? (optional)", sendText: "Flag for discussion",
      sendCls: "amber", onSend: t => act(id, "discuss", { note: t }) });
    const approve = noteForm("apv:" + id, { label: "Approval note", placeholder: "A note with the approval (optional)", sendText: "Approve", sendCls: "ok solid", onSend: t => act(id, "approve", { note: t }) });
    if (can.approve) wrap.append(h("button", { class: "btn ok solid small", type: "button", text: "Approve", onclick: () => act(id, "approve", {}) }),
      h("button", { class: "linkbtn small", type: "button", text: "with a note", onclick: approve.open }));
    if (can.changes) wrap.append(h("button", { class: "btn warn small", type: "button", text: it.review === "approved" ? "Reopen…" : "Request changes…", onclick: changes.open }));
    if (can.discuss) wrap.append(h("button", { class: "btn amber small", type: "button", text: "Needs discussion…", onclick: discuss.open }));
    wrap.append(approve.form, changes.form, discuss.form);
    return wrap;
  }

  /* =================================================================== Home
     Only what needs you, in a few short lists. Empty lists disappear. */
  function renderToday(root) {
    root.textContent = "";
    const now = A.now, me_ = whoAmI();
    const meetLine = A.nextMeeting
      ? ["Next meeting ", h("b", { text: C.fmtWhen(A.nextMeeting.at) }), C.dayDiff(A.nextMeeting.at, now) === 0 ? " (today)" : ""]
      : ["No meeting booked · ", h("button", { class: "linkbtn", type: "button", text: "Propose one", onclick: () => setView("meetings") })];
    root.append(h("div", { class: "today-head" },
      h("h2", { text: greeting() }),
      h("p", { class: "meet" }, meetLine)));
    const cards = role === "guide" ? guideHome(now) : studentHome(now);
    const shown = cards.filter(Boolean);
    if (!shown.length) root.append(h("div", { class: "allclear" }, h("h3", { text: "All clear" }), h("p", { class: "muted", text: "Nothing needs you right now." })));
    root.append(h("div", { class: "home" }, shown));
    const wk = weekLine();
    root.append(h("p", { class: "weekline" }, h("span", { text: wk }), " ", h("button", { class: "linkbtn", type: "button", text: "Weekly report →", onclick: () => setView("log") })));
    void me_;
  }
  function greeting() {
    const hr = new Date().getHours(), first = me && me.name ? me.name.split(" ")[0] : "";
    return (hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening") + (first ? ", " + first : "");
  }
  function weekLine() {
    const w = A.week, bits = [];
    if (w.approvals.length) bits.push(C.plural(w.approvals.length, "approval"));
    if (w.submissions.length) bits.push(C.plural(w.submissions.length, "item") + " sent for review");
    if (w.newResults.length) bits.push(C.plural(w.newResults.length, "new result"));
    if (w.comments.length) bits.push(C.plural(w.comments.length, "comment"));
    return bits.length ? "This week: " + bits.join(", ") + "." : "Nothing recorded this week yet.";
  }
  function homeCard(title, rows, o) {
    if (!rows.length && !(o && o.always)) return null;
    return h("section", { class: "hcard" + (o && o.primary ? " primary" : ""), "aria-label": title },
      h("h3", null, title, rows.length ? h("span", { class: "count", text: String(rows.length) }) : null),
      rows.length ? h("ul", { class: "ilist" }, rows) : h("p", { class: "empty", text: o.empty }));
  }
  function itemRow(n, why, tone, extra) {
    return irow({ title: C.label(n), open: opener(n.id), chips: why ? [chip(why, tone)] : [], sub: stageText(n.id), extra });
  }
  function studentHome(now) {
    const s = A.withStudent;
    const doNext = A.actions.filter(a => a.kind !== "comment").slice(0, 3).map((a, i) => actionRow(a, i + 1));
    const waiting = []
      .concat(s.changes.map(f => irow({ title: C.label(f.node), open: opener(f.node.id), chips: [chip(f.flag.kind === "invalidated" ? "Redo" : "Changes requested", "warn")], quote: f.flag.note })))
      .concat(s.discuss.map(f => irow({ title: C.label(f.node), open: opener(f.node.id), chips: [chip("To discuss", "amber")], quote: f.flag.note })))
      .concat(s.comments.map(u => irow({ title: C.label(u.node), open: opener(u.node.id, "comments"), chips: [chip("Reply", "blue")], quote: u.comment.text })))
      .concat(s.decisions.map(d => irow({ title: d.text, open: () => setView("meetings"), chips: [chip("Decide", "amber")] })))
      .concat(A.pendingMeetings.filter(m => !C.sameActor(m, whoAmI())).map(m => irow({ title: "Meeting " + C.fmtWhen(m.at), open: () => setView("meetings"), chips: [chip("Confirm?", "amber")] })))
      .concat(A.staleClaims.map(c => irow({ title: C.clip(c.claim.text, 120), open: () => setView("manuscript"), chips: [chip("Claim to recheck", "warn")] })));
    const withGuide = A.awaitingReview.map(r => itemRow(r.node, r.days ? C.plural(r.days, "day") : "Sent today", r.days >= 3 ? "amber" : "blue"))
      .concat(A.needsDiscussion.map(f => itemRow(f.node, "To discuss", "amber")));
    return [
      homeCard("Do next", doNext, { primary: true, always: true, empty: "You're all caught up. Open Items to start something new." }),
      homeCard("Waiting for you", waiting),
      homeCard("Coming up", comingUp(now)),
      homeCard("With your guide", withGuide)
    ];
  }
  function guideHome(now) {
    const w = canWrite();
    const review = A.awaitingReview.map(r => irow({ title: C.label(r.node), open: opener(r.node.id),
      chips: [chip(r.days ? "Waiting " + C.plural(r.days, "day") : "Sent today", r.days >= 3 ? "warn" : "blue")],
      quote: itemOf(r.node.id).note && itemOf(r.node.id).note.text,
      extra: w ? h("div", { style: "margin-top:8px" }, reviewControls(r.node.id)) : null }));
    const input = []
      .concat(A.needsDiscussion.map(f => irow({ title: C.label(f.node), open: opener(f.node.id), chips: [chip("To discuss", "amber")], quote: f.flag.note,
        extra: w ? h("div", { style: "margin-top:8px" }, reviewControls(f.node.id)) : null })))
      .concat(A.withGuide.decisions.map(d => irow({ title: d.text, open: () => setView("meetings"), chips: [chip("Decide", "amber")] })))
      .concat(A.withGuide.comments.map(u => irow({ title: C.label(u.node), open: opener(u.node.id, "comments"), chips: [chip("Reply", "blue")], quote: u.comment.text })))
      .concat(A.withGuide.specs.map(n => itemRow(n, "Write the deliverable", "warn")))
      .concat(A.readyToCheck.map(n => irow({ title: C.label(n), open: opener(n.id), chips: [chip("Ready to check", "blue")],
        actions: w ? [btn("Independently checked", () => act(n.id, "verify", { to: "independent" }), "ok")] : [] })))
      .concat(A.blocked.map(b => irow({ title: C.label(b.node), open: opener(b.node.id), chips: [chip("Blocked", "warn")], quote: b.info.reason })))
      .concat(A.pendingMeetings.filter(m => !C.sameActor(m, whoAmI())).map(m => irow({ title: "Meeting " + C.fmtWhen(m.at), open: () => setView("meetings"), chips: [chip("Confirm?", "amber")] })));
    const withStudent = A.changesRequested.map(f => itemRow(f.node, f.flag.kind === "invalidated" ? "Being redone" : "Changes requested", "")) ;
    return [
      homeCard("Review now", review, { primary: true, always: true, empty: "Nothing is waiting for your review." }),
      homeCard("Needs your input", input),
      homeCard("Coming up", comingUp(now)),
      homeCard("With your student", withStudent)
    ];
  }
  function comingUp(now) {
    return A.deadlines.filter(d => C.dayDiff(d.due, now) <= 14).slice(0, 6).map(d => {
      const dd = C.dayDiff(d.due, now);
      return irow({ title: d.task ? d.task.text : C.label(d.node), open: d.node ? opener(d.node.id, d.task ? "tasks" : null) : null,
        chips: [chip(C.dueLabel(d.due, now), dd < 0 ? "warn" : dd <= 3 ? "amber" : "")] });
    });
  }
  function reasonTone(r) {
    if (/Overdue|Changes requested|invalidated|Redo|Waiting [3-9]|Waiting \d\d|not written/.test(r)) return "warn";
    if (/Due|discuss|Critical|Decision|Waiting/.test(r)) return "amber";
    if (/review|plan|meeting|send|check/i.test(r)) return "blue";
    return "";
  }
  function actionRow(a, rank) {
    const title = a.kind === "task" || a.kind === "log" || a.kind === "decision" || a.kind === "question" ? a.title : C.label(a.node);
    let open = null;
    if (a.kind === "task") open = a.node ? opener(a.node.id, "tasks") : null;
    else if (a.kind === "log") open = () => setView("log");
    else if (a.kind === "decision" || a.kind === "question") open = () => setView("meetings");
    else open = opener(a.node.id, a.kind === "comment" ? "comments" : null);
    return irow({ rank, title, open, chips: a.reasons.slice(0, 2).map(r => chip(r, reasonTone(r))) });
  }
  // Theory vs Numerics, shown on the Items page when someone opens it.
  function syncTable() {
    const s = A.sync; if (!s || !s.pairs.length) return null;
    const verdict = p => p.status === "in-step" ? "In step" : p.status === "a-ahead" ? pretty(s.A.title) + " ahead"
      : p.status === "b-ahead" ? pretty(s.B.title) + " ahead" : pretty(s.B.title) + " started first";
    const cell = n => n.children.length ? h("span", { class: "muted small", text: C.leavesOf(n).filter(l => C.isApproved(st, l.id)).length + "/" + C.leavesOf(n).length + " approved" }) : stagePill(n.id);
    return h("div", { class: "tablewrap" }, h("table", { class: "sync" },
      h("thead", null, h("tr", null, h("th", { text: "Item" }), h("th", { text: pretty(s.A.title) }), h("th", { text: pretty(s.B.title) }), h("th", { text: "" }))),
      h("tbody", null, s.pairs.map(p => h("tr", { class: p.status === "in-step" ? "" : p.status === "b-without-a" ? "alarm" : "off" },
        h("td", null, h("button", { class: "linkbtn", type: "button", style: "font-weight:500", text: p.name, onclick: opener(p.a.id) })),
        h("td", null, cell(p.a)), h("td", null, cell(p.b)), h("td", { class: "verdict", text: verdict(p) }))))));
  }


  /* =================================================================== Outline */
  function renderOutline(root) {
    if (!built.outline) buildOutline(root);
    updateTree();
    renderActivity();
  }
  function buildOutline(root) {
    root.textContent = "";
    const segs = [["all", "All"], ["open", "To do"], ["review", "With guide"], ["done", "Approved"]];
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Show" }, segs.map(([k, t]) => h("button", { type: "button", "aria-pressed": String(filter === k), dataset: { f: k }, text: t,
      onclick: () => { filter = k; $$(".seg button", root).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.f === k))); updateTree(); } })));
    const search = h("input", { class: "search", type: "search", id: "q", placeholder: "Find an item   /", "aria-label": "Find an item", autocomplete: "off" });
    search.value = query;
    search.addEventListener("input", () => { query = search.value; updateTree(); });
    search.addEventListener("keydown", ev => { if (ev.key === "Escape") { search.value = ""; query = ""; updateTree(); search.blur(); } });
    const tree = h("div", { id: "tree" });
    const aside = h("aside", { class: "aside" }, h("h3", { text: "Recent activity" }), h("ul", { class: "act", id: "activity" }),
      h("div", { class: "legend" }, h("span", { text: "Click an item to open it. An item is done once your guide approves it." })));
    const sync = syncTable();
    const syncFold = sync ? fold("sync", "Theory and Numerics side by side" + (A.sync.outOfStep ? " · out of step on " + C.plural(A.sync.outOfStep, "item") : " · in step"), sync, "fold sub sync-fold") : null;
    root.append(h("div", { class: "toolbar" }, seg, search,
      h("button", { class: "btn ghost small", type: "button", text: "Expand all", onclick: () => { for (const n of idx.nodes.values()) if (n.children.length && n.id !== "root") expanded.add(n.id); saveExpanded(); updateTree(); } }),
      h("button", { class: "btn ghost small", type: "button", text: "Collapse all", onclick: () => { expanded = new Set(); saveExpanded(); updateTree(); } })),
      syncFold, h("div", { class: "layout" }, tree, aside));
    buildTree(tree);
    built.outline = true;
  }
  const saveExpanded = () => LS.set("rt:expanded:" + project.id, [...expanded]);
  function buildTree(main) {
    main.textContent = ""; els.clear();
    const saved = LS.get("rt:expanded:" + project.id, null);
    expanded = new Set(saved || [...idx.nodes.values()].filter(n => n.children.length && n.id !== "root").map(n => n.id));
    for (const p of idx.pillars) {
      const sec = h("section", { class: "pillar", id: "p-" + p.id });
      sec.append(...makeRow(p, true));
      const ul = h("ul", { class: "kids" }); p.children.forEach(c => ul.append(makeNode(c)));
      sec.append(ul); els.get(p.id).kids = ul; main.append(sec);
    }
    main.append(h("p", { class: "empty", id: "noMatch", hidden: true, text: "No items match. Clear the search or the filter." }));
  }
  function makeRow(n, isPillar) {
    const ind = isPillar ? 0 : (n.depth - 1) * 22;
    const row = h("div", { class: isPillar ? "prow row" : "row", style: "--ind:" + ind + "px" });
    const tw = h("button", { class: "tw", type: "button" });
    if (n.children.length && !isPillar) { tw.append(svg(ICON.chev)); tw.setAttribute("aria-label", "Show or hide the items under " + pretty(n.title)); tw.onclick = () => { expanded.has(n.id) ? expanded.delete(n.id) : expanded.add(n.id); saveExpanded(); updateTree(); }; }
    else { tw.tabIndex = -1; tw.setAttribute("aria-hidden", "true"); tw.disabled = true; }
    // A status mark, not a checkbox: an item is done when it's approved, never by ticking it.
    const sg = h("span", { class: "sg", role: "img" }); sg.append(svg(ICON.ck));
    const title = h("button", { class: "title", type: "button", text: pretty(n.title), "aria-expanded": "false", onclick: () => toggleItem(n.id) });
    const chips = h("span", { class: "chips" });
    const tt = h("div", { class: "tt" }, title, chips);
    if (n.detail) { const d = h("div", { class: "detail muted small" }); d.textContent = n.detail; tt.append(d); }
    const meta = h("div", { class: "meta" });
    let pct = null, mini = null, spill = null;
    if (n.children.length) { pct = h("span", { class: "pct", title: "Average position along the workflow" }); mini = h("span", { class: "mini" }, h("i")); meta.append(pct, mini); }
    else { spill = h("span", { class: "spill" }); meta.append(spill); }
    const cm = h("button", { class: "cm", type: "button", onclick: () => toggleItem(n.id, "comments") });
    cm.append(svg(ICON.bubble), h("span", { class: "n" }));
    meta.append(cm);
    row.append(tw, sg, tt, meta);
    const panel = h("div", { class: "ipanel", hidden: true, style: "--ind:" + ind + "px", role: "region", "aria-label": pretty(n.title) });
    els.set(n.id, { row, tw, sg, title, chips, pct, mini: mini && mini.firstChild, spill, cm, cmN: cm.lastChild, panel });
    return [row, panel];
  }
  function makeNode(n) {
    const li = h("li", { class: "node lvl" + n.depth + (n.children.length ? "" : " leaf") + (n.dlv ? " dlv" : ""), dataset: { id: n.id } });
    li.append(...makeRow(n, false));
    const e = els.get(n.id); e.li = li;
    if (n.children.length) {
      const ul = h("ul", { class: "kids", style: "--ind:" + (n.depth - 1) * 22 + "px" });
      n.children.forEach(c => ul.append(makeNode(c))); li.append(ul); e.kids = ul;
    }
    return li;
  }
  function updateTree() {
    if (!built.outline) return;
    const memo = new Map(), now = Date.now(), q = query.trim().toLowerCase();
    const cc = {}; for (const c of st.comments) cc[c.node] = (cc[c.node] || 0) + 1;
    const openTasks = {}; for (const t of st.tasks) if (!t.done) openTasks[t.node] = (openTasks[t.node] || 0) + 1;
    const passes = n => {
      if (n.children.length) return false;
      const it = itemOf(n.id);
      if (filter === "open") return it.review === "none" || it.review === "changes";
      if (filter === "review") return it.review === "submitted" || it.review === "discussion";
      if (filter === "flagged") return it.review === "changes" || it.review === "discussion" || !!it.blocked;
      if (filter === "unchecked") return C.posOf(it) !== null && C.posOf(it) >= S.PRODUCE && VIDX[it.verify] < VIDX.independent;
      if (filter === "done") return it.review === "approved";
      return true;
    };
    const visible = new Map();
    (function vis(n, inherited) {
      const hit = inherited || !q || (pretty(n.title) + " " + n.title).toLowerCase().indexOf(q) >= 0 || (C.crumb(n).toLowerCase().indexOf(q) >= 0 && !n.children.length);
      const kids = n.children.map(c => vis(c, inherited || (!!q && hit && n.id !== "root"))).some(Boolean);
      const self = n.id !== "root" && hit && (filter === "all" ? true : passes(n));
      visible.set(n.id, self || kids); return self || kids;
    })(idx.root, false);
    const filtering = filter !== "all" || !!q;
    let shown = 0;
    for (const [id, e] of els) {
      const n = idx.nodes.get(id); if (!n) continue;
      const leaf = !n.children.length, p = C.progress(n, st, memo);
      const done = leaf ? C.isApproved(st, id) : C.leavesOf(n).every(l => C.isApproved(st, l.id));
      const ph = leaf ? C.phaseOf(st, id) : done ? "approved" : p > 0 ? "work" : "none";
      e.sg.className = "sg ph-" + ph + (leaf ? "" : " sec");
      e.sg.setAttribute("aria-label", leaf ? stageText(id) : done ? "Everything under it approved" : pctText(p) + " along the workflow");
      if (e.li) { e.li.hidden = !visible.get(id); e.li.classList.toggle("done", done); e.li.classList.toggle("approved", leaf && done); if (leaf && visible.get(id)) shown++; }
      if (!leaf) { e.pct.textContent = pctText(p); e.mini.style.width = (p * 100) + "%"; }
      else { e.spill.className = "spill ph-" + ph; e.spill.textContent = stageText(id); }
      rowChips(e.chips, id, leaf, now);
      const nC = cc[id] || 0;
      e.cmN.textContent = nC ? String(nC) : ""; e.cm.classList.toggle("has", nC > 0);
      e.cm.setAttribute("aria-label", nC ? C.plural(nC, "comment") + " on " + pretty(n.title) : "Comment on " + pretty(n.title));
      if (e.kids && n.depth > 0) { const open = filtering || expanded.has(id); e.kids.hidden = !open; e.tw.setAttribute("aria-expanded", String(open)); }
      const isOpen = openItem === id;
      e.row.classList.toggle("open", isOpen); e.title.setAttribute("aria-expanded", String(isOpen)); e.panel.hidden = !isOpen;
    }
    const nm = $("#noMatch"); if (nm) nm.hidden = !filtering || shown > 0;
    if (openItem && els.has(openItem)) renderItemPanel(openItem);
  }
  function rowChips(box, id, leaf, now) {
    box.textContent = "";
    if (!leaf) return;
    const it = itemOf(id);
    if (it.critical) box.append(chip("★", "amber", "Critical"));
    const f = C.flagOf(st, id);
    if (f) box.append(chip(f.kind === "invalidated" ? "Redo" : f.status === "changes_requested" ? "Changes" : "Discuss", f.status === "changes_requested" ? "warn" : "amber", f.note || ""));
    if (it.blocked) box.append(chip("Blocked", "warn", it.blocked.reason));
    const due = C.dueMs(it.due);
    if (due && it.review !== "approved") { const d = C.dayDiff(due, now); if (d <= 14) box.append(chip(d < 0 ? "Overdue" : d === 0 ? "Due today" : "Due " + C.fmtDate(due), d < 0 ? "warn" : d <= 3 ? "amber" : "", C.dueLabel(due, now))); }
  }
  function toggleItem(id, section) {
    if (openItem === id && !section) { openItem = null; writeHash(); updateTree(); const e = els.get(id); if (e) e.title.focus(); return; }
    openNode(id, section, true);
  }
  function openNode(id, section, keepFilter) {
    const n = idx.nodes.get(id);
    if (!n) { toast("That item isn't in the outline any more."); return; }
    let p = n.parent; while (p && p.id !== "root") { expanded.add(p.id); p = p.parent; }
    saveExpanded();
    if (!keepFilter && (filter !== "all" || query)) {
      filter = "all"; query = "";
      const q = $("#q"); if (q) q.value = "";
      $$("#view-outline .seg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.f === "all")));
    }
    openItem = id;
    if (view !== "outline") setView("outline"); else { writeHash(); render(); }
    const go = () => {
      const e = els.get(id); if (!e) return;
      const target = section ? e.panel.querySelector('[data-sec="' + section + '"]') : null;
      (target || e.row).scrollIntoView({ block: target ? "nearest" : "center", behavior: reduceMotion() ? "auto" : "smooth" });
      const field = section === "comments" ? e.panel.querySelector("textarea[data-key^='c:']") : section === "tasks" ? e.panel.querySelector("input[data-key^='tt:']")
        : section === "spec" ? e.panel.querySelector("textarea[data-key^='spec:']") : null;
      (field || e.title).focus({ preventScroll: true });
      if (!reduceMotion() && e.row.animate) e.row.animate([{ boxShadow: "inset 3px 0 0 var(--accent)" }, { boxShadow: "inset 3px 0 0 transparent" }], { duration: 1400 });
    };
    (window.requestAnimationFrame || setTimeout)(go);
  }

  /* ---------- the item panel: status and the one next step first, everything else folded ---------- */
  function renderItemPanel(id) {
    const e = els.get(id), n = idx.nodes.get(id), leaf = !n.children.length;
    e.panel.textContent = "";
    if (leaf) {
      e.panel.append(statusSection(n), specSection(n), checksSection(n), detailsSection(n), commentsSection(n),
        tasksFold(n), moreOptions(n));
    } else e.panel.append(sectionSection(n), commentsSection(n));
    const hist = historySection(n); if (hist) e.panel.append(hist);
    if (/\$/.test(e.panel.textContent)) typeset(e.panel);
  }
  const specEditing = id => openEdits.has("spec:" + id);

  function statusSentence(it) {
    if (it.review === "approved") return { text: "Approved", tone: "ok" };
    if (it.review === "submitted") return { text: role === "guide" ? "Waiting for your review" : "With your guide for review", tone: "blue" };
    if (it.review === "discussion") return { text: "With your guide · to discuss", tone: "amber" };
    if (it.review === "changes") return { text: it.note && it.note.kind === "invalidated" ? "Result marked wrong · redo it" : "Changes requested", tone: "warn" };
    if (it.stage === null) return { text: "Not started", tone: "" };
    return { text: "In progress · " + STAGES[it.stage], tone: "" };
  }
  // The status, who said what, the progress strip, and the single obvious next step.
  function statusSection(n) {
    const id = n.id, it = itemOf(id), can = canWrite() ? C.actionsFor(it, role) : {}, pos = C.posOf(it), s = statusSentence(it);
    const box = h("div", { class: "status-box " + s.tone, dataset: { sec: "status" } },
      h("div", { class: "status-line" }, h("span", { class: "status-text", text: s.text }),
        it.reviewAt && it.review !== "none" ? h("span", { class: "muted small", text: C.ago(it.reviewAt, A.now) }) : null));
    if (it.note && it.note.kind === "legacy") box.append(h("div", { class: "rb-note", text: role === "guide" ? it.note.text
      : "Carried over from the old tracker, where it was marked done. It's waiting for your guide to approve it. To keep working on it instead, take it back." }));
    else if (it.note && it.note.text && it.review !== "none") box.append(h("div", { class: "rb-note" }, it.note.text, h("span", { class: "rb-meta", text: " — " + nameOf(it.note) })));
    // progress strip: the five work steps, then review and approval
    box.append(h("ol", { class: "strip", "aria-label": "Progress" }, STAGES.map((label, k) => {
      const work = k <= C.LAST_WORK, done = pos !== null && k < pos, cur = k === pos;
      const clickable = work && can.stage && k !== it.stage;
      return h("li", { class: (done ? "done" : "") + (cur ? " cur" : "") }, clickable
        ? h("button", { type: "button", title: "Set the stage to " + label, onclick: () => act(id, "stage", { to: k }), text: label })
        : h("span", { text: label }));
    })));
    // the next step
    const row = h("div", { class: "next" });
    if (role === "student" && canWrite() && (it.review === "none" || it.review === "changes")) {
      if (it.stage === null) row.append(btn("Start: " + STAGES[0], () => act(id, "stage", { to: 0 }), "primary"));
      else if (it.stage < C.LAST_WORK) row.append(btn("Done with " + STAGES[it.stage] + " → " + STAGES[it.stage + 1], () => act(id, "stage", { to: it.stage + 1 }), "primary"));
      else {
        const why = C.check(it, "submit", {}, role);
        const sub = noteForm("sub:" + id, { label: "Note for your guide", placeholder: "Anything your guide should look at first? (optional)", sendText: "Send", onSend: t => act(id, "submit", { note: t }) });
        row.append(h("button", { class: "btn primary small", type: "button", text: it.review === "changes" ? "Send for review again" : "Send for review", disabled: !!why, title: why || null, onclick: () => act(id, "submit", {}) }),
          why ? null : h("button", { class: "linkbtn small", type: "button", text: "add a note", onclick: sub.open }));
        box.append(row, sub.form);
        if (why) box.append(h("p", { class: "hintline", text: why }));
        return box;
      }
    } else if (role === "guide" && canWrite() && (it.review === "submitted" || it.review === "discussion")) {
      row.append(reviewControls(id));
    } else if (role === "student" && can.withdraw) {
      row.append(btn("Take it back to keep working", () => act(id, "withdraw", {})), h("span", { class: "muted small", text: "or wait for your guide to reply. The stages are locked while it's with your guide." }));
    } else if (role === "guide" && it.review !== "approved") {
      row.append(h("span", { class: "muted small", text: it.review === "changes" ? "Back with your student. It returns to you when they send it again." : "Your student sends it for review when it's ready." }));
    }
    if (row.childNodes.length) box.append(row);
    return box;
  }
  // What the item must produce, written by the guide.
  function specSection(n) {
    const id = n.id, it = itemOf(id), guide = role === "guide" && canWrite(), spec = it.spec || {};
    const box = h("div", { class: "spec" + (C.hasSpec(it) ? "" : " missing"), dataset: { sec: "spec" } });
    box.append(h("div", { class: "sec-h" }, h("h4", { text: "What to deliver" }), h("span", { class: "grow" }),
      guide && !specEditing(id) ? btn(C.hasSpec(it) ? "Edit" : "Write it", () => { openEdits.add("spec:" + id); schedule(); }, C.hasSpec(it) ? "ghost" : "primary") : null));
    if (guide && specEditing(id)) {
      const key = k => "spec:" + id + ":" + k;
      const field = (k, label, ph, rows) => {
        const ta = h("textarea", { rows: String(rows || 3), "aria-label": label, placeholder: ph, dataset: { key: key(k) }, maxlength: "4000" });
        ta.value = drafts.has(key(k)) ? drafts.get(key(k)) : (spec[k] || "");
        ta.addEventListener("input", () => drafts.set(key(k), ta.value));
        return h("label", { class: "field" }, h("span", { text: label }), ta);
      };
      const clear = () => { for (const k of ["what", "acceptance", "artifacts"]) drafts.delete(key(k)); openEdits.delete("spec:" + id); };
      box.append(h("div", { class: "form" },
        field("what", "What exactly to produce", "e.g. |β_k|² for the free field across the transition, k from 10⁻³ to 10² H.", 3),
        field("acceptance", "How you'll judge it (optional)", "e.g. reproduces the sudden-transition limit; independent of the initial time to 1%.", 2),
        field("artifacts", "What to hand in (optional)", "e.g. notebook and one figure", 1),
        h("div", { class: "formbtns" },
          btn("Cancel", () => { clear(); schedule(); }, "ghost"),
          btn("Save", async () => {
            const v = k => (drafts.has(key(k)) ? drafts.get(key(k)) : (spec[k] || ""));
            if (await act(id, "spec", { what: v("what"), acceptance: v("acceptance"), artifacts: v("artifacts") }, { quiet: true })) { clear(); toast("Saved."); schedule(); }
          }, "primary"))));
      return box;
    }
    if (C.hasSpec(it)) {
      box.append(h("p", { class: "spec-what", text: spec.what }));
      if (spec.acceptance) box.append(h("p", { class: "spec-more" }, h("b", { text: "Judged by: " }), spec.acceptance));
      if (spec.artifacts) box.append(h("p", { class: "spec-more" }, h("b", { text: "Hand in: " }), spec.artifacts));
    } else box.append(h("p", { class: "muted small", text: role === "guide" ? "Not written yet. A few lines here save a lot of back-and-forth." : "Your guide hasn't written this yet." }));
    return box;
  }
  // How far the result has been checked: one dropdown.
  function checksSection(n) {
    const id = n.id, it = itemOf(id), can = canWrite() ? C.actionsFor(it, role) : { verifyTo: [] }, cur = VIDX[it.verify];
    const pendKey = "vdown:" + id;
    const down = noteForm(pendKey, { label: "Why the earlier check no longer holds", placeholder: "Why doesn't the earlier check hold any more?", sendText: "Lower it", required: true, sendCls: "warn",
      onSend: async t => { const to = drafts.get(pendKey + ":to"); const ok = await act(id, "verify", { to, note: t }); if (ok) drafts.delete(pendKey + ":to"); return ok; } });
    const sel = h("select", { class: "checksel", "aria-label": "Checks", disabled: !can.verifyTo.length, "data-defer": "" },
      VERIFY.map((v, k) => h("option", { value: v.key, disabled: k !== cur && can.verifyTo.indexOf(v.key) < 0, text: v.label + (k > C.STUDENT_VERIFY_MAX && role === "student" ? " (guide)" : "") })));
    sel.value = it.verify;
    sel.addEventListener("change", () => {
      const to = sel.value;
      if (VIDX[to] < cur) { drafts.set(pendKey + ":to", to); down.open(); }
      else act(id, "verify", { to });
    });
    return h("div", { class: "row-field", dataset: { sec: "verify" } },
      h("span", { class: "rf-label", text: "Checks" }), sel,
      h("span", { class: "muted small rf-help", text: VERIFY[cur].help }), down.form);
  }
  function detailsSection(n) {
    const id = n.id, it = itemOf(id), ro = !canWrite();
    const due = h("input", { type: "date", disabled: ro, "aria-label": "Due date", "data-defer": "" });
    due.value = it.due || "";
    due.addEventListener("change", () => act(id, "due", { due: due.value || null }));
    const link = h("input", { type: "url", inputmode: "url", disabled: ro, "aria-label": "Notebook or file link", "data-defer": "", placeholder: "Paste a link to the notebook or file" });
    link.value = it.link || "";
    link.addEventListener("change", () => setLink(id, link.value));
    link.addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); link.blur(); } });
    const open = safeUrl(it.link) ? h("a", { class: "btn small", href: safeUrl(it.link), target: "_blank", rel: "noopener noreferrer", text: "Open ↗" }) : null;
    const blocked = it.blocked ? h("div", { class: "reviewbox warn", style: "grid-column:1/-1" }, h("div", { class: "rb-note" }, h("b", { text: "Blocked: " }), it.blocked.reason),
      ro ? null : h("div", { class: "rc" }, btn("Unblock", () => act(id, "unblock", {})))) : null;
    return h("div", { class: "details" },
      h("label", { class: "row-field" }, h("span", { class: "rf-label", text: "Due" }), due),
      h("label", { class: "row-field" }, h("span", { class: "rf-label", text: "Link" }), link, open), blocked);
  }
  function tasksFold(n) {
    const open = st.tasks.filter(t => t.node === n.id && !t.done).length, all = st.tasks.filter(t => t.node === n.id).length;
    return fold("tasks:" + n.id, all ? "Tasks · " + open + " open" : "Tasks", tasksSection(n), "fold sub");
  }
  // Everything that isn't needed day to day.
  function moreOptions(n) {
    const id = n.id, it = itemOf(id), w = canWrite(), can = w ? C.actionsFor(it, role) : {}, guide = role === "guide" && w;
    if (!w) return null;
    const parts = [];
    if (!it.blocked && it.review !== "approved") {
      const key = "blk:" + id;
      const reason = h("input", { type: "text", placeholder: "What's in the way?", "aria-label": "What is blocking this item", dataset: { key }, maxlength: "300" });
      reason.value = drafts.get(key) || "";
      reason.addEventListener("input", () => { drafts.set(key, reason.value); reason.classList.remove("invalid"); });
      const go = async () => { const v = reason.value.trim(); if (!v) { reason.classList.add("invalid"); reason.focus(); return; } if (await act(id, "block", { reason: v })) drafts.delete(key); };
      reason.addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); go(); } });
      parts.push(h("div", { class: "opt" }, h("span", { class: "opt-l", text: "Stuck?" }), h("div", { class: "inline" }, reason, btn("Mark blocked", go))));
    }
    parts.push(h("div", { class: "opt" }, h("label", { class: "toggle" }, h("input", { type: "checkbox", checked: !!it.critical, onchange: ev => act(id, "critical", { on: ev.target.checked }) }),
      h("span", { text: "Critical (a key uncertainty, or on the critical path)" }))));
    const btns = [];
    if (can.stage && it.stage !== null) btns.push(btn("Reset to not started", () => act(id, "stage", { to: null }), "ghost"));
    let inv = null;
    if (can.invalidate) {
      inv = noteForm("inv:" + id, { label: "What's wrong with the result", placeholder: "What's wrong with it? It goes back for redoing and its checks are cleared.", sendText: "Mark result wrong", required: true, sendCls: "warn",
        onSend: t => act(id, "invalidate", { note: t }) });
      btns.push(btn("The result is wrong…", inv.open, "warn"));
    }
    let reopen = null;
    if (guide && it.review === "approved") {
      reopen = noteForm("chg:" + id, { label: "What needs to change", placeholder: "What needs to change?", sendText: "Reopen", required: true, sendCls: "warn", onSend: t => act(id, "changes", { note: t }) });
      btns.push(btn("Reopen…", reopen.open, "warn"));
    }
    if (n.dlv && guide) btns.push(btn("Rename", () => { openEdits.add("ren:" + id); openDetails.add("more:" + id); schedule(); }), btn("Archive", () => archiveDeliverable(n), "ghost"));
    if (btns.length) parts.push(h("div", { class: "rc" }, btns));
    if (inv) parts.push(inv.form);
    if (reopen) parts.push(reopen.form);
    if (openEdits.has("ren:" + id) && guide) parts.push(renameForm(n));
    if (guide) parts.push(h("div", { class: "opt" }, h("span", { class: "opt-l", text: "Split it into smaller deliverables" }), addDeliverableForm(n, true)));
    return fold("more:" + id, "More options", h("div", { class: "opts" }, parts), "fold sub");
  }
  function renameForm(n) {
    const key = "ren:" + n.id, inp = h("input", { type: "text", maxlength: "200", "aria-label": "New title", dataset: { key } });
    inp.value = drafts.has(key) ? drafts.get(key) : n.title;
    inp.addEventListener("input", () => drafts.set(key, inp.value));
    const go = async () => { const v = inp.value.trim(); if (!v) { inp.classList.add("invalid"); return; } if (await renameDeliverable(n, v)) { drafts.delete(key); openEdits.delete(key); schedule(); } };
    inp.addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); go(); } if (ev.key === "Escape") { drafts.delete(key); openEdits.delete(key); schedule(); } });
    return h("div", { class: "addrow", style: "margin-bottom:8px" }, inp, btn("Save", go, "primary"), btn("Cancel", () => { drafts.delete(key); openEdits.delete(key); schedule(); }, "ghost"));
  }
  function addDeliverableForm(n, fromLeaf) {
    const key = "add:" + n.id, inp = h("input", { type: "text", maxlength: "200", placeholder: "Title of the deliverable, e.g. Mode functions in the WKB basis", "aria-label": "New deliverable title", dataset: { key } });
    inp.value = drafts.get(key) || "";
    inp.addEventListener("input", () => { drafts.set(key, inp.value); inp.classList.remove("invalid"); });
    const go = async () => { const v = inp.value.trim(); if (!v) { inp.classList.add("invalid"); inp.focus(); return; } if (await addDeliverable(n, v)) { drafts.delete(key); inp.value = ""; } };
    inp.addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); go(); } });
    const it = fromLeaf ? itemOf(n.id) : null;
    const warn = it && (it.stage !== null || it.review !== "none") ? h("p", { class: "warnline", text: "This item has its own progress (" + stageText(n.id) + "). Once it has deliverables under it, it becomes a section: its own stage stops counting and progress comes from the new deliverables. Its history and comments stay." }) : null;
    return h("div", { class: "form" }, warn, h("div", { class: "addrow" }, inp, btn("Add deliverable", go, "primary")));
  }
  // The panel for a section: its deliverables (the guide can add more), archived ones, comments.
  function sectionSection(n) {
    const guide = role === "guide" && canWrite(), leaves = C.leavesOf(n);
    const approved = leaves.filter(l => C.isApproved(st, l.id)).length, withGuide = leaves.filter(l => C.stageIdx(st, l.id) === S.REVIEW).length;
    const box = h("div", { dataset: { sec: "spec" } }, h("h4", { text: "Section" }),
      h("p", { class: "muted small", text: C.plural(leaves.length, "deliverable") + " · " + approved + " approved · " + withGuide + " with the guide" }));
    if (n.dlv && guide) box.append(h("div", { class: "rc", style: "margin-top:8px" }, btn("Rename", () => { openEdits.add("ren:" + n.id); schedule(); }, "ghost"), btn("Archive", () => archiveDeliverable(n), "ghost")));
    if (openEdits.has("ren:" + n.id) && guide) box.append(renameForm(n));
    if (guide) box.append(h("div", { style: "margin-top:12px" }, h("h4", { text: "Add a deliverable here" }), addDeliverableForm(n, false)));
    const arch = st.deliverables.filter(d => d.archived && d.parent === n.id);
    if (arch.length) box.append(fold("arch:" + n.id, "Archived deliverables · " + arch.length, h("ul", { class: "ilist" }, arch.map(d => irow({ title: d.title, sub: "Archived",
      actions: guide ? [btn("Restore", () => restoreDeliverable(d))] : [] })))));
    return box;
  }
  // Where the item is in the workflow, and the review moves that are open to you right now.
  function tasksSection(n) {
    const id = n.id, ro = !canWrite(), now = Date.now();
    const list = st.tasks.filter(t => t.node === id).sort((a, b) => (a.done - b.done) || ((C.dueMs(a.due) || Infinity) - (C.dueMs(b.due) || Infinity)) || a.at - b.at);
    const open = list.filter(t => !t.done).length;
    const ul = list.length ? h("ul", { class: "tasks" }, list.map(t => {
      const dm = C.dueMs(t.due), d = dm ? C.dayDiff(dm, now) : null;
      return h("li", { class: "task" + (t.done ? " done" : "") },
        h("input", { type: "checkbox", checked: !!t.done, disabled: ro, "aria-label": "Done: " + t.text, onchange: ev => toggleTask(t, ev.target.checked) }),
        h("span", { class: "ttext", text: t.text }),
        dm && !t.done ? h("span", { class: "tdue" + (d < 0 ? " late" : ""), text: C.dueLabel(dm, now) }) : null,
        ro ? null : h("button", { class: "x", type: "button", text: "Remove", "aria-label": "Remove task: " + t.text, onclick: () => removeTask(t) }));
    })) : null;
    let add = null;
    if (!ro) {
      const key = "tt:" + id, dr = drafts.get(key) || { text: "", due: "" };
      const txt = h("input", { type: "text", placeholder: "Add a task, e.g. check the sign of the cross term", "aria-label": "New task", dataset: { key }, maxlength: "300" });
      txt.value = dr.text;
      const due = h("input", { type: "date", "aria-label": "Task due date (optional)", "data-defer": "" }); due.value = dr.due;
      const keep = () => drafts.set(key, { text: txt.value, due: due.value });
      txt.addEventListener("input", keep); due.addEventListener("change", keep);
      const go = async () => { const v = txt.value.trim(); if (!v) { txt.focus(); return; } if (await addTask({ node: id, text: v, due: due.value || null })) drafts.delete(key); };
      txt.addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); go(); } });
      add = h("div", { class: "addrow" }, txt, due, btn("Add task", go));
    }
    return h("div", { dataset: { sec: "tasks" } }, ul,
      !list.length && ro ? h("p", { class: "muted small", text: "No tasks." }) : null, add);
  }
  function commentsSection(n) {
    const id = n.id, ro = !canWrite(), leaf = !n.children.length;
    const list = st.comments.filter(c => c.node === id).sort((a, b) => a.at - b.at);
    const box = h("div", { class: "clist" });
    const pr = me ? C.prefsFor(st, me.email) : C.DEFAULT_PREFS;
    if (!list.length) box.append(h("p", { class: "muted small", text: ro ? "No comments yet." : "No comments yet. Anything you write here, " + otherLabel() + " sees." }));
    for (const c of list) {
      const head = h("div", { class: "h" }, h("b", { text: nameOf(c) }), h("span", { text: C.ago(c.at, A.now), title: new Date(c.at).toLocaleString(C.LOCALE) }));
      if (!ro && leaf) head.append(c.taskId ? h("span", { class: "made", text: "✓ made into a task" }) : h("button", { class: "act", type: "button", text: "→ Make it a task", onclick: () => commentToTask(c) }));
      if (!ro && C.sameActor(c, whoAmI())) head.append(h("button", { class: "act del", type: "button", text: "Delete", onclick: () => deleteComment(c) }));
      box.append(h("div", { class: "c" }, avatar(c), h("div", null, head, h("div", { class: "txt", text: c.text }))));
    }
    let form = null;
    if (!ro) {
      const key = "c:" + id, saved = LS.get("rt:drafts", {});
      const ta = h("textarea", { rows: "2", placeholder: "Write a comment…", "aria-label": "Comment", dataset: { key }, maxlength: "4000" });
      ta.value = saved[id] || "";
      const post = h("button", { class: "btn primary", type: "submit", text: "Post", disabled: !ta.value.trim() });
      ta.addEventListener("input", () => { post.disabled = !ta.value.trim(); const d = LS.get("rt:drafts", {}); if (ta.value) d[id] = ta.value; else delete d[id]; LS.set("rt:drafts", d); });
      ta.addEventListener("keydown", ev => { if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); form.requestSubmit(); } });
      form = h("form", { class: "cform" }, ta, post);
      form.addEventListener("submit", async ev => {
        ev.preventDefault(); const text = ta.value.trim(); if (!text) return;
        post.disabled = true;
        const d = LS.get("rt:drafts", {}); delete d[id]; LS.set("rt:drafts", d);   // clear before the re-render the save triggers
        if (!(await addComment(id, text))) { d[id] = text; LS.set("rt:drafts", d); schedule(); }
      });
    }
    return h("div", { dataset: { sec: "comments" } }, h("h4", { text: "Comments" + (list.length ? " · " + list.length : "") }), box, form,
      form ? h("p", { class: "hint", text: "Ctrl or ⌘ + Enter to post" }) : null);
  }
  function historySection(n) {
    const evs = st.events.filter(e => e.node === n.id).sort((a, b) => b.at - a.at);
    if (!evs.length) return null;
    return fold("hist:" + n.id, "History · " + evs.length, h("ul", { class: "hlist" }, evs.slice(0, 80).map(e => h("li", null,
      h("time", { datetime: new Date(e.at).toISOString(), text: C.fmtDate(e.at) + " " + C.fmtTime(e.at) }), C.describeEvent(e, idx, nameOf)))), "hist");
  }
  function renderActivity() {
    const ul = $("#activity"); if (!ul) return;
    const items = [];
    for (const e of st.events) { const t = C.describeEvent(e, idx, nameOf); if (t) items.push({ at: e.at, x: e, text: t, node: e.node }); }
    for (const c of st.comments) items.push({ at: c.at, x: c, text: nameOf(c) + " commented on " + C.labelId(idx, c.node), node: c.node, quote: c.text });
    items.sort((a, b) => b.at - a.at);
    ul.textContent = "";
    if (!items.length) { ul.append(h("li", { class: "muted small", style: "display:block", text: "Changes by you and " + otherLabel() + " appear here." })); return; }
    for (const it of items.slice(0, 14)) {
      const can = it.node && idx.nodes.has(it.node);
      ul.append(h("li", null, avatar(it.x), h("div", null,
        can ? h("button", { class: "what", type: "button", style: "text-align:left", text: it.text, onclick: opener(it.node, it.quote ? "comments" : null) }) : h("div", { class: "what", text: it.text }),
        it.quote ? h("div", { class: "q", text: it.quote }) : null,
        h("div", { class: "when", text: C.ago(it.at, A.now) }))));
    }
  }

  function decideControls(d) {
    const key = "dec:" + d.id;
    const ta = h("textarea", { rows: "2", placeholder: "What was decided?", "aria-label": "Decision for: " + d.text, dataset: { key }, maxlength: "1000" });
    ta.value = drafts.get(key) || "";
    ta.addEventListener("input", () => { drafts.set(key, ta.value); ta.classList.remove("invalid"); });
    const go = async () => { const v = ta.value.trim(); if (!v) { ta.classList.add("invalid"); ta.focus(); return; } if (await recordDecision(d, v)) drafts.delete(key); };
    return h("div", { class: "rc-form", style: "margin-top:8px" }, ta, h("div", { class: "formbtns" }, btn("Record decision", go, "primary")));
  }
  /* =================================================================== Meetings */
  function renderMeetings(root) { if (!built.meetings) buildMeetings(root); updateMeetings(); }
  function localInput(ms) { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); }
  function buildMeetings(root) {
    root.textContent = "";
    const when = h("input", { type: "datetime-local", required: true, "aria-label": "Date and time" });
    const dur = h("select", { "aria-label": "Length" }, [30, 45, 60, 90].map(m => h("option", { value: String(m), text: m + " min" })));
    dur.value = "60";
    const agenda = h("textarea", { rows: "4", placeholder: "Agenda (optional), one topic per line", maxlength: "2000", "aria-label": "Agenda" });
    when.addEventListener("focus", () => { when.min = localInput(Date.now()); });
    when.addEventListener("input", () => when.classList.remove("invalid"));
    const form = h("form", { class: "form" },
      h("div", { class: "row2" }, h("label", null, h("span", { text: "Date & time" }), when), h("label", null, h("span", { text: "Length" }), dur)),
      h("label", null, h("span", { text: "Agenda" }), agenda),
      h("div", { class: "formbtns" }, btn("Insert open questions & reviews", () => {
        const lines = A.openQuestions.map(q => "• " + q.text).concat(A.awaitingReview.map(r => "• Review: " + C.label(r.node)), A.needsDiscussion.map(f => "• Discuss: " + C.label(f.node)));
        if (!lines.length) { toast("There are no open questions or reviews to insert."); return; }
        agenda.value = (agenda.value.trim() ? agenda.value.trim() + "\n" : "") + lines.join("\n"); agenda.focus();
      }, "ghost"), h("span", { class: "grow" }), h("button", { class: "btn primary", type: "submit", text: "Propose meeting" })));
    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      const at = when.value ? new Date(when.value).getTime() : NaN;
      if (isNaN(at)) { when.classList.add("invalid"); when.focus(); return; }
      if (at < Date.now() - 5 * 60000) { when.classList.add("invalid"); toast("Pick a time in the future.", { error: true }); when.focus(); return; }
      if (await proposeMeeting({ at, duration: parseInt(dur.value, 10) || 60, note: agenda.value.trim() })) { when.value = ""; agenda.value = ""; toast("Meeting proposed. " + (role === "guide" ? "Your student" : "Your guide") + " can confirm it here."); }
    });
    const qText = h("textarea", { rows: "2", placeholder: "A question to raise at the next meeting…", maxlength: "800", "aria-label": "New question" });
    const qForm = h("form", { class: "form" }, qText, h("div", { class: "formbtns" }, h("button", { class: "btn primary", type: "submit", text: "Add question" })));
    qText.addEventListener("keydown", ev => { if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); qForm.requestSubmit(); } });
    qForm.addEventListener("submit", async ev => { ev.preventDefault(); const v = qText.value.trim(); if (!v) { qText.focus(); return; } if (await addQuestion(v)) qText.value = ""; });
    const dText = h("textarea", { rows: "2", placeholder: "e.g. Use the adiabatic vacuum of order 4 throughout", maxlength: "800", "aria-label": "Decision" });
    const dForm = h("form", { class: "form" }, dText, h("div", { class: "formbtns" },
      h("button", { class: "btn", type: "submit", dataset: { kind: "request" }, text: role === "guide" ? "Ask your student to decide" : "Ask your guide to decide" }),
      h("button", { class: "btn primary", type: "submit", dataset: { kind: "record" }, text: "Record as decided" })));
    dForm.addEventListener("submit", async ev => {
      ev.preventDefault();
      const kind = (ev.submitter && ev.submitter.dataset.kind) || "record", v = dText.value.trim();
      if (!v) { dText.classList.add("invalid"); dText.focus(); return; }
      dText.classList.remove("invalid");
      if (await (kind === "request" ? requestDecision(v) : recordNewDecision(v))) dText.value = "";
    });
    root.append(h("div", { class: "grid2" },
      h("section", { class: "panel" }, h("h3", { text: "Meetings" }), h("div", { class: "mcards", id: "mtUpcoming" }), form, h("div", { id: "mtPast" })),
      h("section", { class: "panel" }, h("h3", null, "Questions for the next meeting", h("span", { class: "count", id: "qCount" })),
        h("div", { id: "qList" }), qForm, h("div", { id: "qDone" })),
      h("section", { class: "panel" }, h("h3", null, "Decisions", h("span", { class: "count", id: "dCount" })),
        h("p", { class: "panel-lede", text: "A requested decision is made by the other person. Recorded decisions are the project's memory of why things are the way they are." }),
        h("div", { id: "decOpen" }), dForm, h("div", { id: "decDone" })),
      h("section", { class: "panel" }, h("h3", { id: "prepTitle" }), h("div", { id: "prep" }))));
    built.meetings = true;
  }
  function updateMeetings() {
    const now = Date.now(), w = canWrite(), endOf = m => m.at + (m.duration || 30) * 60000;
    const upcoming = st.meetings.filter(m => endOf(m) >= now).sort((a, b) => a.at - b.at);
    const past = st.meetings.filter(m => endOf(m) < now).sort((a, b) => b.at - a.at);
    const up = $("#mtUpcoming"); up.textContent = "";
    if (!upcoming.length) up.append(h("p", { class: "muted small", text: "No upcoming meetings. Propose a time below." }));
    upcoming.forEach(m => up.append(meetingCard(m, false, w)));
    const pa = $("#mtPast"); pa.textContent = "";
    if (past.length) pa.append(fold("past-meetings", "Past meetings · " + past.length, h("div", { class: "mcards", style: "margin-top:10px" }, past.slice(0, 30).map(m => meetingCard(m, true, w))), "past"));

    $("#qCount").textContent = String(A.openQuestions.length); $("#qCount").className = "count" + (A.openQuestions.length ? "" : " zero");
    const ql = $("#qList"); ql.textContent = "";
    if (!A.openQuestions.length) ql.append(h("p", { class: "muted small", text: "No open questions. Add them as they come up, so the meeting has an agenda." }));
    A.openQuestions.forEach(q => ql.append(questionItem(q, w)));
    const answered = st.questions.filter(q => q.answered).sort((a, b) => (b.answeredAt || b.at) - (a.answeredAt || a.at));
    const qd = $("#qDone"); qd.textContent = "";
    if (answered.length) qd.append(fold("answered", "Answered · " + answered.length, h("div", { style: "margin-top:8px" }, answered.slice(0, 40).map(q => questionItem(q, w))), "past"));

    $("#dCount").textContent = String(A.openDecisions.length); $("#dCount").className = "count" + (A.openDecisions.length ? "" : " zero");
    const dop = $("#decOpen"); dop.textContent = "";
    A.openDecisions.forEach(d => {
      const mine = C.sameActor(d, whoAmI());
      dop.append(h("div", { class: "qcard" }, h("div", { style: "flex:1;min-width:0" },
        h("div", { class: "qtext", text: d.text }), h("div", { class: "qmeta", text: "Asked by " + nameOf(d) + " · " + C.ago(d.at, A.now) + (mine ? " · waiting for " + otherLabel() : "") }),
        w && !mine ? decideControls(d) : null)));
    });
    const dd = $("#decDone"); dd.textContent = "";
    if (A.decided.length) dd.append(fold("decided", "Decision record · " + A.decided.length, h("div", { style: "margin-top:8px" }, A.decided.map(d => h("div", { class: "qcard" },
      h("div", { style: "flex:1;min-width:0" }, h("div", { class: "qtext", text: C.decisionText(d) }),
        d.decision && d.text && d.decision !== d.text ? h("div", { class: "qmeta", text: "On: " + d.text }) : null,
        h("div", { class: "qmeta", text: (d.decidedBy ? nameOf({ by: d.decidedBy, name: d.decidedName }) : nameOf(d)) + " · " + C.fmtDate(d.decidedAt || d.at, true) }))))), "past"));

    $("#prepTitle").textContent = A.lastMeeting ? "Since the last meeting (" + C.fmtDay(A.lastMeeting.at) + ")" : "This week, for the next meeting";
    const prep = $("#prep"); prep.textContent = "";
    const approvals = st.events.filter(e => e.type === "approve" && e.at > A.sinceRef);
    prep.append(h("div", { class: "subhead", text: "New results" }), ilist(A.resultsSince.map(n => irow({ title: C.label(n), open: opener(n.id), chips: [stagePill(n.id), verifyChip(n.id)] })), "None yet."),
      h("div", { class: "subhead", text: "Approved" }), ilist(approvals.map(e => irow({ title: C.labelId(idx, e.node), open: idx.nodes.has(e.node) ? opener(e.node) : null, sub: nameOf(e) + " · " + C.ago(e.at, A.now) })), "Nothing approved."),
      h("div", { class: "subhead", text: "Still open" }), h("p", { class: "muted small", text: [C.plural(A.awaitingReview.length, "item") + " awaiting review", C.plural(A.changesRequested.length, "change request"), C.plural(A.blocked.length, "blocker"), C.plural(A.withGuide.decisions.length + A.withStudent.decisions.length, "open decision")].join(" · ") }));
  }
  function meetingCard(m, past, w) {
    const mine = C.sameActor(m, whoAmI()), end = m.at + (m.duration || 30) * 60000;
    const status = m.status === "confirmed" ? chip(past ? "Held" : "Confirmed", "ok") : m.status === "declined" ? chip("Declined", "warn")
      : past ? chip("Never confirmed") : chip(mine ? "Waiting for a reply" : "Needs your reply", mine ? "" : "amber");
    const acts = [];
    if (w && !past) {
      if (m.status === "proposed") { if (mine) acts.push(btn("Withdraw", () => cancelMeeting(m))); else acts.push(btn("Confirm", () => respondMeeting(m, "confirmed"), "ok solid"), btn("Decline", () => respondMeeting(m, "declined"))); }
      else if (m.status === "confirmed") acts.push(h("a", { class: "btn small", href: gcalLink(m), target: "_blank", rel: "noopener noreferrer", text: "Google Calendar ↗" }), btn("Download .ics", () => downloadICS(m)), btn("Cancel meeting", () => cancelMeeting(m), "warn"));
      else acts.push(btn("Remove", () => removeMeeting(m), "ghost"));
    }
    if (w && past) acts.push(btn("Remove", () => removeMeeting(m), "ghost"));
    return h("div", { class: "mcard" + (m.status === "declined" ? " declined" : "") },
      h("div", { class: "mwhen" }, C.fmtDay(m.at), h("small", { text: C.fmtTime(m.at) + " – " + C.fmtTime(end) })),
      h("div", null, h("div", { class: "mhead" }, status, h("span", { text: "Proposed by " + nameOf(m) })),
        m.note ? h("div", { class: "mnote", text: m.note }) : null, acts.length ? h("div", { class: "macts" }, acts) : null));
  }
  function questionItem(q, w) {
    return h("div", { class: "qcard" + (q.answered ? " resolved" : "") },
      h("div", { style: "flex:1;min-width:0" }, h("div", { class: "qtext", text: q.text }),
        h("div", { class: "qmeta", text: nameOf(q) + " · " + C.ago(q.at, A.now) + (q.answered && q.answeredAt ? " · answered " + C.ago(q.answeredAt, A.now) : "") })),
      w ? h("div", { class: "qacts" }, btn(q.answered ? "Reopen" : "Answered", () => answerQuestion(q, !q.answered)),
        C.sameActor(q, whoAmI()) ? btn("Delete", () => deleteQuestion(q), "ghost") : null) : null);
  }
  const icsDate = ms => new Date(ms).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  function gcalLink(m) {
    const end = m.at + (m.duration || 30) * 60000;
    const p = new URLSearchParams({ action: "TEMPLATE", text: project.name + " meeting", dates: icsDate(m.at) + "/" + icsDate(end),
      details: (m.note ? m.note + "\n\n" : "") + location.origin + location.pathname + "#meetings" });
    return "https://calendar.google.com/calendar/render?" + p.toString();
  }
  function downloadICS(m) {
    const end = m.at + (m.duration || 30) * 60000;
    const esc = s => String(s || "").replace(/\\/g, "\\\\").replace(/[,;]/g, "\\$&").replace(/\r?\n/g, "\\n");
    const foldLine = line => { const out = []; while (line.length > 74) { out.push(line.slice(0, 74)); line = " " + line.slice(74); } out.push(line); return out.join("\r\n"); };
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Research tracker//" + project.name + "//EN", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
      "UID:" + m.id + "@research-tracker", "DTSTAMP:" + icsDate(Date.now()), "DTSTART:" + icsDate(m.at), "DTEND:" + icsDate(end),
      "SUMMARY:" + esc(project.name + " meeting")].concat(m.note ? ["DESCRIPTION:" + esc(m.note)] : []).concat(["END:VEVENT", "END:VCALENDAR"]);
    download(project.id + "-meeting-" + C.dateKey(m.at) + ".ics", lines.map(foldLine).join("\r\n") + "\r\n", "text/calendar");
  }

  /* =================================================================== Log & report */
  function renderLog(root) { if (!built.log) buildLog(root); updateLog(); }
  function buildLog(root) {
    root.textContent = "";
    const F = {}, HR = {};
    const date = h("input", { type: "date", "aria-label": "Date of this entry", required: true });
    const field = (k, label, ph, full) => {
      const ta = h("textarea", { rows: "2", placeholder: ph || "", maxlength: "2000", "aria-label": label }); F[k] = ta;
      return h("label", { class: "field", style: full ? "grid-column:1/-1" : null }, h("span", { text: label }), ta);
    };
    const hour = (k, label) => { const i = h("input", { type: "number", min: "0", max: "24", step: "0.5", inputmode: "decimal", placeholder: "0", "aria-label": "Hours on " + label }); HR[k] = i; return h("label", { class: "field" }, h("span", { text: label }), i); };
    const state = h("span", { class: "savestate", "aria-live": "polite" }), prefill = h("p", { class: "prefill", hidden: true });
    const save = h("button", { class: "btn primary", type: "submit", text: "Save entry" });
    const form = h("form", { class: "logform form" },
      h("div", { class: "inline", style: "display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap" }, h("label", { class: "field" }, h("span", { text: "Date" }), date), prefill),
      h("div", { class: "fgrid" },
        field("intended", "What I intended to do", "The plan for the day"),
        field("actual", "What I actually did", "What really happened"),
        field("produced", "Files / results produced", "Notebooks, plots, derivations, commits"),
        field("failed", "What failed", "Dead ends, bugs, results that didn't hold up"),
        field("learned", "What I learned", ""),
        field("blocker", "Current blocker", "Anything in the way"),
        field("tomorrow", "First action tomorrow", "The very first thing to do next", true)),
      h("div", { class: "field" }, h("span", { text: "Hours by workstream" }), h("div", { class: "hours" }, C.WORKSTREAMS.map(([k, n]) => hour(k, n)))),
      h("div", { class: "formbtns" }, state, h("span", { class: "grow" }), save));
    const draftKey = d => "rt:logdraft:" + project.id + ":" + role + ":" + d;
    const values = () => { const v = { hours: {} }; for (const k in F) v[k] = F[k].value; for (const k in HR) v.hours[k] = HR[k].value; return v; };
    const fill = v => { for (const k in F) F[k].value = (v && v[k]) || ""; for (const k in HR) { const x = v && v.hours && v.hours[k]; HR[k].value = x ? String(x) : ""; } };
    const mine = d => st.logs.filter(l => C.sameActor(l, whoAmI()) && l.date === d).sort((a, b) => (b.updatedAt || b.at) - (a.updatedAt || a.at))[0];
    let current = null, timer = null;
    function load(d) {
      current = d; date.value = d; date.max = C.dateKey(Date.now());
      const draft = LS.get(draftKey(d), null), existing = mine(d);
      prefill.hidden = true;
      if (draft) { fill(draft); state.textContent = "Unsaved draft"; }
      else if (existing) { fill(existing); state.textContent = "Saved " + C.ago(existing.updatedAt || existing.at, Date.now()); }
      else {
        fill(null); state.textContent = "";
        const prev = st.logs.filter(l => C.sameActor(l, whoAmI()) && l.tomorrow && C.logTime(l) < C.parseDateKey(d)).sort((a, b) => C.logTime(b) - C.logTime(a))[0];
        if (prev) { F.intended.value = prev.tomorrow; prefill.textContent = "Pre-filled from your plan on " + C.fmtDay(C.logTime(prev)) + "."; prefill.hidden = false; }
      }
      save.textContent = existing ? "Update entry" : "Save entry";
    }
    form.addEventListener("input", ev => {
      if (ev.target === date) return;
      if (ev.target.classList) ev.target.classList.remove("invalid");
      clearTimeout(timer);
      timer = setTimeout(() => { LS.set(draftKey(current), values()); state.textContent = "Unsaved draft"; }, 350);
    });
    date.addEventListener("change", () => { if (date.value && date.value !== current) { clearTimeout(timer); load(date.value); } });
    form.addEventListener("submit", async ev => {
      ev.preventDefault(); clearTimeout(timer);
      const v = values(), entry = { date: current, hours: {} };
      for (const k in F) entry[k] = v[k].trim();
      for (const k in HR) { const x = parseFloat(v.hours[k]); if (x > 0) entry.hours[k] = Math.min(24, Math.round(x * 2) / 2); }
      if (!entry.intended && !entry.actual) { F.actual.classList.add("invalid"); F.actual.focus(); toast("Fill in at least what you intended or what you did.", { error: true }); return; }
      save.disabled = true;
      const ok = await saveLog(entry, mine(current));
      save.disabled = false;
      if (ok) { LS.del(draftKey(current)); state.textContent = "Saved just now"; save.textContent = "Update entry"; prefill.hidden = true; }
    });
    logForm = { load, current: () => current, hasDraft: () => !!LS.get(draftKey(current), null), state, mine };

    const wk = h("span", { class: "wk", id: "wkLabel" });
    const nav = h("div", { class: "weeknav" }, wk,
      btn("‹ Earlier", () => { weekOffset--; updateLog(); }), h("button", { class: "btn small", type: "button", id: "wkNext", text: "Later ›", onclick: () => { if (weekOffset < 0) { weekOffset++; updateLog(); } } }),
      btn("Copy", () => lastReport && copyText(C.reportText(lastReport, project.name), "Report")),
      btn("Download .md", () => lastReport && download(project.id + "-week-" + C.dateKey(lastReport.window.start) + ".md", C.reportMarkdown(lastReport, project.name), "text/markdown")));
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Whose entries", style: "margin-left:auto" }, [["mine", "Mine"], ["all", "Both of us"]].map(([k, t]) =>
      h("button", { type: "button", "aria-pressed": String(logFilter === k), dataset: { f: k }, text: t, onclick: ev => { logFilter = k; $$("button", ev.target.parentNode).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.f === k))); updateLog(); } })));
    root.append(h("div", { class: "logwrap" },
      h("section", { class: "panel" }, h("h3", { text: "Daily log" }), h("p", { class: "panel-lede", text: "Two minutes at the end of the day. It feeds the weekly report, time by workstream, and tomorrow's first action on the Today page." }), form),
      h("section", { class: "panel" }, h("h3", { text: "Weekly report" }), h("p", { class: "panel-lede", text: "Built from every record: reviews, checks, deliverables, decisions, questions, meetings, tasks, claims and the daily log. Emailed on Sunday evenings to anyone who has it switched on." }), nav, h("div", { class: "report", id: "report" }))),
      h("section", { class: "panel", style: "margin-top:14px" }, h("h3", null, "Past entries", seg), h("div", { id: "logEntries" })));
    built.log = true;
  }
  function updateLog() {
    if (logForm && ready && !logLoadedReady) { logLoadedReady = true; logForm.load(C.dateKey(Date.now())); }
    else if (logForm && ready && !logForm.hasDraft()) {
      const ex = logForm.mine(logForm.current());
      if (ex && !(document.activeElement && $("#view-log").contains(document.activeElement) && isTextField(document.activeElement))) logForm.state.textContent = "Saved " + C.ago(ex.updatedAt || ex.at, Date.now());
    }
    const now = Date.now(), w = C.weekBounds(now, weekOffset), r = C.weeklyReport(idx, st, w, now);
    lastReport = r;
    $("#wkLabel").textContent = (weekOffset === 0 ? "This week · " : weekOffset === -1 ? "Last week · " : "") + C.fmtRange(w.start, C.addDays(w.end, -1));
    $("#wkNext").disabled = weekOffset >= 0;
    const box = $("#report"); box.textContent = "";
    for (const s of C.reportSections(r)) {
      box.append(h("h4", { text: s.title }));
      if (s.title === "Time by workstream" && s.lines.length) box.append(h("div", { class: "timebar", role: "img", "aria-label": s.lines.join("; ") },
        C.WORKSTREAMS.filter(([k]) => r.time[k] > 0).map(([k]) => h("i", { class: "tb-" + k, style: "flex-grow:" + r.time[k] }))));
      box.append(s.lines.length ? h("ul", null, s.lines.map(l => h("li", { text: l }))) : h("p", { text: s.empty }));
    }
    const list = st.logs.filter(l => logFilter === "all" || C.sameActor(l, whoAmI())).sort((a, b) => C.logTime(b) - C.logTime(a) || b.at - a.at);
    const le = $("#logEntries"); le.textContent = "";
    if (!list.length) { le.append(h("p", { class: "muted small", text: logFilter === "all" ? "No entries yet." : "No entries from you yet. The first one takes two minutes." })); return; }
    const FIELDS = [["intended", "Intended"], ["actual", "Did"], ["produced", "Produced"], ["failed", "Failed"], ["learned", "Learned"], ["blocker", "Blocker"], ["tomorrow", "First action next"]];
    for (const l of list.slice(0, 60)) {
      const hrs = l.hours ? C.WORKSTREAMS.filter(([k]) => l.hours[k]).map(([k, n]) => n + " " + C.fmtHours(l.hours[k])).join(", ") : "";
      const sum = h("summary", null, h("b", { text: C.fmtDay(C.logTime(l)) }), logFilter === "all" ? h("span", { class: "muted", text: nameOf(l) }) : null,
        h("span", { class: "lsum", text: C.clip(l.actual || l.intended || "", 120) }), hrs ? h("span", { class: "muted small", text: hrs }) : null);
      const dl = h("dl", null, FIELDS.filter(([k]) => l[k]).map(([k, n]) => [h("dt", { text: n }), h("dd", { text: l[k] })]));
      const d = fold("log:" + l.id, "", dl, "logcard"); d.replaceChild(sum, d.firstChild);
      if (C.sameActor(l, whoAmI()) && l.date) dl.append(h("dd", null, btn("Edit this entry", () => { logForm.load(l.date); $("#view-log").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth" }); })));
      le.append(d);
    }
  }

  /* =================================================================== Manuscript */
  function renderManuscript(root) { if (!built.manuscript) buildManuscript(root); updateManuscript(); }
  function evidencePicker(selected, draftKey) {
    const set = new Set(draftKey && drafts.has(draftKey) ? drafts.get(draftKey) : selected), boxes = [];
    const el = h("div", { class: "evpick", role: "group", "aria-label": "Results this claim relies on" });
    for (const p of idx.pillars) {
      el.append(h("div", { class: "grp", text: pretty(p.title) }));
      for (const l of C.leavesOf(p)) {
        const cb = h("input", { type: "checkbox", value: l.id, checked: set.has(l.id) });
        if (draftKey) cb.addEventListener("change", () => drafts.set(draftKey, boxes.filter(b => b.checked).map(b => b.value)));
        boxes.push(cb);
        el.append(h("label", null, cb, h("span", null, pretty(l.title), h("span", { class: "muted small", text: " · " + C.trail(l).slice(1, -1).join(" › ") }), " ", stagePill(l.id))));
      }
    }
    return { el, value: () => boxes.filter(b => b.checked).map(b => b.value), clear: () => boxes.forEach(b => { b.checked = false; }) };
  }
  function buildManuscript(root) {
    root.textContent = "";
    const sec = h("input", { type: "text", placeholder: "§3.2, Eq. 41…", maxlength: "60", "aria-label": "Where in the manuscript" });
    const txt = h("textarea", { rows: "3", placeholder: "The claim, as the manuscript states it", maxlength: "1500", "aria-label": "Claim" });
    const pickHolder = h("div");
    let pick = null;
    const mount = () => { pick = evidencePicker([], null); pickHolder.textContent = ""; pickHolder.append(pick.el); };
    mount();
    const form = h("form", { class: "form" },
      h("div", { class: "row2", style: "grid-template-columns:150px minmax(0,1fr)" }, h("label", null, h("span", { text: "Where" }), sec), h("label", null, h("span", { text: "Claim" }), txt)),
      h("div", { class: "field" }, h("span", { text: "Relies on" }), pickHolder),
      h("div", { class: "formbtns" }, h("button", { class: "btn primary", type: "submit", text: "Add claim" })));
    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      const t = txt.value.trim(); if (!t) { txt.classList.add("invalid"); txt.focus(); return; }
      txt.classList.remove("invalid");
      if (await addClaim({ text: t, section: sec.value.trim(), nodes: pick.value() })) { txt.value = ""; sec.value = ""; pick.clear(); toast("Claim added."); }
    });
    root.append(h("section", { class: "panel" }, h("h3", null, "Manuscript claims", h("span", { class: "count", id: "claimCount" })),
      h("p", { class: "panel-lede", text: "List what your paper or thesis claims and link each claim to the results it rests on. A claim is stale when one of those results changes, is sent back or is invalidated after you last checked it; it isn't fully supported until its evidence is approved and independently checked." }),
      h("div", { id: "claimList" })),
      h("section", { class: "panel", style: "margin-top:14px" }, h("h3", { text: "Add a claim" }), form));
    built.manuscript = { refreshPicker: mount };
  }
  function updateManuscript() {
    const list = $("#claimList"), w = canWrite(); list.textContent = "";
    const cc = $("#claimCount"); cc.textContent = A.staleClaims.length ? A.staleClaims.length + " stale" : String(A.claims.length); cc.className = "count" + (A.staleClaims.length ? " hot" : A.claims.length ? "" : " zero");
    if (!A.claims.length) { list.append(h("p", { class: "muted small", text: "No claims yet." })); return; }
    const order = { stale: 0, unsupported: 1, current: 2 };
    for (const c of A.claims.slice().sort((a, b) => order[a.status] - order[b.status])) {
      const cl = c.claim, tone = c.status === "stale" ? "warn" : c.status === "unsupported" ? "amber" : "ok";
      const label = c.status === "stale" ? "Stale evidence" : c.status === "unsupported" ? "Not fully supported yet" : "Current";
      const ev = h("ul", { class: "claim-ev" }, c.evidence.length ? c.evidence.map(e => h("li", null,
        e.node ? stagePill(e.id) : chip("Removed", "warn"), e.node ? verifyChip(e.id, true) : null,
        e.node ? h("button", { class: "linkbtn", type: "button", style: "font-weight:500", text: C.label(e.node), onclick: opener(e.id) }) : h("span", { text: e.id }),
        e.reasons.length ? h("span", { class: "why", text: e.reasons.join("; ") }) : null,
        e.soft && e.soft.length ? h("span", { class: "why soft", text: e.soft.join("; ") }) : null))
        : h("li", { class: "muted", text: "No results linked yet. Use Edit evidence." }));
      const ek = "claimedit:" + cl.id, editing = openEdits.has(ek);
      let editor = null;
      if (editing && w) {
        const pk = evidencePicker(cl.nodes || [], "pick:" + cl.id);
        editor = h("div", { class: "form" }, pk.el, h("div", { class: "formbtns" },
          btn("Cancel", () => { openEdits.delete(ek); drafts.delete("pick:" + cl.id); schedule(); }, "ghost"),
          btn("Save evidence", async () => { if (await run(() => backend.update("claims", cl.id, { nodes: pk.value() }))) { openEdits.delete(ek); drafts.delete("pick:" + cl.id); } }, "primary")));
      }
      const checked = cl.verifiedAt || cl.at;
      list.append(h("div", { class: "claim" },
        h("div", { class: "claim-h" }, cl.section ? h("span", { class: "claim-sec", text: cl.section }) : null, chip(label, tone),
          h("span", { class: "muted small", text: "Checked " + C.ago(checked, A.now) + (cl.verifiedBy ? " by " + nameOf({ by: cl.verifiedBy, name: cl.verifiedName }) : "") })),
        h("div", { class: "claim-text", text: cl.text }), ev,
        w ? h("div", { class: "claim-acts" },
          btn("Re-verified, still holds", () => verifyClaim(cl), c.status === "stale" ? "primary" : ""),
          btn(editing ? "Close" : "Edit evidence", () => { editing ? openEdits.delete(ek) : openEdits.add(ek); schedule(); }),
          btn("Delete", () => deleteClaim(cl), "ghost")) : null,
        editor));
    }
  }

  /* =================================================================== actions */
  const ev = (type, node, data, at) => backend.add("events", { type, node: node || null, data: data || {}, at: at || Date.now() });
  const L = id => C.labelId(idx, id);
  const crumbOf = id => (idx.nodes.get(id) ? C.crumb(idx.nodes.get(id)) : L(id));
  const TOAST = { submit: "Sent to your guide for review.", resubmit: "Resent for review.", withdraw: "Taken back. You can change its stage again.",
    approve: "Approved.", changes: "Change request sent.", discuss: "Flagged for discussion.", invalidate: "Marked invalid. It's back for changes and its checks are cleared.",
    blocked: "Marked blocked.", unblocked: "Unblocked.", spec: "Deliverable saved." };

  // Every change to an item goes through here: core.js decides whether it's allowed (against the
  // server's current copy, inside a transaction) and writes the item and its history entry together.
  async function act(id, action, args, o) {
    o = o || {};
    if (!canWrite()) { toast(fs && !me ? "Sign in to make changes." : "This account can't make changes.", { error: true }); return false; }
    const base = st.items[id] ? null : C.legacyItem(st.legacy, id);
    let res = null;
    const ok = await run(async () => { res = await backend.applyItem(id, base, cur => C.transition(cur, action, args || {}, actor(), id)); });
    if (ok && res) afterAct(id, res.event, o);
    return ok;
  }
  function afterAct(id, e, o) {
    const d = e.data || {}, who = myName(), where = crumbOf(id);
    const t = e.type;
    if (!o.quiet && TOAST[t]) toast(TOAST[t]);
    const quote = d.note ? ["", "“" + d.note + "”"] : [];
    const link = safeUrl(itemOf(id).link);
    switch (t) {
      case "submit": case "resubmit":
        notify("reviews", (t === "resubmit" ? "Resubmitted: " : "Review requested: ") + L(id),
          [who + (t === "resubmit" ? " made the requested changes and resent " : " sent ") + where + " for your review."].concat(quote, link ? ["", "Notebook: " + link] : []), id, "guide"); break;
      case "withdraw": notify("reviews", "Withdrawn from review: " + L(id), [who + " withdrew " + where + " from review to keep working on it."].concat(quote), id, "guide"); break;
      case "approve": notify("reviews", "Approved: " + L(id), [who + " approved " + where + "."].concat(quote), id, "student"); break;
      case "changes": notify("reviews", (d.from === "approved" ? "Reopened: " : "Changes requested: ") + L(id),
        [who + (d.from === "approved" ? " reopened " : " requested changes on ") + where + "."].concat(quote, d.verifyFrom ? ["", "Its verification was reset to Converged, since the result will change."] : []), id, "student"); break;
      case "discuss": notify("reviews", "To discuss: " + L(id), [who + " flagged " + where + " for discussion."].concat(quote), id, "student"); break;
      case "invalidate": notify("reviews", "Result invalidated: " + L(id), [who + " marked the result of " + where + " invalid. It's back for changes and its checks are cleared."].concat(quote), id); break;
      case "verify":
        if (C.eventCategory(e) === "reviews") notify("reviews", "Verification: " + L(id), [C.describeEvent(Object.assign({}, e, { name: who }), idx) + "."], id);
        else if (!o.quiet) toast("Recorded as " + VERIFY[VIDX[d.to]].label + ".");
        break;
      case "blocked": notify("blockers", "Blocked: " + L(id), [who + " marked " + where + " as blocked:", "“" + d.reason + "”"], id); break;
      case "spec": notify("deliverables", (d.first ? "Deliverable written: " : "Deliverable updated: ") + L(id), [who + (d.first ? " wrote the deliverable for " : " updated the deliverable for ") + where + ".", "",
        (itemOf(id).spec && itemOf(id).spec.what) || ""], id, "student"); break;
    }
  }
  async function setLink(id, raw) {
    const url = normalizeUrl(raw);
    if (url === false) { toast("That doesn't look like a web link. Paste the full address, e.g. https://github.com/…", { error: true }); schedule(); return false; }
    return act(id, "link", { url });
  }

  /* ---------- deliverables your guide adds under a section ---------- */
  async function addDeliverable(n, title) {
    if (role !== "guide") { toast("Your guide adds deliverables.", { error: true }); return false; }
    const order = n.children.length ? Math.max.apply(null, n.children.map((c, i) => i + 1)) + 1 : 1;
    let ref = null;
    const ok = await run(async () => {
      ref = await backend.add("deliverables", { parent: n.id, title, order, archived: false, at: Date.now(), updatedAt: Date.now() });
      await ev("deliverable_add", C.dlvId(ref.id), { title, parent: n.id });
    });
    if (ok) {
      const id = C.dlvId(ref.id);
      expanded.add(n.id); saveExpanded();
      toast("Deliverable added. Write what it must produce next.");
      notify("deliverables", "New deliverable: " + title, [myName() + " added a deliverable under " + C.crumb(n) + ":", "“" + title + "”"], id, "student");
      openEdits.add("spec:" + id);
      setTimeout(() => openNode(id, "spec", true), 0);
    }
    return ok;
  }
  const docOf = n => st.deliverables.find(d => d.id === n.dlv);
  async function renameDeliverable(n, title) {
    const d = docOf(n); if (!d || title === d.title) return true;
    return run(() => Promise.all([backend.update("deliverables", d.id, { title, updatedAt: Date.now() }), ev("deliverable_rename", n.id, { from: d.title, to: title })]));
  }
  async function archiveDeliverable(n) {
    const d = docOf(n); if (!d) return;
    const live = C.leavesOf(n).filter(l => C.stageIdx(st, l.id) !== null).length;
    if (await run(() => Promise.all([backend.update("deliverables", d.id, { archived: true, updatedAt: Date.now() }), ev("deliverable_archive", n.id, { title: d.title })]))) {
      if (openItem === n.id) openItem = null;
      toast("Archived “" + C.clip(d.title, 60) + "”" + (live ? ". Its history is kept." : "."), { undo: () => restoreDeliverable(d) });
    }
  }
  const restoreDeliverable = d => run(() => Promise.all([backend.update("deliverables", d.id, { archived: false, updatedAt: Date.now() }), ev("deliverable_restore", C.dlvId(d.id), { title: d.title })]));

  /* ---------- tasks, comments, decisions, questions, meetings, log, claims ---------- */
  async function addTask(t) {
    return run(() => backend.add("tasks", { node: t.node, text: t.text, due: t.due || null, done: false, at: Date.now(), fromComment: t.fromComment || null })
      .then(() => ev("task_add", t.node, { text: t.text })));
  }
  async function toggleTask(t, done) {
    return run(() => Promise.all([backend.update("tasks", t.id, { done: !!done, doneAt: done ? Date.now() : null })].concat(done ? [ev("task_done", t.node, { text: t.text })] : [])));
  }
  async function removeTask(t) {
    if (await run(() => backend.remove("tasks", t.id))) toast("Task removed.", { undo: () => run(() => backend.add("tasks", { node: t.node, text: t.text, due: t.due || null, done: !!t.done, doneAt: t.doneAt || null, at: t.at, fromComment: t.fromComment || null })) });
  }
  async function addComment(node, text) {
    const ok = await run(() => backend.add("comments", { node, text, at: Date.now() }));
    if (ok) notify("comments", "Comment on " + L(node), [myName() + " commented on " + crumbOf(node) + ":", "", text], node);
    return ok;
  }
  async function deleteComment(c) {
    if (await run(() => backend.remove("comments", c.id))) toast("Comment deleted.", { undo: () => run(() => backend.add("comments", { node: c.node, text: c.text, at: c.at })) });
  }
  async function commentToTask(c) {
    const ok = await run(async () => {
      await backend.add("tasks", { node: c.node, text: C.clip(c.text, 300), due: null, done: false, at: Date.now(), fromComment: c.id });
      await backend.update("comments", c.id, { taskId: "yes" });
      await ev("task_add", c.node, { text: C.clip(c.text, 300) });
    });
    if (ok) { toast("Task created. Give it a due date if it has one."); openNode(c.node, "tasks", true); }
  }
  async function requestDecision(text) {
    const ok = await run(() => Promise.all([backend.add("decisions", { text, status: "open", at: Date.now(), node: null }), ev("decision_request", null, { text })]));
    if (ok) { notify("decisions", "Decision needed", [myName() + " asked you to decide:", "“" + text + "”"], null); toast("Decision request added."); }
    return ok;
  }
  async function recordDecision(d, decision) {
    if (C.sameActor(d, whoAmI())) { toast("A decision you asked for is made by " + otherLabel() + ".", { error: true }); return false; }
    const at = Date.now();
    const ok = await run(() => Promise.all([backend.update("decisions", d.id, { status: "decided", decision, decidedAt: at, decidedBy: backend.me, decidedName: myName() }), ev("decision_record", null, { text: decision, on: d.text }, at)]));
    if (ok) { notify("decisions", "Decision recorded", [myName() + " decided on:", "“" + d.text + "”", "", "Decision: " + decision], null); toast("Decision recorded."); }
    return ok;
  }
  async function recordNewDecision(text) {
    const at = Date.now();
    const ok = await run(() => Promise.all([backend.add("decisions", { text, decision: text, status: "decided", at, decidedAt: at, decidedBy: backend.me, decidedName: myName(), node: null }), ev("decision_record", null, { text }, at)]));
    if (ok) { notify("decisions", "Decision recorded", [myName() + " recorded a decision:", "“" + text + "”"], null); toast("Decision recorded."); }
    return ok;
  }
  const addQuestion = text => run(() => backend.add("questions", { text, answered: false, at: Date.now() }));
  const answerQuestion = (q, v) => run(() => backend.update("questions", q.id, { answered: !!v, answeredAt: v ? Date.now() : null }));
  async function deleteQuestion(q) {
    if (await run(() => backend.remove("questions", q.id))) toast("Question deleted.", { undo: () => run(() => backend.add("questions", { text: q.text, answered: !!q.answered, answeredAt: q.answeredAt || null, at: q.at })) });
  }
  async function proposeMeeting(m) {
    const ok = await run(() => Promise.all([backend.add("meetings", Object.assign({ status: "proposed", createdAt: Date.now(), byName: myName() }, m)), ev("meeting_propose", null, { at: m.at })]));
    if (ok) notify("meetings", "Meeting proposed: " + C.fmtWhen(m.at), [myName() + " proposed a meeting on " + C.fmtWhen(m.at) + " (" + m.duration + " min).", m.note ? "\nAgenda:\n" + m.note : "", "", "Confirm or decline it in the tracker."], null);
    return ok;
  }
  async function respondMeeting(m, status) {
    const ok = await run(() => Promise.all([backend.update("meetings", m.id, { status, respondedBy: backend.me, respondedName: myName(), respondedAt: Date.now() }), ev(status === "confirmed" ? "meeting_confirm" : "meeting_decline", null, { at: m.at })]));
    if (ok) notify("meetings", (status === "confirmed" ? "Meeting confirmed: " : "Meeting declined: ") + C.fmtWhen(m.at), [myName() + (status === "confirmed" ? " confirmed" : " declined") + " the meeting on " + C.fmtWhen(m.at) + "."], null);
    return ok;
  }
  async function cancelMeeting(m) {
    const ok = await run(() => Promise.all([backend.remove("meetings", m.id), ev("meeting_cancel", null, { at: m.at })]));
    if (ok) { notify("meetings", "Meeting cancelled: " + C.fmtWhen(m.at), [myName() + " cancelled the meeting on " + C.fmtWhen(m.at) + "."], null); toast("Meeting cancelled."); }
  }
  const removeMeeting = m => run(() => backend.remove("meetings", m.id));
  function saveLog(entry, existing) {
    return run(() => existing ? backend.update("logs", existing.id, Object.assign({}, entry, { updatedAt: Date.now() })) : backend.add("logs", Object.assign({}, entry, { at: Date.now(), updatedAt: Date.now() })));
  }
  const addClaim = c => run(() => backend.add("claims", { text: c.text, section: c.section || "", nodes: c.nodes || [], at: Date.now(), verifiedAt: Date.now(), verifiedBy: backend.me, verifiedName: myName() }));
  async function verifyClaim(cl) {
    if (await run(() => Promise.all([backend.update("claims", cl.id, { verifiedAt: Date.now(), verifiedBy: backend.me, verifiedName: myName() }), ev("claim_verify", null, { text: cl.text })]))) toast("Marked as re-verified.");
  }
  async function deleteClaim(cl) {
    if (await run(() => backend.remove("claims", cl.id))) toast("Claim deleted.", { undo: () => run(() => backend.add("claims", { text: cl.text, section: cl.section || "", nodes: cl.nodes || [], at: cl.at, verifiedAt: cl.verifiedAt || cl.at, verifiedBy: cl.verifiedBy || null, verifiedName: cl.verifiedName || "" })) });
  }

  /* =================================================================== email (the immediate tier)
     Only what matters right away is emailed here, and only per the recipient's settings; routine
     changes reach them in the daily digest (scripts/notify.js). You are never emailed about your own changes. */
  function deepLink(nodeId) { return location.origin + location.pathname + (nodeId ? "#outline/" + encodeURIComponent(nodeId) : "#today"); }
  function notify(category, subject, lines, nodeId, onlyRole) {
    if (!EJ || !EJ.publicKey || !window.emailjs || !me || !backend || backend.mode !== "live") return;
    const text = lines.filter(x => x != null && x !== false).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    for (const p of project.people || []) {
      if (sameEmail(p.email, me.email) || (onlyRole && p.role !== onlyRole)) continue;
      const pr = C.prefsFor(st, p.email);
      if (category === "comments" ? pr.comments !== "immediate" : !pr[category]) continue;
      const link = deepLink(nodeId);
      window.emailjs.send(EJ.serviceId, EJ.templateId, {
        to_email: p.email, subject: project.name + " · " + subject, message: text + "\n\n" + link,
        message_html: C.textToHtml(text) + '<p style="margin-top:18px"><a href="' + C.esc(link) + '">Open in the tracker</a></p>',
        link, from_name: myName(), project: project.name, section: subject
      }).catch(err => console.warn("Email not sent:", err));
    }
  }

  /* =================================================================== export */
  function exportSnapshot() {
    if (!idx) return;
    const now = Date.now();
    download(project.id + "-snapshot-" + C.dateKey(now) + ".md", C.snapshotMarkdown(project, idx, st, { now, me: whoAmI(), role: role || "student", nameOf }), "text/markdown");
  }
  // Everything, as stored: restorable, and the only backup the free Firebase plan gives you.
  function exportBackup() {
    const now = Date.now(), out = { format: "research-tracker-backup", version: 2, exportedAt: new Date(now).toISOString(), project: { id: project.id, name: project.name }, legacy: st.legacy };
    for (const c of C.LIST_COLLECTIONS) out[c] = st[c];
    for (const c of C.MAP_COLLECTIONS) out[c] = st[c];
    download(project.id + "-backup-" + C.dateKey(now) + ".json", JSON.stringify(out, null, 2) + "\n", "application/json");
  }
  function exportWeek() {
    if (!idx) return;
    const now = Date.now(), r = C.weeklyReport(idx, st, C.weekBounds(now, 0), now);
    download(project.id + "-week-" + C.dateKey(r.window.start) + ".md", C.reportMarkdown(r, project.name), "text/markdown");
  }

  /* =================================================================== project switching, auth, start */
  function renderProjects() {
    const nav = $("#projects");
    nav.hidden = PROJECTS.length < 2; nav.textContent = "";
    if (PROJECTS.length < 2) return;
    for (const p of PROJECTS) nav.append(h("button", { class: "ptab", type: "button", text: p.name, "aria-selected": String(p.id === project.id), onclick: () => switchProject(p) }));
  }
  function loadProject(p) {
    project = p;
    idx = C.buildIndex(p, []);
    $("#pname").textContent = p.name; $("#pgoal").textContent = p.goal;
    openItem = null; built = {}; logForm = null; logLoadedReady = false; weekOffset = 0;
    for (const s of $$(".view")) s.textContent = "";
    renderProjects();
    requestAnimationFrame(() => { const g = $("#pgoal"); $("#goalMore").hidden = !(g.scrollHeight > g.clientHeight + 2); });
    if (/\$/.test(p.outline)) loadMathJax();
  }
  function switchProject(p) { loadProject(p); connect(); }
  function connect() {
    if (backend && backend.stop) backend.stop();
    st = C.emptyState(); for (const k in got) delete got[k];
    ready = false; accessDenied = false; denied.clear();
    idx = C.buildIndex(project, []);
    built = {}; logForm = null; logLoadedReady = false;
    for (const s of $$(".view")) s.textContent = "";
    if (fs && me) {
      role = roleOfEmail(me.email);
      if (role) { backend = firebaseBackend(project.id, fs, me); setStatus("live", "Connecting as " + (me.name || me.email) + "…"); }
      else { backend = null; setStatus("ro", "Signed in as " + me.email + ", not on this project"); }
    } else if (fs) { backend = null; role = null; setStatus("ro", "Signed out"); }
    else { role = LS.get("rt:previewRole", "student"); backend = localBackend(project.id); setStatus("local", "Saved in this browser only (shared database not set up)"); }
    if (backend) backend.subscribe(H);
    applyRoute();
  }
  function provider() { const p = new firebase.auth.GoogleAuthProvider(); p.setCustomParameters({ prompt: "select_account" }); return p; }
  function signIn() {
    if (!auth) return;
    auth.signInWithPopup(provider()).catch(e => {
      const code = e && e.code;
      if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment") return auth.signInWithRedirect(provider());
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return;
      toast("Sign-in failed: " + (e && e.message ? e.message : e), { error: true });
    });
  }
  function switchAccount() { if (auth) auth.signOut().then(signIn); }
  let mjLoading = false;
  function loadMathJax() {
    if (mjLoading || window.MathJax) return;
    mjLoading = true;
    window.MathJax = { tex: { inlineMath: [["$", "$"]] }, svg: { fontCache: "global" }, startup: { typeset: false, ready() { MathJax.startup.defaultReady(); const t = $("#main"); if (t) MathJax.typesetPromise([t]).catch(() => {}); } } };
    document.head.append(h("script", { src: "https://cdnjs.cloudflare.com/ajax/libs/mathjax/3.2.2/es5/tex-svg.js", async: true }));
  }
  function typeset(el) {
    if (window.MathJax && MathJax.typesetPromise) MathJax.typesetPromise([el]).catch(() => {});
    else loadMathJax();
  }

  // keyboard: "/" to search the outline, Esc to close the open item or the export menu
  document.addEventListener("keydown", ev => {
    if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const inField = isTextField(document.activeElement);
    if (ev.key === "Escape" && !$("#moreMenu").hidden) { closeMenu(); $("#moreBtn").focus(); return; }
    if (ev.key === "/" && !inField) { ev.preventDefault(); if (view !== "outline") setView("outline"); const q = $("#q"); if (q) q.focus(); }
    else if (ev.key === "Escape" && !inField && openItem && view === "outline" && !$("#prefsDialog").open) { const id = openItem; openItem = null; writeHash(); updateTree(); const e = els.get(id); if (e) e.title.focus(); }
  });
  $("#goalMore").addEventListener("click", () => { const g = $("#pgoal"), open = g.classList.toggle("clamp"); $("#goalMore").textContent = open ? "Show full aim" : "Show less"; });
  const closeMenu = () => { $("#moreMenu").hidden = true; $("#moreBtn").setAttribute("aria-expanded", "false"); };
  $("#moreBtn").addEventListener("click", ev => { ev.stopPropagation(); const m = $("#moreMenu"); m.hidden = !m.hidden; $("#moreBtn").setAttribute("aria-expanded", String(!m.hidden)); if (!m.hidden) $("button:not([hidden])", m).focus(); });
  $("#moreMenu").addEventListener("click", ev => {
    const b = ev.target.closest("button"); if (!b) return;
    closeMenu();
    const act_ = b.dataset.act;
    if (act_ === "manuscript") setView("manuscript");
    else if (act_ === "snapshot") exportSnapshot();
    else if (act_ === "week") exportWeek();
    else if (act_ === "backup") exportBackup();
    else if (act_ === "signout") { if (auth) auth.signOut(); }
  });
  document.addEventListener("click", ev => { const m = $("#moreMenu"); if (!m.hidden && !m.contains(ev.target) && ev.target !== $("#moreBtn")) closeMenu(); });
  $("#rolePreview").addEventListener("click", ev => {
    const b = ev.target.closest("button"); if (!b || !local() || b.dataset.role === role) return;
    role = b.dataset.role; LS.set("rt:previewRole", role);
    built = {}; logForm = null; logLoadedReady = false; openEdits.clear();
    for (const s of $$(".view")) s.textContent = "";
    toast("Previewing as the " + role + ". On the shared site, your Google account decides this.");
    setView(defaultView());
  });
  const PREF_KEYS = ["reviews", "deliverables", "decisions", "blockers", "meetings", "daily", "reminders", "deadlines", "weekly"];
  $("#prefsBtn").addEventListener("click", () => {
    const email = me ? me.email : "";
    const form = $("#prefsForm"), p = C.prefsFor(st, email);
    for (const k of PREF_KEYS) form.elements[k].checked = !!p[k];
    for (const r of $$('input[name="comments"]', form)) r.checked = r.value === p.comments;
    $("#prefsWho").textContent = me ? "Emails go to " + me.email + "." + (EJ && EJ.publicKey ? "" : " Email sending isn't configured for this site yet (see the README).") : "Preview only: no emails are sent from this browser-only copy.";
    $("#prefsDialog").showModal();
  });
  $("#prefsDialog").addEventListener("close", async () => {
    const dlg = $("#prefsDialog");
    if (dlg.returnValue !== "save" || !backend) return;
    const form = $("#prefsForm"), email = me ? me.email : "local-" + role, p = { email };
    for (const k of PREF_KEYS) p[k] = form.elements[k].checked;
    const c = $('input[name="comments"]:checked', form); p.comments = c ? c.value : "daily";
    if (await run(() => backend.setPref(C.emailKey(email), p))) toast("Email settings saved.");
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });
  setInterval(() => { if (!document.hidden) schedule(); }, 60000);   // relative times, "today", overdue
  $("#main").prepend(gateEl);

  (function start() {
    loadProject(PROJECTS[0]);
    if (EJ && EJ.publicKey && window.emailjs) { try { window.emailjs.init({ publicKey: EJ.publicKey }); } catch (e) { console.warn(e); } }
    const firebaseReady = CFG && CFG.apiKey && window.firebase && firebase.firestore;
    $("#signout").hidden = true;
    if (!firebaseReady) { connect(); return; }
    firebase.initializeApp(CFG);
    auth = firebase.auth(); fs = firebase.firestore();
    try { fs.enablePersistence({ synchronizeTabs: true }).catch(() => {}); } catch (e) { /* offline cache is optional */ }
    $("#signin").addEventListener("click", signIn);
    setStatus("ro", "Checking sign-in…");
    auth.onAuthStateChanged(u => {
      me = u ? { uid: u.uid, name: u.displayName || u.email, email: u.email, photo: u.photoURL || "" } : null;
      $("#signin").hidden = !!u; $("#signout").hidden = !u;
      connect();
    });
  })();
})();
