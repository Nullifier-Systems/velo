-- Migration: 033_add_user_locale_preferences.sql
-- Adds per-user locale and currency preferences to provider_profiles.
-- Both columns default to the current global defaults so existing rows
-- are unaffected and no back-fill is required.

ALTER TABLE provider_profiles
  ADD COLUMN IF NOT EXISTS preferred_locale   VARCHAR(10) NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS preferred_currency VARCHAR(5)  NOT NULL DEFAULT 'USD';

COMMENT ON COLUMN provider_profiles.preferred_locale   IS 'BCP-47 language tag chosen by the provider (e.g. en, es, fr, ar, pt).';
COMMENT ON COLUMN provider_profiles.preferred_currency IS 'ISO 4217 currency code used to format cash amounts (e.g. USD, EUR, ARS, BRL).';
