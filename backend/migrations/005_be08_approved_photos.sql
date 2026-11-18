ALTER TABLE streeteye_private.photo_bytes ADD COLUMN link_secret uuid NOT NULL DEFAULT gen_random_uuid();
-- Same UTC expiry bucket for all readers. Private random key is unique per image.
CREATE FUNCTION streeteye_private.photo_link_key(secret uuid, until_epoch bigint) RETURNS text
 LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
 SELECT encode(sha256(convert_to(secret::text||':'||until_epoch::text,'UTF8')),'hex')
$$;
CREATE FUNCTION streeteye_private.approved_photos(hid uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(item ORDER BY ord DESC,rid,n),'[]'::jsonb) FROM (
 SELECT p.uploaded_at ord,r.report_id rid,p.photo_no n,jsonb_build_object(
 'report_id',r.report_id,'photo_no',p.photo_no,'mime_type',p.mime_type,
 'uploaded_at',to_char(p.uploaded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'captured_at',to_char(p.captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'caption',p.caption,'moderation_status','approved','url_expires_at',to_char(to_timestamp(e) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'url','/api/v1/evidence/'||r.report_id||'/'||p.photo_no||'?expires='||e||'&key='||streeteye_private.photo_link_key(b.link_secret,e)) item
 FROM public.reports r JOIN public.hazards h USING(hazard_id) JOIN public.report_photos p USING(report_id)
 JOIN streeteye_private.photo_bytes b USING(report_id,photo_no)
 CROSS JOIN (SELECT (floor(extract(epoch FROM now())/900)::bigint+1)*900 e) expiry
 WHERE r.hazard_id=hid AND h.status<>'rejected' AND p.moderation_status='approved'
 ORDER BY p.uploaded_at DESC,r.report_id,p.photo_no LIMIT 20
 ) items
$$;
CREATE FUNCTION streeteye_private.public_photo(rid uuid,n integer,m text,e bigint,k text)
 RETURNS TABLE(mime text,content bytea) LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT p.mime_type,b.content FROM public.reports r JOIN public.hazards h USING(hazard_id)
 JOIN public.report_photos p USING(report_id) JOIN streeteye_private.photo_bytes b USING(report_id,photo_no)
 WHERE r.report_id=rid AND p.photo_no=n AND h.data_mode=m AND h.status<>'rejected' AND p.moderation_status='approved'
 AND e>extract(epoch FROM now()) AND e<=extract(epoch FROM now())+900 AND k=streeteye_private.photo_link_key(b.link_secret,e)
$$;
REVOKE ALL ON FUNCTION streeteye_private.approved_photos(uuid),streeteye_private.photo_link_key(uuid,bigint),
 streeteye_private.public_photo(uuid,integer,text,bigint,text) FROM PUBLIC,anon,authenticated,service_role,streeteye_backend;
GRANT EXECUTE ON FUNCTION streeteye_private.approved_photos(uuid),streeteye_private.public_photo(uuid,integer,text,bigint,text) TO streeteye_backend;
