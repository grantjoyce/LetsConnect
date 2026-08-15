'use strict';

/* Let's Connect - the whole front end.
 *
 * Vanilla JS, no framework, no build step. render() replaces the app root's
 * innerHTML wholesale and wire() re-attaches handlers afterwards. Two rules
 * follow from that and they are not optional:
 *
 *   1. Handlers are attached by ASSIGNMENT (el.onsubmit = ...), never
 *      addEventListener, so a repeated wire() pass cannot stack duplicates.
 *   2. A render() throws away unsaved form state. Anything typed that must
 *      survive a re-render is mirrored into state.form first.
 *
 * Overlays (dialogs, toasts) append to <body> and manage their own lifecycle,
 * independent of render(), which is what lets a confirm appear over a deck.
 */

// Must match "version" in package.json. Bump BOTH or the footer badge will
// show `vX ⚠ server vY` after a deploy - see the README.
const APP_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  ready: false,
  view: 'auth', // auth | onboard | levels | deck | account
  authMode: 'login', // login | register
  me: null,
  couple: null,
  levels: [],
  serverVersion: null,
  deck: null, // { level, stats, cards, index, releasedEarly }
  form: {}, // values mirrored out of inputs so a re-render can restore them
  error: null,
  busy: false,
};

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

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Puts a colour on the element as a CSS variable the stylesheet reads. */
function accentVars(accent) {
  return `--lv-accent:${esc(accent)};--lv-glow:${esc(accent)}33`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const api = {
  async call(method, path, body) {
    const opts = {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    // Cache-buster on reads, belt and braces alongside the server's no-store.
    const sep = path.includes('?') ? '&' : '?';
    const url = method === 'GET' ? `${path}${sep}t=${Date.now()}` : path;

    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      throw new Error('No connection. Check your signal and try again.');
    }

    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }

    if (res.status === 401 && state.ready) {
      // The session went away underneath us. Drop straight to the login screen
      // rather than leaving a dead UI on screen.
      state.me = null;
      state.couple = null;
      state.deck = null;
      state.view = 'auth';
      render();
      throw new Error((data && data.error) || 'Please log in again.');
    }

    if (!res.ok) throw new Error((data && data.error) || 'Something went wrong.');
    return data;
  },
  get: (p) => api.call('GET', p),
  post: (p, b) => api.call('POST', p, b),
  patch: (p, b) => api.call('PATCH', p, b),
};

// ---------------------------------------------------------------------------
// Overlays - appended to <body>, so they survive and stack over any render()
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
  toastTimer = setTimeout(() => el.remove(), isError ? 4200 : 2600);
}

/**
 * The one dialog primitive. Returns a promise resolving to the value of the
 * button pressed, or null if dismissed.
 */
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
            .map(
              (a, i) =>
                `<button class="btn ${a.className || 'btn-ghost'}" data-i="${i}">${esc(a.label)}</button>`
            )
            .join('')}
        </div>
      </div>`;

    const close = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };

    function onKey(e) {
      if (e.key === 'Escape') close(null);
    }

    overlay.onclick = (e) => {
      if (e.target === overlay) close(null);
    };
    overlay.querySelectorAll('[data-i]').forEach((btn) => {
      btn.onclick = () => close(actions[Number(btn.dataset.i)].value);
    });

    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    const first = overlay.querySelector('.dialog-actions .btn');
    if (first) first.focus();
  });
}

function uiAlert(title, message) {
  return dialog({
    title,
    bodyHtml: `<p>${esc(message)}</p>`,
    actions: [{ label: 'OK', value: true, className: 'btn' }],
  });
}

function uiConfirm(title, message, confirmLabel, danger) {
  return dialog({
    title,
    bodyHtml: `<p>${message}</p>`,
    actions: [
      { label: 'Cancel', value: false, className: 'btn-ghost' },
      {
        label: confirmLabel || 'Confirm',
        value: true,
        className: danger ? 'btn-ghost danger' : 'btn',
      },
    ],
  }).then((v) => v === true);
}

function showHowItWorks() {
  const steps = [
    ['Pair up', 'One of you creates the couple and gets a six-character code. The other enters it. That is the only setup there is.'],
    ['Pick a depth', 'Seven decks, from Icebreakers up to Deep Waters. Choose by how much energy and honesty you both have tonight, not by which one sounds most impressive.'],
    ['Talk about the card', 'One question fills the screen. There is no timer and nothing to type - the app never records a single answer, only whether you dealt with the card.'],
    ['Completed or Skip', '<strong>Completed</strong> retires the question for good. <strong>Skip</strong> means &ldquo;not tonight&rdquo; - it drops out of the deck and can come back around in a couple of weeks.'],
    ['Shared progress', 'Progress belongs to the two of you, not to one phone. Whoever taps, you both stop seeing that card.'],
  ];
  return dialog({
    title: 'How it works',
    bodyHtml: steps
      .map(
        ([h, p], i) => `
        <div class="how-step">
          <div class="how-num">${i + 1}</div>
          <div><h4>${esc(h)}</h4><p>${p}</p></div>
        </div>`
      )
      .join(''),
    actions: [{ label: 'Got it', value: true, className: 'btn' }],
  });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function viewAuth() {
  const isLogin = state.authMode === 'login';
  const f = state.form;

  return `
    <div class="screen screen--centred">
      <div class="hero">
        <div class="hero-mark" aria-hidden="true">&#10084;</div>
        <h1>Let's Connect</h1>
        <p>Questions for couples, one card at a time.</p>
      </div>

      <div class="panel">
        <h2>${isLogin ? 'Welcome back' : 'Create your account'}</h2>
        <p class="panel-sub">
          ${isLogin
            ? 'Sign in to pick up where the two of you left off.'
            : 'You each get your own login, then you pair with a code.'}
        </p>

        ${state.error ? `<div class="form-error">${esc(state.error)}</div>` : ''}

        <form id="auth-form" novalidate>
          ${
            isLogin
              ? ''
              : `<div class="field">
                   <label for="f-name">Your first name</label>
                   <input class="input" id="f-name" name="displayName" type="text"
                          autocomplete="given-name" placeholder="Sam"
                          value="${esc(f.displayName || '')}" required>
                 </div>`
          }
          <div class="field">
            <label for="f-email">Email</label>
            <input class="input" id="f-email" name="email" type="email"
                   autocomplete="email" inputmode="email" placeholder="you@example.com"
                   value="${esc(f.email || '')}" required>
          </div>
          <div class="field">
            <label for="f-password">Password</label>
            <input class="input" id="f-password" name="password" type="password"
                   autocomplete="${isLogin ? 'current-password' : 'new-password'}"
                   placeholder="${isLogin ? 'Your password' : 'At least 8 characters'}" required>
            ${isLogin ? '' : '<p class="hint">At least 8 characters.</p>'}
          </div>

          <button class="btn btn-block" type="submit" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? 'Just a moment…' : isLogin ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div class="switch-row">
          ${isLogin ? "Don't have an account?" : 'Already have one?'}
          <button class="btn-quiet" data-action="switch-auth">
            ${isLogin ? 'Create one' : 'Sign in'}
          </button>
        </div>
      </div>

      <div class="footer-note">
        <button class="btn-quiet" data-action="how">How it works</button>
      </div>
    </div>`;
}

function viewOnboard() {
  const f = state.form;
  return `
    <div class="screen">
      ${topbar(false)}

      <div class="hero">
        <h1>Pair with your partner</h1>
        <p>One of you creates the couple, the other joins with the code.</p>
      </div>

      ${state.error ? `<div class="form-error">${esc(state.error)}</div>` : ''}

      <div class="panel">
        <h2>Start a new couple</h2>
        <p class="panel-sub">You will get a code to send to your partner. You can start using the decks straight away, before they join.</p>
        <form id="create-form" novalidate>
          <div class="field">
            <label for="f-couple">What should we call you two? (optional)</label>
            <input class="input" id="f-couple" name="name" type="text"
                   placeholder="Sam &amp; Alex" value="${esc(f.coupleName || '')}">
          </div>
          <button class="btn btn-block" type="submit" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? 'Just a moment…' : 'Create our couple'}
          </button>
        </form>
      </div>

      <div class="divider">or</div>

      <div class="panel">
        <h2>Join with a code</h2>
        <p class="panel-sub">Enter the six characters your partner sent you.</p>
        <form id="join-form" novalidate>
          <div class="field">
            <label for="f-code">Invite code</label>
            <input class="input input--code" id="f-code" name="inviteCode" type="text"
                   inputmode="text" autocapitalize="characters" autocomplete="off"
                   spellcheck="false" maxlength="6" placeholder="ABC123"
                   value="${esc(f.inviteCode || '')}">
          </div>
          <button class="btn btn-block btn-ghost" type="submit" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? 'Just a moment…' : 'Join'}
          </button>
        </form>
      </div>

      <div class="footer-note">
        <button class="btn-quiet" data-action="how">How it works</button>
      </div>
    </div>`;
}

function topbar(showAccount) {
  return `
    <div class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">&#10084;</span>
        <span>Let's Connect</span>
      </div>
      <div class="topbar-actions">
        <button class="icon-btn" data-action="how" aria-label="How it works" title="How it works">?</button>
        ${
          showAccount
            ? `<button class="icon-btn" data-action="go-account" aria-label="Account" title="Account">&#9881;</button>`
            : `<button class="icon-btn" data-action="logout" aria-label="Sign out" title="Sign out">&#9099;</button>`
        }
      </div>
    </div>`;
}

function levelCard(lv) {
  const done = lv.completed;
  const pct = lv.total ? Math.round((done / lv.total) * 100) : 0;

  // `ready` (not `available`) is what the deck would actually serve: it counts
  // skipped cards the server would release early rather than dead-end. Using
  // `available` here showed "0 ready" on decks that had cards waiting.
  const ready = lv.ready !== undefined ? lv.ready : lv.available;
  const nothingLeft = ready === 0;

  const dots = [1, 2, 3, 4, 5]
    .map((d) => `<span class="dot${d <= lv.depth ? ' on' : ''}"></span>`)
    .join('');

  return `
    <button class="level-card${nothingLeft ? ' is-empty' : ''}"
            style="${accentVars(lv.accent)}"
            data-action="open-deck" data-slug="${esc(lv.slug)}">
      <div class="level-head">
        <span class="level-name">${esc(lv.name)}</span>
        <span class="level-count">${nothingLeft ? 'all done' : `${ready} ready`}</span>
      </div>
      <div class="level-tagline">${esc(lv.tagline)}</div>
      <div class="depth-dots">${dots}<span class="depth-label">Depth ${lv.depth}</span></div>
      <div class="progress"><span style="width:${pct}%"></span></div>
      <div class="level-meta">
        <span>${lv.completed} of ${lv.total} discussed</span>
        ${lv.skipped ? `<span>${lv.skipped} skipped</span>` : ''}
      </div>
    </button>`;
}

function viewLevels() {
  const c = state.couple;
  const partner = c.members.find((m) => m.id !== state.me.id);
  const solo = !partner;

  const totalDone = state.levels.reduce((n, l) => n + l.completed, 0);
  const totalAll = state.levels.reduce((n, l) => n + l.total, 0);

  return `
    <div class="screen">
      ${topbar(true)}

      <div class="hero" style="text-align:left;margin-bottom:1.4rem">
        <h1 style="font-size:1.7rem">${esc(c.name || 'Tonight')}</h1>
        <p style="margin:0.35rem 0 0;max-width:none">
          ${
            solo
              ? `Your invite code is <strong style="color:var(--text);letter-spacing:0.15em">${esc(c.inviteCode)}</strong> — send it to your partner so you share progress.`
              : `${esc(totalDone)} of ${esc(totalAll)} questions discussed with ${esc(partner.displayName)}.`
          }
        </p>
      </div>

      ${
        solo
          ? `<div class="notice">
               <strong>You are on your own so far.</strong> Everything works, and when your
               partner joins with the code they will see exactly the progress you have made.
             </div>`
          : ''
      }

      <h2 class="section-title">Choose a depth</h2>
      <div class="level-list">
        ${state.levels.map(levelCard).join('')}
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

function viewDeck() {
  const d = state.deck;
  const lv = d.level;
  const card = d.cards[d.index];
  const doneInDeck = d.index;
  const stats = d.stats || { completed: 0, total: 0, skipped: 0, available: 0 };

  if (!card) return deckFinished();

  return `
    <div class="deck" style="${accentVars(lv.accent)}">
      <div class="deck-bar">
        <button class="icon-btn" data-action="close-deck" aria-label="Back to the decks">&times;</button>
        <div class="deck-titles">
          <div class="deck-level">${esc(lv.name)}</div>
          <div class="deck-progress-text">
            ${esc(stats.completed)} of ${esc(stats.total)} discussed${
    doneInDeck ? ` &middot; ${plural(doneInDeck, 'card', 'cards')} this sitting` : ''
  }
          </div>
        </div>
        <button class="icon-btn" data-action="deck-menu" aria-label="Deck options">&hellip;</button>
      </div>

      <div class="deck-body">
        <div class="qcard entering" id="qcard">
          <div class="qcard-eyebrow">${esc(lv.name)}</div>
          <div class="qtext">${esc(card.text)}</div>
          ${
            card.seenBefore
              ? '<div class="qcard-note">You skipped this one before — it has come back around.</div>'
              : ''
          }
        </div>
      </div>

      <div class="deck-actions">
        <button class="btn btn-ghost" data-action="answer" data-decision="skipped"
                ${state.busy ? 'disabled' : ''}>Skip</button>
        <button class="btn btn-complete" data-action="answer" data-decision="completed"
                ${state.busy ? 'disabled' : ''}>Completed</button>
      </div>
    </div>`;
}

function deckFinished() {
  const d = state.deck;
  const lv = d.level;
  const s = d.stats || { completed: 0, total: 0, skipped: 0 };
  const allDone = s.completed >= s.total && s.total > 0;

  return `
    <div class="deck" style="${accentVars(lv.accent)}">
      <div class="deck-bar">
        <button class="icon-btn" data-action="close-deck" aria-label="Back to the decks">&times;</button>
        <div class="deck-titles">
          <div class="deck-level">${esc(lv.name)}</div>
          <div class="deck-progress-text">${esc(s.completed)} of ${esc(s.total)} discussed</div>
        </div>
        <span style="width:38px"></span>
      </div>

      <div class="deck-body">
        <div class="deck-done">
          <div class="deck-done-mark" aria-hidden="true">${allDone ? '&#10003;' : '&#8987;'}</div>
          <h2>${allDone ? 'That is the whole deck' : 'Nothing left for now'}</h2>
          <p>
            ${
              allDone
                ? `You have talked your way through all ${esc(s.total)} questions in ${esc(lv.name)}. That is not nothing.`
                : `You have worked through everything currently available here.${
                    s.skipped
                      ? ` ${plural(s.skipped, 'question is', 'questions are')} on the skipped pile and will come back around in a couple of weeks.`
                      : ''
                  }`
            }
          </p>
          <div class="stack">
            ${
              s.skipped
                ? `<button class="btn btn-ghost" data-action="restore-skipped">
                     Bring back the ${plural(s.skipped, 'skipped one', 'skipped ones')} now
                   </button>`
                : ''
            }
            <button class="btn" data-action="close-deck">Choose another depth</button>
            ${
              s.completed
                ? `<button class="btn btn-ghost danger" data-action="reset-deck">
                     Start this deck again
                   </button>`
                : ''
            }
          </div>
        </div>
      </div>
    </div>`;
}

function viewAccount() {
  const c = state.couple;
  const partner = c ? c.members.find((m) => m.id !== state.me.id) : null;
  const canInstall = !!window.__deferredInstall;

  return `
    <div class="screen">
      <div class="topbar">
        <div class="brand">
          <button class="icon-btn" data-action="go-levels" aria-label="Back">&larr;</button>
          <span>Account</span>
        </div>
      </div>

      <h2 class="section-title">You</h2>
      <div class="rows">
        <button class="row" data-action="edit-name">
          <span class="row-label">Name</span>
          <span class="row-value">${esc(state.me.displayName)}</span>
        </button>
        <div class="row is-static">
          <span class="row-label">Email</span>
          <span class="row-value">${esc(state.me.email)}</span>
        </div>
        <button class="row" data-action="change-password">
          <span class="row-label">Change password</span>
          <span class="row-value">&rsaquo;</span>
        </button>
      </div>

      ${
        c
          ? `<h2 class="section-title" style="margin-top:1.5rem">Your couple</h2>
             <div class="rows">
               <button class="row" data-action="edit-couple-name">
                 <span class="row-label">Couple name</span>
                 <span class="row-value">${esc(c.name || 'Not set')}</span>
               </button>
               <button class="row" data-action="show-code">
                 <span class="row-label">Invite code</span>
                 <span class="row-value" style="letter-spacing:0.12em">${esc(c.inviteCode)}</span>
               </button>
               <div class="row is-static">
                 <span class="row-label">Partner</span>
                 <span class="row-value">${partner ? esc(partner.displayName) : 'Not joined yet'}</span>
               </div>
               <button class="row danger" data-action="leave-couple">
                 <span class="row-label">Leave this couple</span>
                 <span class="row-value">&rsaquo;</span>
               </button>
             </div>`
          : ''
      }

      <h2 class="section-title" style="margin-top:1.5rem">App</h2>
      <div class="rows">
        ${
          canInstall
            ? `<button class="row" data-action="install">
                 <span class="row-label">Add to home screen</span>
                 <span class="row-value">&rsaquo;</span>
               </button>`
            : ''
        }
        <button class="row" data-action="how">
          <span class="row-label">How it works</span>
          <span class="row-value">&rsaquo;</span>
        </button>
        <button class="row" data-action="logout">
          <span class="row-label">Sign out</span>
          <span class="row-value">&rsaquo;</span>
        </button>
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

// ---------------------------------------------------------------------------
// render / wire
// ---------------------------------------------------------------------------

function render() {
  let html;
  if (!state.ready) {
    html = '<div class="boot"><div class="boot-mark"></div><p class="boot-text">Loading…</p></div>';
  } else if (!state.me) {
    html = viewAuth();
  } else if (!state.couple) {
    html = viewOnboard();
  } else if (state.view === 'deck' && state.deck) {
    html = viewDeck();
  } else if (state.view === 'account') {
    html = viewAccount();
  } else {
    html = viewLevels();
  }

  root.innerHTML = html;
  wire();
}

function wire() {
  // Delegated clicks. One handler, assigned (not added), so repeated wire()
  // passes cannot stack duplicates.
  root.onclick = (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    e.preventDefault();
    handleAction(el.dataset.action, el);
  };

  const authForm = document.getElementById('auth-form');
  if (authForm) authForm.onsubmit = onAuthSubmit;

  const createForm = document.getElementById('create-form');
  if (createForm) createForm.onsubmit = onCreateCouple;

  const joinForm = document.getElementById('join-form');
  if (joinForm) joinForm.onsubmit = onJoinCouple;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function handleAction(action, el) {
  switch (action) {
    case 'how':
      showHowItWorks();
      break;

    case 'switch-auth':
      state.authMode = state.authMode === 'login' ? 'register' : 'login';
      state.error = null;
      render();
      break;

    case 'go-account':
      state.view = 'account';
      render();
      break;

    case 'go-levels':
      state.view = 'levels';
      render();
      break;

    case 'logout':
      await doLogout();
      break;

    case 'open-deck':
      await openDeck(el.dataset.slug);
      break;

    case 'close-deck':
      state.deck = null;
      state.view = 'levels';
      render();
      break;

    case 'answer':
      await answerCard(el.dataset.decision);
      break;

    case 'deck-menu':
      await showDeckMenu();
      break;

    case 'restore-skipped':
      await resetDeck('skipped');
      break;

    case 'reset-deck':
      await resetDeck('all');
      break;

    case 'edit-name':
      await editName();
      break;

    case 'change-password':
      await changePassword();
      break;

    case 'edit-couple-name':
      await editCoupleName();
      break;

    case 'show-code':
      await showCode();
      break;

    case 'leave-couple':
      await leaveCouple();
      break;

    case 'install':
      await doInstall();
      break;

    default:
      break;
  }
}

// ---- Auth -----------------------------------------------------------------

async function onAuthSubmit(e) {
  e.preventDefault();
  if (state.busy) return;

  const form = e.target;
  const email = form.email.value.trim();
  const password = form.password.value;
  const displayName = form.displayName ? form.displayName.value.trim() : '';

  // Mirror into state so the re-render on failure does not wipe what was typed.
  state.form = { email, displayName };
  state.error = null;
  state.busy = true;
  render();

  try {
    if (state.authMode === 'login') {
      await api.post('/api/auth/login', { email, password });
    } else {
      await api.post('/api/auth/register', { email, password, displayName });
    }
    state.form = {};
    state.busy = false;
    await loadData();
  } catch (err) {
    state.busy = false;
    state.error = err.message;
    render();
  }
}

async function doLogout() {
  const yes = await uiConfirm('Sign out?', 'You can sign back in any time.', 'Sign out');
  if (!yes) return;
  try {
    await api.post('/api/auth/logout');
  } catch (err) {
    /* signing out locally regardless */
  }
  state.me = null;
  state.couple = null;
  state.levels = [];
  state.deck = null;
  state.view = 'auth';
  state.authMode = 'login';
  render();
}

// ---- Pairing --------------------------------------------------------------

async function onCreateCouple(e) {
  e.preventDefault();
  if (state.busy) return;

  const name = e.target.name.value.trim();
  state.form = { ...state.form, coupleName: name };
  state.error = null;
  state.busy = true;
  render();

  try {
    const res = await api.post('/api/couple', { name });
    state.busy = false;
    state.form = {};
    await loadData();
    await dialog({
      title: 'Your invite code',
      bodyHtml: `
        <p>Send this to your partner. When they enter it, the two of you share one set of progress.</p>
        <div class="code-display">
          <span class="code-label">Invite code</span>
          <span class="code">${esc(res.inviteCode)}</span>
        </div>
        <p>It stays in Account if you need it again.</p>`,
      actions: [
        { label: 'Copy code', value: 'copy', className: 'btn-ghost' },
        { label: 'Done', value: 'ok', className: 'btn' },
      ],
    }).then((choice) => {
      if (choice === 'copy') copyText(res.inviteCode);
    });
  } catch (err) {
    state.busy = false;
    state.error = err.message;
    render();
  }
}

async function onJoinCouple(e) {
  e.preventDefault();
  if (state.busy) return;

  const inviteCode = e.target.inviteCode.value.trim().toUpperCase();
  state.form = { ...state.form, inviteCode };
  state.error = null;

  if (!inviteCode) {
    state.error = 'Enter the code your partner sent you.';
    render();
    return;
  }

  state.busy = true;
  render();

  try {
    await api.post('/api/couple/join', { inviteCode });
    state.busy = false;
    state.form = {};
    await loadData();
    toast('You are paired up.');
  } catch (err) {
    state.busy = false;
    state.error = err.message;
    render();
  }
}

async function leaveCouple() {
  const partner = state.couple.members.find((m) => m.id !== state.me.id);
  const yes = await uiConfirm(
    'Leave this couple?',
    `You will stop sharing progress${
      partner ? ` with <strong>${esc(partner.displayName)}</strong>` : ''
    }, and you will need an invite code to join a couple again. The progress itself is kept, not deleted.`,
    'Leave',
    true
  );
  if (!yes) return;

  try {
    await api.post('/api/couple/leave');
    await loadData();
    toast('You have left the couple.');
  } catch (err) {
    uiAlert('Could not leave', err.message);
  }
}

async function showCode() {
  const choice = await dialog({
    title: 'Invite code',
    bodyHtml: `
      <p>Give this to your partner so they can join.</p>
      <div class="code-display">
        <span class="code-label">Invite code</span>
        <span class="code">${esc(state.couple.inviteCode)}</span>
      </div>`,
    actions: [
      { label: 'Copy', value: 'copy', className: 'btn-ghost' },
      { label: 'Close', value: 'ok', className: 'btn' },
    ],
  });
  if (choice === 'copy') copyText(state.couple.inviteCode);
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => toast('Copied.'),
      () => toast('Could not copy — write it down instead.', true)
    );
  } else {
    toast('Copying is not available here — write it down.', true);
  }
}

// ---- The deck -------------------------------------------------------------

/**
 * Always asks the server, even when the level looks empty.
 *
 * An earlier version short-circuited to the "nothing left" screen whenever
 * `available` was 0, to save a request. That silently defeated the server's
 * own guard: when the skip cool-off is the only thing holding cards back, the
 * deck releases them early - and the short-circuit meant that release could
 * never happen from the levels list. Let the server decide what is left.
 */
async function openDeck(slug) {
  try {
    const data = await api.get(`/api/deck/${encodeURIComponent(slug)}`);
    state.deck = {
      level: data.level,
      stats: data.stats,
      cards: data.cards,
      index: 0,
      releasedEarly: data.releasedEarly,
    };
    state.view = 'deck';
    render();
    if (data.releasedEarly) {
      toast('Bringing back questions you skipped earlier.');
    }
  } catch (err) {
    uiAlert('Could not open that deck', err.message);
  }
}

async function answerCard(decision) {
  const d = state.deck;
  if (!d || state.busy) return;
  const card = d.cards[d.index];
  if (!card) return;

  state.busy = true;

  // Animate the card out first. The DOM is mutated in place here rather than
  // re-rendered, because a render() would swap the card instantly and the
  // animation would never be seen.
  const el = document.getElementById('qcard');
  if (el) el.classList.add(decision === 'skipped' ? 'leaving-skip' : 'leaving-done');

  const settle = new Promise((r) => setTimeout(r, el ? 200 : 0));

  try {
    const [res] = await Promise.all([
      api.post('/api/answer', { questionId: card.id, action: decision }),
      settle,
    ]);

    state.levels = res.levels;
    const fresh = res.levels.find((l) => l.slug === d.level.slug);
    if (fresh) d.stats = fresh;

    d.index += 1;
    state.busy = false;

    // Top the deck up before it runs dry, so there is never a pause mid-flow.
    if (d.index >= d.cards.length - 3 && fresh && (fresh.ready || 0) > 0) {
      refillDeck().catch(() => {});
    }

    render();
  } catch (err) {
    state.busy = false;
    if (el) el.classList.remove('leaving-skip', 'leaving-done');
    render();
    toast(err.message, true);
  }
}

/**
 * Fetch a fresh batch and append anything not already in hand.
 *
 * Deduped by id because the server re-shuffles from the same seed each time,
 * so an unanswered card will legitimately appear in both the old batch and the
 * new one.
 */
async function refillDeck() {
  const d = state.deck;
  if (!d) return;
  const data = await api.get(`/api/deck/${encodeURIComponent(d.level.slug)}`);
  if (!state.deck || state.deck.level.slug !== d.level.slug) return;

  const have = new Set(d.cards.map((c) => c.id));
  const extra = data.cards.filter((c) => !have.has(c.id));
  if (extra.length) {
    d.cards = d.cards.concat(extra);
    d.stats = data.stats;
    if (state.view === 'deck') render();
  }
}

async function showDeckMenu() {
  const d = state.deck;
  const s = d.stats || {};
  const actions = [{ label: 'Close', value: null, className: 'btn-ghost' }];
  if (s.skipped) actions.unshift({ label: 'Bring back skipped', value: 'skipped', className: 'btn-ghost' });
  if (s.completed) actions.unshift({ label: 'Start deck again', value: 'all', className: 'btn-ghost danger' });

  const choice = await dialog({
    title: d.level.name,
    bodyHtml: `
      <p>${esc(d.level.description || d.level.tagline)}</p>
      <p style="margin-top:0.75rem">
        <strong>${esc(s.completed || 0)}</strong> discussed &middot;
        <strong>${esc(s.skipped || 0)}</strong> skipped &middot;
        <strong>${esc(s.total || 0)}</strong> in the deck
      </p>`,
    actions,
  });

  if (choice === 'skipped' || choice === 'all') await resetDeck(choice);
}

/**
 * Clears progress for the open deck.
 *
 * The count comes from the stats already in hand, so the confirmation names a
 * real number rather than a vague warning - and the server returns what it
 * actually removed, which is what the toast reports.
 */
async function resetDeck(scope) {
  const d = state.deck;
  if (!d) return;
  const s = d.stats || {};

  const isSkipped = scope === 'skipped';
  const count = isSkipped ? s.skipped || 0 : (s.completed || 0) + (s.skipped || 0);

  if (!count) {
    toast('There is nothing to clear here.');
    return;
  }

  const yes = await uiConfirm(
    isSkipped ? 'Bring back skipped questions?' : `Start ${esc(d.level.name)} again?`,
    isSkipped
      ? `The <strong>${count}</strong> question${count === 1 ? '' : 's'} you skipped in ${esc(
          d.level.name
        )} will go straight back into the deck. Nothing you marked as discussed is affected.`
      : `This clears all <strong>${count}</strong> record${
          count === 1 ? '' : 's'
        } for ${esc(d.level.name)} — every question becomes available again, as if you had never opened it. This cannot be undone.`,
    isSkipped ? 'Bring them back' : `Clear ${count}`,
    !isSkipped
  );
  if (!yes) return;

  try {
    const res = await api.post(`/api/deck/${encodeURIComponent(d.level.slug)}/reset`, { scope });
    state.levels = res.levels;
    toast(`Cleared ${plural(res.cleared, 'record', 'records')}.`);
    await openDeck(d.level.slug);
  } catch (err) {
    uiAlert('Could not reset', err.message);
  }
}

// ---- Account --------------------------------------------------------------

/** A dialog with a single text input. Resolves to the trimmed value or null. */
function promptDialog({ title, message, label, value, placeholder, type, confirmLabel }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="dialog" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        <div class="dialog-body">
          ${message ? `<p style="margin-bottom:1rem">${message}</p>` : ''}
          <div class="field">
            <label for="pd-input">${esc(label)}</label>
            <input class="input" id="pd-input" type="${esc(type || 'text')}"
                   placeholder="${esc(placeholder || '')}" value="${esc(value || '')}">
          </div>
        </div>
        <div class="dialog-actions">
          <button class="btn btn-ghost" data-v="cancel">Cancel</button>
          <button class="btn" data-v="ok">${esc(confirmLabel || 'Save')}</button>
        </div>
      </div>`;

    const input = overlay.querySelector('#pd-input');
    const close = (v) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    function onKey(e) {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && document.activeElement === input) close(input.value.trim());
    }

    overlay.onclick = (e) => {
      if (e.target === overlay) close(null);
    };
    overlay.querySelector('[data-v="cancel"]').onclick = () => close(null);
    overlay.querySelector('[data-v="ok"]').onclick = () => close(input.value.trim());

    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 30);
  });
}

async function editName() {
  const name = await promptDialog({
    title: 'Your name',
    label: 'First name',
    value: state.me.displayName,
  });
  if (name === null || name === state.me.displayName) return;
  if (!name) return uiAlert('Name needed', 'Enter a name.');

  try {
    await api.patch('/api/me', { displayName: name });
    state.me.displayName = name;
    render();
    toast('Name updated.');
  } catch (err) {
    uiAlert('Could not save', err.message);
  }
  return undefined;
}

async function editCoupleName() {
  const name = await promptDialog({
    title: 'Couple name',
    message: 'Just what the two of you are called in the app. Leave it blank to clear it.',
    label: 'Name',
    value: state.couple.name || '',
    placeholder: 'Sam & Alex',
  });
  if (name === null) return;

  try {
    const res = await api.patch('/api/couple', { name });
    state.couple.name = res.name;
    render();
    toast('Saved.');
  } catch (err) {
    uiAlert('Could not save', err.message);
  }
}

async function changePassword() {
  const current = await promptDialog({
    title: 'Change password',
    message: 'First, confirm the password you use now.',
    label: 'Current password',
    type: 'password',
    confirmLabel: 'Next',
  });
  if (!current) return;

  const next = await promptDialog({
    title: 'New password',
    message: 'At least 8 characters.',
    label: 'New password',
    type: 'password',
    confirmLabel: 'Change it',
  });
  if (!next) return;

  try {
    await api.post('/api/me/password', { currentPassword: current, newPassword: next });
    toast('Password changed.');
  } catch (err) {
    uiAlert('Could not change it', err.message);
  }
}

async function doInstall() {
  const prompt = window.__deferredInstall;
  if (!prompt) {
    return uiAlert(
      'Add to home screen',
      'Your browser has not offered an install prompt. On iPhone, use Share then "Add to Home Screen".'
    );
  }
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  window.__deferredInstall = null;
  if (outcome === 'accepted') toast('Installed.');
  render();
  return undefined;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function loadData() {
  try {
    const data = await api.get('/api/data');
    state.me = data.me;
    state.couple = data.couple;
    state.levels = data.levels || [];
    state.serverVersion = data.version;
    state.error = null;
    if (state.view === 'deck') state.view = 'levels';
    if (state.view !== 'account') state.view = 'levels';
  } catch (err) {
    // A 401 here just means nobody is logged in - the normal first visit.
    state.me = null;
    state.couple = null;
  }
  state.ready = true;
  render();
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.__deferredInstall = e;
  if (state.ready && state.view === 'account') render();
});

// Refresh progress when the app comes back to the foreground, so a partner's
// taps on their own phone are picked up.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.me) return;
  if (state.view === 'deck') return; // never swap the card out from under them
  api
    .get('/api/data')
    .then((data) => {
      state.couple = data.couple;
      state.levels = data.levels || [];
      state.serverVersion = data.version;
      render();
    })
    .catch(() => {});
});

render();
loadData();
