CREATE TABLE streeteye_private.event_receipts (
 actor uuid NOT NULL REFERENCES public.contributors, kind text NOT NULL, event uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 fingerprint text NOT NULL, observation jsonb NOT NULL, receipt jsonb NOT NULL,
 PRIMARY KEY(actor,kind,event)
);
CREATE INDEX event_receipts_actor_time ON streeteye_private.event_receipts(actor,created_at);
CREATE TABLE streeteye_private.photo_bytes (
 report_id uuid NOT NULL, photo_no integer NOT NULL, upload_id uuid NOT NULL, original_hash text NOT NULL, content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 2097152),
 PRIMARY KEY(report_id,photo_no), UNIQUE(report_id,upload_id),
 FOREIGN KEY(report_id,photo_no) REFERENCES public.report_photos
);
CREATE FUNCTION streeteye_private.evidence_ttl(t text) RETURNS interval LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE t WHEN 'flood' THEN interval '6 hours' WHEN 'roadwork' THEN interval '3 days' WHEN 'pothole' THEN interval '7 days' ELSE interval '1 day' END
$$;
CREATE FUNCTION streeteye_private.recalculate(hid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h public.hazards; ttl interval; t timestamptz:=clock_timestamp(); positives int; negatives int; newer int;
 support float8; opposition float8; points numeric; target text; n bigint; prior numeric; disputed boolean;
BEGIN
 SELECT * INTO STRICT h FROM public.hazards WHERE hazard_id=hid FOR UPDATE;
 IF h.status NOT IN ('active','pending') THEN RETURN; END IF;
 ttl:=streeteye_private.evidence_ttl(h.hazard_type);
 WITH evidence AS (
 SELECT contributor_id,observed_at,received_at,report_id id,true present,accuracy_m FROM public.reports
 WHERE hazard_id=hid AND eligibility='eligible' AND source<>'seed'
 UNION ALL SELECT contributor_id,observed_at,received_at,verification_id,result='still_present',accuracy_m
 FROM public.verifications WHERE hazard_id=hid AND eligibility='eligible'
 ), latest AS (
 SELECT DISTINCT ON(contributor_id) * FROM evidence WHERE observed_at>t-ttl
 ORDER BY contributor_id,observed_at DESC,received_at DESC,id DESC
 ), weighted AS (
 SELECT *, power(0.5,2*extract(epoch FROM t-observed_at)/extract(epoch FROM ttl))*(1-0.25*accuracy_m/30) w FROM latest
 )
 SELECT count(*) FILTER(WHERE present), count(*) FILTER(WHERE NOT present),
 count(*) FILTER(WHERE NOT present AND observed_at>h.last_observed_at),
 coalesce(sum(w) FILTER(WHERE present),0), coalesce(sum(w) FILTER(WHERE NOT present),0)
 INTO positives,negatives,newer,support,opposition FROM weighted;
 points:=round(greatest(0,least(100,40*support-30*opposition))::numeric,2);
 disputed:=negatives>0 AND h.expires_at>t;
 target:=CASE WHEN h.expires_at<=t THEN 'expired'
 WHEN newer>=2 AND opposition>=1.4 AND points<=25 THEN 'resolved'
 WHEN positives>=2 AND points>=CASE WHEN h.status='active' THEN 45 ELSE 60 END THEN 'active' ELSE 'pending' END;
 SELECT calculation_no,score INTO n,prior FROM public.score_snapshots WHERE hazard_id=hid ORDER BY calculation_no DESC LIMIT 1;
 IF prior IS NOT DISTINCT FROM points AND target=h.status AND disputed=h.is_disputed THEN RETURN; END IF;
 n:=coalesce(n,0)+1;
 INSERT INTO public.score_snapshots VALUES(hid,n,points,'exp-v1',t,t,jsonb_build_object('present',positives,'cleared',negatives,'newer_cleared',newer));
 UPDATE public.hazards SET status=target,is_disputed=disputed,updated_at=t,row_version=row_version+1 WHERE hazard_id=hid;
 IF target<>h.status THEN
 INSERT INTO public.hazard_events(hazard_id,actor_kind,event_type,from_status,to_status,reason,score_calculation_no)
 VALUES(hid,'system','status_changed',h.status,target,'exp-v1',n);
 END IF;
END $$;
CREATE FUNCTION streeteye_private.submit_event(actor uuid,kind text,hid uuid,p jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE eid uuid:=(p->>'client_event_id')::uuid; v_mode text:=p->>'data_mode'; old streeteye_private.event_receipts;
 raw_time timestamptz:=(p->>'observed_at')::timestamptz; t timestamptz; obs timestamptz; ttl interval;
 acc float8:=(p->>'accuracy_m')::float8; heading float8:=(p->>'heading_deg')::float8;
 pt extensions.geography:=extensions.st_setsrid(extensions.st_makepoint((p#>>'{position,longitude}')::float8,(p#>>'{position,latitude}')::float8),4326)::extensions.geography;
 typ text:=p->>'hazard_type'; why text; elig text; h public.hazards; candidates uuid[]; rid uuid:=gen_random_uuid(); ack jsonb; effective boolean:=false;
BEGIN
 IF NOT EXISTS(SELECT FROM public.contributors WHERE contributor_id=actor AND disabled_at IS NULL FOR SHARE) THEN RAISE EXCEPTION USING ERRCODE='SE403'; END IF;
 -- Serialize pilot-volume writes per mode, including the gap before a matching hazard exists.
 PERFORM pg_advisory_xact_lock(19370008,hashtext(v_mode));
 PERFORM pg_advisory_xact_lock(hashtext(actor::text),hashtext(kind||eid::text));
 SELECT * INTO old FROM streeteye_private.event_receipts r WHERE r.actor=submit_event.actor AND r.kind=submit_event.kind AND event=eid;
 IF FOUND THEN
 IF old.fingerprint<>fingerprint THEN RAISE EXCEPTION USING ERRCODE='SE409'; END IF;
 RETURN jsonb_build_object('replay',true,'body',old.receipt);
 END IF;
 IF (SELECT count(*) FROM streeteye_private.event_receipts r WHERE r.actor=submit_event.actor AND created_at>clock_timestamp()-interval '1 minute')>=30 THEN RAISE EXCEPTION USING ERRCODE='SE429'; END IF;
 t:=date_trunc('milliseconds',clock_timestamp()); obs:=least(t,raw_time);
 IF raw_time>t+interval '5 minutes' OR (p->>'confirmed_at')::timestamptz>t+interval '5 minutes' THEN RAISE EXCEPTION USING ERRCODE='SE422'; END IF;
 IF NOT EXISTS(SELECT FROM streeteye_private.seed_regions r WHERE r.mode=v_mode AND extensions.st_covers(r.boundary,pt::extensions.geometry)) THEN RAISE EXCEPTION USING ERRCODE='SE423'; END IF;
 IF kind='verification' THEN
 SELECT * INTO h FROM public.hazards WHERE hazard_id=hid AND data_mode=v_mode AND status<>'rejected' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='SE404'; END IF;
 typ:=h.hazard_type;
 END IF;
 ttl:=streeteye_private.evidence_ttl(typ);
 why:=CASE WHEN kind='verification' AND (h.status NOT IN ('active','pending') OR h.expires_at<=t) THEN 'HAZARD_CLOSED'
 WHEN obs<=t-ttl THEN 'STALE_OBSERVATION' WHEN acc IS NULL THEN 'MISSING_ACCURACY' WHEN acc>30 THEN 'LOW_LOCATION_ACCURACY'
 WHEN kind='verification' AND NOT extensions.st_dwithin(pt,h.location,30+acc) THEN 'TOO_FAR' END;
 IF kind='report' AND why IS NULL THEN
 SELECT array_agg(hazard_id) INTO candidates FROM public.hazards WHERE data_mode=v_mode AND status IN ('pending','active')
 AND expires_at>t AND hazard_type=typ AND extensions.st_dwithin(location,pt,20);
 IF candidates IS NULL THEN
 hid:=gen_random_uuid();
 INSERT INTO public.hazards(hazard_id,data_mode,hazard_type,severity,location,direction_bearing,last_observed_at,expires_at)
 VALUES(hid,v_mode,typ,p->>'severity',pt,heading,obs,obs+ttl);
 INSERT INTO public.hazard_events(hazard_id,actor_id,actor_kind,event_type,to_status,reason) VALUES(hid,actor,'contributor','created','pending','Eligible observation');
 ELSIF cardinality(candidates)=1 THEN
 SELECT * INTO h FROM public.hazards WHERE hazard_id=candidates[1] FOR UPDATE;
 IF h.status IN ('pending','active') AND typ<>'unknown' AND obs BETWEEN h.last_observed_at-ttl AND h.last_observed_at+ttl AND heading IS NOT NULL AND h.direction_bearing IS NOT NULL
 AND least(abs(heading-h.direction_bearing),360-abs(heading-h.direction_bearing))<=25 THEN hid:=h.hazard_id;
 ELSE why:='NEEDS_REVIEW'; END IF;
 ELSE why:='NEEDS_REVIEW'; END IF;
 END IF;
 elig:=CASE WHEN why IS NULL THEN 'eligible' WHEN why IN ('MISSING_ACCURACY','NEEDS_REVIEW') THEN 'needs_review' ELSE 'ineligible' END;
 ack:=jsonb_build_object('client_event_id',eid,'data_mode',v_mode,'accepted',true,'eligibility',elig,'reason_codes',CASE WHEN why IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(why) END,
 'observed_at_raw',raw_time,'observed_at',obs,'received_at',t,'hazard_id',hid);
 IF kind='report' THEN
 INSERT INTO public.reports(report_id,contributor_id,hazard_id,client_event_id,payload_hash,data_mode,source,hazard_type,severity,position,accuracy_m,heading_deg,observed_at_raw,observed_at,received_at,eligibility,ineligibility_reason,classification_method,confirmed_at,peak_accel_g,speed_kmh)
 VALUES(rid,actor,hid,eid,fingerprint,v_mode,p->>'source',typ,p->>'severity',pt,acc,heading,raw_time,obs,t,elig,why,p->>'classification_method',(p->>'confirmed_at')::timestamptz,(p->>'peak_accel_g')::numeric,(p->>'speed_kmh')::numeric);
 ack:=ack||jsonb_build_object('report_id',rid,'source',p->>'source','eligible_for_alert',why IS NULL);
 ELSIF kind='verification' THEN
 INSERT INTO public.verifications(verification_id,contributor_id,hazard_id,client_event_id,payload_hash,data_mode,result,position,accuracy_m,observed_at_raw,observed_at,received_at,eligibility,ineligibility_reason)
 VALUES(rid,actor,hid,eid,fingerprint,v_mode,p->>'result',pt,acc,raw_time,obs,t,elig,why);
 SELECT EXISTS(SELECT FROM public.latest_effective_verification WHERE verification_id=rid) INTO effective;
 ack:=ack||jsonb_build_object('verification_id',rid,'result',p->>'result','eligible_for_score',why IS NULL,'effective_at_receipt',effective);
 ELSE RAISE EXCEPTION 'Invalid event kind'; END IF;
 IF why IS NULL THEN
 IF kind='report' OR p->>'result'='still_present' THEN
 UPDATE public.hazards SET last_observed_at=greatest(last_observed_at,obs),expires_at=greatest(expires_at,obs+ttl),updated_at=t,row_version=row_version+1 WHERE hazard_id=hid;
 END IF;
 PERFORM streeteye_private.recalculate(hid);
 END IF;
 INSERT INTO streeteye_private.event_receipts(actor,kind,event,fingerprint,observation,receipt) VALUES(actor,kind,eid,fingerprint,p,ack);
 RETURN jsonb_build_object('replay',false,'body',ack);
END $$;
CREATE FUNCTION streeteye_private.own_report(a uuid,r uuid,m text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('receipt',e.receipt,'observation',e.observation,'photos',coalesce((
 SELECT jsonb_agg(jsonb_build_object('photo_no',photo_no,'mime_type',mime_type,'captured_at',captured_at,'uploaded_at',uploaded_at,
 'caption',caption,'moderation_status',moderation_status,'url','/api/v1/reports/'||r||'/photos/'||photo_no,'url_expires_at',NULL) ORDER BY photo_no)
 FROM public.report_photos WHERE report_id=r),'[]'::jsonb))
 FROM public.reports p JOIN streeteye_private.event_receipts e ON e.actor=p.contributor_id AND e.kind='report' AND e.event=p.client_event_id
 WHERE p.report_id=r AND p.contributor_id=a AND p.data_mode=m
$$;
CREATE FUNCTION streeteye_private.put_photo(a uuid,r uuid,m text,k uuid,mime text,original_hash text,bytes bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE prior streeteye_private.photo_bytes; n int;
BEGIN
 IF NOT EXISTS(SELECT FROM public.contributors WHERE contributor_id=a AND disabled_at IS NULL FOR SHARE) THEN RAISE EXCEPTION USING ERRCODE='SE403'; END IF;
 PERFORM 1 FROM public.reports WHERE report_id=r AND contributor_id=a AND data_mode=m FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='SE404'; END IF;
 SELECT * INTO prior FROM streeteye_private.photo_bytes WHERE report_id=r AND upload_id=k;
 IF FOUND THEN
 IF prior.original_hash<>put_photo.original_hash OR NOT EXISTS(SELECT FROM public.report_photos WHERE report_id=r AND photo_no=prior.photo_no AND mime_type=mime) THEN RAISE EXCEPTION USING ERRCODE='SE409'; END IF;
 RETURN jsonb_build_object('photo_no',prior.photo_no,'replay',true);
 END IF;
 SELECT coalesce(max(photo_no),0)+1 INTO n FROM public.report_photos WHERE report_id=r;
 IF n>20 THEN RAISE EXCEPTION USING ERRCODE='SE413'; END IF;
 INSERT INTO public.report_photos(report_id,photo_no,mime_type,storage_key) VALUES(r,n,mime,'pg-private/'||r||'/'||n);
 INSERT INTO streeteye_private.photo_bytes VALUES(r,n,k,original_hash,bytes);
 RETURN jsonb_build_object('photo_no',n,'replay',false);
END $$;
CREATE FUNCTION streeteye_private.get_photo(a uuid,r uuid,m text,n int) RETURNS TABLE(mime text,content bytea)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT p.mime_type,b.content FROM public.reports x JOIN public.report_photos p USING(report_id) JOIN streeteye_private.photo_bytes b USING(report_id,photo_no)
 WHERE x.report_id=r AND x.contributor_id=a AND x.data_mode=m AND p.photo_no=n
$$;
CREATE TABLE streeteye_private.score_schedule(hazard_id uuid PRIMARY KEY REFERENCES public.hazards ON DELETE CASCADE,checked_at timestamptz NOT NULL);
CREATE FUNCTION streeteye_private.decay_batch() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE id uuid; n int:=0;
BEGIN
 IF NOT pg_try_advisory_xact_lock(19370009,1) THEN RETURN 0; END IF;
 FOR id IN SELECT h.hazard_id FROM public.hazards h LEFT JOIN streeteye_private.score_schedule s USING(hazard_id)
 WHERE h.status IN ('pending','active') AND (s.checked_at IS NULL OR s.checked_at<now()-interval '5 minutes')
 ORDER BY s.checked_at NULLS FIRST,h.hazard_id LIMIT 50 FOR UPDATE OF h SKIP LOCKED LOOP
 PERFORM streeteye_private.recalculate(id);
 INSERT INTO streeteye_private.score_schedule VALUES(id,now()) ON CONFLICT(hazard_id) DO UPDATE SET checked_at=excluded.checked_at;
 n:=n+1;
 END LOOP;
 RETURN n;
END $$;
REVOKE ALL ON streeteye_private.photo_bytes,streeteye_private.event_receipts,streeteye_private.score_schedule FROM PUBLIC,anon,authenticated,service_role,streeteye_backend;
REVOKE ALL ON FUNCTION streeteye_private.recalculate(uuid),streeteye_private.evidence_ttl(text),streeteye_private.decay_batch(),
 streeteye_private.own_report(uuid,uuid,text),streeteye_private.put_photo(uuid,uuid,text,uuid,text,text,bytea),
 streeteye_private.get_photo(uuid,uuid,text,integer),streeteye_private.submit_event(uuid,text,uuid,jsonb,text)
 FROM PUBLIC,anon,authenticated,service_role,streeteye_backend;
GRANT EXECUTE ON FUNCTION streeteye_private.decay_batch(),streeteye_private.own_report(uuid,uuid,text),
 streeteye_private.put_photo(uuid,uuid,text,uuid,text,text,bytea),streeteye_private.get_photo(uuid,uuid,text,integer),
 streeteye_private.submit_event(uuid,text,uuid,jsonb,text) TO streeteye_backend;
