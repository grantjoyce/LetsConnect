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
  is_admin        TINYINT(1) NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS couples (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  invite_code        VARCHAR(12) NOT NULL,
  couple_name        VARCHAR(120) NULL,
  shuffle_seed       VARCHAR(32) NOT NULL,
  status             ENUM('active','dissolved') NOT NULL DEFAULT 'active',
  created_by_user_id INT NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
  UNIQUE KEY uq_couple_members_user (user_id),
  UNIQUE KEY uq_couple_members_pair (couple_id, user_id),
  KEY idx_couple_members_couple (couple_id),
  CONSTRAINT fk_couple_members_couple FOREIGN KEY (couple_id)
    REFERENCES couples (id) ON DELETE CASCADE,
  CONSTRAINT fk_couple_members_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- The question catalogue
--
-- levels + questions are CONTENT, not user data. They are kept in step with
-- data/catalogue.js by the seed migration, which upserts on the stable `slug`
-- / `ref` keys and deactivates rather than deletes, so progress rows always
-- keep something to point at.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS levels (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  slug         VARCHAR(60) NOT NULL,
  name         VARCHAR(100) NOT NULL,
  tagline      VARCHAR(180) NOT NULL,
  description  TEXT NULL,
  depth        TINYINT NOT NULL DEFAULT 1,
  accent       VARCHAR(9) NOT NULL DEFAULT '#D8327C',
  sort_order   INT NOT NULL DEFAULT 0,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_levels_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS questions (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  ref         VARCHAR(40) NOT NULL,
  level_id    INT NOT NULL,
  text        TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_questions_ref (ref),
  KEY idx_questions_level (level_id, is_active),
  CONSTRAINT fk_questions_level FOREIGN KEY (level_id)
    REFERENCES levels (id) ON DELETE CASCADE
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
-- Settings
--
-- Anything worth tuning without a deploy lives here, not in .env and not
-- hard-coded. Code defaults apply when a key is absent.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS settings (
  setting_key   VARCHAR(100) NOT NULL PRIMARY KEY,
  setting_value TEXT NULL,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- NOTE: the `sessions` table is created by the app itself at boot (see the
-- MySQLSessionStore in server.js) and is deliberately not defined here.
