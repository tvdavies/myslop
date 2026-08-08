-- Shoo pairwise subjects vary by origin. A verified email identifies one
-- account across the custom domain and the platform alias.
CREATE UNIQUE INDEX IF NOT EXISTS users_verified_email
ON users(email COLLATE NOCASE)
WHERE email IS NOT NULL;
