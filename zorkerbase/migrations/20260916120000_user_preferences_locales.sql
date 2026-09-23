-- Widen the interface language from the original zh-CN/en-US pair to the full
-- product locale set (Simplified/Traditional Chinese, English US/Singapore,
-- German, French, Japanese, Korean, Russian).
alter table openlink.user_preferences
  drop constraint if exists user_preferences_locale_check;

alter table openlink.user_preferences
  add constraint user_preferences_locale_check
  check (locale in ('zh-CN', 'zh-TW', 'en-US', 'en-SG', 'de-DE', 'fr-FR', 'ja-JP', 'ko-KR', 'ru-RU'));
