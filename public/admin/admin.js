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

const APP_VERSION = '1.6.0';

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
  draftStatus: 'pending',
  chainId: null, // which sequence is open in the editor
  chainPick: '', // search text for adding a question to a sequence
  importPreview: null,
  importFile: null,
};

/**
 * The rail, grouped by what the work actually is.
 *
 * Order matters more here than it did as a tab strip: a vertical list reads as
 * a table of contents, so it runs content first (what couples are dealt), then
 * the feedback on it, then the people, then the machinery.
 */
const TABS = [
  ['overview', 'Overview'],

  // Content
  ['structure', 'Topics & depths'],
  ['questions', 'Questions'],
  ['develop', 'Develop'],
  ['chains', 'Sequences'],
  ['import', 'Import'],

  // What comes back
  ['insights', 'Insights'],
  ['reports', 'Reports'],

  // Who
  ['people', 'People'],
  ['couples', 'Couples'],

  // Machinery
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

/**
 * Topics and depths on one page, because they are the two axes of the same
 * grid and reading either one alone tells you nothing about coverage.
 *
 * A topic is a SUBJECT and has no depth of its own. A depth is EXPOSURE and
 * says nothing about subject. That separation is the thing this page exists to
 * make visible - the old version printed "Depth undefined" on every topic row,
 * which is what a leftover from the single-axis model looks like.
 */
function tabStructure() {
  const d = state.data.groups;
  const dep = state.data.depths;
  if (!d || !dep) return loading();
  const levels = d.domains;

  return `
    <div class="notice">
      Two independent axes. A <strong>topic</strong> is what a question is about;
      a <strong>depth</strong> is how exposed answering it makes you. Couples tick any
      number of each on the start screen and play one shuffled deck drawn from all of it,
      so every topic can hold questions at every depth.
    </div>

    <h2 class="section-title">Topics</h2>
    <p class="hint" style="margin-bottom:0.8rem">
      The order here is the order couples see. Hiding a topic takes it off their list
      without touching any of its questions.
    </p>

    <div style="border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;margin-bottom:0.8rem">
      ${levels
        .map(
          (l, i) => `
        <div class="group-row">
          <div class="group-swatch" style="background:${esc(l.accent)}"></div>
          <div class="group-main">
            <strong>${esc(l.name)} ${l.isActive ? '' : '<span class="pill pill-off">hidden</span>'}</strong>
            <span class="row-sub">${esc(l.tagline || 'No tagline')}</span>
            ${l.description ? `<span class="row-sub">${esc(l.description)}</span>` : ''}
            <span class="row-sub">
              ${plural(l.questions, 'question', 'questions')}${
                l.minDepth === null
                  ? ' · nothing yet'
                  : ` · D${l.minDepth}–D${l.maxDepth}`
              }${l.hidden ? ` · ${l.hidden} hidden` : ''}${
                l.needsReview ? ` · ${l.needsReview} held back` : ''
              }${l.volatileCount ? ` · ${l.volatileCount} volatile` : ''}
            </span>
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
    </div>

    <button class="btn btn-ghost" data-action="group-new" style="margin-bottom:2rem">
      Add a topic
    </button>

    <h2 class="section-title">Depths</h2>
    <p class="hint" style="margin-bottom:0.8rem">
      The ladder couples pick from. The <strong>name</strong> and <strong>one-liner</strong>
      are what they read on the chips; the <strong>description</strong> is the longer
      explanation. The number itself cannot be changed after the fact — every question
      sitting on a rung stores it, so renumbering would silently move all of them.
    </p>

    <div class="table-wrap" style="margin-bottom:0.8rem">
      <table class="data">
        <thead>
          <tr><th>Depth</th><th>Description</th><th class="num">Live</th><th class="num">All</th>
              <th class="actions">Actions</th></tr>
        </thead>
        <tbody>
          ${dep.depths
            .map(
              (x) => `<tr>
            <td style="${x.isActive ? '' : 'opacity:0.55'}">
              <strong>D${x.n} · ${esc(x.name)}</strong>
              ${x.isActive ? '' : '<span class="pill pill-off">off</span>'}
              <span class="row-sub">${esc(x.blurb || 'No one-liner')}</span>
            </td>
            <td>${x.description ? esc(x.description) : '<span class="row-sub">Nothing written yet.</span>'}</td>
            <td class="num">${x.live}</td>
            <td class="num">${x.questions}</td>
            <td class="actions">
              <button class="mini" data-action="depth-edit" data-id="${x.id}">Edit</button>
              <button class="mini" data-action="depth-toggle" data-id="${x.id}">
                ${x.isActive ? 'Switch off' : 'Switch on'}
              </button>
              <button class="mini danger" data-action="depth-delete" data-id="${x.id}">Delete</button>
            </td>
          </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <button class="btn btn-ghost" data-action="depth-new">Add a depth</button>`;
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
          <tr><th>Question</th><th>Topic</th><th>Depth</th><th>Framework</th>
              <th class="num">Answered</th><th class="actions">Actions</th></tr>
        </thead>
        <tbody>
          ${
            shown.length
              ? shown
                  .map(
                    (x) => `<tr>
              <td style="${x.hidden || x.needsReview ? 'opacity:0.55' : ''}">
                ${esc(x.text)}
                ${x.hidden ? '<span class="pill pill-off">hidden</span>' : ''}
                ${x.needsReview ? '<span class="pill pill-off">held back</span>' : ''}
                ${x.volatile ? '<span class="pill">volatile</span>' : ''}
                ${
                  x.context
                    ? `<span class="row-sub">${esc(x.context)}</span>`
                    : '<span class="row-sub">No context line — this card cannot be served.</span>'
                }
                <span class="row-sub">${esc(x.ref)} · ${esc(x.source)}${
                      x.chainName ? ` · in “${esc(x.chainName)}”` : ''
                    }</span>
              </td>
              <td>${esc(x.levelName)}</td>
              <td>D${x.depth}</td>
              <td>${x.lens ? esc(x.lens) : '—'}</td>
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
              : '<tr><td colspan="6">Nothing matches.</td></tr>'
          }
        </tbody>
      </table>
    </div>`;
}

/**
 * Question development: authors, the generator, and the review queue.
 *
 * One page because it is one flow, and splitting it would let somebody add an
 * author and never find the thing that uses it. It reads top to bottom in the
 * order the work happens: connect the key, describe the framework, ask for
 * questions, read what came back.
 *
 * Nothing on this page puts a question in front of a couple. Acceptance does,
 * and acceptance is a person clicking Accept on a draft that has already passed
 * the construction rules.
 */
function tabDevelop() {
  const ai = state.data.ai;
  const lensData = state.data.lenses;
  const drafts = state.data.drafts;
  const groups = state.data.groups;
  const dep = state.data.depths;
  if (!ai || !lensData || !drafts || !groups || !dep) return loading();

  const lenses = lensData.lenses;
  const ready = lenses.filter((l) => l.ready && l.isActive);

  return `
    <div class="notice">
      Questions are written here, against a framework, and land in a review queue —
      never straight into the collection. Everything that comes back is put through the
      same construction rules the corpus is held to, and anything that cannot stand alone
      on a card is refused rather than quietly accepted.
    </div>

    <h2 class="section-title">Connection</h2>
    <form id="ai-form">
      <div class="panel">
        <div class="form-cols">
          <div class="field">
            <label for="ai-key">Anthropic API key</label>
            <input class="input" id="ai-key" name="apiKey" type="password" autocomplete="off"
                   placeholder="${
                     ai.configured
                       ? `Stored (${esc(ai.masked)}) — leave blank to keep it`
                       : 'sk-ant-…'
                   }">
            <p class="hint">
              ${
                ai.unreadable
                  ? '<strong>The stored key cannot be read.</strong> Enter it again and save.'
                  : ai.configured
                  ? `In use, from ${ai.source === 'env' ? 'the server environment' : 'these settings'}.`
                  : 'Not set. Generation is off until there is one.'
              }
              Encrypted at rest and never sent back to this page.
            </p>
          </div>
          <div class="field">
            <label for="ai-model">Model</label>
            <input class="input" id="ai-model" name="model" type="text"
                   value="${esc(ai.model)}" placeholder="${esc(ai.defaultModel)}">
            <p class="hint">Blank uses ${esc(ai.defaultModel)}.</p>
          </div>
        </div>
        ${
          ai.configured && ai.source === 'settings'
            ? `<div class="field"><label class="check">
                 <input type="checkbox" name="clearKey"><span>Forget the stored key</span>
               </label></div>`
            : ''
        }
      </div>
      <button class="btn" type="submit" style="margin-top:0.8rem">Save connection</button>
    </form>

    <h2 class="section-title" style="margin-top:2rem">Frameworks</h2>
    <p class="hint" style="margin-bottom:0.8rem">
      A framework is a way of looking at a relationship, and the three-letter code is the
      badge a couple sees in the corner of a card. Attribution runs to the framework and
      to whose it is — never to a book, a deck, or anybody's published material. Every
      question here is newly written.
    </p>

    <div class="table-wrap" style="margin-bottom:0.8rem">
      <table class="data">
        <thead>
          <tr><th>Code</th><th>Framework</th><th>What it interrogates</th>
              <th class="num">Questions</th><th class="actions">Actions</th></tr>
        </thead>
        <tbody>
          ${
            lenses.length
              ? lenses
                  .map(
                    (l) => `<tr>
              <td style="${l.isActive ? '' : 'opacity:0.55'}">
                <strong>${esc(l.code)}</strong>
                ${l.isActive ? '' : '<span class="pill pill-off">off</span>'}
              </td>
              <td>
                ${esc(l.name)}
                <span class="row-sub">${l.author ? esc(l.author) : 'No attribution'}</span>
              </td>
              <td>
                ${
                  l.brief
                    ? esc(l.brief)
                    : '<span class="row-sub">Nothing written. The generator has only a name to '
                      + 'work from, so it cannot be used here yet.</span>'
                }
              </td>
              <td class="num">${l.questions}</td>
              <td class="actions">
                <button class="mini" data-action="lens-edit" data-id="${l.id}">Edit</button>
                <button class="mini" data-action="lens-toggle" data-id="${l.id}">
                  ${l.isActive ? 'Switch off' : 'Switch on'}
                </button>
                <button class="mini danger" data-action="lens-delete" data-id="${l.id}">Delete</button>
              </td>
            </tr>`
                  )
                  .join('')
              : '<tr><td colspan="5">No frameworks yet.</td></tr>'
          }
        </tbody>
      </table>
    </div>

    <button class="btn btn-ghost" data-action="lens-new">Add an author or framework</button>

    <h2 class="section-title" style="margin-top:2rem">Write new questions</h2>
    ${
      !ai.configured
        ? '<div class="notice">Add an API key above before generating.</div>'
        : !ready.length
        ? `<div class="notice">
             No framework has a brief written yet. The generator needs to know what a
             framework actually interrogates — a name on its own produces generic questions
             under a respected label, which is worse than none.
           </div>`
        : ''
    }
    <form id="gen-form">
      <div class="panel">
        <div class="form-cols">
          <div class="field">
            <label for="g-lens">Framework</label>
            <select class="input" id="g-lens" name="lensCode">
              ${ready
                .map((l) => `<option value="${esc(l.code)}">${esc(l.code)} · ${esc(l.name)}</option>`)
                .join('')}
            </select>
          </div>
          <div class="field">
            <label for="g-domain">Topic</label>
            <select class="input" id="g-domain" name="domainId">
              ${groups.domains
                .map((x) => `<option value="${x.id}">${esc(x.name)}</option>`)
                .join('')}
            </select>
          </div>
          <div class="field">
            <label for="g-depths">Depths</label>
            <select class="input" id="g-depths" name="depths" multiple size="5"
                    style="height:auto">
              ${dep.depths
                .filter((x) => x.isActive)
                .map((x) => `<option value="${x.n}" selected>D${x.n} · ${esc(x.name)}</option>`)
                .join('')}
            </select>
            <p class="hint">Ctrl-click to pick several. They get spread across the set.</p>
          </div>
          <div class="field">
            <label for="g-count">How many</label>
            <input class="input" id="g-count" name="count" type="number" min="1" max="20" value="8">
            <p class="hint">One request, up to twenty. Costs roughly one API call per batch.</p>
          </div>
          <div class="field field-wide">
            <label for="g-note">Anything else</label>
            <textarea class="input" id="g-note" name="note" rows="2"
                      placeholder="e.g. lean towards the early years of a relationship"></textarea>
          </div>
        </div>
      </div>
      <button class="btn" type="submit" style="margin-top:0.8rem"
              ${!ai.configured || !ready.length || state.busy ? 'disabled' : ''}>
        ${state.busy ? 'Writing…' : 'Write questions'}
      </button>
    </form>

    <h2 class="section-title" style="margin-top:2rem">
      Review queue
      ${drafts.counts.pending ? `<span class="pill">${drafts.counts.pending} waiting</span>` : ''}
    </h2>

    <div class="field" style="max-width:280px">
      <label for="d-status">Showing</label>
      <select class="input" id="d-status">
        <option value="pending"${state.draftStatus === 'pending' ? ' selected' : ''}>
          Waiting (${drafts.counts.pending})
        </option>
        <option value="accepted"${state.draftStatus === 'accepted' ? ' selected' : ''}>
          Accepted (${drafts.counts.accepted})
        </option>
        <option value="discarded"${state.draftStatus === 'discarded' ? ' selected' : ''}>
          Turned down (${drafts.counts.discarded})
        </option>
      </select>
    </div>

    ${
      drafts.drafts.length
        ? drafts.drafts
            .map(
              (x) => `
      <div class="draft is-${esc(x.verdict)}">
        <div class="draft-q">${esc(x.text)}</div>
        ${x.context ? `<div class="draft-context">${esc(x.context)}</div>` : ''}
        <div class="draft-meta">
          <span class="pill">D${x.depth}</span>
          ${x.lens ? `<span class="pill">${esc(x.lens)}</span>` : ''}
          <span>${esc(x.domainName || 'no topic')}</span>
          ${x.volatile ? '<span class="pill">volatile</span>' : ''}
          <span>·</span>
          <span>${esc(fmtWhen(x.createdAt))}</span>
          ${x.model ? `<span>· ${esc(x.model)}</span>` : ''}
        </div>
        ${
          x.issues
            ? `<div class="draft-issues">${
                x.verdict === 'rejected' ? 'Cannot be served as written — ' : 'Worth a look — '
              }${esc(x.issues)}</div>`
            : ''
        }
        ${
          x.status === 'pending'
            ? `<div class="draft-actions">
                 <button class="mini go" data-action="draft-accept" data-id="${x.id}"
                         ${x.verdict === 'rejected' ? 'disabled title="Rewrite it first."' : ''}>
                   Accept
                 </button>
                 <button class="mini" data-action="draft-edit" data-id="${x.id}">Rewrite</button>
                 <button class="mini danger" data-action="draft-discard" data-id="${x.id}">
                   Turn down
                 </button>
               </div>`
            : `<div class="draft-meta">${
                x.status === 'accepted' ? 'In the collection.' : 'Turned down.'
              }</div>`
        }
      </div>`
            )
            .join('')
        : `<div class="empty-state">
             <h3>Nothing ${
               state.draftStatus === 'pending'
                 ? 'waiting'
                 : state.draftStatus === 'accepted'
                 ? 'accepted yet'
                 : 'turned down'
             }</h3>
             <p>${
               state.draftStatus === 'pending'
                 ? 'Write some questions above and they appear here.'
                 : 'Drafts move here once you have read them.'
             }</p>
           </div>`
    }`;
}

/**
 * Sequences — the linked questions.
 *
 * A sequence is a recommended running order over cards that circle the same
 * construct at rising exposure. The invariant is that every card in one STILL
 * STANDS ALONE: pull one out and it makes complete sense on its own. So this
 * editor manages membership and order and never rewrites a question — the
 * order is the only thing a sequence owns.
 */
function tabChains() {
  const d = state.data.chains;
  const groups = state.data.groups;
  if (!d || !groups) return loading();

  if (state.chainId) return chainEditor();

  return `
    <div class="notice">
      A sequence is a suggested running order, not a new kind of question. Every card in
      one is still dealt on its own in the normal decks, and still reads on its own —
      the order only adds something when a couple chooses to play it through.
    </div>

    <button class="btn btn-ghost" data-action="chain-new" style="margin-bottom:1.2rem">
      Start a sequence
    </button>

    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr><th>Sequence</th><th>Topic</th><th class="num">Cards</th><th>Depth</th>
              <th class="actions">Actions</th></tr>
        </thead>
        <tbody>
          ${
            d.chains.length
              ? d.chains
                  .map(
                    (c) => `<tr>
              <td style="${c.isActive ? '' : 'opacity:0.55'}">
                <strong>${esc(c.name)}</strong>
                ${c.isActive ? '' : '<span class="pill pill-off">off</span>'}
                ${
                  c.unpositioned
                    ? `<span class="row-sub">${c.unpositioned} card(s) with no position — open it to set the order</span>`
                    : ''
                }
                ${c.volatileCount ? `<span class="row-sub">${c.volatileCount} volatile</span>` : ''}
              </td>
              <td>${esc(c.domainName || '—')}</td>
              <td class="num">${c.members}</td>
              <td>${c.members ? `D${c.minDepth}–D${c.maxDepth}` : '—'}</td>
              <td class="actions">
                <button class="mini go" data-action="chain-open" data-id="${c.id}">Open</button>
                <button class="mini" data-action="chain-rename" data-id="${c.id}">Rename</button>
                <button class="mini" data-action="chain-toggle" data-id="${c.id}">
                  ${c.isActive ? 'Switch off' : 'Switch on'}
                </button>
                <button class="mini danger" data-action="chain-delete" data-id="${c.id}">Delete</button>
              </td>
            </tr>`
                  )
                  .join('')
              : '<tr><td colspan="5">No sequences yet.</td></tr>'
          }
        </tbody>
      </table>
    </div>`;
}

function chainEditor() {
  const e = state.data.chain;
  if (!e) return loading();
  const { chain, members } = e;

  // Cards not already in this sequence, filtered by whatever has been typed.
  const q = state.chainPick.trim().toLowerCase();
  const inChain = new Set(members.map((m) => m.id));
  const pool = ((state.data.questions && state.data.questions.questions) || [])
    .filter((x) => !inChain.has(x.id))
    .filter((x) => (q ? x.text.toLowerCase().includes(q) : false))
    .slice(0, 12);

  let gateShown = false;

  return `
    <button class="btn-quiet" data-action="chain-close" style="margin-bottom:1rem">
      &larr; All sequences
    </button>

    <h2 class="section-title">${esc(chain.name)}</h2>
    <p class="hint" style="margin-bottom:1rem">
      ${plural(members.length, 'card', 'cards')}${
    members.length ? ` · D${chain.minDepth}–D${chain.maxDepth}` : ''
  }${chain.domainName ? ` · ${esc(chain.domainName)}` : ''}. Order runs top to bottom.
    </p>

    <div style="border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;margin-bottom:1rem">
      ${
        members.length
          ? members
              .map((m, i) => {
                // The consent gate falls at the transition INTO depth 4, so mark
                // it here rather than leaving it to be inferred from two numbers.
                let gate = '';
                if (!gateShown && m.depth >= 4) {
                  gateShown = true;
                  gate =
                    '<div class="chain-gate">Consent gate — the couple is asked before going past this point.</div>';
                }
                return `${gate}
          <div class="chain-member">
            <div class="chain-pos">${i + 1}</div>
            <div class="chain-member-main">
              <strong>${esc(m.text)}</strong>
              <span class="row-sub">
                D${m.depth}${m.lens ? ` · ${esc(m.lens)}` : ''}
                ${m.domainName ? ` · ${esc(m.domainName)}` : ''}
                ${m.volatile ? ' · volatile' : ''}
                ${m.hidden ? ' · hidden' : ''}
                ${m.needsReview ? ' · held back' : ''}
              </span>
            </div>
            <div class="chain-actions">
              <button class="order-btn" data-action="chain-up" data-id="${m.id}"
                      ${i === 0 ? 'disabled' : ''} aria-label="Move up">&#9650;</button>
              <button class="order-btn" data-action="chain-down" data-id="${m.id}"
                      ${i === members.length - 1 ? 'disabled' : ''} aria-label="Move down">&#9660;</button>
              <button class="mini danger" data-action="chain-remove" data-id="${m.id}">Remove</button>
            </div>
          </div>`;
              })
              .join('')
          : '<div class="chain-member"><div class="chain-member-main">Nothing in this sequence yet.</div></div>'
      }
    </div>

    <p class="hint" style="margin-bottom:0.8rem">
      Removing a card here does not delete it. It goes back to being dealt on its own.
    </p>

    <h2 class="section-title">Add a card</h2>
    <div class="field">
      <label for="chain-search">Find a question</label>
      <input class="input" id="chain-search" type="search" placeholder="Type a few words"
             value="${esc(state.chainPick)}">
    </div>
    ${
      pool.length
        ? `<div style="border:1px solid var(--line);border-radius:var(--radius);overflow:hidden">
             ${pool
               .map(
                 (x) => `<div class="chain-member">
               <div class="chain-member-main">
                 <strong>${esc(x.text)}</strong>
                 <span class="row-sub">D${x.depth} · ${esc(x.levelName)}${
                   x.chainName ? ` · already in “${esc(x.chainName)}”` : ''
                 }</span>
               </div>
               <div class="chain-actions">
                 <button class="mini go" data-action="chain-add" data-id="${x.id}">Add</button>
               </div>
             </div>`
               )
               .join('')}
           </div>`
        : q
        ? '<p class="hint">Nothing matches.</p>'
        : '<p class="hint">Type to search across every question.</p>'
    }`;
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
    const view = {
      overview: tabOverview,
      structure: tabStructure,
      questions: tabQuestions,
      develop: tabDevelop,
      chains: tabChains,
      import: tabImport,
      insights: tabInsights,
      reports: tabReports,
      people: tabPeople,
      couples: tabCouples,
      audit: tabAudit,
      settings: tabSettings,
    }[state.tab];
    // A tab key that no longer exists (an old bookmark, a renamed section) must
    // land somewhere real rather than throw on an undefined call.
    const body = view ? view() : tabOverview();

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

        <div class="admin-body">
          <nav class="tabs admin-nav" role="tablist" aria-label="Admin sections">
            ${TABS.map(
              ([key, label]) => `
              <button class="tab${key === state.tab ? ' is-on' : ''}" role="tab"
                      aria-selected="${key === state.tab}" data-action="tab" data-tab="${key}">
                ${esc(label)}${
                key === 'reports' && state.openReports ? ` (${state.openReports})` : ''
              }${key === 'develop' && state.pendingDrafts ? ` (${state.pendingDrafts})` : ''}
              </button>`
            ).join('')}
          </nav>

          <div class="tab-body admin-main">${body}</div>
        </div>

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

  const aiForm = document.getElementById('ai-form');
  if (aiForm) aiForm.onsubmit = onSaveAi;

  const genForm = document.getElementById('gen-form');
  if (genForm) genForm.onsubmit = onGenerate;

  const dStatus = document.getElementById('d-status');
  if (dStatus) {
    dStatus.onchange = () => {
      state.draftStatus = dStatus.value;
      state.data.drafts = null;
      loadTab();
    };
  }

  const chainSearch = document.getElementById('chain-search');
  if (chainSearch) {
    // Filters in memory, so this is a re-render rather than a request. Restore
    // the caret, since render() replaces the input underneath it.
    chainSearch.oninput = () => {
      state.chainPick = chainSearch.value;
      const pos = chainSearch.selectionStart;
      render();
      const again = document.getElementById('chain-search');
      if (again) {
        again.focus();
        again.setSelectionRange(pos, pos);
      }
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

    case 'depth-new': await depthNew(); break;
    case 'depth-edit': await depthEdit(id); break;
    case 'depth-toggle': await depthToggle(id); break;
    case 'depth-delete': await depthDelete(id); break;

    case 'lens-new': await lensNew(); break;
    case 'lens-edit': await lensEdit(id); break;
    case 'lens-toggle': await lensToggle(id); break;
    case 'lens-delete': await lensDelete(id); break;

    case 'draft-accept': await draftAccept(id); break;
    case 'draft-edit': await draftEdit(id); break;
    case 'draft-discard': await draftDiscard(id); break;

    case 'chain-new': await chainNew(); break;
    case 'chain-open':
      state.chainId = id;
      state.chainPick = '';
      state.data.chain = null;
      render();
      loadTab();
      break;
    case 'chain-close':
      state.chainId = null;
      state.data.chain = null;
      render();
      break;
    case 'chain-rename': await chainRename(id); break;
    case 'chain-toggle': await chainToggle(id); break;
    case 'chain-delete': await chainDelete(id); break;
    case 'chain-add': await chainMove(id, 'add'); break;
    case 'chain-remove': await chainMove(id, 'remove'); break;
    case 'chain-up': await chainMove(id, -1); break;
    case 'chain-down': await chainMove(id, 1); break;

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
    } else if (t === 'structure') {
      if (!state.data.groups) state.data.groups = await api.get('/api/owner/domains');
      if (!state.data.depths) state.data.depths = await api.get('/api/owner/depths');
    } else if (t === 'develop') {
      // Five payloads, fetched together rather than one per section, because the
      // page is a single flow and staggering them would show it assembling.
      const [ai, lenses, drafts, groups, depths] = await Promise.all([
        state.data.ai || api.get('/api/owner/ai'),
        state.data.lenses || api.get('/api/owner/lenses'),
        state.data.drafts || api.get(`/api/owner/drafts?status=${state.draftStatus}`),
        state.data.groups || api.get('/api/owner/domains'),
        state.data.depths || api.get('/api/owner/depths'),
      ]);
      state.data.ai = ai;
      state.data.lenses = lenses;
      state.data.drafts = drafts;
      state.data.groups = groups;
      state.data.depths = depths;
      state.pendingDrafts = Number(drafts.counts.pending) || 0;
    } else if (t === 'chains') {
      if (!state.data.groups) state.data.groups = await api.get('/api/owner/domains');
      if (!state.data.chains) state.data.chains = await api.get('/api/owner/chains');
      if (state.chainId) {
        // The editor searches across every question, so it needs the full list
        // rather than whatever the Questions tab happens to be filtered to.
        if (!state.data.chain) {
          state.data.chain = await api.get(`/api/owner/chains/${state.chainId}`);
        }
        if (!state.data.questions) {
          state.data.questions = await api.get('/api/owner/questions?level=');
        }
      }
    } else if (t === 'questions') {
      // The editor sets topic, depth and framework, so all three lists have to
      // be here before it opens - not fetched when the dialog appears, which
      // would leave an empty select on a slow connection.
      if (!state.data.groups) state.data.groups = await api.get('/api/owner/domains');
      if (!state.data.depths) state.data.depths = await api.get('/api/owner/depths');
      if (!state.data.lenses) state.data.lenses = await api.get('/api/owner/lenses');
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
  state.data.depths = null;
  state.data.lenses = null;
  state.data.chains = null;
  state.data.chain = null;
}

// ---- Depths ---------------------------------------------------------------

const DEPTH_FIELDS = (d) => [
  { name: 'name', label: 'Name', value: d ? d.name : '', placeholder: 'Reflective' },
  {
    name: 'blurb',
    label: 'One-liner',
    value: d ? d.blurb : '',
    placeholder: 'Needs a moment’s thought. Mild disclosure.',
    hint: 'Shown on the chip when a couple holds it, so keep it to one short sentence.',
  },
  {
    name: 'description',
    label: 'Description',
    type: 'textarea',
    value: d ? d.description : '',
    hint: 'The longer explanation of what this rung asks of them.',
  },
];

async function depthNew() {
  const v = await formDialog({
    title: 'Add a depth',
    intro:
      'Depth is <strong>exposure</strong> and has nothing to do with subject. The number is '
      + 'permanent once questions sit on it, so choose it deliberately.',
    fields: [
      {
        name: 'n',
        label: 'Number',
        type: 'number',
        min: 1,
        max: 20,
        value: '',
        hint: 'Shown as D6, D7 and so on. Cannot be changed later.',
      },
      ...DEPTH_FIELDS(null),
    ],
    confirmLabel: 'Add depth',
  });
  if (!v) return;
  try {
    await api.post('/api/owner/depths', v);
    state.data.depths = null;
    await loadTab();
    toast('Depth added.');
  } catch (err) {
    toast(err.message, true);
  }
}

async function depthEdit(id) {
  const d = state.data.depths.depths.find((x) => x.id === id);
  if (!d) return;
  const v = await formDialog({
    title: `Edit D${d.n}`,
    intro: `<strong>${plural(d.questions, 'question sits', 'questions sit')}</strong> on this rung.
            The number itself cannot be changed — every one of them stores it.`,
    fields: DEPTH_FIELDS(d),
    confirmLabel: 'Save',
  });
  if (!v) return;
  try {
    await api.patch(`/api/owner/depths/${id}`, v);
    state.data.depths = null;
    await loadTab();
    toast('Saved.');
  } catch (err) {
    toast(err.message, true);
  }
}

async function depthToggle(id) {
  const d = state.data.depths.depths.find((x) => x.id === id);
  if (!d) return;
  try {
    await api.patch(`/api/owner/depths/${id}`, { isActive: !d.isActive });
  } catch (err) {
    // 409 means it holds live questions. Say the number and let them decide -
    // switching off a whole rung is not something to do by accident.
    const ok = await uiConfirm('Switch this depth off?', esc(err.message), 'Switch off', true);
    if (!ok) return;
    try {
      await api.patch(`/api/owner/depths/${id}`, { isActive: false, confirmed: true });
    } catch (err2) {
      return toast(err2.message, true);
    }
  }
  state.data.depths = null;
  await loadTab();
  return toast(d.isActive ? 'Switched off.' : 'Switched on.');
}

async function depthDelete(id) {
  const d = state.data.depths.depths.find((x) => x.id === id);
  if (!d) return;
  const ok = await uiConfirm(
    `Delete D${d.n}?`,
    'Switching it off keeps it and its questions. Deleting it is only possible when nothing sits on it.',
    'Delete',
    true
  );
  if (!ok) return;
  try {
    await api.del(`/api/owner/depths/${id}`);
    state.data.depths = null;
    await loadTab();
    toast('Deleted.');
  } catch (err) {
    uiAlert('Cannot delete that depth', err.message);
  }
}

// ---- Frameworks (lenses) --------------------------------------------------

const LENS_FIELDS = (l) => [
  { name: 'name', label: 'Framework name', value: l ? l.name : '', placeholder: 'Purpose and identity' },
  {
    name: 'author',
    label: 'Whose framework',
    value: l ? l.author : '',
    placeholder: 'Jay Shetty',
    hint: 'Attribution runs to the framework, never to a book, deck or published material.',
  },
  {
    name: 'description',
    label: 'What a couple reads',
    type: 'textarea',
    value: l ? l.description : '',
    hint: 'Shown when they tap the badge on a card. Written for someone holding a phone.',
  },
  {
    name: 'brief',
    label: 'What it interrogates',
    type: 'textarea',
    value: l ? l.brief : '',
    hint:
      'This is what the generator works from. Name the constructs the framework actually '
      + 'cares about, in a few sentences. Without it, questions come back generic under a '
      + 'respected name.',
  },
];

async function lensNew() {
  const v = await formDialog({
    title: 'Add an author or framework',
    intro:
      'You are describing a <strong>way of looking at a relationship</strong>, so that '
      + 'questions can be written to it. Never a book, a deck, or anybody’s published '
      + 'material — everything written here is original.',
    fields: [
      {
        name: 'code',
        label: 'Code',
        value: '',
        placeholder: 'SHE',
        hint: 'Exactly three letters. This is the badge in the corner of a card, and it is permanent.',
      },
      ...LENS_FIELDS(null),
    ],
    confirmLabel: 'Add framework',
  });
  if (!v) return;
  try {
    await api.post('/api/owner/lenses', v);
    state.data.lenses = null;
    await loadTab();
    toast('Framework added.');
  } catch (err) {
    toast(err.message, true);
  }
}

async function lensEdit(id) {
  const l = state.data.lenses.lenses.find((x) => x.id === id);
  if (!l) return;
  const v = await formDialog({
    title: `Edit ${l.code}`,
    intro: `The code cannot be changed — ${plural(
      l.questions,
      'question carries',
      'questions carry'
    )} it.`,
    fields: LENS_FIELDS(l),
    confirmLabel: 'Save',
  });
  if (!v) return;
  try {
    await api.patch(`/api/owner/lenses/${id}`, v);
    state.data.lenses = null;
    await loadTab();
    toast('Saved.');
  } catch (err) {
    toast(err.message, true);
  }
}

async function lensToggle(id) {
  const l = state.data.lenses.lenses.find((x) => x.id === id);
  if (!l) return;
  try {
    await api.patch(`/api/owner/lenses/${id}`, { isActive: !l.isActive });
    state.data.lenses = null;
    await loadTab();
    toast(l.isActive ? 'Switched off.' : 'Switched on.');
  } catch (err) {
    toast(err.message, true);
  }
}

async function lensDelete(id) {
  const l = state.data.lenses.lenses.find((x) => x.id === id);
  if (!l) return;
  const ok = await uiConfirm(
    `Delete ${l.code}?`,
    'Only possible while no question carries the badge.',
    'Delete',
    true
  );
  if (!ok) return;
  try {
    await api.del(`/api/owner/lenses/${id}`);
    state.data.lenses = null;
    await loadTab();
    toast('Deleted.');
  } catch (err) {
    uiAlert('Cannot delete that framework', err.message);
  }
}

// ---- AI and generation ----------------------------------------------------

async function onSaveAi(e) {
  e.preventDefault();
  const f = e.target;
  const body = { model: f.model.value.trim() };
  if (f.apiKey.value) body.apiKey = f.apiKey.value;
  if (f.clearKey && f.clearKey.checked) body.clearKey = true;

  try {
    await api.put('/api/owner/ai', body);
    state.data.ai = null;
    await loadTab();
    toast('Saved.');
  } catch (err) {
    toast(err.message, true);
  }
}

async function onGenerate(e) {
  e.preventDefault();
  if (state.busy) return;
  const f = e.target;

  const depths = [...f.depths.selectedOptions].map((o) => Number(o.value));
  if (!depths.length) return toast('Pick at least one depth.', true);

  state.busy = true;
  render();
  // The button is disabled while this runs, so say what is happening - a model
  // writing a dozen questions takes long enough for silence to read as failure.
  toast('Writing. This takes a moment…');

  try {
    const res = await api.post('/api/owner/ai/generate', {
      lensCode: f.lensCode.value,
      domainId: Number(f.domainId.value),
      depths,
      count: Number(f.count.value) || 8,
      note: f.note.value.trim(),
    });
    state.busy = false;
    state.draftStatus = 'pending';
    state.data.drafts = null;
    await loadTab();
    toast(
      `${plural(res.drafted, 'draft', 'drafts')} — ${res.clean} clean`
        + `${res.flagged ? `, ${res.flagged} to look at` : ''}`
        + `${res.rejected ? `, ${res.rejected} refused` : ''}.`
    );
  } catch (err) {
    state.busy = false;
    render();
    uiAlert('Could not write questions', err.message);
  }
  return undefined;
}

// ---- Drafts ---------------------------------------------------------------

async function draftAccept(id) {
  try {
    await api.post(`/api/owner/drafts/${id}/accept`);
    state.data.drafts = null;
    invalidateContent();
    state.tab = 'develop';
    await loadTab();
    toast('In the collection.');
  } catch (err) {
    uiAlert('Not accepted', err.message);
  }
}

async function draftEdit(id) {
  const d = state.data.drafts.drafts.find((x) => x.id === id);
  if (!d) return;
  const groups = (state.data.groups && state.data.groups.domains) || [];
  const depths = ((state.data.depths && state.data.depths.depths) || []).filter((x) => x.isActive);

  const v = await formDialog({
    title: 'Rewrite this draft',
    intro: d.issues
      ? `The rules say: <strong>${esc(d.issues)}</strong>. Rewriting is how a refused draft is released.`
      : 'Every save re-checks it against the construction rules.',
    fields: [
      { name: 'text', label: 'Question', type: 'textarea', value: d.text },
      {
        name: 'context',
        label: 'Context line',
        type: 'textarea',
        value: d.context,
        hint: 'Under 18 words. Opens the territory and never supplies an example answer.',
      },
      {
        name: 'depth',
        label: 'Depth',
        type: 'select',
        value: String(d.depth),
        options: depths.map((x) => ({ value: String(x.n), label: `D${x.n} · ${x.name}` })),
      },
      {
        name: 'domainId',
        label: 'Topic',
        type: 'select',
        value: String(d.domainId || ''),
        options: groups.map((x) => ({ value: String(x.id), label: x.name })),
      },
      {
        name: 'volatile',
        label: 'Volatile',
        type: 'select',
        value: d.volatile ? '1' : '0',
        options: [
          { value: '0', label: 'No' },
          { value: '1', label: 'Yes — both partners must consent first' },
        ],
      },
    ],
    confirmLabel: 'Save',
  });
  if (!v) return;

  try {
    const res = await api.patch(`/api/owner/drafts/${id}`, {
      text: v.text,
      context: v.context,
      depth: Number(v.depth),
      domainId: Number(v.domainId),
      volatile: v.volatile === '1',
    });
    state.data.drafts = null;
    await loadTab();
    toast(
      res.verdict === 'ok'
        ? 'Saved — it passes.'
        : res.verdict === 'review'
        ? 'Saved, still worth a look.'
        : 'Saved, but it still cannot be served.'
    );
  } catch (err) {
    toast(err.message, true);
  }
}

async function draftDiscard(id) {
  try {
    await api.post(`/api/owner/drafts/${id}/discard`);
    state.data.drafts = null;
    await loadTab();
    toast('Turned down.');
  } catch (err) {
    toast(err.message, true);
  }
}

// ---- Sequences (chains) ---------------------------------------------------

async function chainNew() {
  const groups = (state.data.groups && state.data.groups.domains) || [];
  const v = await formDialog({
    title: 'Start a sequence',
    intro:
      'A running order over cards that circle the same thing at rising exposure. '
      + 'Every card in it still stands alone.',
    fields: [
      { name: 'name', label: 'Name', value: '', placeholder: 'The thing we do not say' },
      {
        name: 'domainId',
        label: 'Topic',
        type: 'select',
        value: '',
        options: [{ value: '', label: 'No particular topic' }].concat(
          groups.map((x) => ({ value: String(x.id), label: x.name }))
        ),
      },
    ],
    confirmLabel: 'Create',
  });
  if (!v) return;
  try {
    const res = await api.post('/api/owner/chains', {
      name: v.name,
      domainId: v.domainId ? Number(v.domainId) : null,
    });
    state.data.chains = null;
    state.chainId = res.id;
    state.data.chain = null;
    state.chainPick = '';
    await loadTab();
    toast('Sequence created.');
  } catch (err) {
    toast(err.message, true);
  }
}

async function chainRename(id) {
  const c = state.data.chains.chains.find((x) => x.id === id);
  if (!c) return;
  const groups = (state.data.groups && state.data.groups.domains) || [];
  const v = await formDialog({
    title: 'Rename',
    fields: [
      { name: 'name', label: 'Name', value: c.name },
      {
        name: 'domainId',
        label: 'Topic',
        type: 'select',
        value: String(c.domainId || ''),
        options: [{ value: '', label: 'No particular topic' }].concat(
          groups.map((x) => ({ value: String(x.id), label: x.name }))
        ),
      },
    ],
    confirmLabel: 'Save',
  });
  if (!v) return;
  try {
    await api.patch(`/api/owner/chains/${id}`, {
      name: v.name,
      domainId: v.domainId ? Number(v.domainId) : null,
    });
    state.data.chains = null;
    await loadTab();
    toast('Saved.');
  } catch (err) {
    toast(err.message, true);
  }
}

async function chainToggle(id) {
  const c = state.data.chains.chains.find((x) => x.id === id);
  if (!c) return;
  try {
    await api.patch(`/api/owner/chains/${id}`, { isActive: !c.isActive });
    state.data.chains = null;
    await loadTab();
    toast(c.isActive ? 'Switched off.' : 'Switched on.');
  } catch (err) {
    toast(err.message, true);
  }
}

async function chainDelete(id) {
  const c = state.data.chains.chains.find((x) => x.id === id);
  if (!c) return;
  const ok = await uiConfirm(
    `Delete “${esc(c.name)}”?`,
    `The ${plural(c.members, 'card', 'cards')} in it are <strong>not</strong> deleted — they go `
      + 'back to being dealt on their own. Only the running order is thrown away.',
    'Delete the sequence',
    true
  );
  if (!ok) return;
  try {
    const res = await api.del(`/api/owner/chains/${id}`);
    state.data.chains = null;
    if (state.chainId === id) {
      state.chainId = null;
      state.data.chain = null;
    }
    await loadTab();
    toast(`Deleted. ${plural(res.released, 'card', 'cards')} released.`);
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * Every membership change goes through the same call, because the server takes
 * the WHOLE ordered list. Building the new order here and sending it in one go
 * means a reorder can never half-apply, which for a sequence would mean a chain
 * that plays in the wrong order rather than one that failed visibly.
 */
async function chainMove(questionId, how) {
  const e = state.data.chain;
  if (!e) return;
  const order = e.members.map((m) => m.id);
  const i = order.indexOf(questionId);

  if (how === 'add') {
    if (i !== -1) return;
    order.push(questionId);
  } else if (how === 'remove') {
    if (i === -1) return;
    order.splice(i, 1);
  } else {
    const j = i + how;
    if (i === -1 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
  }

  try {
    await api.put(`/api/owner/chains/${state.chainId}/questions`, { order });
  } catch (err) {
    // 409: one of these already belongs to another sequence. A question can only
    // be in one, so say which way it goes rather than failing silently.
    const ok = await uiConfirm('Already in another sequence', esc(err.message), 'Move it here', false);
    if (!ok) return;
    try {
      await api.put(`/api/owner/chains/${state.chainId}/questions`, { order, confirmed: true });
    } catch (err2) {
      return toast(err2.message, true);
    }
  }

  state.data.chain = null;
  state.data.chains = null;
  state.data.questions = null;
  await loadTab();
  return undefined;
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
    hint: 'Longer explanation, shown when they open the topic’s menu.',
  },
  // No depth field here, deliberately. A topic is a SUBJECT and carries no
  // depth of its own - depth belongs to the question and is chosen separately
  // by the couple. This form used to ask for one; the server has never stored
  // it, so it was a leftover of the single-axis model asking for a number that
  // went nowhere.
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
    title: 'New topic',
    intro:
      'A subject couples can tick on the start screen. It carries no depth of its own — '
      + 'depth belongs to each question and is chosen separately.',
    fields: GROUP_FIELDS(null),
    confirmLabel: 'Create',
  });
  if (!v) return;
  if (!v.name) return uiAlert('Name needed', 'Give the topic a name.');
  try {
    await api.post('/api/owner/domains', v);
    invalidateContent();
    await loadTab();
    toast('Topic created.');
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
    toast('Topic deleted.');
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

/** Depth options, from the ladder rather than a hard-coded D1..D5. */
function depthOptions() {
  return ((state.data.depths && state.data.depths.depths) || [])
    .filter((x) => x.isActive)
    .map((x) => ({ value: String(x.n), label: `D${x.n} · ${x.name}` }));
}

/** Framework options. "None" first, because most questions have no lens. */
function lensOptions() {
  return [{ value: '', label: 'No framework' }].concat(
    ((state.data.lenses && state.data.lenses.lenses) || [])
      .filter((x) => x.isActive)
      .map((x) => ({ value: x.code, label: `${x.code} · ${x.name}` }))
  );
}

/**
 * The whole question, not just its words.
 *
 * A question carries four things beyond its text: which topic it belongs to,
 * which rung of the ladder it sits on, the line revealed on tap, and whether
 * an honest answer could do damage. The editor used to offer two of those, so
 * anything written here landed at a default depth with no context line - and a
 * card with no context line is one the corpus rules refuse.
 */
const QUESTION_FIELDS = (q, levelOptions) => [
  {
    name: 'text',
    label: 'Question',
    type: 'textarea',
    value: q ? q.text : '',
    placeholder: 'What would you like to ask?',
    hint: 'It has to read on its own, on a card, with nothing else visible — and it cannot be answered yes or no.',
  },
  {
    name: 'context',
    label: 'Context line',
    type: 'textarea',
    value: q ? q.context : '',
    hint: 'Revealed when they tap Expand. Under 18 words, and never an example answer — an example anchors every couple to the same reply.',
  },
  {
    name: 'level',
    label: 'Topic',
    type: 'select',
    options: levelOptions,
    value: q ? q.levelSlug : state.questionLevel || levelOptions[0].value,
  },
  {
    name: 'depth',
    label: 'Depth',
    type: 'select',
    options: depthOptions(),
    value: q ? String(q.depth) : '',
  },
  {
    name: 'lens',
    label: 'Framework',
    type: 'select',
    options: lensOptions(),
    value: q ? q.lens || '' : '',
  },
  {
    name: 'volatile',
    label: 'Volatile',
    type: 'select',
    value: q && q.volatile ? '1' : '0',
    options: [
      { value: '0', label: 'No' },
      { value: '1', label: 'Yes — both partners must consent first' },
    ],
  },
];

async function questionNew() {
  const options = groupOptions();
  if (!options.length) return uiAlert('No topics', 'Create a topic first.');

  const v = await formDialog({
    title: 'New question',
    fields: QUESTION_FIELDS(null, options),
    confirmLabel: 'Add it',
  });
  if (!v || !v.text) return undefined;

  try {
    await api.post('/api/owner/questions', {
      text: v.text,
      context: v.context,
      level: v.level,
      depth: Number(v.depth),
      lens: v.lens,
      volatile: v.volatile === '1',
    });
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
    intro:
      `${esc(q.ref)} · answered ${plural(q.timesUsed, 'time', 'times')}`
      + (q.needsReview
        ? `<br><strong>Held back:</strong> ${esc(q.reviewNote || 'fails the construction rules')}. `
          + 'Rewriting the words is what releases it.'
        : '')
      + (q.chainName ? `<br>In the sequence “${esc(q.chainName)}”.` : ''),
    fields: QUESTION_FIELDS(q, options),
    confirmLabel: 'Save',
  });
  if (!v || !v.text) return;

  try {
    // One PATCH with everything that changed, rather than one per field - the
    // route takes them all and a half-applied edit is worse than a failed one.
    const patch = {};
    if (v.text !== q.text) patch.text = v.text;
    if ((v.context || '') !== (q.context || '')) patch.context = v.context;
    if (Number(v.depth) !== q.depth) patch.depth = Number(v.depth);
    if ((v.lens || '') !== (q.lens || '')) patch.lens = v.lens;
    if ((v.volatile === '1') !== q.volatile) patch.volatile = v.volatile === '1';

    if (Object.keys(patch).length) await api.patch(`/api/owner/questions/${id}`, patch);
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
