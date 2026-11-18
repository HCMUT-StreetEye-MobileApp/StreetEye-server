CREATE OR REPLACE FUNCTION streeteye_private.submit_event(actor uuid,kind text,hid uuid,p jsonb,fingerprint text)
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
 -- Reconnecting riders can report an observation from an already closed episode.
 -- Check even when a newer episode is open, before attaching any evidence to it.
 IF kind='report' AND why IS NULL AND EXISTS (
   SELECT FROM public.hazards prior
   WHERE prior.data_mode=v_mode AND prior.hazard_type=typ
     AND extensions.st_dwithin(prior.location,pt,20)
     AND (prior.direction_bearing IS NULL OR heading IS NULL OR
       least(abs(prior.direction_bearing-heading),360-abs(prior.direction_bearing-heading))<=25)
     AND ((prior.status='resolved' AND obs<=prior.updated_at)
       OR (prior.status IN ('expired','pending','active') AND prior.expires_at<=t AND obs<=prior.expires_at))
 ) THEN why:='NEEDS_REVIEW'; END IF;
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
