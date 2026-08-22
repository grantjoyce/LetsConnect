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
const APP_VERSION = '1.22.0';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  ready: false,
  view: 'levels', // levels | deck | chains | account
  // The owner, only when they happen to be signed in at /admin in the same
  // browser. A couple has no account at all - see state.couple.
  me: null,
  // The whole identity. A redeemed code, with the two names on it.
  couple: null,

  // Depth and domain are INDEPENDENT axes. A domain is a subject and carries no
  // depth of its own; each domain reports what it holds at each depth, so the
  // picker can grey out a depth that has nothing in it.
  domains: [],

  // The depth ladder, from /api/data. It used to be a constant in this file,
  // which made the one piece of couple-facing copy the owner could not edit
  // without a deploy.
  depths: [],

  // What the couple has ticked on the start screen. Both are chosen BEFORE
  // play, and the deck is one shuffled pile drawn from all of it - not one
  // deck per topic. Null means "not chosen yet", which resolves to everything.
  selection: { domains: null, depths: null },

  // Sequences are not a mode. A chained card is dealt like any other and the
  // rest of its run follows it, so there is no sequence state to hold.
  volatile: null, // { unlocked, available }

  serverVersion: null,
  deck: null, // { domain, depth, stats, cards, index, releasedEarly }
  revealed: false, // whether the context line on the current card is showing
  form: {}, // values mirrored out of inputs so a re-render can restore them
  error: null,
  notice: null,
  busy: false,

  // App name, tagline and accent, set by the owner in the admin area.
  branding: null,

  // Set once a registration has been accepted, so /register shows the
  // "we will email you" panel instead of the form again.
  registered: false,
  registeredEmail: null,

  // The "how did that land?" list, from /api/data. Empty until the bootstrap
  // returns, and empty for good on a database that has not run the feedback
  // migration - the prompt simply never appears rather than erroring.
  feedbackOptions: [],
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

/**
 * "Esther Perel's", "The Gottmans'".
 *
 * A plain `${name}'s` produced "The Gottmans's" on screen, because several of
 * these authorities are plural or already end in s.
 */
function possessive(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
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
      // The session went away underneath us - expired, or the code was
      // suspended. Drop straight back to the code screen rather than leaving a
      // dead UI on screen.
      state.couple = null;
      state.deck = null;
      state.view = 'levels';
      render();
      throw new Error((data && data.error) || 'Enter your code to start.');
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
    // Scoped to .dialog-actions. It used to select every [data-i] in the
    // overlay, so a body containing its own indexed buttons would resolve
    // against the ACTIONS array - reading index 3 of a two-item list and
    // throwing on undefined.value.
    overlay.querySelectorAll('.dialog-actions [data-i]').forEach((btn) => {
      btn.onclick = () => close(actions[Number(btn.dataset.i)].value);
    });

    // A body may offer the real choices itself, when there are more of them
    // than a row of buttons can carry. Resolves with the index as a number.
    overlay.querySelectorAll('.dialog-body [data-choice]').forEach((btn) => {
      btn.onclick = () => close(Number(btn.dataset.choice));
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
    ['Sit down together', 'This is one phone between two people, not two apps talking to each other. Put it somewhere you can both see and give it an hour.'],
    ['Choose the ground', 'Tick the topics you are up for and how deep you want to go. Depth is about exposure, not difficulty - D1 costs nothing to answer, D5 changes something.'],
    ['Talk about the card', 'One question fills the screen. There is no timer and nothing to type - the app never records a single answer, only whether you dealt with the card.'],
    ['Completed or Skip', '<strong>Completed</strong> retires the question for good. <strong>Skip</strong> means &ldquo;not this time&rdquo; - it drops out of the deck and comes back around in a couple of weeks.'],
    ['Come back to it', 'Your code keeps your place. Close the app, sit down again next month, and it carries on from where the two of you left off.'],
    // Last on purpose: it is the only step that is about the phone rather than
    // the conversation, and it only makes sense once someone knows the app is
    // worth keeping.
    ['Keep it on your phone', 'Open this page in <strong>Chrome</strong> on Android or <strong>Safari</strong> on iPhone, then choose <strong>Install app</strong> or <strong>Add to Home Screen</strong>. It gets its own icon and opens full screen, so it is there the next time you sit down without hunting for a link.'],
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

/**
 * The welcome screen. One field.
 *
 * This replaces a register screen, a sign-in screen, a forgotten-password
 * screen, a reset screen and a pairing screen. All five existed to build one
 * shared account across two phones - and the exercise is done SITTING
 * TOGETHER, one screen between two people. Every one of them was a wall
 * between buying the app and using it.
 *
 * The code arrives by email from the shop. Either of them can type it.
 */
/**
 * The registration page.
 *
 * There is no payment here and it does not pretend otherwise. It takes two
 * names and an email, and says plainly that a code will be sent - because
 * over-promising at this step is how you get somebody sitting waiting for an
 * instant download that was never coming.
 */
function viewRegister() {
  const f = state.form;
  if (state.registered) {
    return `
      <div class="screen screen--centred">
        <div class="hero">
          ${brandLockup('hero')}
        </div>
        <div class="panel">
          <h2 class="panel-title">Thank you - that is with us</h2>
          <p class="hint" style="margin-bottom:1.1rem">
            We will email your code to <strong>${esc(state.registeredEmail || 'you')}</strong>.
            When it arrives, come back here and enter it.
          </p>
          <a class="btn btn-block" href="/" style="text-align:center;text-decoration:none">
            Back to the start
          </a>
        </div>
      </div>`;
  }

  return `
    <div class="screen screen--centred">
      <div class="hero">
        ${brandLockup('hero')}
        <p>${esc(brand().tagline)}</p>
      </div>

      <div class="panel">
        <h2 class="panel-title">Register</h2>
        <p class="hint" style="margin-bottom:1.1rem">
          Tell us who the two of you are and we will send a code to your email.
          One code covers both of you - this is done sitting together, with one
          phone between you.
        </p>

        <form id="register-form" autocomplete="on">
          ${state.error ? `<div class="form-error" role="alert">${esc(state.error)}</div>` : ''}
          <div class="field">
            <label for="r-a">Your name</label>
            <input class="input" id="r-a" name="partnerA" type="text" autocomplete="given-name"
                   maxlength="60" value="${esc(f.partnerA || '')}" required>
          </div>
          <div class="field">
            <label for="r-b">Your partner&rsquo;s name</label>
            <input class="input" id="r-b" name="partnerB" type="text"
                   maxlength="60" value="${esc(f.partnerB || '')}" required>
          </div>
          <div class="field">
            <label for="r-email">Email</label>
            <input class="input" id="r-email" name="email" type="email" autocomplete="email"
                   maxlength="191" value="${esc(f.email || '')}" required>
            <p class="hint">Where we send the code. We do not send anything else.</p>
          </div>
          <div class="field">
            <label for="r-note">Anything you want to tell us <span class="hint">(optional)</span></label>
            <textarea class="input" id="r-note" name="note" rows="3"
                      maxlength="500">${esc(f.note || '')}</textarea>
          </div>
          <button class="btn btn-block" type="submit" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? 'Sending…' : 'Register'}
          </button>
        </form>

        <p class="gate-register">
          Already have a code? <a href="/">Enter it here</a>
        </p>
      </div>

      <div class="footer-note">
        <button class="btn-quiet" data-action="how">How it works</button>
      </div>
    </div>`;
}

function viewGate() {
  const f = state.form;
  return `
    <div class="screen screen--centred">
      <div class="hero">
        ${brandLockup('hero')}
        <p>${esc(brand().tagline)}</p>
      </div>

      <div class="panel">
        <h2 class="panel-title">Enter your code</h2>
        <p class="hint" style="margin-bottom:1.1rem">
          The code from your order email. Sit somewhere you will not be interrupted -
          this works best with one phone between the two of you.
        </p>

        <form id="gate-form" autocomplete="off">
          ${state.error ? `<div class="form-error" role="alert">${esc(state.error)}</div>` : ''}
          <div class="field">
            <label for="g-code">Your code</label>
            <input class="input input-code" id="g-code" name="code" type="text"
                   inputmode="latin" autocapitalize="characters" autocomplete="off"
                   spellcheck="false" placeholder="XXXX-XXXX-XXXX"
                   value="${esc(f.code || '')}" required>
          </div>
          <button class="btn btn-block" type="submit" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? 'Checking…' : 'Start'}
          </button>
        </form>

        ${
          // For the person who arrived without a code. Inside the panel, under
          // the button, because that is the moment they discover they cannot
          // get in - not in a footer they have already scrolled past.
          //
          // rel="noopener" on a new tab: without it the opened page gets a
          // handle on this one through window.opener and can navigate it.
          registerUrl()
            ? `<p class="gate-register">
                 Don&rsquo;t have a code?
                 <a href="${esc(registerUrl())}" target="_blank" rel="noopener noreferrer">Register here</a>
               </p>`
            : ''
        }
      </div>

      <div class="footer-note">
        <button class="btn-quiet" data-action="how">How it works</button>
      </div>
    </div>`;
}

/**
 * The cog screen.
 *
 * There is no account here any more, so what is left is the three things two
 * people sitting together might actually want mid-session: what the volatile
 * questions are and whether to open them, a way to clear progress, and a way
 * to hand the phone back with the code closed.
 */
function viewAccount() {
  const c = state.couple;
  const v = state.volatile || {};
  const theme = currentTheme();

  return `
    <div class="screen">
      ${topbar(false, true)}

      <div class="hero">
        <h1>${esc(c.name)}</h1>
        <p>Settings for this session</p>
      </div>

      <div class="panel">
        <h2 class="panel-title">The ones with consequences</h2>
        <p class="hint" style="margin-bottom:0.9rem">
          ${plural(v.available || 0, 'question is', 'questions are')} held back until you
          both say so. These are not the most exposing questions - they are the ones
          where an honest answer <strong>forces something to happen</strong>. A hidden
          debt, a crossed line, a doubt about staying. Decide out loud, together,
          before you turn them on.
        </p>
        <button class="btn ${v.unlocked ? 'btn-ghost' : ''} btn-block" data-action="volatile">
          ${v.unlocked ? 'Put them away again' : 'We both agree - include them'}
        </button>
        ${
          v.unlocked
            ? '<p class="hint" style="margin-top:0.6rem">They are in the deck now.</p>'
            : ''
        }
      </div>

      <div class="panel">
        <h2 class="panel-title">Start again</h2>
        <p class="hint" style="margin-bottom:0.9rem">
          Clears what you have worked through so the cards come back. Nothing you
          said is stored anywhere - only which cards you dealt with.
        </p>
        <button class="btn btn-ghost btn-block" data-action="reset-all">
          Clear our progress
        </button>
      </div>

      <div class="panel">
        <h2 class="panel-title">How it looks</h2>
        <p class="hint" style="margin-bottom:0.9rem">
          Dark is the default. It is easier on the eyes in a dim room, which is
          where most of these conversations happen - but a bright one asks for
          the opposite. Kept on this phone, so you each choose your own.
        </p>
        <div class="theme-switch" role="group" aria-label="Appearance">
          <button class="btn${theme === 'day' ? ' btn-ghost' : ''}"
                  data-action="theme" data-mode="night"
                  aria-pressed="${theme === 'night'}">Dark</button>
          <button class="btn${theme === 'day' ? '' : ' btn-ghost'}"
                  data-action="theme" data-mode="day"
                  aria-pressed="${theme === 'day'}">Light</button>
        </div>
      </div>

      <div class="panel">
        <h2 class="panel-title">Finish</h2>
        <p class="hint" style="margin-bottom:0.9rem">
          Closes the code on this phone. It keeps working - enter it again whenever
          you sit down together.
        </p>
        <button class="btn btn-ghost btn-block" data-action="leave">Close the app</button>
      </div>

      ${
        state.me && state.me.isOwner
          ? `<div class="footer-note"><a class="btn-quiet" href="/admin/">Owner area</a></div>`
          : ''
      }

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

function topbar(showAccount, isSettings) {
  return `
    <div class="topbar">
      <div class="brand">
        ${brandLockup('bar')}
      </div>
      <div class="topbar-actions">
        <button class="icon-btn" data-action="how" aria-label="How it works" title="How it works">?</button>
        ${
          showAccount
            ? `<button class="icon-btn" data-action="go-account" aria-label="Settings" title="Settings">&#9881;</button>`
            : isSettings
            ? `<button class="icon-btn" data-action="back-to-topics" aria-label="Back" title="Back">&#8592;</button>`
            : ''
        }
      </div>
    </div>`;
}

/**
 * The depth ladder. Exposure only - nothing to do with subject.
 *
 * Comes down with /api/data. The fallback is not a second source of truth: it
 * is what the picker draws if the ladder has not arrived yet, so a slow first
 * response shows the rungs greyed rather than an empty row where the chips go.
 */
const DEPTH_FALLBACK = [
  { n: 1, name: 'Open', blurb: '' },
  { n: 2, name: 'Reflective', blurb: '' },
  { n: 3, name: 'Personal', blurb: '' },
  { n: 4, name: 'Exposed', blurb: '' },
  { n: 5, name: 'Rupture', blurb: '' },
];

function depthLadder() {
  return state.depths && state.depths.length ? state.depths : DEPTH_FALLBACK;
}

/** Selected topics, defaulting to all of them. */
function selectedDomains() {
  if (state.selection.domains) return state.selection.domains;
  return state.domains.map((d) => d.slug);
}

/** Selected depths, defaulting to every rung on the ladder. */
function selectedDepths() {
  return state.selection.depths || depthLadder().map((d) => d.n);
}

/**
 * How many questions the current selection would actually serve.
 *
 * Counted from the per-depth breakdown rather than the domain totals, because
 * the depth ticks cut across every chosen topic.
 */
function selectionReady() {
  const doms = new Set(selectedDomains());
  const deps = new Set(selectedDepths());
  return state.domains
    .filter((d) => doms.has(d.slug))
    .flatMap((d) => d.depths)
    .filter((x) => deps.has(x.depth))
    .reduce((n, x) => n + x.ready, 0);
}

function domainCard(d) {
  const on = selectedDomains().includes(d.slug);
  const deps = new Set(selectedDepths());

  // The count shown is what THIS topic contributes at the currently ticked
  // depths, so unticking D5 visibly changes every card rather than only the
  // total at the bottom.
  const ready = d.depths.filter((x) => deps.has(x.depth)).reduce((n, x) => n + x.ready, 0);
  const total = d.depths.filter((x) => deps.has(x.depth)).reduce((n, x) => n + x.total, 0);

  return `
    <button class="topic-card${on ? ' is-on' : ''}${total === 0 ? ' is-empty' : ''}"
            style="${accentVars(d.accent)}"
            role="checkbox" aria-checked="${on}"
            data-action="toggle-domain" data-slug="${esc(d.slug)}">
      <span class="topic-tick" aria-hidden="true">${on ? '&#10003;' : ''}</span>
      <span class="topic-main">
        <span class="topic-name">${esc(d.name)}</span>
        <span class="topic-tagline">${esc(d.tagline || '')}</span>
      </span>
      <span class="topic-count">${
        total === 0 ? 'none at these depths' : ready === 0 ? 'all done' : `${ready}`
      }</span>
    </button>`;
}

/**
 * The start screen. Both axes are chosen here, then Start deals one shuffled
 * deck from everything ticked.
 *
 * Depth is picked BEFORE a topic, not inside one. Narrowing depth after
 * committing to a single topic was the wrong shape entirely: it made "one
 * topic at a time" the only option and turned depth into a filter on a deck
 * already in progress, when it is really half of what you are choosing.
 */
function viewSelection() {
  const c = state.couple;
  const doms = selectedDomains();
  const deps = selectedDepths();
  const ready = selectionReady();

  return `
    <div class="screen has-start-bar">
      ${topbar(true)}

      <div class="hero" style="text-align:left;margin-bottom:1.2rem">
        ${/* "Welcome" is the greeting; the names are the point. Dropping the
             greeting to a small line above lets the names keep the full size
             and stops a long pair - "Welcome Sipho and Nomvula" - wrapping
             mid-phrase. */ ''}
        <h1 style="font-size:1.7rem"><span class="hero-greeting">Welcome</span>${esc(c.name)}</h1>
      </div>


      ${/* Not "tonight". Nothing here knows when they are playing, and a
           Sunday-afternoon couple should not be told they are doing it at the
           wrong time of day. */ ''}
      <h2 class="section-title">How deep?</h2>
      <div class="depth-filter depth-filter--page" role="group" aria-label="Depth">
        ${depthLadder().map((depth) => {
          const on = deps.includes(depth.n);
          return `
            <button class="depth-chip${on ? ' is-on' : ''}"
                    data-action="toggle-depth" data-depth="${depth.n}"
                    role="checkbox" aria-checked="${on}"
                    title="${esc(depth.name)} - ${esc(depth.blurb)}">
              D${depth.n}
              <span class="depth-chip-n">${esc(depth.name)}</span>
            </button>`;
        }).join('')}
      </div>

      <h2 class="section-title" style="margin-top:1.5rem">
        What would you like to talk about?
        <button class="btn-quiet" data-action="toggle-all-domains" style="float:right">
          ${doms.length === state.domains.length ? 'Clear all' : 'Select all'}
        </button>
      </h2>
      <div class="topic-list">
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
    </div>

    <div class="start-bar">
      <button class="btn btn-block" data-action="start"
              ${doms.length === 0 || ready === 0 || state.busy ? 'disabled' : ''}>
        ${
          doms.length === 0
            ? 'Choose a topic'
            : ready === 0
              ? 'Nothing left in this selection'
              : `Start &middot; ${plural(ready, 'question', 'questions')}`
        }
      </button>
    </div>`;
}

/** The list of guided sequences. */
function viewDeck() {
  const d = state.deck;
  const card = d.cards[d.index];
  const doneInDeck = d.index;
  const stats = d.stats || { completed: 0, total: 0, skipped: 0, available: 0 };

  if (!card) return deckFinished();

  const depth = depthLadder().find((x) => x.n === card.depth) || { n: card.depth, name: '' };

  // Each card carries its own topic colour, so a mixed selection is visibly
  // moving between subjects rather than looking like one flat pile.
  const accent = card.accent || '#D8327C';

  return `
    <div class="deck" style="${accentVars(accent)}">
      <div class="deck-bar">
        <button class="icon-btn" data-action="close-deck" aria-label="Close">&times;</button>
        <button class="icon-btn" data-action="prev-card" aria-label="Previous card"
                ${d.index === 0 ? 'disabled' : ''}>&larr;</button>
        <div class="deck-titles">
          <div class="deck-level">${esc(card.domainName || '')}</div>
          <div class="deck-progress-text">
            ${`${esc(stats.completed)} of ${esc(stats.total)} discussed${
                    doneInDeck ? ` &middot; ${plural(doneInDeck, 'card', 'cards')} this sitting` : ''
                  }`
            }
          </div>
        </div>
        <button class="icon-btn" data-action="deck-menu" aria-label="Options">&hellip;</button>
      </div>

      <div class="deck-body">
        <div class="qcard entering" id="qcard">
          <div class="qcard-top">
            <span class="depth-badge" data-depth="${depth.n}">D${depth.n}${
              depth.name ? ` · ${esc(depth.name)}` : ''
            }</span>
            ${card.volatile ? '<span class="pill pill-warn">this one has consequences</span>' : ''}
            ${
              // A sequence is not a mode you enter - it arrives. The card says
              // where it sits so the couple knows more is coming, and the
              // position counts against the sequence's real length, not the run
              // being dealt now: "3 of 5" stays true when 1 and 2 were answered
              // last month.
              card.chain
                ? `<span class="chain-step" title="${esc(card.chain.name)}">
                     Card ${card.chain.position} of ${card.chain.total}
                   </span>`
                : ''
            }
            ${
              // Subject on top, lens under it. These are two different things
              // and the three-letter code alone could not say which it was -
              // on a Money card the lens is MON, which read like a shortened
              // topic rather than the way the question was written.
              card.domainName || card.lens
                ? `<div class="qcard-provenance">
                     ${card.domainName ? `<span class="card-topic">${esc(card.domainName)}</span>` : ''}
                     ${
                       card.lens
                         ? `<button class="lens-badge" data-action="show-lens"
                                    data-lens="${esc(card.lens)}"
                                    data-ref="${esc(card.ref || '')}"
                                    aria-label="About the ${esc(card.lens)} lens">
                              ${esc(card.lens)}
                            </button>`
                         : ''
                     }
                   </div>`
                : ''
            }
          </div>

          ${cardWatermark()}

          <div class="qcard-middle">
            <div class="qtext">${esc(card.text)}</div>
            ${
              card.seenBefore
                ? '<div class="qcard-note">You skipped this one before - it has come back around.</div>'
                : ''
            }
            ${
              state.revealed && card.context
                ? `<div class="qcard-context">${esc(card.context)}</div>`
                : ''
            }
          </div>

          <div class="qcard-bottom">
            ${
              card.context && !state.revealed
                ? `<button class="qcard-expand" data-action="reveal-context">
                     <span aria-hidden="true">+</span> Expand
                   </button>`
                : ''
            }
          </div>
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
  const s = d.stats || { completed: 0, total: 0, skipped: 0 };
  const allDone = s.completed >= s.total && s.total > 0;
  const where = d.selection ? d.selection.names.join(', ') : 'this selection';

  return `
    <div class="deck" style="${accentVars('#D8327C')}">
      <div class="deck-bar">
        <button class="icon-btn" data-action="close-deck" aria-label="Back">&times;</button>
        <div class="deck-titles">
          <div class="deck-level">${esc(where)}</div>
          <div class="deck-progress-text">${esc(s.completed)} of ${esc(s.total)} discussed</div>
        </div>
        <span style="width:38px"></span>
      </div>

      <div class="deck-body">
        <div class="deck-done">
          <div class="deck-done-mark" aria-hidden="true">${allDone ? '&#10003;' : '&#8987;'}</div>
          <h2>${allDone ? 'That is everything you selected' : 'Nothing left for now'}</h2>
          <p>
            ${
              allDone
                ? `You have talked your way through all ${esc(s.total)} questions in ${esc(where)}. That is not nothing.`
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
            <button class="btn" data-action="close-deck">Change what you picked</button>
            ${
              s.completed
                ? `<button class="btn btn-ghost danger" data-action="reset-deck">
                     Start this selection again
                   </button>`
                : ''
            }
          </div>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// render / wire
// ---------------------------------------------------------------------------

/**
 * /register is its own screen, decided by the URL rather than by state.
 *
 * It sits ABOVE the code gate in this chain deliberately: somebody arriving
 * here has no code, and being shown the "enter your code" screen first is
 * exactly the dead end the page exists to fix. It is reachable while a couple
 * is signed in too - there is no reason to hide it from them.
 */
function isRegisterPath() {
  return /^\/register\/?$/i.test(location.pathname);
}

function render() {
  let html;
  if (!state.ready) {
    html = '<div class="boot"><div class="boot-mark"></div><p class="boot-text">Loading…</p></div>';
  } else if (isRegisterPath()) {
    html = viewRegister();
  } else if (!state.couple) {
    // One gate, one field. There is nothing to be signed in AS - the code is
    // the whole identity, so there is no half-authenticated state to render.
    html = viewGate();
  } else if (state.view === 'deck' && state.deck) {
    html = viewDeck();
  } else if (state.view === 'account') {
    html = viewAccount();
  } else {
    html = viewSelection();
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

  const regForm = document.getElementById('register-form');
  if (regForm) regForm.onsubmit = onRegister;

  const gateForm = document.getElementById('gate-form');
  if (gateForm) {
    gateForm.onsubmit = onRedeem;
    // Mirrored into state.form so a re-render (a failed attempt) does not throw
    // away what they typed - retyping a twelve-character code after a typo is
    // exactly the moment somebody gives up.
    const codeInput = document.getElementById('g-code');
    if (codeInput) {
      codeInput.oninput = () => {
        state.form.code = codeInput.value;
      };
      if (!state.busy) codeInput.focus();
    }
  }

}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function handleAction(action, el) {
  switch (action) {
    case 'how':
      showHowItWorks();
      break;

    case 'report-question':
      await reportQuestion();
      break;

    // Re-rendered so the pair of buttons shows which one is on. Safe here in a
    // way it would not be on a form screen: settings holds nothing typed.
    case 'theme':
      applyTheme(el.dataset.mode === 'day' ? 'day' : 'night');
      render();
      break;

    case 'back-to-topics':
      state.view = 'levels';
      render();
      break;

    case 'leave':
      await leaveSession();
      break;

    case 'reset-all':
      await resetDeck('all');
      break;

    case 'go-account':
      state.view = 'account';
      render();
      break;

    case 'go-levels':
      state.view = 'levels';
      render();
      break;

    case 'toggle-domain': {
      const slug = el.dataset.slug;
      const on = new Set(selectedDomains());
      if (on.has(slug)) on.delete(slug);
      else on.add(slug);
      state.selection.domains = [...on];
      render();
      break;
    }

    case 'toggle-all-domains':
      state.selection.domains =
        selectedDomains().length === state.domains.length ? [] : state.domains.map((d) => d.slug);
      render();
      break;

    case 'toggle-depth': {
      const n = Number(el.dataset.depth);
      const on = new Set(selectedDepths());
      if (on.has(n)) {
        if (on.size === 1) {
          // Refuse visibly rather than leaving a selection that can serve
          // nothing at all.
          toast('Keep at least one depth switched on.');
          el.classList.remove('shake');
          void el.offsetWidth; // force a reflow so a repeated tap re-runs it
          el.classList.add('shake');
          break;
        }
        on.delete(n);
      } else {
        on.add(n);
      }
      // Numeric sort, not the default lexicographic one. Harmless at five
      // rungs and wrong the moment there is a tenth.
      state.selection.depths = [...on].sort((a, b) => a - b);
      render();
      break;
    }

    case 'start':
      await startDeck();
      break;

    case 'go-domains':
      state.view = 'levels';
      render();
      break;

    case 'prev-card':
      // Steps back through the cards already dealt. It does NOT undo the
      // answer: the couple asked to look at it again, not to un-discuss it.
      // Answering again upserts, so nothing is double counted either way.
      if (state.deck && state.deck.index > 0) {
        state.deck.index -= 1;
        state.revealed = false;
        render();
      }
      break;

    case 'show-lens':
      await showLens(el.dataset.lens, el.dataset.ref);
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
      state.view = 'levels';
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

// ---- Pairing --------------------------------------------------------------

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => toast('Copied.'),
      () => toast('Could not copy - write it down instead.', true)
    );
  } else {
    toast('Copying is not available here - write it down.', true);
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
/**
 * What the three-letter code on a card means.
 *
 * The lens list is loaded once with the rest of the app data, so tapping the
 * badge opens instantly rather than waiting on a request.
 */
/**
 * What the three letters in the corner mean.
 *
 * The code comes from the question's own ID - GOT-001 is the first question
 * written through the Gottman lens - so the badge is provenance, not decoration.
 *
 * The attribution is careful on purpose, and it is the same line the corpus
 * draws. A lens is a WAY OF LOOKING: an approach that somebody's work made
 * legible. Frameworks are ideas and can be built on freely; expression is
 * protected. So the modal names whose thinking shaped the question, and says
 * plainly that the question is newly written and that nobody named is involved
 * in this app. Five of the sixteen lenses have no authority behind them at all
 * and say so, because attaching Money to a name would be a false attribution.
 */
async function showLens(code, ref) {
  if (!code) return;

  if (!state.lenses) {
    try {
      const res = await api.get('/api/lenses');
      state.lenses = res.lenses;
    } catch (err) {
      return uiAlert('Could not load that', err.message);
    }
  }

  const lens = (state.lenses || []).find((l) => l.code === code);
  if (!lens) {
    return uiAlert(esc(code), 'No description has been written for this grouping yet.');
  }

  await dialog({
    title: `${code} · ${lens.name}`,
    bodyHtml: `
      ${
        lens.author
          ? `<p style="margin-bottom:0.7rem;font-size:0.85rem;letter-spacing:0.04em;
                       text-transform:uppercase;color:var(--accent);font-weight:800">
               Influenced by ${esc(lens.author)}
             </p>`
          : `<p style="margin-bottom:0.7rem;font-size:0.85rem;letter-spacing:0.04em;
                       text-transform:uppercase;color:var(--text-faint);font-weight:800">
               Written to the subject directly
             </p>`
      }
      <p>${esc(lens.description || '')}</p>
      <p style="margin-top:0.9rem;font-size:0.85rem;color:var(--text-faint)">
        ${
          lens.author
            ? `This question was written from that way of looking - newly written for this
               app, and not taken from ${esc(possessive(lens.author))} published material.
               Nobody named here is involved in this app.`
            : `No outside framework sits behind these. They are written straight to the
               subject, and every question here is newly written.`
        }
      </p>
      ${
        ref
          ? `<p style="margin-top:0.9rem;font-size:0.78rem;color:var(--text-faint);
                       letter-spacing:0.08em">This card is ${esc(ref)}.</p>`
          : ''
      }`,
    actions: [{ label: 'Close', value: true, className: 'btn' }],
  });
  return undefined;
}

/** Query string for the current selection. */
function selectionQuery() {
  return `domains=${selectedDomains().map(encodeURIComponent).join(',')}&depths=${selectedDepths().join(',')}`;
}

/** Deal one shuffled deck from everything ticked on the start screen. */
async function startDeck() {
  if (state.busy) return;
  state.busy = true;
  render();

  try {
    const data = await api.get(`/api/deck?${selectionQuery()}`);
    state.busy = false;
    if (!data.cards.length) {
      render();
      return uiAlert(
        'Nothing left',
        'You have worked through everything in this selection. Add a topic or a depth.'
      );
    }
    state.deck = {
      selection: data.selection,
      stats: data.stats,
      cards: data.cards,
      index: 0,
      chain: null,
      releasedEarly: data.releasedEarly,
    };
    state.revealed = false;
    state.view = 'deck';
    render();
    if (data.releasedEarly) toast('Bringing back questions you skipped earlier.');
  } catch (err) {
    state.busy = false;
    render();
    uiAlert('Could not start', err.message);
  }
  return undefined;
}

// ---- Chains ---------------------------------------------------------------

/**
 * Open, or close, the hardest questions.
 *
 * This used to be per-person and mutual: two accounts on two phones meant one
 * partner could otherwise open that door on the other's behalf. Sitting
 * together there is no second session to ask - so the gate is the wording, and
 * it says plainly that this is a decision to make out loud before anyone taps.
 *
 * Closing them again asks nothing. Withdrawing consent should never be
 * negotiable, which is the one part of the old design worth keeping.
 */
async function toggleVolatile() {
  const v = state.volatile;
  const turningOn = !v.unlocked;

  if (turningOn) {
    const yes = await uiConfirm(
      'Include the ones with consequences?',
      `<strong>${v.available}</strong> questions are held back - not because they are the most ` +
        'exposing, but because an honest answer to them forces something to happen. A hidden ' +
        'debt, a crossed line, a doubt about staying.' +
        '<br><br>Say it out loud to each other before you tap. Either of you can put them away ' +
        'again at any point, and that needs no discussion at all.',
      'We both agree'
    );
    if (!yes) return;
  }

  try {
    await api.post('/api/couple/volatile', { unlocked: turningOn });
    await loadData();
    toast(turningOn ? 'They are in the deck now.' : 'Put away again.');
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
    // Progress moved by one, whichever topic the card came from. Recomputing
    // the whole selection's total here would cost a round trip for a number
    // that only ever changes by one.
    d.stats = { ...d.stats, completed: d.stats.completed + (decision === 'completed' ? 1 : 0) };

    d.index += 1;
    // Each card earns its own reveal. Carrying it over would turn the next
    // question into a worksheet, which is the whole reason it hides.
    state.revealed = false;
    state.busy = false;

    // Top the deck up before it runs dry, so there is never a pause mid-flow.
    //
    // No separate chain bookkeeping any more. A sequence's place is not session
    // state to be resumed - it is simply which of its cards are still
    // unanswered, which the deck query already knows.
    if (d.index >= d.cards.length - 3) {
      refillDeck().catch(() => {});
    }

    render();

    // Ask how it landed - but only after the next card is already on screen,
    // and only for a completed one. Skipping a card has already said what the
    // couple thought of it.
    if (decision === 'completed') askHowItLanded(card);
  } catch (err) {
    state.busy = false;
    if (el) el.classList.remove('leaving-skip', 'leaving-done');
    render();
    toast(err.message, true);
  }
}

/**
 * "How did that land?"
 *
 * The only feedback loop the corpus has. 850 questions were written from
 * research and judgement, and until now nothing told anyone which of them
 * actually work in a living room.
 *
 * Deliberately easy to decline. The card is already marked completed before
 * this opens, so dismissing it costs the couple nothing - no progress is
 * riding on an answer, and a couple mid-conversation should never be made to
 * fill in a form to get to the next question. It closes on Escape, on a tap
 * outside, and on "Skip".
 *
 * Nothing about who answered is sent. See the route in server.js.
 */
async function askHowItLanded(card) {
  const options = state.feedbackOptions || [];
  if (!card || !options.length) return;

  const choice = await dialog({
    title: 'How did that land?',
    bodyHtml: `
      <p style="color:var(--text-dim);margin-bottom:0.9rem">
        Only if you want to. It helps us write better questions - and it is not
        stored against you, just against the question.
      </p>
      <div class="landed-list">
        ${options
          .map(
            (o, i) =>
              `<button class="landed-option" data-choice="${i}" type="button">${esc(o.label)}</button>`
          )
          .join('')}
      </div>`,
    // The six live in the body; the action row holds only the way out.
    actions: [{ label: 'Skip', value: null, className: 'btn-quiet' }],
  });

  if (choice === null || choice === undefined) return;
  const option = options[choice];
  if (!option) return;

  try {
    await api.post('/api/answer/feedback', { questionId: card.id, optionId: option.id });
  } catch (err) {
    // Silent on purpose. This is a favour the couple did us; failing to record
    // it is our problem, and an error toast mid-conversation would make it
    // theirs.
    console.error('[feedback]', err.message);
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
  const data = await api.get(`/api/deck?${selectionQuery()}`);
  if (!state.deck) return;

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

  const card = d.cards[d.index];
  const sel = d.selection;

  const choice = await dialog({
    title: 'This session',
    bodyHtml: `
      ${
        sel
          ? `<p>${esc(sel.names.join(', '))} &middot; depth ${esc(sel.depths.join(', '))}</p>`
          : ''
      }
      ${card ? `<p style="margin-top:0.6rem">This card is from <strong>${esc(card.domainName)}</strong>.</p>` : ''}
      <p style="margin-top:0.75rem">
        <strong>${esc(s.completed || 0)}</strong> discussed &middot;
        <strong>${esc(s.skipped || 0)}</strong> skipped &middot;
        <strong>${esc(s.total || 0)}</strong> in this selection
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
    message: 'Optional - but a sentence here is worth far more than the category alone.',
    label: 'Your note',
    placeholder: 'Leave blank if you would rather not say',
    confirmLabel: 'Send it',
  });
  if (note === null) return;

  try {
    await api.post('/api/report', { questionId: card.id, reason, note });
    toast('Thank you - that has been passed on.');
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

  // Scoped to the selection being played, and named, so "start again" can
  // never quietly clear more than what is on screen.
  const where = d.selection ? d.selection.names.join(', ') : 'this selection';

  const yes = await uiConfirm(
    isSkipped ? 'Bring back skipped questions?' : 'Start this selection again?',
    isSkipped
      ? `The <strong>${count}</strong> question${count === 1 ? '' : 's'} you skipped in ${esc(
          where
        )} will go straight back into the deck. Nothing you marked as discussed is affected.`
      : `This clears all <strong>${count}</strong> record${
          count === 1 ? '' : 's'
        } for ${esc(where)} at ${
          d.selection ? `depth ${esc(d.selection.depths.join(', '))}` : 'these depths'
        } - every question becomes available again, as if you had never opened it. This cannot be undone.`,
    isSkipped ? 'Bring them back' : `Clear ${count}`,
    !isSkipped
  );
  if (!yes) return;

  try {
    const res = await api.post('/api/deck/reset', {
      scope,
      domains: selectedDomains(),
      depths: selectedDepths(),
    });
    state.domains = res.domains;
    toast(`Cleared ${plural(res.cleared, 'record', 'records')}.`);
    await startDeck();
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
 * Name, accent, palette and favicon, as set by the owner.
 *
 * The palette arrives keyed by CSS property name ("--night"), so this loop does
 * not know or care which tokens exist - adding one to PALETTE in server.js is
 * the entire change. Values are written onto the root element, where they
 * override the stylesheet's own :root defaults by specificity.
 */
// ---------------------------------------------------------------------------
// Night or day
// ---------------------------------------------------------------------------

/**
 * The theme is kept on the DEVICE, not against the couple.
 *
 * It describes the room the phone is in rather than the pair using it: the same
 * code redeemed at a bright kitchen table and in a dark bedroom wants two
 * different answers, and a couple with two phones should not have to agree
 * about brightness. localStorage also means it survives closing the code, which
 * a server-side preference tied to the session would not.
 *
 * index.html applies the stored value before the stylesheet is fetched. The key
 * name and the string 'day' are the contract between that copy and this one.
 */
const THEME_KEY = 'lc-theme';

function currentTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === 'day' ? 'day' : 'night';
  } catch (err) {
    // Private browsing, or storage switched off. Night is the default anyway.
    return 'night';
  }
}

function applyTheme(theme) {
  const day = theme === 'day';

  // Night is the ABSENCE of the attribute, not data-theme="night". The
  // stylesheet's :root block is already the night palette, so removing it is
  // what returns the app to its default rather than layering another override.
  if (day) document.documentElement.setAttribute('data-theme', 'day');
  else document.documentElement.removeAttribute('data-theme');

  // The chrome AROUND the app - the status bar on an installed PWA, the address
  // bar on Android - is painted from these meta tags and not from the CSS. Left
  // alone, a day-mode app keeps a black bar above a pale screen.
  const meta = (name) => document.querySelector(`meta[name="${name}"]`);
  const themeColor = meta('theme-color');
  if (themeColor) themeColor.setAttribute('content', day ? '#F2EFE9' : '#11141B');
  const colorScheme = meta('color-scheme');
  if (colorScheme) colorScheme.setAttribute('content', day ? 'light' : 'dark');

  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (err) {
    // Nothing to do. The theme still applies for as long as this tab is open.
  }
}

function applyBranding() {
  const b = state.branding;
  if (!b) return;

  if (b.palette) {
    for (const [prop, value] of Object.entries(b.palette)) {
      // Guarded: these go straight into the CSSOM, and a value from the
      // database should not be able to smuggle in a declaration.
      //
      // Written as --brand-<name>, NOT as the token itself.
      //
      // These land as INLINE styles on :root, and an inline declaration beats
      // any stylesheet rule no matter how specific. Setting --night here would
      // therefore outrank :root[data-theme='day'] { --night: ... } and snap the
      // app back to dark the instant branding loaded. The stylesheet reads each
      // token as var(--brand-x, <default>), so this feeds the palette without
      // being able to overrule a theme.
      if (/^--[a-z0-9-]+$/i.test(prop) && /^#[0-9a-f]{6}$/i.test(value)) {
        document.documentElement.style.setProperty('--brand-' + prop.slice(2), value);
      }
    }
  }

  if (b.brand_accent) document.documentElement.style.setProperty('--accent', b.brand_accent);
  if (b.app_name) document.title = b.app_name;

  // The browser asked for the favicon long before this ran, so swapping it
  // means replacing the link element rather than setting an attribute - some
  // browsers ignore an href change on an already-resolved icon link.
  if (b.assets && b.assets.favicon) {
    document.querySelectorAll('link[rel~="icon"]').forEach((el) => el.remove());
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = b.assets.faviconUrl;
    document.head.appendChild(link);
  }

  // iOS ignores the manifest for the home-screen icon and uses this instead, so
  // it has to be pointed at separately or iPhone users get a screenshot of the
  // page as their icon.
  //
  // Prefers the FAVICON, same reasoning as the manifest: a home-screen icon is
  // composited onto a background someone else chooses, and the favicon is the
  // solid one. The logo is line art on transparency and disappears there.
  if (b.assets && (b.assets.favicon || b.assets.logo)) {
    document.querySelectorAll('link[rel="apple-touch-icon"]').forEach((el) => el.remove());
    const touch = document.createElement('link');
    touch.rel = 'apple-touch-icon';
    touch.href = b.assets.favicon ? b.assets.faviconUrl : b.assets.logoUrl;
    document.head.appendChild(touch);
  }
}

/**
 * The watermark on a question card.
 *
 * Sits BEHIND the question rather than above it, and is marked aria-hidden and
 * pointer-events:none so it cannot take a tap meant for the card or be read
 * aloud to somebody using a screen reader. It is decoration; the question is
 * the content.
 *
 * Strength is the owner's, from Settings > Brand. Zero means off, and off is a
 * real answer - a watermark competing with the question would be exactly the
 * wrong outcome on a screen whose whole job is one sentence.
 */
function cardWatermark() {
  const b = state.branding || {};
  const opacity = Number(b.watermarkOpacity);
  if (!b.assets || !(b.assets.watermark || b.assets.logo)) return '';
  if (!Number.isFinite(opacity) || opacity <= 0) return '';
  // Size and position come from the owner too. Percentages, not pixels: a card
  // is a different size on every phone, so anything fixed would sit correctly
  // on exactly one of them.
  const size = Number(b.watermarkSize);
  const x = Number(b.watermarkX);
  const y = Number(b.watermarkY);
  const style = [
    `opacity:${opacity / 100}`,
    `width:${Number.isFinite(size) ? size : 78}%`,
    `left:${Number.isFinite(x) ? x : 50}%`,
    `top:${Number.isFinite(y) ? y : 50}%`,
  ].join(';');

  // Two marks, one shown by CSS - same reasoning as the header lockup. Only
  // when the day fallback actually differs: with no day logo uploaded both URLs
  // are the same image and a second copy would be pure waste.
  const day = b.assets.watermarkDayUrl;
  if (day && day !== b.assets.watermarkUrl) {
    return `<img class="qcard-watermark qcard-watermark--night" src="${esc(b.assets.watermarkUrl)}" alt=""
                 aria-hidden="true" style="${style}">
            <img class="qcard-watermark qcard-watermark--day is-day-asset" src="${esc(day)}" alt=""
                 aria-hidden="true" style="${style}">`;
  }

  return `<img class="qcard-watermark" src="${esc(b.assets.watermarkUrl)}" alt=""
               aria-hidden="true" style="${style}">`;
}

/** Where to send somebody who has no code. Blank means show nothing. */
function registerUrl() {
  const b = state.branding || {};
  const url = String(b.register_url || '').trim();
  const lower = url.toLowerCase();

  // An absolute http(s) link, or a path on this site such as /register.
  //
  // Anything else is ignored rather than rendered. This href comes from a
  // database value and is shown on a page anyone can reach, so javascript:
  // and data: must never survive it.
  //
  // A leading double slash is excluded: that is a protocol-relative URL,
  // which looks like a local path and sends people off-site. Character 92
  // is a backslash, tested by code point because some browsers treat it as
  // a slash and it can be used for the same trick.
  if (lower.startsWith('http://') || lower.startsWith('https://')) return url;
  if (url.length > 1 && url[0] === '/' && url[1] !== '/' && url.charCodeAt(1) !== 92) {
    return url;
  }
  return '';
}




/** Whether the owner has uploaded a logo. */
function hasLogo() {
  const b = state.branding || {};
  return !!(b.assets && b.assets.logo);
}

/**
 * The whole brand lockup: mark AND name, as one unit.
 *
 * An uploaded logo replaces BOTH, and that is the point. These logos are
 * wordmarks - the name is drawn into the artwork - so rendering the app name in
 * text beside one prints it twice. The character tile is the fallback, and only
 * then does the name need setting in type next to it.
 *
 * `size` is 'hero' for the welcome screen or 'bar' for the header.
 */
function brandLockup(size) {
  const name = brand().name;
  if (hasLogo()) {
    const a = state.branding.assets || {};
    // BOTH marks are emitted when a day logo exists, and CSS shows one. Picking
    // in JS here would mean re-rendering every screen that carries the lockup
    // on a theme change - including the boot screen and the code gate, which do
    // not re-render at all. The unused one costs a request the browser caches
    // for a year, and only when a day logo has actually been uploaded.
    if (a.logoDay) {
      return `<img class="brand-logo brand-logo--${size} brand-logo--night" src="${esc(a.logoUrl)}" alt="${esc(name)}">
              <img class="brand-logo brand-logo--${size} brand-logo--day is-day-asset" src="${esc(a.logoDayUrl)}" alt="${esc(name)}">`;
    }
    return `<img class="brand-logo brand-logo--${size}" src="${esc(a.logoUrl)}" alt="${esc(name)}">`;
  }
  return size === 'hero'
    ? `<div class="hero-mark" aria-hidden="true">${esc(brand().mark)}</div>
       <h1>${esc(name)}</h1>`
    : `<span class="brand-mark" aria-hidden="true">${esc(brand().mark)}</span>
       <span>${esc(name)}</span>`;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Send a registration request.
 *
 * The values are mirrored into state.form BEFORE the request, because a
 * re-render on error would otherwise empty every box and make the person type
 * it all again just to find out what was wrong.
 */
async function onRegister(e) {
  e.preventDefault();
  if (state.busy) return;
  const f = e.target;
  const values = {
    partnerA: f.partnerA.value.trim(),
    partnerB: f.partnerB.value.trim(),
    email: f.email.value.trim(),
    note: f.note.value.trim(),
  };

  state.form = values;
  state.error = null;
  state.busy = true;
  render();

  try {
    await api.post('/api/register', values);
    state.registered = true;
    state.registeredEmail = values.email;
    state.form = {};
    state.busy = false;
    render();
  } catch (err) {
    state.busy = false;
    state.error = err.message;
    render();
  }
  return undefined;
}

/**
 * Redeem a code.
 *
 * Everything after this is the app; everything before it is one field. The
 * server does the normalising, so a code typed with the dashes, without them,
 * or in lower case all reach it the same way.
 */
async function onRedeem(e) {
  e.preventDefault();
  if (state.busy) return;

  const code = e.target.code.value.trim();
  if (!code) return;

  state.form.code = code;
  state.error = null;
  state.busy = true;
  render();

  try {
    const res = await api.post('/api/access/redeem', { code });
    state.busy = false;
    state.form = {};
    state.error = null;
    await loadData();
    // Said once, on the way in, rather than parked on the screen where it
    // would just be furniture by the third visit.
    toast(`Welcome ${res.couple.name}.`);
  } catch (err) {
    state.busy = false;
    state.error = err.message;
    render();
  }
  return undefined;
}

/** Close the code on this phone. It keeps working - nothing is revoked. */
async function leaveSession() {
  const yes = await uiConfirm(
    'Close the app?',
    'Your progress is kept. You will need the code again next time you sit down.',
    'Close it'
  );
  if (!yes) return;
  try {
    await api.post('/api/access/leave');
  } catch (err) {
    /* closing locally regardless */
  }
  state.couple = null;
  state.deck = null;
  state.selection = { domains: null, depths: null };
  state.view = 'levels';
  state.form = {};
  render();
}

async function loadData() {
  try {
    const data = await api.get('/api/data');
    state.me = data.me;
    state.couple = data.couple;
    state.domains = data.domains || [];
    state.depths = data.depths || [];
    state.feedbackOptions = data.feedbackOptions || [];
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
    // /api/data is public now and answers with couple: null before a code has
    // been redeemed, so reaching here means the request itself failed rather
    // than "not signed in". Leave the gate on screen.
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
  // The register form is typed into, and a render() would throw it away. This
  // only ever fires for a signed-in owner previewing the page - a stranger has
  // no state.me and never reaches here - but losing a half-filled form on a
  // tab switch is not something to leave in.
  if (isRegisterRoute()) return;
  if (state.view === 'deck') return; // never swap the card out from under them
  api
    .get('/api/data')
    .then((data) => {
      state.couple = data.couple;
      state.domains = data.domains || [];
      state.depths = data.depths || [];
    state.feedbackOptions = data.feedbackOptions || [];
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

loadData();
