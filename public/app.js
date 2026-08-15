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
const APP_VERSION = '1.3.1';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  ready: false,
  view: 'auth', // auth | onboard | levels | deck | account | admin
  authMode: 'login', // login | register | forgot
  me: null,
  couple: null,

  // Depth and domain are INDEPENDENT axes. A domain is a subject and carries no
  // depth of its own; each domain reports what it holds at each depth, so the
  // picker can grey out a depth that has nothing in it.
  domains: [],
  domain: null, // the domain being browsed, before a depth is chosen
  chains: null,
  chain: null, // { chain, cards, position } while running a sequence
  volatile: null, // { unlocked, mine, waitingOnPartner, available }

  serverVersion: null,
  deck: null, // { domain, depth, stats, cards, index, releasedEarly }
  revealed: false, // whether the context line on the current card is showing
  form: {}, // values mirrored out of inputs so a re-render can restore them
  error: null,
  notice: null,
  busy: false,

  // Password reset, driven by ?reset=<token> in the URL.
  reset: null, // { token, checking, valid, displayName, done, error }

  // App name, tagline and accent, set by the owner in the admin area.
  branding: null,
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

/** Branding with the built-in values as a fallback, so it is safe before load. */
function brand() {
  const b = state.branding || {};
  return {
    name: b.app_name || "Let's Connect",
    tagline: b.app_tagline || 'Questions for couples, one card at a time.',
    mark: b.brand_mark || '❤',
  };
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

function viewForgot() {
  const f = state.form;
  return `
    <div class="screen screen--centred">
      <div class="hero">
        <div class="hero-mark" aria-hidden="true">&#10084;</div>
        <h1>Forgotten password</h1>
        <p>We will email you a link to choose a new one.</p>
      </div>

      <div class="panel">
        ${state.error ? `<div class="form-error">${esc(state.error)}</div>` : ''}
        ${state.notice ? `<div class="notice">${esc(state.notice)}</div>` : ''}

        <form id="forgot-form" novalidate>
          <div class="field">
            <label for="f-email">Email</label>
            <input class="input" id="f-email" name="email" type="email"
                   autocomplete="email" inputmode="email" placeholder="you@example.com"
                   value="${esc(f.email || '')}" required>
          </div>
          <button class="btn btn-block" type="submit" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? 'Sending…' : 'Send the link'}
          </button>
        </form>

        <div class="switch-row">
          <button class="btn-quiet" data-action="go-login">Back to sign in</button>
        </div>
      </div>
    </div>`;
}

/** The ?reset=<token> screen. Shown to logged-out and logged-in visitors alike. */
function viewReset() {
  const r = state.reset;

  if (r.done) {
    return `
      <div class="screen screen--centred">
        <div class="hero">
          <div class="hero-mark" aria-hidden="true">&#10003;</div>
          <h1>Password changed</h1>
          <p>You can sign in with your new password now.</p>
        </div>
        <div class="panel">
          <button class="btn btn-block" data-action="finish-reset">Sign in</button>
        </div>
      </div>`;
  }

  if (r.checking) {
    return `
      <div class="screen screen--centred">
        <div class="boot"><div class="boot-mark"></div>
        <p class="boot-text">Checking your link…</p></div>
      </div>`;
  }

  if (!r.valid) {
    return `
      <div class="screen screen--centred">
        <div class="hero">
          <div class="hero-mark" aria-hidden="true">&#9888;</div>
          <h1>Link no longer works</h1>
          <p>${esc(r.error || 'That reset link has expired or has already been used.')}</p>
        </div>
        <div class="panel">
          <button class="btn btn-block" data-action="go-forgot">Send a new link</button>
          <div class="switch-row">
            <button class="btn-quiet" data-action="finish-reset">Back to sign in</button>
          </div>
        </div>
      </div>`;
  }

  return `
    <div class="screen screen--centred">
      <div class="hero">
        <div class="hero-mark" aria-hidden="true">&#10084;</div>
        <h1>Choose a new password</h1>
        <p>Hello ${esc(r.displayName)}. Pick something you have not used here before.</p>
      </div>

      <div class="panel">
        ${state.error ? `<div class="form-error">${esc(state.error)}</div>` : ''}
        <form id="reset-form" novalidate>
          <div class="field">
            <label for="f-password">New password</label>
            <input class="input" id="f-password" name="password" type="password"
                   autocomplete="new-password" placeholder="At least 8 characters" required>
          </div>
          <div class="field">
            <label for="f-confirm">Confirm it</label>
            <input class="input" id="f-confirm" name="confirm" type="password"
                   autocomplete="new-password" placeholder="Type it again" required>
          </div>
          <button class="btn btn-block" type="submit" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? 'Saving…' : 'Change my password'}
          </button>
        </form>
        <p class="hint" style="margin-top:0.9rem">
          This link works once and expires an hour after it was sent. Changing your password
          signs you out everywhere else.
        </p>
      </div>
    </div>`;
}

function viewAuth() {
  if (state.authMode === 'forgot') return viewForgot();
  const isLogin = state.authMode === 'login';
  const f = state.form;

  return `
    <div class="screen screen--centred">
      <div class="hero">
        <div class="hero-mark" aria-hidden="true">${esc(brand().mark)}</div>
        <h1>${esc(brand().name)}</h1>
        <p>${esc(brand().tagline)}</p>
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

        ${
          isLogin
            ? `<div class="switch-row" style="margin-top:0.35rem">
                 <button class="btn-quiet" data-action="go-forgot">Forgotten your password?</button>
               </div>`
            : ''
        }
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
        <span class="brand-mark" aria-hidden="true">${esc(brand().mark)}</span>
        <span>${esc(brand().name)}</span>
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

/** D1..D5. Exposure only - nothing to do with subject. */
const DEPTHS = [
  { n: 1, name: 'Open', blurb: 'Answerable straight away. Nothing at stake.' },
  { n: 2, name: 'Reflective', blurb: 'Needs a moment’s thought. Mild disclosure.' },
  { n: 3, name: 'Personal', blurb: 'Real disclosure. Assumes you already trust each other.' },
  { n: 4, name: 'Exposed', blurb: 'Shame, fear, unmet need. Give it proper time.' },
  { n: 5, name: 'Rupture', blurb: 'Damage that cannot be taken back. Only when you both mean it.' },
];

function domainCard(d) {
  const pct = d.total ? Math.round((d.completed / d.total) * 100) : 0;
  const nothingLeft = d.ready === 0;
  const deepest = d.depths.length ? Math.max(...d.depths.map((x) => x.depth)) : 0;

  // Dots show the range of exposure this SUBJECT reaches, which is a property
  // of its questions rather than of the subject itself. "What Matters" holding
  // only D1 is worth seeing before you open it.
  const dots = [1, 2, 3, 4, 5]
    .map((n) => {
      const has = d.depths.some((x) => x.depth === n && x.total > 0);
      return `<span class="dot${has ? ' on' : ''}"></span>`;
    })
    .join('');

  return `
    <button class="level-card${nothingLeft ? ' is-empty' : ''}"
            style="${accentVars(d.accent)}"
            data-action="open-domain" data-slug="${esc(d.slug)}">
      <div class="level-head">
        <span class="level-name">${esc(d.name)}</span>
        <span class="level-count">${nothingLeft ? 'all done' : `${d.ready} ready`}</span>
      </div>
      <div class="level-tagline">${esc(d.tagline || '')}</div>
      <div class="depth-dots">${dots}<span class="depth-label">
        ${deepest ? `to depth ${deepest}` : 'empty'}
      </span></div>
      <div class="progress"><span style="width:${pct}%"></span></div>
      <div class="level-meta">
        <span>${d.completed} of ${d.total} discussed</span>
        ${d.skipped ? `<span>${d.skipped} skipped</span>` : ''}
      </div>
    </button>`;
}

function viewDomains() {
  const c = state.couple;
  const partner = c.members.find((m) => m.id !== state.me.id);
  const solo = !partner;

  const totalDone = state.domains.reduce((n, d) => n + d.completed, 0);
  const totalAll = state.domains.reduce((n, d) => n + d.total, 0);
  const chainCount = state.chains ? state.chains.length : null;

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

      <button class="btn btn-block btn-ghost" data-action="open-chains" style="margin-bottom:1.4rem">
        Guided sequences${chainCount ? ` · ${chainCount}` : ''}
      </button>

      <h2 class="section-title">What would you like to talk about?</h2>
      <div class="level-list">
        ${state.domains.map(domainCard).join('')}
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

/**
 * Depth picker for the chosen subject.
 *
 * The second half of the two-axis choice: you have said what to talk about,
 * now say how exposing you want it. Depths with nothing in them are shown but
 * disabled rather than hidden, so the shape of the subject is visible - it is
 * useful to see that Home holds almost nothing above D3.
 */
function viewDepthPicker() {
  const d = state.domain;
  if (!d) return viewDomains();

  return `
    <div class="screen" style="${accentVars(d.accent)}">
      <div class="topbar">
        <div class="brand">
          <button class="icon-btn" data-action="go-domains" aria-label="Back">&larr;</button>
          <span>${esc(d.name)}</span>
        </div>
      </div>

      <div class="hero" style="text-align:left;margin-bottom:1.2rem">
        <h1 style="font-size:1.6rem">${esc(d.name)}</h1>
        <p style="margin:0.35rem 0 0;max-width:none">${esc(d.description || d.tagline || '')}</p>
      </div>

      <h2 class="section-title">How deep tonight?</h2>
      <div class="level-list">
        ${DEPTHS.map((depth) => {
          const stat = d.depths.find((x) => x.depth === depth.n);
          const ready = stat ? stat.ready : 0;
          const total = stat ? stat.total : 0;
          const empty = total === 0;
          return `
            <button class="level-card${empty || ready === 0 ? ' is-empty' : ''}"
                    style="${accentVars(d.accent)}"
                    ${empty ? 'disabled' : ''}
                    data-action="open-deck" data-slug="${esc(d.slug)}" data-depth="${depth.n}">
              <div class="level-head">
                <span class="level-name">${depth.n}. ${esc(depth.name)}</span>
                <span class="level-count">${
                  empty ? 'none here' : ready === 0 ? 'all done' : `${ready} ready`
                }</span>
              </div>
              <div class="level-tagline">${esc(depth.blurb)}</div>
              ${
                total
                  ? `<div class="level-meta"><span>${stat.completed} of ${total} discussed</span>
                     ${stat.skipped ? `<span>${stat.skipped} skipped</span>` : ''}</div>`
                  : ''
              }
            </button>`;
        }).join('')}
      </div>

      <button class="btn btn-block btn-ghost" data-action="open-deck"
              data-slug="${esc(d.slug)}" style="margin-top:1rem">
        Any depth — mix them
      </button>
    </div>`;
}

/** The list of guided sequences. */
function viewChains() {
  const chains = state.chains;

  return `
    <div class="screen">
      <div class="topbar">
        <div class="brand">
          <button class="icon-btn" data-action="go-domains" aria-label="Back">&larr;</button>
          <span>Guided sequences</span>
        </div>
      </div>

      <div class="notice">
        A sequence is a handful of cards that circle the same thing, getting more
        exposing as you go. Every card still stands on its own, so stopping early is a
        complete conversation rather than an abandoned one.
      </div>

      ${
        !chains
          ? '<div class="boot" style="min-height:30vh"><div class="boot-mark"></div></div>'
          : chains.length
            ? `<div class="level-list">
                 ${chains
                   .map(
                     (c) => `
                   <button class="level-card" style="${accentVars(c.accent)}"
                           data-action="open-chain" data-id="${c.id}">
                     <div class="level-head">
                       <span class="level-name">${esc(c.name)}</span>
                       <span class="level-count">${c.total} card${c.total === 1 ? '' : 's'}</span>
                     </div>
                     <div class="level-tagline">${esc(c.domainName || '')} · depth ${c.minDepth}${
                       c.maxDepth !== c.minDepth ? ` to ${c.maxDepth}` : ''
                     }</div>
                     ${
                       c.gateAt
                         ? '<div class="level-meta"><span>Goes deep — you will be asked before it does</span></div>'
                         : ''
                     }
                     ${
                       c.completed
                         ? `<div class="level-meta"><span>${c.completed} of ${c.total} done</span></div>`
                         : ''
                     }
                   </button>`
                   )
                   .join('')}
               </div>`
            : `<div class="empty-state"><h3>Nothing left</h3>
                 <p>You have worked through every sequence available to you.</p></div>`
      }
    </div>`;
}

/**
 * D1-D5 as toggles, above the card.
 *
 * Multi-select rather than a single choice, because "everything except the
 * deepest" is a normal thing to want on a weeknight. Unticking is the way you
 * exclude a depth; the last remaining one cannot be unticked, since a deck
 * with nothing selected is just an empty screen.
 */
function depthFilterBar() {
  const d = state.deck;
  const on = d.selectedDepths || [1, 2, 3, 4, 5];
  const counts = d.depthCounts || [];
  const onlyOne = on.length === 1;

  return `
    <div class="depth-filter" role="group" aria-label="Depth">
      ${DEPTHS.map((depth) => {
        const stat = counts.find((x) => x.depth === depth.n);
        const has = stat && stat.total > 0;
        const active = on.includes(depth.n);
        return `
          <button class="depth-chip${active ? ' is-on' : ''}"
                  data-action="toggle-depth" data-depth="${depth.n}"
                  aria-pressed="${active}"
                  title="${esc(depth.name)} — ${esc(depth.blurb)}"
                  ${!has ? 'disabled' : ''}
                  ${active && onlyOne ? 'data-last="1"' : ''}>
            D${depth.n}
            <span class="depth-chip-n">${stat ? stat.ready : 0}</span>
          </button>`;
      }).join('')}
    </div>`;
}

function viewDeck() {
  const d = state.deck;
  const lv = d.domain;
  const card = d.cards[d.index];
  const doneInDeck = d.index;
  const stats = d.stats || { completed: 0, total: 0, skipped: 0, available: 0 };

  if (!card) return deckFinished();

  const inChain = !!d.chain;
  const depthName = (DEPTHS.find((x) => x.n === card.depth) || {}).name || '';

  return `
    <div class="deck" style="${accentVars(lv.accent)}">
      <div class="deck-bar">
        <button class="icon-btn" data-action="close-deck" aria-label="Back">&times;</button>
        <div class="deck-titles">
          <div class="deck-level">${esc(inChain ? d.chain.name : lv.name)}</div>
          <div class="deck-progress-text">
            ${
              inChain
                ? `Card ${d.index + 1} of ${d.cards.length}`
                : `${esc(stats.completed)} of ${esc(stats.total)} discussed${
                    doneInDeck ? ` &middot; ${plural(doneInDeck, 'card', 'cards')} this sitting` : ''
                  }`
            }
          </div>
        </div>
        <button class="icon-btn" data-action="deck-menu" aria-label="Options">&hellip;</button>
      </div>

      ${inChain ? '' : depthFilterBar()}

      <div class="deck-body">
        <div class="qcard entering" id="qcard">
          <div class="qcard-eyebrow">
            ${esc(inChain ? `${lv.name} · ${d.chain.name}` : lv.name)}
            <span style="opacity:0.6">· ${card.depth}. ${esc(depthName)}</span>
            ${card.volatile ? '<span class="pill pill-warn">handle with care</span>' : ''}
          </div>
          <div class="qtext">${esc(card.text)}</div>

          ${
            card.seenBefore
              ? '<div class="qcard-note">You skipped this one before — it has come back around.</div>'
              : ''
          }

          ${
            card.context
              ? state.revealed
                ? `<div class="qcard-context">${esc(card.context)}</div>`
                : `<button class="qcard-help" data-action="reveal-context">
                     <span aria-hidden="true">?</span> What does this mean
                   </button>`
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
  const lv = d.domain;
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

      ${
        state.volatile
          ? `<h2 class="section-title" style="margin-top:1.5rem">The hardest questions</h2>
             <div class="rows">
               <button class="row" data-action="toggle-volatile">
                 <span class="row-label">
                   ${state.volatile.mine ? 'Unlocked by you' : 'Locked'}
                   <span class="row-sub">${
                     state.volatile.unlocked
                       ? `${state.volatile.available} questions about betrayal, leaving and real damage are in play.`
                       : state.volatile.waitingOnPartner
                         ? 'Waiting for your partner to switch it on too. Nothing changes until they do.'
                         : `${state.volatile.available} questions are held back. Both of you have to switch this on.`
                   }</span>
                 </span>
                 <span class="row-value">${state.volatile.mine ? 'On' : 'Off'}</span>
               </button>
             </div>`
          : ''
      }

      <h2 class="section-title" style="margin-top:1.5rem">Your data</h2>
      <div class="rows">
        <button class="row" data-action="export-data">
          <span class="row-label">Download my data
            <span class="row-sub">Everything this app holds about you, as a file</span>
          </span>
          <span class="row-value">&rsaquo;</span>
        </button>
        <button class="row danger" data-action="delete-account">
          <span class="row-label">Delete my account
            <span class="row-sub">Permanent. Cannot be undone.</span>
          </span>
          <span class="row-value">&rsaquo;</span>
        </button>
      </div>

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
  } else if (state.reset) {
    // Comes before the login check on purpose: a reset link is nearly always
    // opened by somebody who cannot get in.
    html = viewReset();
  } else if (!state.me) {
    html = viewAuth();
  } else if (!state.couple) {
    html = viewOnboard();
  } else if (state.view === 'deck' && state.deck) {
    html = viewDeck();
  } else if (state.view === 'account') {
    html = viewAccount();
  } else if (state.view === 'chains') {
    html = viewChains();
  } else if (state.view === 'depths' && state.domain) {
    html = viewDepthPicker();
  } else {
    html = viewDomains();
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

  const forgotForm = document.getElementById('forgot-form');
  if (forgotForm) forgotForm.onsubmit = onForgotSubmit;

  const resetForm = document.getElementById('reset-form');
  if (resetForm) resetForm.onsubmit = onResetSubmit;

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
      state.notice = null;
      render();
      break;

    case 'go-forgot':
      state.reset = null;
      clearResetFromUrl();
      state.authMode = 'forgot';
      state.error = null;
      state.notice = null;
      render();
      break;

    case 'go-login':
      state.authMode = 'login';
      state.error = null;
      state.notice = null;
      render();
      break;

    case 'finish-reset':
      state.reset = null;
      clearResetFromUrl();
      state.authMode = 'login';
      state.error = null;
      state.notice = null;
      render();
      break;

    case 'report-question':
      await reportQuestion();
      break;

    case 'export-data':
      window.location.href = '/api/me/export';
      toast('Your data is downloading.');
      break;

    case 'delete-account':
      await deleteAccount();
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

    case 'open-domain':
      // Straight into the deck with every depth on. The depth filter lives
      // above the cards, so choosing a subject is one tap rather than two.
      state.domain = state.domains.find((d) => d.slug === el.dataset.slug) || null;
      await openDeck(el.dataset.slug, null);
      break;

    case 'toggle-depth':
      await toggleDepth(Number(el.dataset.depth), el);
      break;

    case 'go-domains':
      state.view = 'levels';
      state.domain = null;
      state.chain = null;
      render();
      break;

    case 'open-chains':
      state.view = 'chains';
      render();
      await loadChains();
      break;

    case 'open-chain':
      await openChain(Number(el.dataset.id));
      break;

    case 'open-deck':
      await openDeck(el.dataset.slug, el.dataset.depth ? Number(el.dataset.depth) : null);
      break;

    case 'reveal-context':
      // Revealed per card, and reset on every advance. The point of hiding it
      // is that the question carries the moment; leaving it open would turn
      // the next card into a worksheet too.
      state.revealed = true;
      render();
      break;

    case 'close-deck':
      state.deck = null;
      state.revealed = false;
      state.view = state.chain ? 'chains' : state.domain ? 'depths' : 'levels';
      state.chain = null;
      render();
      break;

    case 'toggle-volatile':
      await toggleVolatile();
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
  state.domains = [];
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
 * Always asks the server, even when the domain looks empty.
 *
 * An earlier version short-circuited to the "nothing left" screen whenever
 * `available` was 0, to save a request. That silently defeated the server's
 * own guard: when the skip cool-off is the only thing holding cards back, the
 * deck releases them early - and the short-circuit meant that release could
 * never happen from the list. Let the server decide what is left.
 */
async function openDeck(slug, depths) {
  try {
    const list = Array.isArray(depths) && depths.length ? depths : null;
    const q = list ? `?depths=${list.join(',')}` : '';
    const data = await api.get(`/api/deck/${encodeURIComponent(slug)}${q}`);
    state.deck = {
      domain: data.domain,
      selectedDepths: data.selectedDepths,
      depthCounts: data.depthCounts,
      stats: data.stats,
      cards: data.cards,
      index: 0,
      chain: null,
      releasedEarly: data.releasedEarly,
    };
    state.revealed = false;
    state.view = 'deck';
    render();
    if (data.releasedEarly) {
      toast('Bringing back questions you skipped earlier.');
    }
  } catch (err) {
    uiAlert('Could not open that set', err.message);
  }
}

// Increments on every depth toggle. A response is applied only if its token is
// still the newest, so an earlier slow request cannot land on top of a later
// one and leave the deck showing depths the chips say are off.
let depthToken = 0;

/**
 * Tick or untick one depth.
 *
 * Refetching rather than filtering in memory, because the deck only ever holds
 * a page of cards: ticking a depth back on has to pull in cards that were never
 * sent.
 *
 * The selection is applied to state and rendered BEFORE the request goes out.
 * An earlier version awaited the fetch first, so two quick taps both read the
 * same stale selection and the second silently undid the first - which on a
 * phone is just "tapping two chips", not an edge case.
 */
async function toggleDepth(n, el) {
  const d = state.deck;
  if (!d) return;

  const on = new Set(d.selectedDepths || [1, 2, 3, 4, 5]);

  if (on.has(n) && on.size === 1) {
    // Refuse visibly rather than emptying the deck.
    toast('Keep at least one depth switched on.');
    if (el) {
      el.classList.remove('shake');
      void el.offsetWidth; // force a reflow so a repeated tap re-runs it
      el.classList.add('shake');
    }
    return;
  }

  if (on.has(n)) on.delete(n);
  else on.add(n);

  const next = [...on].sort();
  const token = (depthToken += 1);

  // Optimistic: the chips respond immediately and the next tap reads the truth.
  d.selectedDepths = next;
  render();

  try {
    const q = next.length === 5 ? '' : `?depths=${next.join(',')}`;
    const data = await api.get(`/api/deck/${encodeURIComponent(d.domain.slug)}${q}`);
    if (token !== depthToken || !state.deck) return; // a later toggle won

    state.deck.cards = data.cards;
    state.deck.stats = data.stats;
    state.deck.depthCounts = data.depthCounts;
    state.deck.selectedDepths = next;
    state.deck.index = 0;
    state.revealed = false;
    render();
  } catch (err) {
    if (token !== depthToken) return;
    toast(err.message, true);
  }
}

// ---- Chains ---------------------------------------------------------------

async function loadChains() {
  try {
    const data = await api.get('/api/chains');
    state.chains = data.chains;
    if (state.view === 'chains') render();
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * Run a guided sequence.
 *
 * The consent gate sits at the transition INTO depth 4, not at the start, so
 * the couple opts in with a clear view of where the arc is heading rather than
 * agreeing blind at card one.
 */
async function openChain(id) {
  try {
    const data = await api.get(`/api/chains/${id}`);
    if (!data.cards.length) {
      return uiAlert('Nothing left', 'You have already worked through this sequence.');
    }

    // Resume where they stopped, but never past the end.
    const start = Math.min(data.position || 0, data.cards.length - 1);

    if (data.chain.maxDepth >= 4) {
      const yes = await uiConfirm(
        `${esc(data.chain.name)}`,
        `This sequence starts gently and ends at depth <strong>${data.chain.maxDepth}</strong> — ` +
          'shame, fear, or things that cannot be unsaid. ' +
          `${data.cards.length} cards, perhaps twenty minutes.<br><br>` +
          'You can stop after any card and still have had a whole conversation.',
        'Start it',
        false
      );
      if (!yes) return undefined;
    }

    state.chain = data.chain;
    state.deck = {
      domain: {
        slug: data.chain.domainSlug,
        name: data.chain.domainName,
        accent: data.chain.accent,
      },
      depth: null,
      stats: { completed: data.position || 0, total: data.cards.length, skipped: 0 },
      cards: data.cards,
      index: start,
      chain: data.chain,
      releasedEarly: false,
    };
    state.revealed = false;
    state.view = 'deck';
    render();
  } catch (err) {
    uiAlert('Could not open that sequence', err.message);
  }
  return undefined;
}

async function toggleVolatile() {
  const v = state.volatile;
  const turningOn = !v.mine;

  if (turningOn) {
    const yes = await uiConfirm(
      'Unlock the hardest questions?',
      `There are <strong>${v.available}</strong> questions held back because they can do real ` +
        'damage if they arrive in a bad week — betrayal, leaving, what you would need to walk ' +
        'away.<br><br>They stay locked until <strong>you both</strong> switch this on separately. ' +
        'Either of you can switch it off again at any time, on your own.',
      'Unlock my side'
    );
    if (!yes) return;
  }

  try {
    const res = await api.post('/api/couple/volatile', { unlocked: turningOn });
    await loadData();
    if (turningOn) {
      toast(res.unlocked ? 'Unlocked for both of you.' : 'Saved — waiting on your partner.');
    } else {
      toast('Locked again.');
    }
  } catch (err) {
    uiAlert('Could not save', err.message);
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

    state.domains = res.domains;
    const fresh = res.domains.find((l) => l.slug === d.domain.slug);
    if (fresh) d.stats = fresh;

    d.index += 1;
    // Each card earns its own reveal. Carrying it over would turn the next
    // question into a worksheet, which is the whole reason it hides.
    state.revealed = false;
    state.busy = false;

    // Keep a chain session's position on the server, so stopping and coming
    // back resumes rather than restarting.
    if (d.chain) {
      api
        .post(`/api/chains/${d.chain.id}/progress`, {
          position: d.index,
          status: d.index >= d.cards.length ? 'done' : 'active',
        })
        .catch(() => {});
    }

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
  const data = await api.get(`/api/deck/${encodeURIComponent(d.domain.slug)}${d.depth ? `?depth=${d.depth}` : ''}`);
  if (!state.deck || state.deck.domain.slug !== d.domain.slug) return;

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
  // Only offered while a card is actually on screen - there is nothing to
  // report from the finished state.
  if (d.cards[d.index]) {
    actions.unshift({ label: 'Report this question', value: 'report', className: 'btn-ghost' });
  }

  const choice = await dialog({
    title: d.domain.name,
    bodyHtml: `
      <p>${esc(d.domain.description || d.domain.tagline || '')}</p>
      <p style="margin-top:0.75rem">
        <strong>${esc(s.completed || 0)}</strong> discussed &middot;
        <strong>${esc(s.skipped || 0)}</strong> skipped &middot;
        <strong>${esc(s.total || 0)}</strong> in the deck
      </p>`,
    actions,
  });

  if (choice === 'skipped' || choice === 'all') await resetDeck(choice);
  else if (choice === 'report') await reportQuestion();
}

/**
 * Tell the owner a question is a problem.
 *
 * The app records no answers, so a skip is just a number. This is the only
 * place a couple can say WHY something did not work, which makes it the most
 * useful content feedback the app can produce - hence a free-text note rather
 * than only a category.
 */
async function reportQuestion() {
  const d = state.deck;
  const card = d && d.cards[d.index];
  if (!card) return;

  const reason = await dialog({
    title: 'Report this question',
    bodyHtml: `
      <p style="color:var(--text)">${esc(card.text)}</p>
      <p style="margin-top:0.8rem">What is wrong with it? This goes to whoever runs the app.
      Your answers are never recorded, and never will be.</p>`,
    actions: [
      { label: 'Confusing', value: 'unclear', className: 'btn-ghost' },
      { label: 'Upsetting', value: 'upsetting', className: 'btn-ghost' },
      { label: 'Inappropriate', value: 'inappropriate', className: 'btn-ghost' },
      { label: 'Cancel', value: null, className: 'btn-ghost' },
    ],
  });
  if (!reason) return;

  const note = await promptDialog({
    title: 'Anything to add?',
    message: 'Optional — but a sentence here is worth far more than the category alone.',
    label: 'Your note',
    placeholder: 'Leave blank if you would rather not say',
    confirmLabel: 'Send it',
  });
  if (note === null) return;

  try {
    await api.post('/api/report', { questionId: card.id, reason, note });
    toast('Thank you — that has been passed on.');
  } catch (err) {
    toast(err.message, true);
  }
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
    isSkipped ? 'Bring back skipped questions?' : `Start ${esc(d.domain.name)} again?`,
    isSkipped
      ? `The <strong>${count}</strong> question${count === 1 ? '' : 's'} you skipped in ${esc(
          d.domain.name
        )} will go straight back into the deck. Nothing you marked as discussed is affected.`
      : `This clears all <strong>${count}</strong> record${
          count === 1 ? '' : 's'
        } for ${esc(d.domain.name)} — every question becomes available again, as if you had never opened it. This cannot be undone.`,
    isSkipped ? 'Bring them back' : `Clear ${count}`,
    !isSkipped
  );
  if (!yes) return;

  try {
    const res = await api.post(`/api/deck/${encodeURIComponent(d.domain.slug)}/reset`, { scope, depth: d.depth || undefined });
    state.domains = res.domains;
    toast(`Cleared ${plural(res.cleared, 'record', 'records')}.`);
    await openDeck(d.domain.slug, d.depth || null);
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

/**
 * Delete this account for good.
 *
 * Two gates, because this is the only genuinely irreversible thing in the app:
 * a typed confirmation, then the account password. The password matters most -
 * somebody who has walked off leaving their phone unlocked should not be one
 * tap from destroying the account.
 */
async function deleteAccount() {
  const partner = state.couple && state.couple.members.find((m) => m.id !== state.me.id);

  const yes = await uiConfirm(
    'Delete your account?',
    'This removes your account, your name and your sign-in for good. It cannot be undone.' +
      (partner
        ? `<br><br>The questions you and <strong>${esc(
            partner.displayName
          )}</strong> have discussed belong to both of you, so that history stays with them — ` +
          'deleting it would erase their record too, and that is not yours to remove.'
        : '') +
      '<br><br>You can download your data first from the screen behind this one.',
    'Continue',
    true
  );
  if (!yes) return;

  const password = await promptDialog({
    title: 'Confirm with your password',
    message: 'Last step. Type the password you use to sign in.',
    label: 'Password',
    type: 'password',
    confirmLabel: 'Delete my account',
  });
  if (!password) return;

  try {
    await api.post('/api/me/delete', { password });
    state.me = null;
    state.couple = null;
    state.domains = [];
    state.deck = null;
    state.view = 'auth';
    state.authMode = 'login';
    render();
    await uiAlert('Account deleted', 'Your account is gone. Thank you for using it.');
  } catch (err) {
    uiAlert('Could not delete it', err.message);
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

// ---- Password reset -------------------------------------------------------

/**
 * Strips ?reset=<token> from the address bar.
 *
 * Uses replaceState so the token does not sit in history, where it would be
 * re-triggered by a Back tap and, more to the point, left in the browser's
 * record of visited URLs long after it stopped being needed.
 */
function clearResetFromUrl() {
  if (!window.location.search.includes('reset=')) return;
  const url = new URL(window.location.href);
  url.searchParams.delete('reset');
  window.history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
}

async function onForgotSubmit(e) {
  e.preventDefault();
  if (state.busy) return;

  const email = e.target.email.value.trim();
  state.form = { email };
  state.error = null;
  state.notice = null;
  state.busy = true;
  render();

  try {
    const res = await api.post('/api/auth/forgot', { email });
    state.busy = false;
    // The server deliberately answers the same way whether or not the address
    // exists, so this message must not imply the account was found.
    state.notice = res.message || 'If that email has an account, a reset link is on its way.';
    render();
  } catch (err) {
    state.busy = false;
    state.error = err.message;
    render();
  }
}

async function onResetSubmit(e) {
  e.preventDefault();
  if (state.busy) return;

  const password = e.target.password.value;
  const confirm = e.target.confirm.value;

  if (password.length < 8) {
    state.error = 'Your password needs at least 8 characters.';
    return render();
  }
  if (password !== confirm) {
    state.error = 'Those two passwords do not match.';
    return render();
  }

  state.error = null;
  state.busy = true;
  render();

  try {
    await api.post('/api/auth/reset', { token: state.reset.token, password });
    state.busy = false;
    state.reset = { ...state.reset, done: true };
    clearResetFromUrl();
    // The reset ended every session for this account, including this browser's.
    state.me = null;
    state.couple = null;
    render();
  } catch (err) {
    state.busy = false;
    state.error = err.message;
    render();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Picks up a reset link before anything else.
 *
 * Validated against the server up front so an expired token shows "this link
 * no longer works" rather than a password form that fails only after the user
 * has typed one in twice.
 */
async function checkResetLink() {
  const token = new URLSearchParams(window.location.search).get('reset');
  if (!token) return false;

  state.reset = { token, checking: true, valid: false };
  state.ready = true;
  render();

  try {
    const res = await api.get(`/api/auth/reset/${encodeURIComponent(token)}`);
    state.reset = { token, checking: false, valid: true, displayName: res.displayName };
  } catch (err) {
    state.reset = { token, checking: false, valid: false, error: err.message };
  }
  render();
  return true;
}

/** App name, tagline and accent, as set by the owner. */
function applyBranding() {
  const b = state.branding;
  if (!b) return;
  if (b.brand_accent) document.documentElement.style.setProperty('--accent', b.brand_accent);
  if (b.app_name) document.title = b.app_name;
}

async function loadData() {
  try {
    const data = await api.get('/api/data');
    state.me = data.me;
    state.couple = data.couple;
    state.domains = data.domains || [];
    state.volatile = data.volatile || null;
    state.serverVersion = data.version;
    if (data.branding) {
      state.branding = data.branding;
      applyBranding();
    }
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
      state.domains = data.domains || [];
    state.volatile = data.volatile || null;
      state.serverVersion = data.version;
      render();
    })
    .catch(() => {});
});

render();

// Branding is public, so the sign-in screen carries the owner's name and colour
// before anybody has authenticated. Failure here is harmless - the built-in
// name is used instead.
api
  .get('/api/branding')
  .then((res) => {
    state.branding = res.branding;
    applyBranding();
    if (state.ready) render();
  })
  .catch(() => {});

// A reset link short-circuits the normal boot: there is no point loading a
// logged-out user's data behind a screen they cannot use yet.
checkResetLink().then((handlingReset) => {
  if (!handlingReset) loadData();
});
