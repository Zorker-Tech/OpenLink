import assert from "node:assert/strict"
import { test } from "node:test"

import {
  DEFAULT_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS,
  MAX_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS,
  MIN_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS,
} from "../../source/packages/constants/environment-setup.ts"

test("environment resumes stay within the one-hour to thirty-day window", () => {
  assert.equal(MIN_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS, 60 * 60 * 1_000)
  assert.equal(DEFAULT_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS, 7 * 24 * 60 * 60 * 1_000)
  assert.equal(MAX_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS, 30 * 24 * 60 * 60 * 1_000)
  assert.ok(MIN_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS < DEFAULT_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS)
  assert.ok(DEFAULT_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS < MAX_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS)
})
