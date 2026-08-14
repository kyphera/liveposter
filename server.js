require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const MediaMonitor = require('./lib/monitor');

const app = express();
const PORT = process.env.PORT || 3000;

// Track server start time for client reload detection
const SERVER_START_TIME = Date.now();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Read a configuration value from the environment.
 *
 * Supports the Docker/Podman/Kubernetes secrets convention: any variable FOO
 * may instead be supplied as FOO_FILE pointing at a file containing the value
 * (e.g. JELLYFIN_API_KEY_FILE=/run/secrets/jellyfin_key). This keeps
 * credentials out of `docker inspect`, out of compose files, and out of the
 * Unraid template. FOO_FILE takes precedence over FOO when both are set.
 */
const secretsFromFiles = [];
function envValue(name) {
  const filePath = process.env[`${name}_FILE`];

  if (filePath) {
    try {
      const value = fs.readFileSync(filePath, 'utf8').trim();
      secretsFromFiles.push(name);
      return value;
    } catch (error) {
      // Fall back to the plain variable rather than starting up misconfigured
      console.error(`Could not read ${name}_FILE at ${filePath}: ${error.message}`);
    }
  }

  return process.env[name];
}

/**
 * Credential handling for the settings API.
 *
 * GET /api/settings never returns a real secret — the management UI only needs
 * to show whether one is set, and this server has no authentication, so anyone
 * who can reach it could otherwise harvest every key. Values come back masked;
 * a mask posted back means "leave this alone".
 */
const SECRET_MASK = '•'.repeat(8);
const SECRET_FIELDS = [
  ['tmdb', 'apiKey'],
  ['tmdb', 'readToken'],
  ['omdb', 'apiKey'],
  ['plex', 'token'],
  ['jellyfin', 'apiKey']
];

function maskSecret(value) {
  if (!value) return '';
  const text = String(value);
  // Keep the last 4 so you can tell which key is loaded without revealing it
  return text.length > 4 ? SECRET_MASK + text.slice(-4) : SECRET_MASK;
}

function isMasked(value) {
  return typeof value === 'string' && value.startsWith(SECRET_MASK);
}

// Load persistent settings from cache directory (for Docker)
const settingsFile = path.join(__dirname, '.cache', 'settings.json');
let persistentSettings = {};

if (fs.existsSync(settingsFile)) {
  try {
    persistentSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    console.log('Loaded persistent settings from cache');
  } catch (error) {
    console.error('Error loading persistent settings:', error.message);
  }
}

/**
 * Whether a media system is switched on. Defaults to on, so existing installs
 * behave exactly as before. Set <NAME>_ENABLED=false to disable one without
 * clearing its credentials.
 */
function sourceEnabled(name, envName) {
  const saved = persistentSettings.sources?.[name];
  if (typeof saved === 'boolean') return saved;

  const fromEnv = envValue(envName);
  if (fromEnv === undefined || fromEnv === '') return true;
  return !/^(false|0|no|off)$/i.test(String(fromEnv).trim());
}

// Configuration from environment variables (with persistent settings override)
const config = {
  sources: {
    kaleidescape: sourceEnabled('kaleidescape', 'KALEIDESCAPE_ENABLED'),
    plex: sourceEnabled('plex', 'PLEX_ENABLED'),
    jellyfin: sourceEnabled('jellyfin', 'JELLYFIN_ENABLED')
  },
  kaleidescape: {
    // The player answers play-status queries; the server holds the movie library.
    // On an all-in-one system (e.g. Strato V) leave serverHost unset.
    playerHost: persistentSettings.kaleidescape?.playerHost || envValue('KALEIDESCAPE_PLAYER_HOST'),
    serverHost: persistentSettings.kaleidescape?.serverHost || envValue('KALEIDESCAPE_SERVER_HOST'),
    port: parseInt(persistentSettings.kaleidescape?.port || envValue('KALEIDESCAPE_PORT')) || 10000
  },
  plex: {
    url: persistentSettings.plex?.url || envValue('PLEX_URL'),
    token: persistentSettings.plex?.token || envValue('PLEX_TOKEN')
  },
  jellyfin: {
    url: persistentSettings.jellyfin?.url || envValue('JELLYFIN_URL'),
    apiKey: persistentSettings.jellyfin?.apiKey || envValue('JELLYFIN_API_KEY'),
    // null means all libraries (the backwards-compatible default); [] means none.
    libraryIds: Array.isArray(persistentSettings.jellyfin?.libraryIds)
      ? persistentSettings.jellyfin.libraryIds
      : null
  },
  tmdb: {
    apiKey: persistentSettings.tmdb?.apiKey || envValue('TMDB_API_KEY'),
    readToken: persistentSettings.tmdb?.readToken || envValue('TMDB_READ_TOKEN')
  },
  omdb: {
    apiKey: persistentSettings.omdb?.apiKey || envValue('OMDB_API_KEY')
  },
  pollInterval: parseInt(persistentSettings.pollInterval || envValue('POLL_INTERVAL')) || 10000,
  slideshowInterval: parseInt(persistentSettings.slideshowInterval || envValue('SLIDESHOW_INTERVAL')) || 30000,
  displayScale: parseFloat(persistentSettings.displayScale || envValue('DISPLAY_SCALE')) || 1.0,
  allowedRatings: persistentSettings.allowedRatings || ['G', 'PG', 'PG-13', 'R', 'NC-17', 'NR']
};

if (secretsFromFiles.length > 0) {
  console.log(`Loaded from *_FILE: ${secretsFromFiles.join(', ')}`);
}

// Initialize media monitor
const monitor = new MediaMonitor(config);

// Track loading state
let isServerReady = false;
let loadingProgress = {
  loaded: 0,
  total: 0,
  status: 'initializing',
  logs: []
};

// Capture enrichment logs
function addProgressLog(message) {
  loadingProgress.logs.push({
    message,
    timestamp: Date.now()
  });
  // Keep only last 50 logs
  if (loadingProgress.logs.length > 50) {
    loadingProgress.logs.shift();
  }
}

// Event listeners
monitor.on('playbackStarted', (state) => {
  console.log(`Playback started on ${state.source}:`, state.content?.title);
});

monitor.on('playbackStopped', () => {
  console.log('Playback stopped');
});

monitor.on('stateChanged', (state) => {
  console.log(`State updated: ${state.source} - ${state.content?.title}`);
});

// API Routes

// Get current playback state
app.get('/api/status', (req, res) => {
  const state = monitor.getCurrentState();
  res.json(state);
});

// Debug endpoint - raw Kaleidescape state
app.get('/api/debug/kaleidescape', (req, res) => {
  const client = monitor.kaleidescapeClient;
  if (!client) {
    return res.json({ error: 'Kaleidescape not configured' });
  }
  res.json({
    connected: client.connected,
    deviceType: client.deviceType,
    standby: client.standby,
    playbackUnsupported: client.playbackUnsupported,
    state: client.currentState,
    playerHost: client.host,
    serverHost: config.kaleidescape.serverHost || client.host,
    port: client.port
  });
});

// Get library
app.get('/api/library', (req, res) => {
  const source = req.query.source || 'all';
  const library = monitor.getLibrary(source);
  res.json({
    source,
    count: library.length,
    movies: library
  });
});

// Get random movie from library
app.get('/api/random', (req, res) => {
  const source = req.query.source || 'kaleidescape';
  const movie = monitor.getRandomMovie(source);

  if (!movie) {
    return res.status(404).json({ error: 'No movies available' });
  }

  res.json(movie);
});

// Get config (sanitized)
app.get('/api/config', (req, res) => {
  res.json({
    pollInterval: config.pollInterval,
    slideshowInterval: config.slideshowInterval,
    systems: {
      kaleidescape: !!config.kaleidescape.playerHost,
      plex: !!config.plex.url && !!config.plex.token,
      jellyfin: !!config.jellyfin.url && !!config.jellyfin.apiKey
    }
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    serverStartTime: SERVER_START_TIME
  });
});

// Loading status
app.get('/api/loading', (req, res) => {
  // Check if any services are configured
  const hasKaleidescape = !!config.kaleidescape.playerHost;
  const hasPlex = !!config.plex.url && !!config.plex.token;
  const hasJellyfin = !!config.jellyfin.url && !!config.jellyfin.apiKey;
  const hasTmdb = !!config.tmdb.apiKey && !!config.tmdb.readToken;

  const hasAnyService = hasKaleidescape || hasPlex || hasJellyfin;
  const needsSetup = !hasAnyService || !hasTmdb;

  res.json({
    ready: isServerReady,
    rebuilding: !!monitor.isRebuilding,
    progress: loadingProgress,
    needsSetup,
    configured: {
      kaleidescape: hasKaleidescape,
      plex: hasPlex,
      jellyfin: hasJellyfin,
      tmdb: hasTmdb
    }
  });
});

// Get all movies with metadata quality indicators
app.get('/api/movies/all', (req, res) => {
  const source = req.query.source || 'all';
  const library = monitor.getLibrary(source);

  // Add metadata quality flags
  const moviesWithQuality = library.map(movie => ({
    ...movie,
    metadataQuality: {
      hasTitle: !!movie.title,
      hasPoster: !!(movie.posterUrl || movie.posterUrlLarge || movie.thumb),
      hasTagline: !!movie.tagline,
      hasRating: !!(movie.voteAverage || movie.rating),
      hasRT: !!movie.rottenTomatoes,
      hasTmdb: !!movie.tmdbId,
      complete: !!(movie.tmdbId && movie.posterUrl)
    }
  }));

  res.json({
    source,
    count: moviesWithQuality.length,
    movies: moviesWithQuality
  });
});

// Search TMDb for alternative matches
app.get('/api/movies/search', async (req, res) => {
  const { title, year } = req.query;

  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  try {
    const results = await monitor.searchMovieAlternatives(title, year);
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update movie metadata manually
app.post('/api/movies/update', express.json(), async (req, res) => {
  const { source, originalTitle, tmdbId, mediaType } = req.body;

  if (!source || !originalTitle || !tmdbId) {
    return res.status(400).json({ error: 'source, originalTitle, and tmdbId are required' });
  }

  try {
    const result = await monitor.updateMovieMetadata(source, originalTitle, tmdbId, mediaType || 'movie');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Toggle movie in slideshow
app.post('/api/movies/toggle-slideshow', express.json(), async (req, res) => {
  const { source, title, enabled } = req.body;

  if (!source || !title || enabled === undefined) {
    return res.status(400).json({ error: 'source, title, and enabled are required' });
  }

  try {
    const result = await monitor.toggleMovieSlideshow(source, title, enabled);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get settings
app.get('/api/settings', (req, res) => {
  res.json({
    tmdb: {
      apiKey: maskSecret(config.tmdb.apiKey),
      readToken: maskSecret(config.tmdb.readToken)
    },
    omdb: {
      apiKey: maskSecret(config.omdb.apiKey)
    },
    sources: config.sources,
    kaleidescape: {
      playerHost: config.kaleidescape.playerHost || '',
      port: config.kaleidescape.port || 10000,
      serverHost: config.kaleidescape.serverHost || ''
    },
    plex: {
      url: config.plex.url || '',
      token: maskSecret(config.plex.token)
    },
    jellyfin: {
      url: config.jellyfin.url || '',
      apiKey: maskSecret(config.jellyfin.apiKey),
      libraryIds: config.jellyfin.libraryIds
    },
    pollInterval: config.pollInterval || 10000,
    slideshowInterval: config.slideshowInterval || 10000,
    displayScale: config.displayScale || 1.0,
    allowedRatings: config.allowedRatings || ['G', 'PG', 'PG-13', 'R', 'NC-17', 'NR']
  });
});

app.get('/api/jellyfin/libraries', async (req, res) => {
  try {
    if (!monitor.jellyfinClient) {
      return res.status(400).json({ error: 'Jellyfin is not configured' });
    }
    res.json({ libraries: await monitor.jellyfinClient.getLibraries() });
  } catch (error) {
    res.status(502).json({ error: `Could not load Jellyfin libraries: ${error.message}` });
  }
});

// Get display scale (for polling)
app.get('/api/display-scale', (req, res) => {
  res.json({ scale: config.displayScale || 1.0 });
});

// Clear cache and restart
app.post('/api/clear-cache', express.json(), async (req, res) => {
  const cacheFile = path.join(__dirname, '.cache', 'movies.json');

  try {
    // Delete cache file if it exists
    if (fs.existsSync(cacheFile)) {
      fs.unlinkSync(cacheFile);
      console.log('Cache cleared by user');
    }

    if (monitor.isRebuilding) {
      return res.status(409).json({ error: 'A metadata rebuild is already running' });
    }

    res.json({
      success: true,
      message: 'Cache cleared. Rebuilding metadata in the background — the display keeps running.'
    });

    // Rebuild in place. This used to call process.exit(0) and rely on the
    // container being restarted from outside, which on many setups just
    // stopped the app.
    monitor.clearCacheAndReload().catch(error => {
      console.error('Rebuild after cache clear failed:', error.message);
    });
  } catch (error) {
    console.error('Error clearing cache:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save settings
app.post('/api/settings', express.json(), async (req, res) => {
  const settings = req.body;

  try {
    const settingsFile = path.join(__dirname, '.cache', 'settings.json');

    // What's on disk right now, so an untouched secret keeps whatever it had -
    // including having nothing, when the value actually comes from the
    // environment. Comparing against the resolved config instead would copy
    // env/_FILE secrets into settings.json the first time anyone hit Save.
    let stored = {};
    if (fs.existsSync(settingsFile)) {
      try {
        stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      } catch (error) {
        console.error('Could not read existing settings, treating as empty:', error.message);
      }
    }

    // A masked value means "unchanged". An empty one means "clear it".
    for (const [section, key] of SECRET_FIELDS) {
      if (!isMasked(settings[section]?.[key])) continue;

      const previous = stored[section]?.[key];
      if (previous === undefined) {
        delete settings[section][key];
      } else {
        settings[section][key] = previous;
      }
    }

    // Merge over what's stored rather than replacing it. The settings UI posts
    // every field, but anything posting a subset (a script, or a future partial
    // save) would otherwise blank every field it didn't mention.
    const SECTIONS = ['tmdb', 'omdb', 'kaleidescape', 'plex', 'jellyfin', 'sources'];
    for (const section of SECTIONS) {
      if (stored[section] || settings[section]) {
        settings[section] = { ...stored[section], ...settings[section] };
      }
    }
    for (const [key, value] of Object.entries(stored)) {
      if (!SECTIONS.includes(key) && settings[key] === undefined) settings[key] = value;
    }

    // The mounted cache directory is the single source of truth for saved
    // settings. We deliberately do NOT also write .env: inside a container
    // that path lives in an image layer, so it is lost on every update and
    // would duplicate each credential in a second, unmounted location.
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
    console.log('Settings saved to persistent cache');

    // Update in-memory config immediately (so changes apply without restart).
    // A secret dropped above (still supplied by the environment) must keep its
    // resolved value rather than being blanked.
    const keepIfAbsent = (incoming, current) => (incoming === undefined ? current : incoming || '');

    config.tmdb.apiKey = keepIfAbsent(settings.tmdb?.apiKey, config.tmdb.apiKey);
    config.tmdb.readToken = keepIfAbsent(settings.tmdb?.readToken, config.tmdb.readToken);
    config.omdb.apiKey = keepIfAbsent(settings.omdb?.apiKey, config.omdb.apiKey);
    config.plex.token = keepIfAbsent(settings.plex?.token, config.plex.token);
    config.jellyfin.apiKey = keepIfAbsent(settings.jellyfin?.apiKey, config.jellyfin.apiKey);

    // Same rule for non-secrets: a field the payload didn't mention keeps its
    // current value, which may have come from the environment rather than disk.
    config.kaleidescape.playerHost = keepIfAbsent(settings.kaleidescape?.playerHost, config.kaleidescape.playerHost);
    config.kaleidescape.serverHost = keepIfAbsent(settings.kaleidescape?.serverHost, config.kaleidescape.serverHost);
    config.plex.url = keepIfAbsent(settings.plex?.url, config.plex.url);
    config.jellyfin.url = keepIfAbsent(settings.jellyfin?.url, config.jellyfin.url);
    if (Array.isArray(settings.jellyfin?.libraryIds)) {
      config.jellyfin.libraryIds = settings.jellyfin.libraryIds;
    }

    if (settings.kaleidescape?.port !== undefined) {
      config.kaleidescape.port = parseInt(settings.kaleidescape.port) || 10000;
    }
    if (settings.pollInterval !== undefined) {
      config.pollInterval = parseInt(settings.pollInterval) || 10000;
    }
    if (settings.slideshowInterval !== undefined) {
      config.slideshowInterval = parseInt(settings.slideshowInterval) || 30000;
    }
    if (settings.displayScale !== undefined) {
      config.displayScale = parseFloat(settings.displayScale) || 1.0;
    }
    if (settings.allowedRatings !== undefined) {
      config.allowedRatings = settings.allowedRatings || ['G', 'PG', 'PG-13', 'R', 'NC-17', 'NR'];
    }

    let jellyfinActivated = false;
    if (settings.sources) {
      const wasEnabled = { ...config.sources };
      config.sources = {
        kaleidescape: settings.sources.kaleidescape !== false,
        plex: settings.sources.plex !== false,
        jellyfin: settings.sources.jellyfin !== false
      };

      // Turning one off applies immediately: the poll loop and the combined
      // library both consult config.sources. Turning one back on may need a
      // client that was never built, so ask the monitor to catch up.
      const switchedOn = Object.keys(config.sources)
        .filter(name => config.sources[name] && !wasEnabled[name]);

      console.log(`Sources enabled: ${Object.entries(config.sources)
        .filter(([, on]) => on).map(([name]) => name).join(', ') || 'none'}`);

      if (switchedOn.length > 0) {
        monitor.activateSources(switchedOn);
        jellyfinActivated = switchedOn.includes('jellyfin');
      } else {
        monitor.rebuildCombinedLibrary();
      }
    }

    // Apply Jellyfin credentials and library selection without a restart.
    if (settings.jellyfin && config.sources.jellyfin && !jellyfinActivated) {
      monitor.activateSources(['jellyfin']);
    }

    console.log(`Settings updated - Display scale: ${config.displayScale}x, Allowed ratings: ${config.allowedRatings.join(', ')}`);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Intercept console.log to capture enrichment progress
const originalLog = console.log;
function captureLog(...args) {
  const message = args.map(arg =>
    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
  ).join(' ');

  // Capture TMDb-related logs
  if (message.includes('TMDb') ||
      message.includes('Enriching') ||
      message.includes('enrichment') ||
      message.includes('Loaded') && message.includes('movies')) {
    addProgressLog(message);
  }

  // Call original
  originalLog.apply(console, args);
}

// Start server
async function start() {
  try {
    // Start Express server immediately
    app.listen(PORT, () => {
      console.log(`\n🎬 LivePoster server running on http://localhost:${PORT}`);
      console.log(`\nConfigured systems:`);
      console.log(`  - Kaleidescape: ${config.kaleidescape.playerHost ? '✓' : '✗'}`);
      console.log(`  - Plex: ${config.plex.url ? '✓' : '✗'}`);
      console.log(`  - Jellyfin: ${config.jellyfin.url ? '✓' : '✗'}`);
      console.log(`\nPolling interval: ${config.pollInterval}ms`);
      console.log(`Slideshow interval: ${config.slideshowInterval}ms\n`);
      console.log(`⏳ Loading media library...`);
    });

    // Start media monitor in background
    loadingProgress.status = 'Loading media library...';

    // Temporarily override console.log to capture progress
    console.log = captureLog;

    await monitor.start();

    // Restore original console.log
    console.log = originalLog;

    isServerReady = true;
    loadingProgress.status = 'Ready';
    console.log(`✓ Media library loaded and ready!\n`);
  } catch (error) {
    console.error('Failed to start server:', error);
    loadingProgress.status = `Error: ${error.message}`;
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  monitor.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down gracefully...');
  monitor.stop();
  process.exit(0);
});

start();
