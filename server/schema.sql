CREATE TABLE IF NOT EXISTS members (
  uid text PRIMARY KEY,
  display_name text NOT NULL,
  email text,
  role text NOT NULL CHECK (role IN ('owner', 'organizer', 'player')),
  status text NOT NULL CHECK (status IN ('pending', 'approved')),
  linked_guest_id text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  approved_by text
);
ALTER TABLE members ADD COLUMN IF NOT EXISTS removed_at timestamptz;

CREATE TABLE IF NOT EXISTS guests (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'linked')),
  linked_uid text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  linked_at timestamptz,
  linked_by text
);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS removed_at timestamptz;

CREATE TABLE IF NOT EXISTS group_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  time_zone text,
  currency text,
  launch_session_date date,
  payment_qr_mime_type text,
  payment_qr_data bytea,
  updated_at timestamptz,
  updated_by text
);

CREATE TABLE IF NOT EXISTS fee_versions (
  subject_type text NOT NULL CHECK (subject_type IN ('member', 'guest')),
  subject_id text NOT NULL,
  effective_from date NOT NULL,
  amount_minor integer NOT NULL CHECK (amount_minor BETWEEN 0 AND 100000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  PRIMARY KEY (subject_type, subject_id, effective_from)
);

CREATE TABLE IF NOT EXISTS invites (
  token_hash text PRIMARY KEY,
  remaining_uses integer NOT NULL CHECK (remaining_uses >= 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  session_date date NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('member', 'guest')),
  subject_id text NOT NULL,
  player_uid text,
  guest_id text,
  display_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'void')),
  checked_in_at timestamptz NOT NULL,
  checked_in_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  corrected_by text,
  PRIMARY KEY (session_date, subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS charges (
  id text PRIMARY KEY,
  session_date date NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('member', 'guest')),
  subject_id text NOT NULL,
  player_uid text,
  guest_id text,
  amount_minor integer NOT NULL CHECK (amount_minor BETWEEN 0 AND 100000000),
  fee_effective_from date NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'void')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_date, subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id text PRIMARY KEY,
  subject_type text NOT NULL CHECK (subject_type IN ('member', 'guest')),
  subject_id text NOT NULL,
  player_uid text,
  guest_id text,
  amount_minor integer NOT NULL CHECK (amount_minor BETWEEN 1 AND 100000000),
  received_at timestamptz NOT NULL DEFAULT now(),
  entered_by text NOT NULL,
  note text NOT NULL DEFAULT '',
  request_id text NOT NULL,
  UNIQUE (subject_type, subject_id, request_id)
);

CREATE TABLE IF NOT EXISTS payment_reversals (
  payment_id text PRIMARY KEY REFERENCES payments(id),
  subject_type text NOT NULL CHECK (subject_type IN ('member', 'guest')),
  subject_id text NOT NULL,
  player_uid text,
  guest_id text,
  amount_minor integer NOT NULL CHECK (amount_minor BETWEEN 1 AND 100000000),
  reason text NOT NULL,
  reversed_by text NOT NULL,
  reversed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  action text NOT NULL,
  actor_uid text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attendance_session_idx ON attendance (session_date, status);
CREATE INDEX IF NOT EXISTS charges_subject_idx ON charges (subject_type, subject_id, session_date);
CREATE INDEX IF NOT EXISTS payments_subject_idx ON payments (subject_type, subject_id, received_at);
CREATE INDEX IF NOT EXISTS fee_versions_lookup_idx ON fee_versions (subject_type, subject_id, effective_from DESC);
