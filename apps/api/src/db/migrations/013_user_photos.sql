-- Photo gallery: up to 6 photos per profile (3 free, 6 with Plus).
-- Position 0 is the primary avatar, mirrored to users.photo_url for compatibility.

CREATE TABLE user_photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url         text NOT NULL,
  position    smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_photos_user ON user_photos(user_id, position ASC);

-- Seed user_photos with existing user avatars so no profiles lose their photo
INSERT INTO user_photos (user_id, url, position)
SELECT id, photo_url, 0
FROM users
WHERE photo_url IS NOT NULL AND photo_url <> ''
ON CONFLICT DO NOTHING;
