-- Team-level owners can manage every app from the platform management area.
ALTER TABLE users ADD COLUMN platform_role TEXT NOT NULL DEFAULT 'member' CHECK (platform_role IN ('member', 'owner'));
UPDATE users SET platform_role='owner' WHERE email IN ('bootstrap@lleverage.ai', 'tom@lleverage.ai');
