-- Let's Connect - fresh-install DDL.
--
-- NON-DESTRUCTIVE by design: CREATE TABLE IF NOT EXISTS only, no drops.
-- `npm run init-db` applies this and safely adds missing tables without
-- touching existing data.
--
-- IMPORTANT: this file is NOT applied by `npm run migrate`. It is the
-- fresh-install path only. Every column added by a migration must ALSO be
-- mirrored here by hand, or fresh installs drift from migrated ones.
-- `npm run check-schema` reports the drift in both directions.

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  email           VARCHAR(191) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  display_name    VARCHAR(100) NOT NULL,
  -- is_owner is the master admin who signs in at /admin/. is_admin predates it
  -- and is kept rather than dropped: removing a column a running release still
  -- selects is how a deploy breaks between the pull and the restart.
  is_admin        TINYINT(1) NOT NULL DEFAULT 0,
  is_owner        TINYINT(1) NOT NULL DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at   DATETIME NULL,
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Couples
--
-- A couple is created by one person, who gets an invite code. The partner
-- redeems the code to join. A couple with a single member is perfectly valid -
-- you can browse and start before your partner has signed up.
--
-- shuffle_seed gives each couple its own stable question order: deterministic,
-- so both partners always see the same sequence, but different per couple.
-- ---------------------------------------------------------------------------

-- A couple IS a licence. One code, bought from the shop, used by two people
-- sitting together with one screen between them.
--
-- These columns live here rather than in a separate access_codes table because
-- every piece of progress already hangs off couples.id. A second identity would
-- mean a join on every read and two things to keep in step; there is no state
-- where a code exists without a couple.
--
-- invite_code and couple_members belong to the retired pairing model. Both are
-- kept: nothing writes to them, and a live database may hold rows describing
-- who was paired with whom.
CREATE TABLE IF NOT EXISTS couples (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  access_code        VARCHAR(24) NULL,
  invite_code        VARCHAR(12) NULL,
  couple_name        VARCHAR(120) NULL,
  partner_a          VARCHAR(60) NULL,
  partner_b          VARCHAR(60) NULL,
  buyer_email        VARCHAR(191) NULL,
  buyer_phone        VARCHAR(32) NULL,
  order_ref          VARCHAR(60) NULL,
  -- Whatever they typed in the optional box on the registration form.
  signup_note        VARCHAR(500) NULL,
  -- suspended, not deleted: a refund has to stop the code working without
  -- erasing that it existed.
  -- The whole lifecycle in one column:
  --   requested  they asked through /register, no code exists yet
  --   active     a code was issued and works
  --   suspended  the code exists but is refused - what a refund looks like
  --   declined   asked, answered no. Kept so it cannot quietly come back.
  code_status        ENUM('requested','active','suspended','declined') NOT NULL DEFAULT 'active',
  issued_at          DATETIME NULL,
  activated_at       DATETIME NULL,
  last_used_at       DATETIME NULL,
  -- One deliberate choice made in front of both of them. It was per-person
  -- under the two-account model, because one partner could otherwise open that
  -- door on the other's behalf; sitting together there is no second session to
  -- ask, and no such risk.
  volatile_unlocked    TINYINT(1) NOT NULL DEFAULT 0,
  volatile_unlocked_at DATETIME NULL,
  shuffle_seed       VARCHAR(32) NOT NULL,
  status             ENUM('active','dissolved') NOT NULL DEFAULT 'active',
  created_by_user_id INT NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_couples_access_code (access_code),
  UNIQUE KEY uq_couples_invite_code (invite_code),
  KEY idx_couples_creator (created_by_user_id),
  CONSTRAINT fk_couples_creator FOREIGN KEY (created_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One membership row per person. UNIQUE(user_id) enforces one couple per user
-- for now; "Leave couple" removes the row so a mis-pairing is recoverable.
CREATE TABLE IF NOT EXISTS couple_members (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  couple_id  INT NOT NULL,
  user_id    INT NOT NULL,
  member_role ENUM('creator','partner') NOT NULL DEFAULT 'partner',
  joined_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Volatile questions are unlocked PER PERSON, and both members must have
  -- done it. One partner must not be able to open that door on the other's
  -- behalf - which is exactly what a couple-level flag would allow.
  volatile_unlocked    TINYINT(1) NOT NULL DEFAULT 0,
  volatile_unlocked_at DATETIME NULL,
  UNIQUE KEY uq_couple_members_user (user_id),
  UNIQUE KEY uq_couple_members_pair (couple_id, user_id),
  KEY idx_couple_members_couple (couple_id),
  CONSTRAINT fk_couple_members_couple FOREIGN KEY (couple_id)
    REFERENCES couples (id) ON DELETE CASCADE,
  CONSTRAINT fk_couple_members_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Content: domains, chains and questions
--
-- DEPTH AND DOMAIN ARE INDEPENDENT AXES. This is the central design decision
-- and it is easy to undo by accident.
--
--   domains   subject matter only. No depth. Sex, Money, Origin, Conflict...
--   depth     emotional exposure only, 1-5, held per QUESTION.
--   volatile  a flag on the few questions that can end a relationship in the
--             wrong week, independent of both.
--
-- An earlier version had one table, `levels`, whose rows carried both a
-- subject and a depth. That collapsed a mild question about sexual timing and
-- a question about whether the relationship should end into the same bucket,
-- because both merely felt risky. `levels` has been retired; do not
-- reintroduce a depth column on `domains`.
--
-- Content is seeded once from data/corpus.json (generated from the corpus
-- markdown by `npm run build-corpus`) and thereafter belongs to the admin area.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS domains (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  slug         VARCHAR(60) NOT NULL,
  name         VARCHAR(100) NOT NULL,
  tagline      VARCHAR(180) NULL,
  description  TEXT NULL,
  accent       VARCHAR(9) NOT NULL DEFAULT '#D8327C',
  sort_order   INT NOT NULL DEFAULT 0,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_domains_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Depth: exposure, nothing to do with subject. Rows rather than a constant so
-- the ladder's couple-facing wording can be edited without a deploy, the same
-- reason domains and questions live here. `n` is what questions.depth stores.
CREATE TABLE IF NOT EXISTS depths (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  n           TINYINT NOT NULL,
  name        VARCHAR(60) NOT NULL,
  blurb       VARCHAR(200) NULL,
  description TEXT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_depths_n (n)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The framework a question was written against, shown as a three-letter code
-- in the card's top corner and explained when tapped.
--
-- questions.lens holds the code with NO foreign key, on purpose: the lens is
-- provenance, and a question whose lens was renamed or removed must keep being
-- served rather than break.
--
-- Two audiences, two columns: `description` is couple-facing copy read on a
-- phone; `brief` is written for the generator and says what the framework
-- actually interrogates. Neither can do the other's job.
CREATE TABLE IF NOT EXISTS lenses (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(3) NOT NULL,
  name        VARCHAR(100) NOT NULL,
  author      VARCHAR(120) NULL,
  description TEXT NULL,
  brief       TEXT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lenses_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A recommended running order over cards that circle the same construct at
-- increasing exposure. Every card still stands alone - pull one out of a chain
-- and it makes complete sense. The chain only adds value played in order.
CREATE TABLE IF NOT EXISTS chains (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(60) NOT NULL,
  total      INT NOT NULL DEFAULT 0,
  min_depth  TINYINT NOT NULL DEFAULT 1,
  max_depth  TINYINT NOT NULL DEFAULT 1,
  domain_id  INT NULL,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_chains_name (name),
  KEY idx_chains_domain (domain_id),
  CONSTRAINT fk_chains_domain FOREIGN KEY (domain_id)
    REFERENCES domains (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- `source` is provenance: where a question came from, not who owns it.
-- `context` is the helper line revealed on tap. It opens the territory and
-- never supplies an answer - a sample answer anchors every couple to the same
-- reply and kills the question.
-- `needs_review` holds back questions that fail the corpus construction rules.
-- They are stored rather than dropped so nothing authored is ever lost.
CREATE TABLE IF NOT EXISTS questions (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  ref         VARCHAR(40) NOT NULL,
  domain_id   INT NULL,
  depth       TINYINT NOT NULL DEFAULT 1,
  lens        VARCHAR(3) NULL,
  is_volatile TINYINT(1) NOT NULL DEFAULT 0,
  source      ENUM('catalogue','admin','import') NOT NULL DEFAULT 'catalogue',
  text        TEXT NOT NULL,
  context     VARCHAR(500) NULL,
  chain_id       INT NULL,
  chain_position INT NULL,
  needs_review   TINYINT(1) NOT NULL DEFAULT 0,
  review_note    VARCHAR(255) NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  -- is_active belongs to the SEEDER. admin_hidden belongs to the ADMIN, and the
  -- seeder never touches it - otherwise hiding a curated question in the app
  -- would be quietly undone by the next migrate. Both are checked when serving.
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  admin_hidden TINYINT(1) NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_questions_ref (ref),
  -- The deck query filters on all four of these together.
  KEY idx_questions_axes (domain_id, depth, is_active, admin_hidden),
  KEY idx_questions_source (source),
  KEY idx_questions_lens (lens),
  KEY idx_questions_chain (chain_id, chain_position),
  CONSTRAINT fk_questions_domain FOREIGN KEY (domain_id)
    REFERENCES domains (id) ON DELETE CASCADE,
  CONSTRAINT fk_questions_chain FOREIGN KEY (chain_id)
    REFERENCES chains (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A couple's position in a chain they have accepted. Stopping part-way is a
-- valid outcome, not a failure: card two was never a fragment.
CREATE TABLE IF NOT EXISTS couple_chain_progress (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  couple_id  INT NOT NULL,
  chain_id   INT NOT NULL,
  position   INT NOT NULL DEFAULT 0,
  status     ENUM('active','done','abandoned') NOT NULL DEFAULT 'active',
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_chain_progress (couple_id, chain_id),
  KEY idx_chain_progress_couple (couple_id, status),
  KEY fk_chain_progress_chain (chain_id),
  CONSTRAINT fk_chain_progress_couple FOREIGN KEY (couple_id)
    REFERENCES couples (id) ON DELETE CASCADE,
  CONSTRAINT fk_chain_progress_chain FOREIGN KEY (chain_id)
    REFERENCES chains (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Generated candidates, waiting on a person.
--
-- Nothing written by a model reaches `questions` directly. Asking for an open,
-- standalone, non-binary question produces a REQUEST for one, not a guarantee,
-- so every candidate is put through the same construction rules the corpus
-- build applies (lib/question-rules.js) and then read by the owner. `verdict`
-- and `issues` are what the code decided; `status` is what the person decided.
CREATE TABLE IF NOT EXISTS question_drafts (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  batch        VARCHAR(40) NOT NULL,
  lens         VARCHAR(3) NULL,
  domain_id    INT NULL,
  depth        TINYINT NOT NULL DEFAULT 2,
  text         TEXT NOT NULL,
  context      VARCHAR(500) NULL,
  is_volatile  TINYINT(1) NOT NULL DEFAULT 0,
  verdict      ENUM('ok','review','rejected') NOT NULL DEFAULT 'ok',
  issues       VARCHAR(500) NULL,
  status       ENUM('pending','accepted','discarded') NOT NULL DEFAULT 'pending',
  question_id  INT NULL,
  model        VARCHAR(60) NULL,
  created_by   INT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at  DATETIME NULL,
  KEY idx_drafts_status (status, created_at),
  KEY idx_drafts_batch (batch),
  KEY fk_drafts_domain (domain_id),
  KEY fk_drafts_question (question_id),
  KEY fk_drafts_user (created_by),
  CONSTRAINT fk_drafts_domain FOREIGN KEY (domain_id)
    REFERENCES domains (id) ON DELETE SET NULL,
  -- SET NULL, not CASCADE: if an accepted question is later deleted, the record
  -- that it was generated and reviewed is still worth keeping.
  CONSTRAINT fk_drafts_question FOREIGN KEY (question_id)
    REFERENCES questions (id) ON DELETE SET NULL,
  CONSTRAINT fk_drafts_user FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Progress
--
-- One row per couple per question. NO ANSWERS ARE STORED - only whether the
-- card has been dealt with, so it is not shown again.
--
--   completed -> never served again (until the couple resets the deck)
--   skipped   -> "not tonight". Held back for skip_cooloff_days, then eligible
--                again. Also released early if it is the only thing left, so a
--                deck can never dead-end with skipped cards sitting unused.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS couple_question_status (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  couple_id          INT NOT NULL,
  question_id        INT NOT NULL,
  status             ENUM('completed','skipped') NOT NULL,
  skip_count         INT NOT NULL DEFAULT 0,
  decided_by_user_id INT NULL,
  decided_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cqs_couple_question (couple_id, question_id),
  KEY idx_cqs_couple_status (couple_id, status),
  CONSTRAINT fk_cqs_couple FOREIGN KEY (couple_id)
    REFERENCES couples (id) ON DELETE CASCADE,
  CONSTRAINT fk_cqs_question FOREIGN KEY (question_id)
    REFERENCES questions (id) ON DELETE CASCADE,
  CONSTRAINT fk_cqs_user FOREIGN KEY (decided_by_user_id)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Password resets
--
-- Only a SHA-256 HASH of the token is stored, never the token. A database dump
-- therefore does not hand anybody a working reset link - the same reasoning as
-- hashing passwords, since a reset token IS a password for the next hour.
--
-- Single-use (used_at) and time-limited (expires_at).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS password_resets (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      INT NOT NULL,
  token_hash   CHAR(64) NOT NULL,
  expires_at   DATETIME NOT NULL,
  used_at      DATETIME NULL,
  requested_ip VARCHAR(64) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_password_resets_token (token_hash),
  KEY idx_password_resets_user (user_id, used_at),
  KEY idx_password_resets_expiry (expires_at),
  CONSTRAINT fk_password_resets_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Question reports
--
-- The app stores no answers, so the only quality signals it can ever have are
-- the skip rate (a number) and a report (a reason). That makes `note` the most
-- valuable content feedback the owner will get.
--
-- UNIQUE(question_id, couple_id) so one couple cannot lodge the same complaint
-- twice from two phones. user_id is SET NULL on delete because the content
-- problem is still real after the reporter has deleted their account.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS question_reports (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  question_id  INT NOT NULL,
  couple_id    INT NOT NULL,
  user_id      INT NULL,
  reason       ENUM('unclear','upsetting','inappropriate','duplicate','other')
                 NOT NULL DEFAULT 'other',
  note         VARCHAR(500) NULL,
  status       ENUM('open','actioned','dismissed') NOT NULL DEFAULT 'open',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at  DATETIME NULL,
  reviewed_by  INT NULL,
  UNIQUE KEY uq_report_question_couple (question_id, couple_id),
  KEY idx_reports_status (status, created_at),
  CONSTRAINT fk_reports_question FOREIGN KEY (question_id)
    REFERENCES questions (id) ON DELETE CASCADE,
  CONSTRAINT fk_reports_couple FOREIGN KEY (couple_id)
    REFERENCES couples (id) ON DELETE CASCADE,
  CONSTRAINT fk_reports_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_reports_reviewer FOREIGN KEY (reviewed_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Audit log
--
-- actor_email is denormalised deliberately: accounts can now be deleted
-- outright, and a foreign key alone would blank the actor on every historic
-- entry the moment somebody left - exactly when you most want to know who did
-- what. The FK degrades actor_user_id to NULL; the readable record survives.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_log (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  actor_user_id INT NULL,
  actor_email   VARCHAR(191) NULL,
  action        VARCHAR(60) NOT NULL,
  target_type   VARCHAR(40) NULL,
  target_id     INT NULL,
  target_label  VARCHAR(255) NULL,
  detail        TEXT NULL,
  ip            VARCHAR(64) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_created (created_at),
  KEY idx_audit_action (action),
  KEY idx_audit_actor (actor_user_id),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Settings
--
-- Anything worth tuning without a deploy lives here, not in .env and not
-- hard-coded. Code defaults apply when a key is absent.
-- ---------------------------------------------------------------------------

-- setting_value is MEDIUMTEXT, not TEXT: the brand logo and favicon are stored
-- here base64-encoded, and TEXT's 64KB limit truncates an image silently rather
-- than raising an error. See scripts/migrate-add-brand-assets.js.
CREATE TABLE IF NOT EXISTS settings (
  setting_key   VARCHAR(100) NOT NULL PRIMARY KEY,
  setting_value MEDIUMTEXT NULL,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- NOTE: the `sessions` table is created by the app itself at boot (see the
-- MySQLSessionStore in server.js) and is deliberately not defined here.

-- ---------------------------------------------------------------------------
-- Question feedback
--
-- How a question landed, recorded against the QUESTION and nobody else. There
-- is deliberately no couple_id here and there must never be one: the app's
-- promise is that what two people say to each other goes no further, and a row
-- tying a named couple to "that one went badly" would break it outright.
--
-- `recorded_on` is a DATE for the same reason. Timestamps seconds apart are
-- obviously one sitting, and an ordered run of those is a fingerprint that
-- could be re-attached to whoever redeemed a code that day.
--
-- See scripts/migrate-add-question-feedback.js.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `feedback_options` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `label` varchar(120) NOT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `question_feedback` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `question_id` int(11) NOT NULL,
  `option_id` int(11) NOT NULL,
  `recorded_on` date NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_feedback_question` (`question_id`),
  KEY `idx_feedback_option` (`option_id`),
  CONSTRAINT `fk_feedback_option` FOREIGN KEY (`option_id`) REFERENCES `feedback_options` (`id`),
  CONSTRAINT `fk_feedback_question` FOREIGN KEY (`question_id`) REFERENCES `questions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
