-- BE-03 v0.1 -> BE-05. Run through the versioned runner, inside one transaction.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;
-- Existing PostGIS in another schema is deliberately not moved automatically.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
    WHERE e.extname='postgis' AND n.nspname='extensions') THEN
    RAISE EXCEPTION 'PostGIS must be reviewed: expected schema extensions';
  END IF;
END $$;

CREATE TABLE public.contributors (
  contributor_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT,
  role text NOT NULL DEFAULT 'rider' CHECK (role IN ('rider','maintainer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

CREATE TABLE public.hazards (
  hazard_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  previous_hazard_id uuid,
  data_mode text NOT NULL CHECK (data_mode IN ('demo','pilot')),
  hazard_type text NOT NULL DEFAULT 'unknown' CHECK (hazard_type IN ('pothole','flood','roadwork','unknown')),
  severity text NOT NULL DEFAULT 'unknown' CHECK (severity IN ('unknown','low','medium','high')),
  location extensions.geography(Point,4326) NOT NULL,
  road_ref text,
  direction_bearing numeric CHECK (direction_bearing >= 0 AND direction_bearing < 360),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','resolved','expired','rejected')),
  is_disputed boolean NOT NULL DEFAULT false,
  last_observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (hazard_id,data_mode),
  CHECK (previous_hazard_id <> hazard_id),
  FOREIGN KEY (previous_hazard_id,data_mode) REFERENCES public.hazards(hazard_id,data_mode) ON DELETE RESTRICT
);

CREATE TABLE public.reports (
  report_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contributor_id uuid NOT NULL REFERENCES public.contributors ON DELETE RESTRICT,
  hazard_id uuid,
  client_event_id uuid NOT NULL,
  payload_hash text NOT NULL CHECK (length(btrim(payload_hash)) > 0),
  data_mode text NOT NULL CHECK (data_mode IN ('demo','pilot')),
  source text NOT NULL CHECK (source IN ('manual','sensor_confirmed','seed')),
  hazard_type text NOT NULL DEFAULT 'unknown' CHECK (hazard_type IN ('pothole','flood','roadwork','unknown')),
  severity text NOT NULL DEFAULT 'unknown' CHECK (severity IN ('unknown','low','medium','high')),
  position extensions.geography(Point,4326) NOT NULL,
  accuracy_m numeric CHECK (accuracy_m >= 0 AND accuracy_m < 'Infinity'::numeric),
  heading_deg numeric CHECK (heading_deg >= 0 AND heading_deg < 360),
  observed_at_raw timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  eligibility text NOT NULL DEFAULT 'needs_review' CHECK (eligibility IN ('eligible','ineligible','needs_review')),
  ineligibility_reason text,
  classification_method text,
  confirmed_at timestamptz,
  peak_accel_g numeric CHECK (peak_accel_g >= 0 AND peak_accel_g < 'Infinity'::numeric),
  speed_kmh numeric CHECK (speed_kmh >= 0 AND speed_kmh < 'Infinity'::numeric),
  source_ref text,
  source_record_key text,
  surveyed_at timestamptz,
  UNIQUE (contributor_id,client_event_id),
  FOREIGN KEY (hazard_id,data_mode) REFERENCES public.hazards(hazard_id,data_mode) ON DELETE RESTRICT,
  CONSTRAINT report_subtype CHECK (
    (source='manual' AND classification_method IS NOT NULL AND classification_method IN ('chosen','timeout')
      AND confirmed_at IS NULL AND peak_accel_g IS NULL AND speed_kmh IS NULL
      AND source_ref IS NULL AND source_record_key IS NULL AND surveyed_at IS NULL)
    OR (source='sensor_confirmed' AND confirmed_at IS NOT NULL AND confirmed_at >= observed_at
      AND classification_method IS NULL AND source_ref IS NULL AND source_record_key IS NULL AND surveyed_at IS NULL)
    OR (source='seed' AND source_ref IS NOT NULL AND length(btrim(source_ref)) > 0
      AND source_record_key IS NOT NULL AND length(btrim(source_record_key)) > 0
      AND classification_method IS NULL AND confirmed_at IS NULL AND peak_accel_g IS NULL AND speed_kmh IS NULL)
  )
);

CREATE TABLE public.verifications (
  verification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contributor_id uuid NOT NULL REFERENCES public.contributors ON DELETE RESTRICT,
  hazard_id uuid NOT NULL,
  client_event_id uuid NOT NULL,
  payload_hash text NOT NULL CHECK (length(btrim(payload_hash)) > 0),
  data_mode text NOT NULL CHECK (data_mode IN ('demo','pilot')),
  result text NOT NULL CHECK (result IN ('still_present','cleared')),
  position extensions.geography(Point,4326) NOT NULL,
  accuracy_m numeric CHECK (accuracy_m >= 0 AND accuracy_m < 'Infinity'::numeric),
  observed_at_raw timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  eligibility text NOT NULL DEFAULT 'needs_review' CHECK (eligibility IN ('eligible','ineligible','needs_review')),
  ineligibility_reason text,
  UNIQUE (contributor_id,client_event_id),
  FOREIGN KEY (hazard_id,data_mode) REFERENCES public.hazards(hazard_id,data_mode) ON DELETE RESTRICT
);

CREATE TABLE public.report_photos (
  report_id uuid NOT NULL REFERENCES public.reports ON DELETE RESTRICT,
  photo_no integer NOT NULL CHECK (photo_no > 0),
  storage_key text NOT NULL,
  mime_type text NOT NULL,
  captured_at timestamptz,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  moderation_status text NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending','approved','rejected')),
  caption text,
  PRIMARY KEY (report_id,photo_no)
);

CREATE TABLE public.score_snapshots (
  hazard_id uuid NOT NULL REFERENCES public.hazards ON DELETE RESTRICT,
  calculation_no bigint NOT NULL CHECK (calculation_no > 0),
  score numeric(5,2) NOT NULL CHECK (score >= 0 AND score <= 100),
  score_version text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  evidence_cutoff_at timestamptz NOT NULL,
  input_summary jsonb NOT NULL,
  PRIMARY KEY (hazard_id,calculation_no)
);

CREATE TABLE public.hazard_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hazard_id uuid NOT NULL REFERENCES public.hazards ON DELETE RESTRICT,
  actor_id uuid REFERENCES public.contributors ON DELETE RESTRICT,
  actor_kind text NOT NULL CHECK (actor_kind IN ('contributor','system')),
  event_type text NOT NULL CHECK (event_type IN ('created','status_changed','rejected')),
  from_status text CHECK (from_status IN ('pending','active','resolved','expired','rejected')),
  to_status text NOT NULL CHECK (to_status IN ('pending','active','resolved','expired','rejected')),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  score_calculation_no bigint,
  FOREIGN KEY (hazard_id,score_calculation_no) REFERENCES public.score_snapshots ON DELETE RESTRICT,
  CHECK ((actor_kind='system' AND actor_id IS NULL) OR (actor_kind='contributor' AND actor_id IS NOT NULL)),
  CHECK ((event_type='created' AND from_status IS NULL) OR (event_type<>'created' AND from_status IS NOT NULL)),
  CHECK (event_type<>'rejected' OR to_status='rejected')
);

CREATE TABLE public.landmarks (
  landmark_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_mode text NOT NULL CHECK (data_mode IN ('demo','pilot')),
  name_vi text NOT NULL,
  description_vi text,
  location extensions.geography(Point,4326) NOT NULL,
  reviewed_at timestamptz,
  review_note text,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (landmark_id,data_mode)
);

CREATE TABLE public.turn_cues (
  cue_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landmark_id uuid NOT NULL,
  data_mode text NOT NULL CHECK (data_mode IN ('demo','pilot')),
  turn_location extensions.geography(Point,4326) NOT NULL,
  approach_bearing numeric CHECK (approach_bearing >= 0 AND approach_bearing < 360),
  exit_bearing numeric CHECK (exit_bearing >= 0 AND exit_bearing < 360),
  bearing_tolerance_deg numeric CHECK (bearing_tolerance_deg > 0 AND bearing_tolerance_deg <= 180),
  instruction_vi text NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  reviewed_at timestamptz,
  UNIQUE (cue_id,landmark_id),
  FOREIGN KEY (landmark_id,data_mode) REFERENCES public.landmarks(landmark_id,data_mode) ON DELETE RESTRICT
);

CREATE TABLE public.landmark_images (
  image_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_mode text NOT NULL CHECK (data_mode IN ('demo','pilot')),
  image_source text NOT NULL CHECK (image_source IN ('mapillary','team_seed')),
  captured_at timestamptz,
  position extensions.geography(Point,4326),
  compass_angle numeric CHECK (compass_angle >= 0 AND compass_angle < 360),
  attribution text NOT NULL,
  usage_status text NOT NULL DEFAULT 'pending_review' CHECK (usage_status IN ('pending_review','approved','rejected')),
  offline_allowed boolean NOT NULL DEFAULT false,
  reviewed_at timestamptz,
  metadata_fetched_at timestamptz,
  mapillary_image_id text,
  source_url text,
  creator_ref text,
  storage_key text,
  photographer_credit text,
  UNIQUE (image_id,data_mode),
  CONSTRAINT image_subtype CHECK (
    (image_source='mapillary' AND mapillary_image_id IS NOT NULL AND length(btrim(mapillary_image_id)) > 0
      AND storage_key IS NULL AND photographer_credit IS NULL)
    OR (image_source='team_seed' AND storage_key IS NOT NULL AND length(btrim(storage_key)) > 0
      AND photographer_credit IS NOT NULL AND length(btrim(photographer_credit)) > 0
      AND mapillary_image_id IS NULL AND source_url IS NULL AND creator_ref IS NULL)
  )
);

CREATE TABLE public.landmark_image_links (
  landmark_id uuid NOT NULL,
  image_id uuid NOT NULL,
  -- Supporting column for database-enforced mode consistency (C07).
  data_mode text NOT NULL CHECK (data_mode IN ('demo','pilot')),
  PRIMARY KEY (landmark_id,image_id),
  FOREIGN KEY (landmark_id,data_mode) REFERENCES public.landmarks(landmark_id,data_mode) ON DELETE RESTRICT,
  FOREIGN KEY (image_id,data_mode) REFERENCES public.landmark_images(image_id,data_mode) ON DELETE RESTRICT
);

CREATE TABLE public.cue_images (
  cue_id uuid NOT NULL,
  image_id uuid NOT NULL,
  landmark_id uuid NOT NULL,
  display_order integer NOT NULL CHECK (display_order > 0),
  PRIMARY KEY (cue_id,image_id),
  UNIQUE (cue_id,display_order),
  FOREIGN KEY (cue_id,landmark_id) REFERENCES public.turn_cues(cue_id,landmark_id) ON DELETE RESTRICT,
  FOREIGN KEY (landmark_id,image_id) REFERENCES public.landmark_image_links(landmark_id,image_id) ON DELETE RESTRICT
);

CREATE INDEX hazards_location_gist ON public.hazards USING gist(location);
CREATE INDEX hazards_mode_status_expiry ON public.hazards(data_mode,status,expires_at);
CREATE INDEX hazards_previous ON public.hazards(previous_hazard_id);
CREATE INDEX reports_hazard_observed ON public.reports(hazard_id,observed_at DESC);
CREATE INDEX reports_position_gist ON public.reports USING gist(position);
CREATE UNIQUE INDEX reports_seed_key ON public.reports(data_mode,source_ref,source_record_key) WHERE source='seed';
CREATE INDEX verifications_latest ON public.verifications(hazard_id,contributor_id,observed_at DESC,received_at DESC,verification_id DESC);
CREATE INDEX hazard_events_history ON public.hazard_events(hazard_id,occurred_at DESC);
CREATE INDEX hazard_events_actor ON public.hazard_events(actor_id);
CREATE INDEX hazard_events_score ON public.hazard_events(hazard_id,score_calculation_no);
CREATE UNIQUE INDEX hazard_events_creation ON public.hazard_events(hazard_id) WHERE event_type='created';
CREATE INDEX landmarks_location_gist ON public.landmarks USING gist(location);
CREATE INDEX turn_cues_location_gist ON public.turn_cues USING gist(turn_location);
CREATE INDEX turn_cues_landmark ON public.turn_cues(landmark_id);
CREATE UNIQUE INDEX landmark_images_mapillary ON public.landmark_images(mapillary_image_id) WHERE mapillary_image_id IS NOT NULL;
CREATE UNIQUE INDEX landmark_images_storage ON public.landmark_images(storage_key) WHERE storage_key IS NOT NULL;
CREATE INDEX landmark_image_links_reverse ON public.landmark_image_links(image_id,landmark_id);
CREATE INDEX cue_images_landmark_image ON public.cue_images(landmark_id,image_id);
CREATE INDEX cue_images_image ON public.cue_images(image_id);

-- Parent writes serialize removal/movement of the last child, including under
-- REPEATABLE READ (which aborts a stale concurrent writer). A read-only count
-- inside a deferred trigger alone would allow write skew.
CREATE FUNCTION public.streeteye_lock_hazard_evidence() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
DECLARE target uuid;
BEGIN
  FOR target IN SELECT DISTINCT x FROM unnest(ARRAY[
    (to_jsonb(OLD)->>'hazard_id')::uuid, (to_jsonb(NEW)->>'hazard_id')::uuid]) x WHERE x IS NOT NULL ORDER BY x
  LOOP
    UPDATE public.hazards SET row_version=row_version WHERE hazard_id=target;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reports_lock_parent BEFORE INSERT OR UPDATE OR DELETE ON public.reports
FOR EACH ROW EXECUTE FUNCTION public.streeteye_lock_hazard_evidence();
CREATE TRIGGER events_lock_parent BEFORE INSERT OR UPDATE OR DELETE ON public.hazard_events
FOR EACH ROW EXECUTE FUNCTION public.streeteye_lock_hazard_evidence();

CREATE FUNCTION public.streeteye_require_hazard_evidence() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
DECLARE target uuid;
BEGIN
  FOR target IN SELECT DISTINCT x FROM unnest(ARRAY[
    (to_jsonb(OLD)->>'hazard_id')::uuid, (to_jsonb(NEW)->>'hazard_id')::uuid]) x WHERE x IS NOT NULL
  LOOP
    IF EXISTS (SELECT 1 FROM public.hazards WHERE hazard_id=target) AND (
      NOT EXISTS (SELECT 1 FROM public.reports WHERE hazard_id=target) OR
      NOT EXISTS (SELECT 1 FROM public.hazard_events WHERE hazard_id=target AND event_type='created')) THEN
      RAISE EXCEPTION 'Hazard requires a source report and creation event' USING ERRCODE='23514', CONSTRAINT='hazard_requires_evidence';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER hazard_requires_evidence AFTER INSERT OR UPDATE ON public.hazards
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.streeteye_require_hazard_evidence();
CREATE CONSTRAINT TRIGGER report_preserves_evidence AFTER UPDATE OR DELETE ON public.reports
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.streeteye_require_hazard_evidence();
CREATE CONSTRAINT TRIGGER event_preserves_evidence AFTER UPDATE OR DELETE ON public.hazard_events
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.streeteye_require_hazard_evidence();

CREATE FUNCTION public.streeteye_lock_image_links() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
DECLARE target uuid;
BEGIN
  FOR target IN SELECT DISTINCT x FROM unnest(ARRAY[
    (to_jsonb(OLD)->>'image_id')::uuid, (to_jsonb(NEW)->>'image_id')::uuid]) x WHERE x IS NOT NULL ORDER BY x
  LOOP
    UPDATE public.landmark_images SET offline_allowed=offline_allowed WHERE image_id=target;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER links_lock_parent BEFORE INSERT OR UPDATE OR DELETE ON public.landmark_image_links
FOR EACH ROW EXECUTE FUNCTION public.streeteye_lock_image_links();

CREATE FUNCTION public.streeteye_require_image_link() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
DECLARE target uuid;
BEGIN
  FOR target IN SELECT DISTINCT x FROM unnest(ARRAY[
    (to_jsonb(OLD)->>'image_id')::uuid, (to_jsonb(NEW)->>'image_id')::uuid]) x WHERE x IS NOT NULL
  LOOP
    IF EXISTS (SELECT 1 FROM public.landmark_images WHERE image_id=target)
      AND NOT EXISTS (SELECT 1 FROM public.landmark_image_links WHERE image_id=target) THEN
      RAISE EXCEPTION 'Catalog image requires a landmark link' USING ERRCODE='23514', CONSTRAINT='image_requires_landmark';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER image_requires_landmark AFTER INSERT OR UPDATE ON public.landmark_images
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.streeteye_require_image_link();
CREATE CONSTRAINT TRIGGER link_preserves_landmark AFTER UPDATE OR DELETE ON public.landmark_image_links
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.streeteye_require_image_link();

-- Internal serialization row; not an application entity. Concurrent graph
-- rewrites cannot each validate against an outdated predecessor graph.
CREATE TABLE streeteye_meta.integrity_locks (name text PRIMARY KEY, revision bigint NOT NULL DEFAULT 0);
INSERT INTO streeteye_meta.integrity_locks(name) VALUES ('hazard_predecessor');
CREATE FUNCTION public.streeteye_lock_predecessor() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
BEGIN
  IF (TG_OP='INSERT' AND NEW.previous_hazard_id IS NOT NULL)
    OR (TG_OP='UPDATE' AND NEW.previous_hazard_id IS DISTINCT FROM OLD.previous_hazard_id) THEN
    UPDATE streeteye_meta.integrity_locks SET revision=revision+1 WHERE name='hazard_predecessor';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hazard_lock_predecessor BEFORE INSERT OR UPDATE OF previous_hazard_id ON public.hazards
FOR EACH ROW EXECUTE FUNCTION public.streeteye_lock_predecessor();
CREATE FUNCTION public.streeteye_check_predecessor() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE ancestors(id) AS (
      SELECT previous_hazard_id FROM public.hazards WHERE hazard_id=NEW.hazard_id
      UNION
      SELECT h.previous_hazard_id FROM public.hazards h JOIN ancestors a ON h.hazard_id=a.id
    ) SELECT 1 FROM ancestors WHERE id=NEW.hazard_id
  ) THEN
    RAISE EXCEPTION 'Hazard predecessor cycle' USING ERRCODE='23514', CONSTRAINT='hazard_predecessor_acyclic';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER hazard_predecessor_acyclic AFTER INSERT OR UPDATE OF previous_hazard_id ON public.hazards
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.streeteye_check_predecessor();

CREATE FUNCTION public.streeteye_append_only() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'History is append-only; retention requires a separate reviewed migration' USING ERRCODE='55000';
END $$;
CREATE TRIGGER verification_append_only BEFORE UPDATE OR DELETE ON public.verifications
FOR EACH ROW EXECUTE FUNCTION public.streeteye_append_only();
CREATE TRIGGER snapshot_append_only BEFORE UPDATE OR DELETE ON public.score_snapshots
FOR EACH ROW EXECUTE FUNCTION public.streeteye_append_only();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON public.hazard_events
FOR EACH ROW EXECUTE FUNCTION public.streeteye_append_only();

CREATE VIEW public.latest_effective_verification WITH (security_invoker=true) AS
SELECT DISTINCT ON (hazard_id,contributor_id) * FROM public.verifications
WHERE eligibility='eligible'
ORDER BY hazard_id,contributor_id,observed_at DESC,received_at DESC,verification_id DESC;

CREATE VIEW public.latest_hazard_score WITH (security_invoker=true) AS
SELECT h.hazard_id,s.calculation_no,s.score,s.score_version,s.computed_at,s.evidence_cutoff_at,s.input_summary
FROM public.hazards h LEFT JOIN LATERAL (
  SELECT * FROM public.score_snapshots s WHERE s.hazard_id=h.hazard_id ORDER BY calculation_no DESC LIMIT 1
) s ON true;

-- Internal query views: API must still bind/filter data_mode and project DTOs.
CREATE VIEW public.public_hazards WITH (security_invoker=true) AS
SELECT h.*,s.score AS confidence_score,s.score_version,s.computed_at,(h.status='pending') AS is_unverified
FROM public.hazards h JOIN public.latest_hazard_score s USING (hazard_id)
WHERE h.status IN ('pending','active') AND h.expires_at > now();

CREATE VIEW public.eligible_turn_cues WITH (security_invoker=true) AS
SELECT c.*,l.name_vi,COALESCE(img.images,'[]'::jsonb) AS images
FROM public.turn_cues c JOIN public.landmarks l ON l.landmark_id=c.landmark_id
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('image_id',i.image_id,'display_order',ci.display_order,
    'image_source',i.image_source,'attribution',i.attribution,'offline_allowed',i.offline_allowed)
    ORDER BY ci.display_order) AS images
  FROM public.cue_images ci JOIN public.landmark_images i ON i.image_id=ci.image_id
  WHERE ci.cue_id=c.cue_id AND i.usage_status='approved'
) img ON true
WHERE c.is_active AND l.is_active AND c.approach_bearing IS NOT NULL
  AND c.exit_bearing IS NOT NULL AND c.bearing_tolerance_deg IS NOT NULL;

-- Access goes through Express. No direct Data API access, including views/RPCs.
-- Scope revokes to StreetEye objects; leave other Supabase/default objects alone.
DO $$
DECLARE obj text; principal text;
BEGIN
  FOREACH obj IN ARRAY ARRAY['contributors','hazards','reports','verifications','report_photos','score_snapshots',
    'hazard_events','landmarks','turn_cues','landmark_images','landmark_image_links','cue_images'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',obj);
  END LOOP;
  FOREACH principal IN ARRAY ARRAY['PUBLIC','anon','authenticated','service_role'] LOOP
    IF principal='PUBLIC' OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname=principal) THEN
      FOREACH obj IN ARRAY ARRAY['contributors','hazards','reports','verifications','report_photos','score_snapshots',
        'hazard_events','landmarks','turn_cues','landmark_images','landmark_image_links','cue_images',
        'latest_effective_verification','latest_hazard_score','public_hazards','eligible_turn_cues'] LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %s',obj,
          CASE WHEN principal='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(principal) END);
      END LOOP;
      FOREACH obj IN ARRAY ARRAY['streeteye_lock_hazard_evidence','streeteye_require_hazard_evidence',
        'streeteye_lock_image_links','streeteye_require_image_link','streeteye_lock_predecessor',
        'streeteye_check_predecessor','streeteye_append_only'] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM %s',obj,
          CASE WHEN principal='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(principal) END);
      END LOOP;
      EXECUTE format('REVOKE ALL ON SCHEMA streeteye_meta FROM %s',
        CASE WHEN principal='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(principal) END);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA streeteye_meta FROM %s',
        CASE WHEN principal='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(principal) END);
    END IF;
  END LOOP;
END $$;
