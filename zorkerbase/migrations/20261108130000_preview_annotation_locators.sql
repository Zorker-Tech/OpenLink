alter table openlink.preview_annotations
  add column if not exists element_locator jsonb;

alter table openlink.preview_annotations
  drop constraint if exists preview_annotations_element_locator_check;

create or replace function openlink.preview_annotation_locator_is_valid(locator jsonb)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $function$
declare
  candidate jsonb;
  candidate_kind text;
  candidate_value text;
  identity text;
  seen text[] := array[]::text[];
begin
  if pg_catalog.jsonb_typeof(locator) <> 'object' then return false; end if;
  if locator - array['version', 'tagName', 'candidates'] <> '{}'::jsonb
    or locator->'version' is null
    or locator->'tagName' is null
    or locator->'candidates' is null
    or pg_catalog.jsonb_typeof(locator->'version') <> 'number'
    or locator->>'version' <> '1'
    or pg_catalog.jsonb_typeof(locator->'tagName') <> 'string'
    or locator->>'tagName' !~ '^[a-z][a-z0-9-]{0,63}$'
    or pg_catalog.jsonb_typeof(locator->'candidates') <> 'array' then
    return false;
  end if;
  if pg_catalog.jsonb_array_length(locator->'candidates') not between 1 and 5 then return false; end if;

  for candidate in select value from pg_catalog.jsonb_array_elements(locator->'candidates') as item(value) loop
    if pg_catalog.jsonb_typeof(candidate) <> 'object' then return false; end if;
    if candidate - array['kind', 'value'] <> '{}'::jsonb
      or candidate->'kind' is null
      or candidate->'value' is null
      or pg_catalog.jsonb_typeof(candidate->'kind') <> 'string'
      or pg_catalog.jsonb_typeof(candidate->'value') <> 'string' then
      return false;
    end if;

    candidate_kind := candidate->>'kind';
    candidate_value := candidate->>'value';
    if candidate_kind not in ('data-testid', 'data-test', 'data-cy', 'id', 'css')
      or pg_catalog.char_length(candidate_value) not between 1 and 1000
      or candidate_value ~ '[[:cntrl:]]' then
      return false;
    end if;

    identity := pg_catalog.jsonb_build_array(candidate->'kind', candidate->'value')::text;
    if identity = any(seen) then return false; end if;
    seen := pg_catalog.array_append(seen, identity);
  end loop;
  return true;
end
$function$;

alter table openlink.preview_annotations
  add constraint preview_annotations_element_locator_check check (
    element_locator is null
    or openlink.preview_annotation_locator_is_valid(element_locator)
  );

notify pgrst, 'reload schema';
