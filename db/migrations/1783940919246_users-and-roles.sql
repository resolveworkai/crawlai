-- Authored by: Mohit Singh
--
-- Replaces Supabase's auth.users + profiles + RLS with a plain, app-owned users table.
-- Authorization is enforced entirely in backend/api (JWT + role middleware) — see
-- .claude/skills/skills_security.md. No RLS, no GRANTs to Supabase-specific roles.
--
-- This is a single shared team workspace, not a multi-tenant app: user_roles governs WHAT
-- actions a role may take (admin/operator/viewer), not WHICH rows are visible — every
-- authenticated user can see the one shared master DB / job queue. See businesses_and_images
-- migration for the corresponding "global master DB" decision.

-- Up Migration

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_users_updated
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

CREATE INDEX idx_user_roles_user_id ON user_roles(user_id);

-- Down Migration

DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS users;
