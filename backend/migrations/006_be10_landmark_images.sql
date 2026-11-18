-- Refreshable delivery metadata. Historical identifiers and editorial links survive expiry.
ALTER TABLE public.landmark_images
  ADD COLUMN delivery_url text CHECK (delivery_url ~ '^https://'),
  ADD COLUMN delivery_expires_at timestamptz;

CREATE VIEW streeteye_private.read_cue_images WITH (security_barrier=true) AS
SELECT ci.cue_id, i.image_id, i.image_source, ci.display_order,
       i.delivery_url AS url, i.delivery_expires_at AS url_expires_at,
       i.attribution, i.captured_at, i.compass_angle::float8,
       (i.image_source='team_seed' AND i.offline_allowed) AS offline_allowed,
       CASE WHEN i.image_source='team_seed' AND i.offline_allowed
         THEN i.delivery_expires_at END AS offline_expires_at
FROM public.cue_images ci
JOIN streeteye_private.read_cues c USING(cue_id,landmark_id)
JOIN public.landmark_images i USING(image_id,data_mode)
WHERE i.usage_status='approved' AND i.reviewed_at IS NOT NULL
  AND length(trim(i.attribution)) BETWEEN 1 AND 500
  AND i.delivery_url IS NOT NULL AND i.delivery_expires_at > now()
  AND (i.image_source='team_seed' OR (
    extensions.st_dwithin(c.turn_location,i.position,50)
    AND least(abs(c.approach_bearing-i.compass_angle),360-abs(c.approach_bearing-i.compass_angle)) <= c.bearing_tolerance_deg));
REVOKE ALL ON streeteye_private.read_cue_images FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON streeteye_private.read_cue_images TO streeteye_backend;
