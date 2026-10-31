CREATE TRIGGER memory_media_insert BEFORE INSERT ON memories BEGIN
 SELECT RAISE(ABORT,'EVERLEAF_MEDIA_CHANGED') WHERE EXISTS(
  SELECT 1 FROM json_each(NEW.media_ids) requested WHERE NOT EXISTS(
   SELECT 1 FROM media WHERE id=requested.value AND memorial_id=NEW.memorial_id
  )
 );
END;
--> statement-breakpoint
CREATE TRIGGER memory_media_update BEFORE UPDATE OF media_ids ON memories BEGIN
 SELECT RAISE(ABORT,'EVERLEAF_MEDIA_CHANGED') WHERE EXISTS(
  SELECT 1 FROM json_each(NEW.media_ids) requested WHERE NOT EXISTS(
   SELECT 1 FROM media WHERE id=requested.value AND memorial_id=NEW.memorial_id
  )
 );
END;
--> statement-breakpoint
CREATE TRIGGER media_delete_guard BEFORE DELETE ON media
WHEN EXISTS(SELECT 1 FROM memorials WHERE id=OLD.memorial_id) BEGIN
 SELECT RAISE(ABORT,'EVERLEAF_MEDIA_CHANGED') WHERE EXISTS(
  SELECT 1 FROM memories,json_each(memories.media_ids) attached
  WHERE memories.memorial_id=OLD.memorial_id AND attached.value=OLD.id
 );
END;
--> statement-breakpoint
CREATE TRIGGER portrait_update_guard BEFORE UPDATE OF portrait_id,status ON memorials BEGIN
 SELECT RAISE(ABORT,'EVERLEAF_MEDIA_CHANGED') WHERE
  (NEW.status='published' AND NEW.portrait_id IS NULL) OR
  (NEW.portrait_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM media WHERE id=NEW.portrait_id AND memorial_id=NEW.id AND purpose='portrait'
  ));
END;
