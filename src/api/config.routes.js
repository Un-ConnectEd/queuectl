import { Router } from 'express';
import { state } from '../worker/appState.js';
import { setConfig } from '../db/db.js';
import { allowOnlyLocalhost } from './middleware.js';

/**
 * A schema defining the type and rules for known config keys.
 * This allows for robust type checking and validation.
 */
const CONFIG_SCHEMA = {
  'max_retries':       { type: 'integer', min: 0, default: 10 },
  'backoff_base':      { type: 'integer', min: 1, default: 5 },
  'backoff_factor_ms': { type: 'integer', min: 0, default: 1000 },
  'tick_interval_ms':  { type: 'integer', min: 50, default: 250 }, // Min 50ms to prevent CPU spin
  'save_interval_ms':  { type: 'integer', min: 1000, default: 5000 } // Min 1s save interval
};

/**
 * Validates and sanitizes a value based on the CONFIG_SCHEMA.
 * @param {string} key - The config key.
 * @param {*} value - The raw value from the request.
 * @returns {{valid: boolean, value?: string, error?: string}}
 */
function validateAndSanitize(key, value) {
  const schema = CONFIG_SCHEMA[key];

  // If no schema, treat as a plain string (allows unknown keys)
  if (!schema) {
    return { valid: true, value: String(value) };
  }

  if (schema.type === 'integer') {
    const parsedValue = parseInt(value, 10);

    if (isNaN(parsedValue)) {
      return { valid: false, error: `Invalid value for ${key}. Must be an integer.` };
    }
    
    if (schema.hasOwnProperty('min') && parsedValue < schema.min) {
      return { valid: false, error: `Invalid value for ${key}. Must be at least ${schema.min}.` };
    }
    
    if (schema.hasOwnProperty('max') && parsedValue > schema.max) {
      return { valid: false, error: `Invalid value for ${key}. Must be at most ${schema.max}.` };
    }
    
    // Return the sanitized value as a string (DB stores text)
    return { valid: true, value: String(parsedValue) };
  }

  // Add other types (e.g., 'string', 'boolean') here if needed
  return { valid: true, value: String(value) };
}


/**
 * Creates the router for all config-related endpoints.
 * All routes in this module are protected by allowOnlyLocalhost.
 * @param {import('sql.js').Database} db - The DB instance.
 * @param {object} config - The in-memory config object.
 * @returns {import('express').Router}
 */
export function createConfigRouter(db, config) {
  const router = Router();

  // Protect all routes in this router
  router.use(allowOnlyLocalhost);

  // Path is '/' (mounted at /config)
  router.get('/', (req, res) => {
    // Read from the in-memory config object
    res.status(200).json(config);
  });

  // Path is '/:key' (mounted at /config)
  router.get('/:key', (req, res) => {
    try {
      const key = req.params.key;
      if (config.hasOwnProperty(key)) {
        res.status(200).json({ [key]: config[key] });
      } else {
        res.status(404).json({ error: `Config key "${key}" not found.` });
      }
    } catch (err) {
      console.error("[API/Config] Error getting config key:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Path is '/' (mounted at /config)
  router.post('/', async (req, res) => {
    try {
      const { key, value } = req.body;
      if (!key || value === undefined) {
        return res.status(400).json({ error: "Missing 'key' or 'value' in request body." });
      }

      // --- Use the new validation function ---
      const validation = validateAndSanitize(key, value);

      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
      
      const sanitizedValue = validation.value;
      // --- End of validation ---

      // 1. Update the database
      setConfig(key, sanitizedValue, db);
      state.isDbChanged = true;

      // 2. Update the in-memory config
      config[key] = sanitizedValue;

      // 3. Log a warning if an interval was changed
      if (key === 'tick_interval_ms' || key === 'save_interval_ms') {
        console.warn(`[API] Config '${key}' changed. Restart server to apply.`);
      }

      console.log(`[API] Config updated: ${key} = ${sanitizedValue}`);
      res.status(200).json({ [key]: sanitizedValue });

    } catch (err) {
      console.error("[API/Config] Error setting config key:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}