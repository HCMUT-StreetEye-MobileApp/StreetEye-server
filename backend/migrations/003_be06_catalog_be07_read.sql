CREATE TABLE streeteye_private.seed_regions (
  mode text NOT NULL CHECK (mode IN ('demo','pilot')),
  region_key text NOT NULL,
  source_ref text NOT NULL,
  manifest_hash text NOT NULL,
  surveyed_at timestamptz,
  boundary extensions.geometry(Polygon,4326) NOT NULL,
  sample_route extensions.geometry(LineString,4326) NOT NULL,
  PRIMARY KEY(mode, region_key),
  CHECK(mode='demo' OR surveyed_at IS NOT NULL),
  CHECK(extensions.st_isvalid(boundary) AND extensions.st_covers(boundary,sample_route))
);
-- Owner-backed projections expose only public fields to the Express login.
CREATE VIEW streeteye_private.read_hazards WITH (security_barrier=true) AS
 SELECT h.hazard_id,h.previous_hazard_id,h.data_mode,h.hazard_type,h.severity,h.location,
 h.road_ref,h.direction_bearing::float8,h.status,h.is_disputed,h.last_observed_at,h.expires_at,h.updated_at,
 s.score::float8 AS confidence_score,s.score_version,s.computed_at
 FROM public.hazards h LEFT JOIN LATERAL (
 SELECT score,score_version,computed_at FROM public.score_snapshots WHERE hazard_id=h.hazard_id
 ORDER BY calculation_no DESC LIMIT 1) s ON true WHERE h.status <> 'rejected';
CREATE VIEW streeteye_private.read_landmarks WITH (security_barrier=true) AS
 SELECT landmark_id,data_mode,name_vi,description_vi,location,reviewed_at FROM public.landmarks WHERE is_active;
CREATE VIEW streeteye_private.read_cues WITH (security_barrier=true) AS
 SELECT c.cue_id,c.landmark_id,c.data_mode,l.name_vi AS landmark_name_vi,c.turn_location,
 c.approach_bearing::float8,c.exit_bearing::float8,c.bearing_tolerance_deg::float8,c.instruction_vi
 FROM public.turn_cues c JOIN streeteye_private.read_landmarks l USING (landmark_id,data_mode)
 WHERE c.is_active AND c.approach_bearing IS NOT NULL AND c.exit_bearing IS NOT NULL AND c.bearing_tolerance_deg IS NOT NULL;
REVOKE ALL ON ALL TABLES IN SCHEMA streeteye_private FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA extensions TO streeteye_backend;
GRANT SELECT ON streeteye_private.read_hazards,streeteye_private.read_landmarks,streeteye_private.read_cues TO streeteye_backend;
