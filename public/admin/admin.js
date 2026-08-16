'use strict';

/* Let's Connect - master admin.
 *
 * A separate page with its own script, served as a real static directory so
 * nginx hands it over without any routing, and so a couple's browser never
 * downloads a line of it.
 *
 * Same conventions as the couple app: render() replaces the root's innerHTML,
 * wire() re-attaches handlers by ASSIGNMENT, and dialogs append to <body> so
 * they survive a re-render.
 */

const APP_VERSION = '1.5.0';

const state = {
  ready: false,
  me: null,
  branding: null,
  serverVersion: null,
  tab: 'overview',
  error: null,
  busy: false,
  form: {},
  data: {}, // per-tab payloads, cleared to force a reload
  userQuery: '',
  questionLevel: '',
  questionQuery: '',
  reportStatus: 'open',
  importPreview: null,
  importFile: null,
};

const TABS = [
  ['overview', 'Overview'],
  ['groups', 'Groups'],
  ['questions', 'Questions'],
  ['import', 'Import'],
  ['insights', 'Insights'],
  ['reports', 'Reports'],
  ['people', 'People'],
  ['couples', 'Couples'],
  ['audit', 'Audit'],
  ['settings', 'Settings'],
];

const root = document.getElementById('app');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtWhen(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(
    undefined,
    { hour: '2-digit', minute: '2-digit' }
  )}`;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Red for a high skip rate, amber in the middle, calm below that. */
function rateColour(pct) {
  if (pct >= 60) return '#E2574C';
  if (pct >= 35) return '#F2A33C';
  return '#35B7A6';
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const api = {
  async call(method, path, body, isForm) {
    const opts = { method, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      if (isForm) opts.body = body;
      else {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }
    const sep = path.includes('?') ? '&' : '?';
    const url = method === 'GET' ? `${path}${sep}t=${Date.now()}` : path;

    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      throw new Error('No connection to the server.');
    }

    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }

    if ((res.status === 401 || res.status === 403) && state.ready) {
      state.me = null;
      render();
      throw new Error((data && data.error) || 'Please sign in again.');
    }
    if (!res.ok) throw new Error((data && data.error) || 'Something went wrong.');
    return data;
  },
  get: (p) => api.call('GET', p),
  post: (p, b) => api.call('POST', p, b),
  patch: (p, b) => api.call('PATCH', p, b),
  put: (p, b) => api.call('PUT', p, b),
  del: (p, b) => api.call('DELETE', p, b),
};

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

let toastTimer = null;

function toast(message, isError) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  if (toastTimer) clearTimeout(toastTimer);
  const el = document.createElement('div');
  el.className = `toast${isError ? ' is-error' : ''}`;
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  toastTimer = setTimeout(() => el.remove(), isError ? 5000 : 2600);
}

function dialog({ title, bodyHtml, actions }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h3>${esc(title)}</h3>
        <div class="dialog-body">${bodyHtml}</div>
        <div class="dialog-actions">
          ${actions
            .map((a, i) => `<button class="btn ${a.className || 'btn-ghost'}" data-i="${i}">${esc(a.label)}</button>`)
            .join('')}
        </div>
      </div>`;
    const close = (v) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    function onKey(e) {
      if (e.key === 'Escape') close(null);
    }
    overlay.onclick = (e) => {
      if (e.target === overlay) close(null);
    };
    overlay.querySelectorAll('[data-i]').forEach((b) => {
      b.onclick = () => close(actions[Number(b.dataset.i)].value);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    const first = overlay.querySelector('.dialog-actions .btn');
    if (first) first.focus();
  });
}

function uiAlert(title, message) {
  return dialog({ title, bodyHtml: `<p>${esc(message)}</p>`, actions: [{ label: 'OK', value: true, className: 'btn' }] });
}

function uiConfirm(title, messageHtml, confirmLabel, danger) {
  return dialog({
    title,
    bodyHtml: `<p>${messageHtml}</p>`,
    actions: [
      { label: 'Cancel', value: false, className: 'btn-ghost' },
      { label: confirmLabel || 'Confirm', value: true, className: danger ? 'btn-ghost danger' : 'btn' },
    ],
  }).then((v) => v === true);
}

/**
 * A dialog built from a list of fields. Returns an object of values, or null.
 * Used for anything with more than one input, so there is one place where form
 * dialogs are built rather than five hand-rolled ones.
 */
function formDialog({ title, intro, fields, confirmLabel }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="dialog" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        <div class="dialog-body">
          ${intro ? `<p style="margin-bottom:1rem">${intro}</p>` : ''}
          ${fields
            .map((f) => {
              if (f.type === 'select') {
                return `<div class="field">
                    <label for="fd-${f.name}">${esc(f.label)}</label>
                    <select class="input" id="fd-${f.name}" name="${f.name}">
                      ${f.options
                        .map(
                          (o) =>
                            `<option value="${esc(o.value)}"${o.value === f.value ? ' selected' : ''}>${esc(
                              o.label
                            )}</option>`
                        )
                        .join('')}
                    </select>
                  </div>`;
              }
              if (f.type === 'textarea') {
                return `<div class="field">
                    <label for="fd-${f.name}">${esc(f.label)}</label>
                    <textarea class="input" id="fd-${f.name}" name="${f.name}" rows="3"
                      placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>
                    ${f.hint ? `<p class="hint">${esc(f.hint)}</p>` : ''}
                  </div>`;
              }
              return `<div class="field">
                  <label for="fd-${f.name}">${esc(f.label)}</label>
                  <input class="input" id="fd-${f.name}" name="${f.name}" type="${f.type || 'text'}"
                    value="${esc(f.value === undefined || f.value === null ? '' : f.value)}"
                    placeholder="${esc(f.placeholder || '')}"
                    ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''}>
                  ${f.hint ? `<p class="hint">${esc(f.hint)}</p>` : ''}
                </div>`;
            })
            .join('')}
        </div>
        <div class="dialog-actions">
          <button class="btn btn-ghost" data-cancel>Cancel</button>
          <button class="btn" data-ok>${esc(confirmLabel || 'Save')}</button>
        </div>
      </div>`;

    const close = (v) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    function onKey(e) {
      if (e.key === 'Escape') close(null);
    }
    const collect = () => {
      const out = {};
      fields.forEach((f) => {
        const el = overlay.querySelector(`[name="${f.name}"]`);
        out[f.name] = el ? el.value.trim() : '';
      });
      return out;
    };
    overlay.onclick = (e) => {
      if (e.target === overlay) close(null);
    };
    overlay.querySelector('[data-cancel]').onclick = () => close(null);
    overlay.querySelector('[data-ok]').onclick = () => close(collect());
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    const first = overlay.querySelector('.input');
    if (first) setTimeout(() => first.focus(), 30);
  });
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function viewLogin() {
  const b = state.branding || {};
  return `
    <div class="admin-login">
      <div style="width:100%;max-width:420px">
        <div class="hero">
          <div class="hero-mark" aria-hidden="true">${esc(b.brand_mark || '❤')}</div>
          <h1>${esc(b.app_name || "Let's Connect")}</h1>
          <p>Owner sign-in</p>
        </div>
        <div class="panel">
          ${state.error ? `<div class="form-error">${esc(state.error)}</div>` : ''}
          <form id="login-form" novalidate>
            <div class="field">
              <label for="l-email">Email</label>
              <input class="input" id="l-email" name="email" type="email" autocomplete="email"
                     value="${esc(state.form.email || '')}" required>
            </div>
            <div class="field">
              <label for="l-password">Password</label>
              <input class="input" id="l-password" name="password" type="password"
                     autocomplete="current-password" required>
            </div>
            <button class="btn btn-block" type="submit" ${state.busy ? 'disabled' : ''}>
              ${state.busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          <p class="hint" style="margin-top:1rem;text-align:center">
            This area is for the app owner. Couples sign in at
            <a href="/">the main app</a>.
          </p>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function statTile(label, value, tint) {
  return `<div class="stat" ${tint ? `style="--stat-accent:${esc(tint)}"` : ''}>
      <div class="stat-value">${esc(value)}</div>
      <div class="stat-label">${esc(label)}</div>
    </div>`;
}

function loading() {
  return '<div class="boot" style="min-height:40vh"><div class="boot-mark"></div></div>';
}

function tabOverview() {
  const d = state.data.overview;
  if (!d) return loading();
  const c = d.counts;
  return `
    <div class="stat-grid">
      ${statTile('People', c.users)}
      ${statTile('Couples', c.couples)}
      ${statTile('Groups', c.groups)}
      ${statTile('Live questions', c.liveQuestions)}
      ${statTile('Discussed', c.completed, '#35B7A6')}
      ${statTile('Skipped', c.skipped, '#F2A33C')}
    </div>

    ${
      Number(c.openReports) > 0
        ? `<div class="notice" style="margin-top:1.2rem">
             <strong>${plural(Number(c.openReports), 'question has', 'questions have')} been reported</strong>
             by couples and ${Number(c.openReports) === 1 ? 'is' : 'are'} waiting for you.
             <button class="btn-quiet" data-action="tab" data-tab="reports">Review now</button>
           </div>`
        : ''
    }
    ${
      !d.email.configured
        ? `<div class="notice" style="margin-top:1.2rem">
             <strong>Email is not set up.</strong> Password reset links cannot be sent.
             <button class="btn-quiet" data-action="tab" data-tab="settings">Set it up</button>
           </div>`
        : ''
    }
    ${
      d.email.unreadable
        ? `<div class="notice" style="margin-top:1.2rem">
             <strong>The saved SMTP password cannot be read.</strong> SECRET_KEY or
             SESSION_SECRET changed on the server — retype the password in Settings.
           </div>`
        : ''
    }

    <h2 class="section-title" style="margin-top:1.6rem">Groups</h2>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Group</th><th class="num">Questions</th><th class="num">Answered</th></tr></thead>
        <tbody>
          ${d.perLevel
            .map(
              (l) => `<tr>
              <td><span class="lv-dot" style="background:${esc(l.accent)}"></span>${esc(l.name)}</td>
              <td class="num">${l.questions}</td>
              <td class="num">${l.decisions}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <h2 class="section-title" style="margin-top:1.6rem">Newest accounts</h2>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Name</th><th>Email</th><th>Joined</th></tr></thead>
        <tbody>
          ${
            d.recentUsers.length
              ? d.recentUsers
                  .map(
                    (u) => `<tr>
                <td>${esc(u.displayName)} ${u.isOwner ? '<span class="pill">owner</span>' : ''}
                    ${u.isActive ? '' : '<span class="pill pill-off">off</span>'}</td>
                <td>${esc(u.email)}</td>
                <td>${esc(fmtDate(u.createdAt))}</td>
              </tr>`
                  )
                  .join('')
              : '<tr><td colspan="3">Nobody yet.</td></tr>'
          }
        </tbody>
      </table>
    </div>`;
}

function tabGroups() {
  const d = state.data.groups;
  if (!d) return loading();
  const levels = d.domains;

  return `
    <div class="notice">
      Groups are what couples choose between. Reordering here changes the order they see.
      Hiding a group takes it off their list without touching any of its questions.
    </div>

    <button class="btn btn-block btn-ghost" data-action="group-new" style="margin-bottom:1.2rem">
      Add a group
    </button>

    <div style="border:1px solid var(--line);border-radius:var(--radius);overflow:hidden">
      ${levels
        .map(
          (l, i) => `
        <div class="group-row">
          <div class="group-swatch" style="background:${esc(l.accent)}"></div>
          <div class="group-main">
            <strong>${esc(l.name)} ${l.isActive ? '' : '<span class="pill pill-off">hidden</span>'}</strong>
            <span class="row-sub">${esc(l.tagline || 'No tagline')}</span>
            <span class="row-sub">Depth ${l.depth} · ${plural(l.questions, 'question', 'questions')}${
              l.hidden ? ` · ${l.hidden} hidden` : ''
            }</span>
          </div>
          <div class="group-actions">
            <button class="order-btn" data-action="group-up" data-id="${l.id}" ${i === 0 ? 'disabled' : ''}
                    aria-label="Move up">&#9650;</button>
            <button class="order-btn" data-action="group-down" data-id="${l.id}"
                    ${i === levels.length - 1 ? 'disabled' : ''} aria-label="Move down">&#9660;</button>
            <button class="mini" data-action="group-edit" data-id="${l.id}">Edit</button>
            <button class="mini" data-action="group-toggle" data-id="${l.id}">
              ${l.isActive ? 'Hide' : 'Show'}
            </button>
            <button class="mini danger" data-action="group-delete" data-id="${l.id}">Delete</button>
          </div>
        </div>`
        )
        .join('')}
    </div>`;
}

function tabQuestions() {
  const d = state.data.questions;
  if (!d) return loading();
  const levels = (state.data.groups && state.data.groups.domains) || [];

  const q = state.questionQuery.toLowerCase();
  const shown = q ? d.questions.filter((x) => x.text.toLowerCase().includes(q)) : d.questions;

  return `
    <div class="admin-grid two" style="margin-bottom:1rem">
      <div class="field" style="margin:0">
        <label for="q-level">Group</label>
        <select class="input" id="q-level">
          <option value="">Every group</option>
          ${levels
            .map(
              (l) =>
                `<option value="${esc(l.slug)}"${state.questionLevel === l.slug ? ' selected' : ''}>${esc(
                  l.name
                )}</option>`
            )
            .join('')}
        </select>
      </div>
      <div class="field" style="margin:0">
        <label for="q-search">Search</label>
        <input class="input" id="q-search" type="search" placeholder="Find a question"
               value="${esc(state.questionQuery)}">
      </div>
    </div>

    <div class="admin-grid two" style="margin-bottom:1.2rem">
      <button class="btn btn-ghost" data-action="question-new">Write a question</button>
      <button class="btn btn-ghost" data-action="tab" data-tab="import">Import from a spreadsheet</button>
    </div>

    <p class="hint" style="margin-bottom:0.7rem">
      Showing ${plural(shown.length, 'question', 'questions')}${
    q ? ` matching “${esc(state.questionQuery)}”` : ''
  }.
    </p>

    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr><th>Question</th><th>Group</th><th class="num">Answered</th><th class="actions">Actions</th></tr>
        </thead>
        <tbody>
          ${
            shown.length
              ? shown
                  .map(
                    (x) => `<tr>
              <td style="${x.hidden ? 'opacity:0.55' : ''}">
                ${esc(x.text)}
                ${x.hidden ? '<span class="pill pill-off">hidden</span>' : ''}
                <span class="row-sub">${esc(x.ref)} · ${esc(x.source)}</span>
              </td>
              <td>${esc(x.levelName)}</td>
              <td class="num">${x.timesUsed}</td>
              <td class="actions">
                <button class="mini" data-action="question-edit" data-id="${x.id}">Edit</button>
                <button class="mini" data-action="question-hide" data-id="${x.id}">
                  ${x.hidden ? 'Show' : 'Hide'}
                </button>
                <button class="mini danger" data-action="question-delete" data-id="${x.id}">Delete</button>
              </td>
            </tr>`
                  )
                  .join('')
              : '<tr><td colspan="4">Nothing matches.</td></tr>'
          }
        </tbody>
      </table>
    </div>`;
}

function tabImport() {
  const p = state.importPreview;

  return `
    <div class="notice">
      Upload an <strong>.xlsx</strong>, <strong>.xls</strong> or <strong>.csv</strong> with a
      <code>group</code> column and a <code>question</code> column. Nothing is saved until you
      confirm — you always see what a file will do first.
    </div>

    <div class="admin-grid two" style="margin-bottom:1.2rem">
      <a class="btn btn-ghost" href="/api/owner/questions/template" style="text-align:center;text-decoration:none;line-height:2.1">
        Download a blank template
      </a>
      <a class="btn btn-ghost" href="/api/owner/questions/export" style="text-align:center;text-decoration:none;line-height:2.1">
        Export everything to Excel
      </a>
    </div>

    <div class="dropzone" id="dropzone">
      <strong>${state.importFile ? esc(state.importFile.name) : 'Choose a file, or drop one here'}</strong>
      <span>${
        state.importFile
          ? `${(state.importFile.size / 1024).toFixed(0)} KB — checking what it will do…`
          : 'Spreadsheet or CSV, up to 5 MB'
      }</span>
      <input type="file" id="import-file" accept=".xlsx,.xls,.csv" style="display:none">
    </div>

    ${
      p
        ? `
      <div class="import-summary">
        ${statTile('New', p.summary.create, '#35B7A6')}
        ${statTile('Updated', p.summary.update, '#3D9BE9')}
        ${statTile('Unchanged', p.summary.unchanged)}
        ${statTile('Problems', p.summary.problems, p.summary.problems ? '#E2574C' : undefined)}
      </div>

      ${
        p.problems && p.problems.length
          ? `<h2 class="section-title">Rows that cannot be used</h2>
             <div class="problem-list">
               ${p.problems
                 .map(
                   (r) =>
                     `<div><b>Row ${r.row}:</b> ${esc(r.error)}${
                       r.text ? ` — “${esc(r.text)}”` : ''
                     }</div>`
                 )
                 .join('')}
             </div>
             <p class="hint" style="margin-top:0.5rem">
               These are skipped. Everything else still imports.
             </p>`
          : ''
      }

      ${
        p.sample && p.sample.length
          ? `<h2 class="section-title" style="margin-top:1.4rem">A sample of what will happen</h2>
             <div class="table-wrap">
               <table class="data">
                 <thead><tr><th>Row</th><th>Action</th><th>Group</th><th>Question</th></tr></thead>
                 <tbody>
                   ${p.sample
                     .map(
                       (r) =>
                         `<tr><td class="num">${r.row}</td><td>${esc(r.action)}</td>
                          <td>${esc(r.group)}</td><td>${esc(r.text)}</td></tr>`
                     )
                     .join('')}
                 </tbody>
               </table>
             </div>`
          : ''
      }

      <div class="admin-grid two" style="margin-top:1.4rem">
        <button class="btn btn-ghost" data-action="import-cancel">Cancel</button>
        <button class="btn" data-action="import-commit" ${
          p.summary.create + p.summary.update === 0 || state.busy ? 'disabled' : ''
        }>
          ${
            state.busy
              ? 'Importing…'
              : p.summary.create + p.summary.update === 0
                ? 'Nothing to import'
                : `Import ${p.summary.create + p.summary.update} question${
                    p.summary.create + p.summary.update === 1 ? '' : 's'
                  }`
          }
        </button>
      </div>`
        : ''
    }`;
}

function tabInsights() {
  const d = state.data.insights;
  if (!d) return loading();

  return `
    <div class="notice">
      The app never records answers, so <strong>skips are the only quality signal there is</strong>.
      A question that couples keep passing over is usually badly worded, too similar to another,
      or lands harder than its group suggests. Only questions answered at least
      ${d.minAnswers} times are ranked.
    </div>

    <h2 class="section-title">Skip rate by group</h2>
    <div class="table-wrap" style="margin-bottom:1.6rem">
      <table class="data">
        <thead><tr><th>Group</th><th class="num">Answered</th><th class="num">Skipped</th><th>Skip rate</th></tr></thead>
        <tbody>
          ${d.byLevel
            .map(
              (l) => `<tr>
            <td><span class="lv-dot" style="background:${esc(l.accent)}"></span>${esc(l.name)}</td>
            <td class="num">${l.answered}</td>
            <td class="num">${l.skipped}</td>
            <td>
              <div class="rate" style="--rate-colour:${rateColour(l.skipRate)}">
                <div class="rate-bar"><span style="width:${l.skipRate}%"></span></div>
                <div class="rate-num">${l.skipRate}%</div>
              </div>
            </td>
          </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <h2 class="section-title">Most-skipped questions</h2>
    ${
      d.worst.length
        ? `<div class="table-wrap">
             <table class="data">
               <thead><tr><th>Question</th><th>Group</th><th class="num">Answered</th><th>Skip rate</th><th class="actions"></th></tr></thead>
               <tbody>
                 ${d.worst
                   .map(
                     (q) => `<tr>
                   <td style="${q.hidden ? 'opacity:0.55' : ''}">${esc(q.text)}
                     ${q.hidden ? '<span class="pill pill-off">hidden</span>' : ''}</td>
                   <td>${esc(q.levelName)}</td>
                   <td class="num">${q.answered}</td>
                   <td>
                     <div class="rate" style="--rate-colour:${rateColour(q.skipRate)}">
                       <div class="rate-bar"><span style="width:${q.skipRate}%"></span></div>
                       <div class="rate-num">${q.skipRate}%</div>
                     </div>
                   </td>
                   <td class="actions">
                     <button class="mini" data-action="insight-hide" data-id="${q.id}">
                       ${q.hidden ? 'Show' : 'Hide'}
                     </button>
                   </td>
                 </tr>`
                   )
                   .join('')}
               </tbody>
             </table>
           </div>`
        : `<div class="empty-state"><h3>Not enough data yet</h3>
             <p>Once couples have answered questions at least ${d.minAnswers} times, the
             ones falling flat will show up here.</p></div>`
    }

    <p class="hint" style="margin-top:1rem">
      ${plural(d.neverAnswered, 'live question has', 'live questions have')} never been answered by anyone.
    </p>`;
}

function tabReports() {
  const d = state.data.reports;
  if (!d) return loading();

  return `
    <div class="admin-grid two" style="margin-bottom:1.2rem">
      <div class="field" style="margin:0">
        <label for="r-status">Showing</label>
        <select class="input" id="r-status">
          <option value="open"${state.reportStatus === 'open' ? ' selected' : ''}>Waiting for review</option>
          <option value="actioned"${state.reportStatus === 'actioned' ? ' selected' : ''}>Actioned</option>
          <option value="dismissed"${state.reportStatus === 'dismissed' ? ' selected' : ''}>Dismissed</option>
        </select>
      </div>
    </div>

    ${
      d.reports.length
        ? `<div class="table-wrap">
             <table class="data">
               <thead><tr><th>Question</th><th>Why</th><th>From</th><th class="actions">Actions</th></tr></thead>
               <tbody>
                 ${d.reports
                   .map(
                     (r) => `<tr>
                   <td>${esc(r.questionText)}
                     ${r.questionHidden ? '<span class="pill pill-off">hidden</span>' : ''}
                     <span class="row-sub">${esc(r.levelName)}</span></td>
                   <td><strong>${esc(r.reason)}</strong>
                     ${r.note ? `<span class="row-sub">“${esc(r.note)}”</span>` : ''}</td>
                   <td>${esc(r.coupleName || 'A couple')}
                     <span class="row-sub">${esc(fmtDate(r.createdAt))}</span></td>
                   <td class="actions">
                     ${
                       r.status === 'open'
                         ? `<button class="mini go" data-action="report-hide" data-id="${r.id}">Hide question</button>
                            <button class="mini" data-action="report-dismiss" data-id="${r.id}">Dismiss</button>`
                         : `<button class="mini" data-action="report-reopen" data-id="${r.id}">Reopen</button>`
                     }
                   </td>
                 </tr>`
                   )
                   .join('')}
               </tbody>
             </table>
           </div>`
        : `<div class="empty-state"><h3>Nothing here</h3>
             <p>${
               state.reportStatus === 'open'
                 ? 'No couple has reported a problem with a question.'
                 : 'No reports with that status.'
             }</p></div>`
    }`;
}

function tabPeople() {
  const d = state.data.people;
  if (!d) return loading();

  return `
    <div class="field" style="margin-bottom:1rem">
      <input class="input" id="user-search" type="search" placeholder="Search name or email"
             value="${esc(state.userQuery)}">
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Name</th><th>Couple</th><th>Joined</th><th>Last seen</th><th class="actions">Actions</th></tr></thead>
        <tbody>
          ${
            d.users.length
              ? d.users
                  .map(
                    (u) => `<tr>
              <td>${esc(u.displayName)}
                ${u.isOwner ? '<span class="pill">owner</span>' : ''}
                ${u.isActive ? '' : '<span class="pill pill-off">deactivated</span>'}
                <span class="row-sub">${esc(u.email)}</span></td>
              <td>${u.coupleId ? esc(u.coupleName || 'In a couple') : '—'}</td>
              <td>${esc(fmtDate(u.createdAt))}</td>
              <td>${esc(fmtDate(u.lastLoginAt))}</td>
              <td class="actions">
                <button class="mini" data-action="user-reset" data-id="${u.id}">Reset link</button>
                <button class="mini" data-action="user-owner" data-id="${u.id}">
                  ${u.isOwner ? 'Remove owner' : 'Make owner'}
                </button>
                <button class="mini ${u.isActive ? 'danger' : ''}" data-action="user-active" data-id="${u.id}">
                  ${u.isActive ? 'Deactivate' : 'Reactivate'}
                </button>
              </td>
            </tr>`
                  )
                  .join('')
              : '<tr><td colspan="5">Nobody matches.</td></tr>'
          }
        </tbody>
      </table>
    </div>`;
}

function tabCouples() {
  const d = state.data.couples;
  if (!d) return loading();

  return `
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Couple</th><th>Code</th><th class="num">Discussed</th><th class="num">Skipped</th><th>Last active</th></tr></thead>
        <tbody>
          ${
            d.couples.length
              ? d.couples
                  .map(
                    (c) => `<tr>
              <td>${esc(c.name || c.memberNames || 'Unnamed')}
                ${c.status === 'dissolved' ? '<span class="pill pill-off">dissolved</span>' : ''}
                ${c.members < 2 ? '<span class="pill pill-warn">not paired</span>' : ''}
                <span class="row-sub">${esc(c.memberNames || 'No members')}</span></td>
              <td>${esc(c.inviteCode)}</td>
              <td class="num">${c.completed}</td>
              <td class="num">${c.skipped}</td>
              <td>${esc(fmtDate(c.lastActivity))}</td>
            </tr>`
                  )
                  .join('')
              : '<tr><td colspan="5">No couples yet.</td></tr>'
          }
        </tbody>
      </table>
    </div>`;
}

function tabAudit() {
  const d = state.data.audit;
  if (!d) return loading();

  return `
    <div class="notice">
      Everything done in this admin area, newest first. Kept even after an account is
      deleted — the email is recorded at the time, not looked up later.
    </div>

    ${
      d.entries.length
        ? `<div class="panel">
             ${d.entries
               .map(
                 (e) => `
               <div class="log-line">
                 <div class="log-when">${esc(fmtWhen(e.createdAt))}</div>
                 <div class="log-what">
                   <strong>${esc(e.actor)}</strong> — ${esc(e.action)}
                   ${e.targetLabel ? ` · ${esc(e.targetLabel)}` : ''}
                 </div>
                 ${e.detail ? `<div class="log-detail">${esc(e.detail)}</div>` : ''}
               </div>`
               )
               .join('')}
           </div>`
        : '<div class="empty-state"><h3>Nothing logged yet</h3><p>Admin actions appear here as you make them.</p></div>'
    }`;
}

function tabSettings() {
  const s = state.data.settings;
  const b = state.data.branding;
  if (!s || !b) return loading();
  const v = s.settings;
  const e = s.email;

  return `
    <form id="branding-form">
      <h2 class="section-title">Branding</h2>
      <div class="panel">
        <div class="field">
          <label for="b-name">App name</label>
          <input class="input" id="b-name" name="app_name" type="text" value="${esc(b.branding.app_name)}">
          <p class="hint">Shown on the sign-in screen, the header, and in reset emails.</p>
        </div>
        <div class="field">
          <label for="b-tagline">Tagline</label>
          <input class="input" id="b-tagline" name="app_tagline" type="text" value="${esc(
            b.branding.app_tagline
          )}">
        </div>
        <div class="field">
          <label for="b-accent">Accent colour</label>
          <input class="input" id="b-accent" name="brand_accent" type="text"
                 value="${esc(b.branding.brand_accent)}" placeholder="#D8327C">
          <p class="hint">A hex colour. Used for buttons and highlights across the app.</p>
        </div>
        <div class="field">
          <label for="b-mark">Logo character</label>
          <input class="input" id="b-mark" name="brand_mark" type="text" maxlength="2"
                 value="${esc(b.branding.brand_mark)}">
          <p class="hint">One or two characters shown in the logo tile — an emoji works well.
          The installed app icon is a PNG and is not changed by this.</p>
        </div>
      </div>
      <button class="btn btn-block" type="submit" style="margin-top:1rem">Save branding</button>
    </form>

    <form id="settings-form" style="margin-top:2rem">
      <h2 class="section-title">How the decks behave</h2>
      <div class="panel">
        <div class="field">
          <label for="s-cooloff">Skip cool-off (days)</label>
          <input class="input" id="s-cooloff" name="skip_cooloff_days" type="number" min="0" max="365"
                 value="${esc(v.skip_cooloff_days ?? s.defaults.skip_cooloff_days)}">
          <p class="hint">How long a skipped question is held back. 0 brings them straight back.</p>
        </div>
        <div class="field">
          <label for="s-deck">Cards loaded per deck</label>
          <input class="input" id="s-deck" name="deck_size" type="number" min="1" max="200"
                 value="${esc(v.deck_size ?? s.defaults.deck_size)}">
        </div>
        <div class="field">
          <label for="s-url">App URL</label>
          <input class="input" id="s-url" name="app_url" type="url" placeholder="https://connect.example.com"
                 value="${esc(v.app_url || '')}">
          <p class="hint">Used to build password reset links. Blank uses the incoming request.</p>
        </div>
      </div>

      <h2 class="section-title" style="margin-top:1.6rem">Email (SMTP)</h2>
      ${
        e.passwordUnreadable
          ? `<div class="notice"><strong>The stored password cannot be read.</strong>
               Type it again below and save.</div>`
          : ''
      }
      <div class="panel">
        <div class="field">
          <label for="s-host">SMTP host</label>
          <input class="input" id="s-host" name="host" type="text" value="${esc(e.host)}"
                 placeholder="mail.example.com">
        </div>
        <div class="field">
          <label for="s-port">Port</label>
          <input class="input" id="s-port" name="port" type="number" value="${esc(e.port)}">
        </div>
        <div class="field">
          <label class="check"><input type="checkbox" name="secure" ${e.secure ? 'checked' : ''}>
            <span>Use TLS on connect (usually port 465)</span></label>
        </div>
        <div class="field">
          <label for="s-user">Username</label>
          <input class="input" id="s-user" name="user" type="text" autocomplete="off" value="${esc(e.user)}">
        </div>
        <div class="field">
          <label for="s-pass">Password</label>
          <input class="input" id="s-pass" name="password" type="password" autocomplete="new-password"
                 placeholder="${e.hasPassword ? 'Stored — leave blank to keep it' : 'Not set'}">
          <p class="hint">Encrypted at rest, never sent back to the browser.</p>
        </div>
        ${
          e.hasPassword
            ? `<div class="field"><label class="check">
                 <input type="checkbox" name="clearPassword"><span>Forget the stored password</span>
               </label></div>`
            : ''
        }
        <div class="field">
          <label for="s-from">From address</label>
          <input class="input" id="s-from" name="from" type="text" value="${esc(e.from)}"
                 placeholder="Let's Connect &lt;hello@example.com&gt;">
        </div>
      </div>

      <button class="btn btn-block" type="submit" style="margin-top:1rem" ${state.busy ? 'disabled' : ''}>
        ${state.busy ? 'Saving…' : 'Save settings'}
      </button>
    </form>

    <button class="btn btn-block btn-ghost" data-action="test-email" style="margin-top:0.6rem">
      Send a test email to myself
    </button>`;
}

// ---------------------------------------------------------------------------
// render / wire
// ---------------------------------------------------------------------------

function render() {
  let html;
  if (!state.ready) {
    html = '<div class="boot"><div class="boot-mark"></div><p class="boot-text">Loading…</p></div>';
  } else if (!state.me) {
    html = viewLogin();
  } else {
    const body = {
      overview: tabOverview,
      groups: tabGroups,
      questions: tabQuestions,
      import: tabImport,
      insights: tabInsights,
      reports: tabReports,
      people: tabPeople,
      couples: tabCouples,
      audit: tabAudit,
      settings: tabSettings,
    }[state.tab]();

    const b = state.branding || {};
    html = `
      <div class="admin-shell">
        <div class="admin-top">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true">${esc(b.brand_mark || '❤')}</span>
            <span>${esc(b.app_name || "Let's Connect")}</span>
            <span class="admin-badge">Admin</span>
          </div>
          <div class="admin-who">
            <span>${esc(state.me.displayName)}</span>
            <a href="/" class="btn-quiet" style="text-decoration:none">Open the app</a>
            <button class="btn-quiet" data-action="logout">Sign out</button>
          </div>
        </div>

        <div class="tabs" role="tablist">
          ${TABS.map(
            ([key, label]) => `
            <button class="tab${key === state.tab ? ' is-on' : ''}" role="tab"
                    aria-selected="${key === state.tab}" data-action="tab" data-tab="${key}">
              ${esc(label)}${
              key === 'reports' && state.openReports ? ` (${state.openReports})` : ''
            }
            </button>`
          ).join('')}
        </div>

        <div class="tab-body">${body}</div>

        <div class="footer-note">
          <span class="version-badge${
            state.serverVersion && state.serverVersion !== APP_VERSION ? ' mismatch' : ''
          }">v${esc(APP_VERSION)}${
      state.serverVersion && state.serverVersion !== APP_VERSION
        ? ` ⚠ server v${esc(state.serverVersion)}`
        : ''
    }</span>
        </div>
      </div>`;
  }

  root.innerHTML = html;
  wire();
}

function wire() {
  root.onclick = (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    e.preventDefault();
    handleAction(el.dataset.action, el);
  };

  const login = document.getElementById('login-form');
  if (login) login.onsubmit = onLogin;

  const settings = document.getElementById('settings-form');
  if (settings) settings.onsubmit = onSaveSettings;

  const branding = document.getElementById('branding-form');
  if (branding) branding.onsubmit = onSaveBranding;

  const qLevel = document.getElementById('q-level');
  if (qLevel) {
    qLevel.onchange = () => {
      state.questionLevel = qLevel.value;
      state.data.questions = null;
      loadTab();
    };
  }

  const qSearch = document.getElementById('q-search');
  if (qSearch) {
    // Filters in memory, so this is a re-render rather than a request. Restore
    // the caret, since render() replaces the input underneath it.
    qSearch.oninput = () => {
      state.questionQuery = qSearch.value;
      const pos = qSearch.selectionStart;
      render();
      const again = document.getElementById('q-search');
      if (again) {
        again.focus();
        again.setSelectionRange(pos, pos);
      }
    };
  }

  const rStatus = document.getElementById('r-status');
  if (rStatus) {
    rStatus.onchange = () => {
      state.reportStatus = rStatus.value;
      state.data.reports = null;
      loadTab();
    };
  }

  const userSearch = document.getElementById('user-search');
  if (userSearch) {
    userSearch.oninput = () => {
      state.userQuery = userSearch.value;
      clearTimeout(window.__searchTimer);
      window.__searchTimer = setTimeout(async () => {
        state.data.people = await api.get(`/api/owner/users?q=${encodeURIComponent(state.userQuery)}`);
        render();
        const again = document.getElementById('user-search');
        if (again) {
          again.focus();
          again.setSelectionRange(again.value.length, again.value.length);
        }
      }, 250);
    };
  }

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('import-file');
  if (dropzone && fileInput) {
    dropzone.onclick = () => fileInput.click();
    fileInput.onchange = () => {
      if (fileInput.files[0]) previewImport(fileInput.files[0]);
    };
    dropzone.ondragover = (e) => {
      e.preventDefault();
      dropzone.classList.add('is-over');
    };
    dropzone.ondragleave = () => dropzone.classList.remove('is-over');
    dropzone.ondrop = (e) => {
      e.preventDefault();
      dropzone.classList.remove('is-over');
      if (e.dataTransfer.files[0]) previewImport(e.dataTransfer.files[0]);
    };
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function handleAction(action, el) {
  const id = Number(el.dataset.id);
  switch (action) {
    case 'tab':
      state.tab = el.dataset.tab;
      render();
      loadTab();
      break;
    case 'logout':
      await api.post('/api/auth/logout');
      state.me = null;
      state.data = {};
      render();
      break;

    case 'group-new': await groupNew(); break;
    case 'group-edit': await groupEdit(id); break;
    case 'group-toggle': await groupToggle(id); break;
    case 'group-delete': await groupDelete(id); break;
    case 'group-up': await moveGroup(id, -1); break;
    case 'group-down': await moveGroup(id, 1); break;

    case 'question-new': await questionNew(); break;
    case 'question-edit': await questionEdit(id); break;
    case 'question-hide': await questionHide(id); break;
    case 'question-delete': await questionDelete(id); break;

    case 'import-cancel':
      state.importPreview = null;
      state.importFile = null;
      render();
      break;
    case 'import-commit': await commitImport(); break;

    case 'insight-hide': await insightHide(id); break;

    case 'report-hide': await resolveReport(id, 'actioned', true); break;
    case 'report-dismiss': await resolveReport(id, 'dismissed', false); break;
    case 'report-reopen': await resolveReport(id, 'open', false); break;

    case 'user-reset': await userResetLink(id); break;
    case 'user-owner': await userToggle(id, 'owner'); break;
    case 'user-active': await userToggle(id, 'active'); break;

    case 'test-email': await testEmail(); break;
    default: break;
  }
}

async function onLogin(e) {
  e.preventDefault();
  if (state.busy) return;
  const email = e.target.email.value.trim();
  const password = e.target.password.value;

  state.form = { email };
  state.error = null;
  state.busy = true;
  render();

  try {
    await api.call('POST', '/api/auth/login', { email, password });
    const data = await api.get('/api/data');
    if (!data.me.isOwner) {
      // Signed in fine, but this is not an owner. End the session rather than
      // leaving them holding a valid cookie on a page that will refuse
      // everything anyway.
      await api.post('/api/auth/logout');
      state.busy = false;
      state.error = 'That account cannot use the admin area.';
      return render();
    }
    state.me = data.me;
    state.branding = data.branding;
    state.serverVersion = data.version;
    state.busy = false;
    state.form = {};
    render();
    loadTab();
  } catch (err) {
    state.busy = false;
    state.error = err.message;
    render();
  }
  return undefined;
}

// ---- Loading --------------------------------------------------------------

async function loadTab() {
  const t = state.tab;
  try {
    if (t === 'overview' && !state.data.overview) {
      state.data.overview = await api.get('/api/owner/overview');
      state.openReports = Number(state.data.overview.counts.openReports) || 0;
    } else if (t === 'groups' && !state.data.groups) {
      state.data.groups = await api.get('/api/owner/domains');
    } else if (t === 'questions') {
      // Questions needs the group list too, for the filter and the editor.
      if (!state.data.groups) state.data.groups = await api.get('/api/owner/domains');
      if (!state.data.questions) {
        state.data.questions = await api.get(
          `/api/owner/questions?level=${encodeURIComponent(state.questionLevel)}`
        );
      }
    } else if (t === 'import' && !state.data.groups) {
      state.data.groups = await api.get('/api/owner/domains');
    } else if (t === 'insights' && !state.data.insights) {
      state.data.insights = await api.get('/api/owner/insights');
    } else if (t === 'reports' && !state.data.reports) {
      state.data.reports = await api.get(`/api/owner/reports?status=${state.reportStatus}`);
    } else if (t === 'people' && !state.data.people) {
      state.data.people = await api.get('/api/owner/users');
    } else if (t === 'couples' && !state.data.couples) {
      state.data.couples = await api.get('/api/owner/couples');
    } else if (t === 'audit' && !state.data.audit) {
      state.data.audit = await api.get('/api/owner/audit');
    } else if (t === 'settings') {
      if (!state.data.settings) state.data.settings = await api.get('/api/owner/settings');
      if (!state.data.branding) state.data.branding = await api.get('/api/owner/branding');
    } else {
      return;
    }
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

/** Anything that changes content invalidates the views that count it. */
function invalidateContent() {
  state.data.overview = null;
  state.data.questions = null;
  state.data.groups = null;
  state.data.insights = null;
}

// ---- Groups ---------------------------------------------------------------

const GROUP_FIELDS = (l) => [
  { name: 'name', label: 'Name', value: l ? l.name : '', placeholder: 'Deep Waters' },
  {
    name: 'tagline',
    label: 'Tagline',
    value: l ? l.tagline : '',
    placeholder: 'The hard, honest ones',
    hint: 'One line, shown under the name on the couple’s list.',
  },
  {
    name: 'description',
    label: 'Description',
    type: 'textarea',
    value: l ? l.description : '',
    hint: 'Longer explanation, shown when they open the group’s menu.',
  },
  {
    name: 'depth',
    label: 'Depth (1–5)',
    type: 'number',
    min: 1,
    max: 5,
    value: l ? l.depth : 3,
    hint: '1 is light and playful, 5 is as deep as it gets.',
  },
  {
    name: 'accent',
    label: 'Colour',
    value: l ? l.accent : '#D8327C',
    placeholder: '#D8327C',
    hint: 'Hex colour used for the card stripe and buttons.',
  },
];

async function groupNew() {
  const v = await formDialog({
    title: 'New group',
    intro: 'Couples will see this as one of the depths they can choose.',
    fields: GROUP_FIELDS(null),
    confirmLabel: 'Create',
  });
  if (!v) return;
  if (!v.name) return uiAlert('Name needed', 'Give the group a name.');
  try {
    await api.post('/api/owner/domains', v);
    invalidateContent();
    await loadTab();
    toast('Group created.');
  } catch (err) {
    uiAlert('Could not create it', err.message);
  }
  return undefined;
}

async function groupEdit(id) {
  const l = state.data.groups.domains.find((x) => x.id === id);
  if (!l) return;
  const v = await formDialog({ title: `Edit ${l.name}`, fields: GROUP_FIELDS(l), confirmLabel: 'Save' });
  if (!v) return;
  try {
    await api.patch(`/api/owner/domains/${id}`, v);
    invalidateContent();
    await loadTab();
    toast('Saved.');
  } catch (err) {
    uiAlert('Could not save', err.message);
  }
}

async function groupToggle(id) {
  const l = state.data.groups.domains.find((x) => x.id === id);
  if (!l) return;
  if (l.isActive) {
    const yes = await uiConfirm(
      `Hide ${esc(l.name)}?`,
      `Couples will stop seeing this group and its ${plural(l.questions, 'question', 'questions')}. ` +
        'Nothing is deleted and any progress is kept — you can show it again at any time.',
      'Hide it'
    );
    if (!yes) return;
  }
  try {
    await api.patch(`/api/owner/domains/${id}`, { isActive: !l.isActive });
    invalidateContent();
    await loadTab();
    toast(l.isActive ? 'Hidden.' : 'Visible again.');
  } catch (err) {
    uiAlert('Could not change it', err.message);
  }
}

async function groupDelete(id) {
  const l = state.data.groups.domains.find((x) => x.id === id);
  if (!l) return;
  const yes = await uiConfirm(
    `Delete ${esc(l.name)}?`,
    l.questions
      ? `This group still holds <strong>${plural(l.questions, 'question', 'questions')}</strong>, ` +
        'so the server will refuse. Hiding it is almost always what you want instead.'
      : 'This group is empty, so nothing else goes with it. This cannot be undone.',
    'Delete',
    true
  );
  if (!yes) return;
  try {
    await api.del(`/api/owner/domains/${id}`);
    invalidateContent();
    await loadTab();
    toast('Group deleted.');
  } catch (err) {
    uiAlert('Could not delete it', err.message);
  }
}

async function moveGroup(id, delta) {
  const levels = state.data.groups.domains.slice();
  const i = levels.findIndex((l) => l.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= levels.length) return;
  [levels[i], levels[j]] = [levels[j], levels[i]];

  // Reorder in place first so the list does not visibly jump while the request
  // is in flight.
  state.data.groups.domains = levels;
  render();

  try {
    await api.put('/api/owner/domains/order', { order: levels.map((l) => l.id) });
  } catch (err) {
    toast(err.message, true);
    state.data.groups = null;
    await loadTab();
  }
}

// ---- Questions ------------------------------------------------------------

function groupOptions() {
  return ((state.data.groups && state.data.groups.domains) || []).map((l) => ({
    label: l.name,
    value: l.slug,
  }));
}

async function questionNew() {
  const options = groupOptions();
  if (!options.length) return uiAlert('No groups', 'Create a group first.');

  const v = await formDialog({
    title: 'New question',
    fields: [
      { name: 'text', label: 'Question', type: 'textarea', placeholder: 'What would you like to ask?' },
      {
        name: 'level',
        label: 'Group',
        type: 'select',
        options,
        value: state.questionLevel || options[0].value,
      },
    ],
    confirmLabel: 'Add it',
  });
  if (!v || !v.text) return undefined;

  try {
    await api.post('/api/owner/questions', { text: v.text, level: v.level });
    invalidateContent();
    await loadTab();
    toast('Question added.');
  } catch (err) {
    uiAlert('Could not add it', err.message);
  }
  return undefined;
}

async function questionEdit(id) {
  const q = state.data.questions.questions.find((x) => x.id === id);
  if (!q) return;
  const options = groupOptions();

  const v = await formDialog({
    title: 'Edit question',
    intro: `${esc(q.ref)} · answered ${plural(q.timesUsed, 'time', 'times')}`,
    fields: [
      { name: 'text', label: 'Question', type: 'textarea', value: q.text },
      { name: 'level', label: 'Group', type: 'select', options, value: q.levelSlug },
    ],
    confirmLabel: 'Save',
  });
  if (!v || !v.text) return;

  try {
    if (v.text !== q.text) await api.patch(`/api/owner/questions/${id}`, { text: v.text });
    if (v.level !== q.levelSlug) await api.patch(`/api/owner/questions/${id}/level`, { level: v.level });
    invalidateContent();
    await loadTab();
    toast('Saved.');
  } catch (err) {
    uiAlert('Could not save', err.message);
  }
}

async function questionHide(id) {
  const q = state.data.questions.questions.find((x) => x.id === id);
  if (!q) return;
  try {
    await api.patch(`/api/owner/questions/${id}`, { hidden: !q.hidden });
    invalidateContent();
    await loadTab();
    toast(q.hidden ? 'Back in the deck.' : 'Hidden.');
  } catch (err) {
    uiAlert('Could not change it', err.message);
  }
}

async function questionDelete(id) {
  const q = state.data.questions.questions.find((x) => x.id === id);
  if (!q) return;

  const yes = await uiConfirm(
    'Delete this question?',
    q.timesUsed
      ? `<strong>${plural(q.timesUsed, 'couple has', 'couples have')}</strong> already answered this. ` +
        'Deleting erases it from their history. <strong>Hiding</strong> stops it being served and ' +
        'keeps the record — that is usually what you want.'
      : 'Nobody has answered this yet, so nothing else goes with it.',
    'Delete',
    true
  );
  if (!yes) return;

  try {
    // `confirmed` is what the server insists on before destroying answer
    // history; the dialog above is where that consent is actually given.
    await api.del(`/api/owner/questions/${id}`, { confirmed: true });
    invalidateContent();
    await loadTab();
    toast('Question deleted.');
  } catch (err) {
    uiAlert('Could not delete it', err.message);
  }
}

async function insightHide(id) {
  const q = state.data.insights.worst.find((x) => x.id === id);
  if (!q) return;
  try {
    await api.patch(`/api/owner/questions/${id}`, { hidden: !q.hidden });
    q.hidden = !q.hidden;
    state.data.questions = null;
    state.data.overview = null;
    render();
    toast(q.hidden ? 'Hidden.' : 'Back in the deck.');
  } catch (err) {
    uiAlert('Could not change it', err.message);
  }
}

// ---- Import ---------------------------------------------------------------

async function previewImport(file) {
  state.importFile = file;
  state.importPreview = null;
  render();

  const body = new FormData();
  body.append('file', file);

  try {
    const res = await api.call('POST', '/api/owner/questions/import', body, true);
    state.importPreview = res;
    render();
  } catch (err) {
    state.importFile = null;
    render();
    uiAlert('Could not read that file', err.message);
  }
}

async function commitImport() {
  if (!state.importFile || state.busy) return;
  state.busy = true;
  render();

  const body = new FormData();
  body.append('file', state.importFile);
  body.append('commit', 'true');

  try {
    const res = await api.call('POST', '/api/owner/questions/import', body, true);
    state.busy = false;
    state.importPreview = null;
    state.importFile = null;
    invalidateContent();
    render();
    await uiAlert(
      'Import finished',
      `${res.summary.created} added, ${res.summary.updated} updated` +
        (res.summary.problems ? `, ${res.summary.problems} skipped.` : '.')
    );
    state.tab = 'questions';
    render();
    loadTab();
  } catch (err) {
    state.busy = false;
    render();
    uiAlert('Import failed', err.message);
  }
}

// ---- Reports --------------------------------------------------------------

async function resolveReport(id, status, hideQuestion) {
  try {
    await api.patch(`/api/owner/reports/${id}`, { status, hideQuestion });
    state.data.reports = null;
    state.data.overview = null;
    invalidateContent();
    await loadTab();
    toast(hideQuestion ? 'Question hidden and report closed.' : 'Report updated.');
  } catch (err) {
    uiAlert('Could not update it', err.message);
  }
}

// ---- People ---------------------------------------------------------------

async function userToggle(id, what) {
  const u = state.data.people.users.find((x) => x.id === id);
  if (!u) return;

  if (what === 'active' && u.isActive) {
    const yes = await uiConfirm(
      `Deactivate ${esc(u.displayName)}?`,
      'They are signed out immediately and cannot sign back in. Their couple and its progress ' +
        'are untouched, and you can reactivate them later.',
      'Deactivate',
      true
    );
    if (!yes) return;
  }

  try {
    const patch = what === 'owner' ? { isOwner: !u.isOwner } : { isActive: !u.isActive };
    const res = await api.patch(`/api/owner/users/${id}`, patch);
    Object.assign(u, res.user);
    state.data.overview = null;
    state.data.audit = null;
    render();
    toast('Saved.');
  } catch (err) {
    uiAlert('Could not do that', err.message);
  }
}

async function userResetLink(id) {
  const u = state.data.people.users.find((x) => x.id === id);
  if (!u) return;
  try {
    const res = await api.post(`/api/owner/users/${id}/reset-link`, {});
    const pick = await dialog({
      title: 'Reset link created',
      bodyHtml: `
        <p>${
          res.emailed
            ? `Emailed to <strong>${esc(u.email)}</strong>.`
            : `<strong>Not emailed</strong> — ${esc(res.emailError || 'email is not set up')}. ` +
              'Send them this link yourself.'
        }</p>
        <div class="code-display" style="word-break:break-all">
          <span class="code-label">One-time link</span>
          <span style="font-size:0.8rem">${esc(res.link)}</span>
        </div>
        <p>Works once, expires in ${esc(res.expiresInMinutes)} minutes. Any earlier link for this
        account has just stopped working.</p>`,
      actions: [
        { label: 'Copy link', value: 'copy', className: 'btn-ghost' },
        { label: 'Done', value: 'ok', className: 'btn' },
      ],
    });
    if (pick === 'copy' && navigator.clipboard) {
      navigator.clipboard.writeText(res.link).then(
        () => toast('Copied.'),
        () => toast('Could not copy.', true)
      );
    }
    state.data.audit = null;
  } catch (err) {
    uiAlert('Could not create a link', err.message);
  }
}

// ---- Settings -------------------------------------------------------------

async function onSaveSettings(e) {
  e.preventDefault();
  if (state.busy) return;
  const f = e.target;
  state.busy = true;
  render();

  try {
    await api.put('/api/owner/settings', {
      skip_cooloff_days: f.skip_cooloff_days.value,
      deck_size: f.deck_size.value,
      app_url: f.app_url.value,
      email: {
        host: f.host.value,
        port: f.port.value,
        secure: f.secure.checked,
        user: f.user.value,
        from: f.from.value,
        password: f.password.value,
        clearPassword: f.clearPassword ? f.clearPassword.checked : false,
      },
    });
    state.busy = false;
    state.data.settings = null;
    state.data.overview = null;
    await loadTab();
    toast('Settings saved.');
  } catch (err) {
    state.busy = false;
    render();
    uiAlert('Could not save', err.message);
  }
}

async function onSaveBranding(e) {
  e.preventDefault();
  const f = e.target;
  try {
    const res = await api.put('/api/owner/branding', {
      app_name: f.app_name.value,
      app_tagline: f.app_tagline.value,
      brand_accent: f.brand_accent.value,
      brand_mark: f.brand_mark.value,
    });
    state.branding = res.branding;
    state.data.branding = null;
    applyBranding();
    await loadTab();
    toast('Branding saved.');
  } catch (err) {
    uiAlert('Could not save', err.message);
  }
}

async function testEmail() {
  try {
    const res = await api.post('/api/owner/email/test', {});
    uiAlert('Sent', `A test email is on its way to ${res.to}.`);
  } catch (err) {
    uiAlert('Could not send', err.message);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function applyBranding() {
  const b = state.branding;
  if (!b) return;
  if (b.brand_accent) document.documentElement.style.setProperty('--accent', b.brand_accent);
  document.title = `Admin · ${b.app_name}`;
}

async function boot() {
  // Branding is public, so the sign-in screen carries the right name even
  // before anybody has authenticated.
  try {
    const pub = await api.get('/api/branding');
    state.branding = pub.branding;
    state.serverVersion = pub.version;
    applyBranding();
  } catch (err) {
    /* falls back to the built-in name */
  }

  try {
    const data = await api.get('/api/data');
    if (data.me && data.me.isOwner) {
      state.me = data.me;
      state.branding = data.branding || state.branding;
      state.serverVersion = data.version;
      applyBranding();
    }
  } catch (err) {
    /* not signed in - the login screen is correct */
  }

  state.ready = true;
  render();
  if (state.me) loadTab();
}

render();
boot();
