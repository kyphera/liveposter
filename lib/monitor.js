const EventEmitter = require('events');
const he = require('he');
const KaleidescapeClient = require('./kaleidescape');
const PlexClient = require('./plex');
const JellyfinClient = require('./jellyfin');
const TMDBClient = require('./tmdb');
const OMDbClient = require('./omdb');
const CacheManager = require('./cache');

/**
 * Content ratings that aren't MPAA codes, mapped to the closest MPAA bucket.
 * The settings UI only offers G/PG/PG-13/R/NC-17/NR, but libraries also carry
 * TV ratings (Jellyfin, Kaleidescape TV content) that would otherwise match
 * nothing and be silently dropped from the slideshow.
 */
const RATING_EQUIVALENTS = {
  'TV-Y': 'G',
  'TV-Y7': 'G',
  'TV-G': 'G',
  'TV-PG': 'PG',
  'TV-14': 'PG-13',
  'TV-MA': 'R',
  'NOT RATED': 'NR',
  'UNRATED': 'NR',
  'UR': 'NR'
};

/**
 * Sort key for a library title.
 *
 * Titles are stored HTML-encoded ("Wallace &amp; Gromit"), which would sort
 * under "&" rather than "G", so decode first. Leading articles are dropped so
 * "The Dark Knight" files under D - the same convention Kaleidescape, Plex and
 * Jellyfin all use for library browsing.
 */
function sortKey(title) {
  return he.decode(String(title || ''))
    .replace(/^(the|a|an)\s+/i, '')
    .trim();
}

// Which copy to keep when the same film is in more than one system.
// Kaleidescape first: it supplies native high-resolution cover art.
const SOURCE_PRIORITY = { kaleidescape: 0, plex: 1, jellyfin: 2 };

/**
 * Identity for de-duplication: decoded title plus year.
 *
 * Deliberately NOT tmdbId. Every season of a series shares one TMDb id, so an
 * id-based key would collapse eight Seinfeld discs into one. Title-and-year
 * keeps "Seinfeld (Season 3)" and "(Season 4)" apart while still merging the
 * same film served by both Plex and Jellyfin.
 */
function dedupeKey(movie) {
  const title = he.decode(String(movie.title || '')).toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${title}|${movie.year || ''}`;
}

// An entry that actually matched TMDb is worth more than a bare one
function isEnriched(movie) {
  return !!(movie.tmdbId && (movie.posterUrl || movie.posterUrlLarge));
}

/**
 * Media Monitoring Service
 * Polls all media systems and manages current playback state
 */
class MediaMonitor extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.currentState = {
      playing: false,
      source: null,
      content: null,
      lastChecked: null
    };

    this.kaleidescapeLibrary = [];
    this.plexLibrary = [];
    this.jellyfinLibrary = [];
    this.allLibraries = [];

    this.pollInterval = null;
    this.isPolling = false;

    // Initialize cache manager
    this.cache = new CacheManager();

    // Initialize clients
    this.initializeClients();
  }

  /** Is this media system switched on? Absent config means yes. */
  isEnabled(source) {
    return this.config.sources?.[source] !== false;
  }

  /**
   * Discard cached metadata and rebuild it from the sources.
   *
   * Does NOT restart the process. Exiting only "restarts" if something outside
   * the app happens to bring it back, so on a container without a matching
   * restart policy it simply stopped.
   *
   * loadLibraries() only swaps the combined library at the very end, so the
   * display keeps serving the previous metadata for the whole rebuild.
   */
  async clearCacheAndReload() {
    if (this.isRebuilding) return false;
    this.isRebuilding = true;

    // Keep a copy: if a system is unreachable during the rebuild its fetch
    // returns nothing, and the usual fall back to cache has just been deleted.
    // Without this, clearing the cache while Jellyfin is down loses Jellyfin.
    const previous = {
      kaleidescape: this.cache.get('kaleidescape'),
      plex: this.cache.get('plex'),
      jellyfin: this.cache.get('jellyfin')
    };

    try {
      this.cache.clear();
      await this.loadLibraries();

      let restored = false;
      for (const source of ['kaleidescape', 'plex', 'jellyfin']) {
        const library = `${source}Library`;
        if (this[library].length === 0 && previous[source].length > 0) {
          console.warn(`${source} returned nothing during the rebuild — keeping its ${previous[source].length} cached titles`);
          this[library] = previous[source];
          this.cache.set(source, previous[source]);
          restored = true;
        }
      }

      if (restored) {
        this.cache.save();
        this.rebuildCombinedLibrary();
      }

      console.log('Metadata rebuild complete');
      return true;
    } catch (error) {
      console.error('Metadata rebuild failed:', error.message);
      // Whatever loaded is still better than nothing
      this.rebuildCombinedLibrary();
      throw error;
    } finally {
      this.isRebuilding = false;
    }
  }

  /**
   * Bring sources online that were just switched on in the settings UI.
   *
   * Clients are only built for enabled sources, so one enabled at runtime has
   * no client yet. Build the missing ones, reload libraries in the background,
   * and leave the caller's request to return immediately.
   */
  async activateSources(names = []) {
    console.log(`Enabling ${names.join(', ')} — loading librar${names.length === 1 ? 'y' : 'ies'}...`);

    this.initializeClients();

    if (names.includes('kaleidescape') && this.kaleidescapeClient && !this.kaleidescapeClient.connected) {
      try {
        await this.kaleidescapeClient.connect();
      } catch (error) {
        console.error('Kaleidescape connect failed while enabling:', error.message);
      }
    }

    try {
      await this.loadLibraries();
    } catch (error) {
      console.error('Library reload after enabling a source failed:', error.message);
      this.rebuildCombinedLibrary();
    }
  }

  initializeClients() {
    // Kaleidescape
    if (this.isEnabled('kaleidescape') && this.config.kaleidescape?.playerHost) {
      this.kaleidescapeClient = new KaleidescapeClient(
        this.config.kaleidescape.playerHost,
        this.config.kaleidescape.port
      );

      // Socket errors are expected (player powered off, network blip). Absorb them
      // here so they can never surface as an uncaught 'error' event.
      this.kaleidescapeClient.on('error', (err) => {
        console.error('Kaleidescape client error (will retry on next poll):', err.message);
      });
    }

    // Plex
    if (this.isEnabled('plex') && this.config.plex?.url && this.config.plex?.token) {
      this.plexClient = new PlexClient(
        this.config.plex.url,
        this.config.plex.token
      );
    }

    // Jellyfin
    if (this.isEnabled('jellyfin') && this.config.jellyfin?.url && this.config.jellyfin?.apiKey) {
      this.jellyfinClient = new JellyfinClient(
        this.config.jellyfin.url,
        this.config.jellyfin.apiKey
      );
    }

    // OMDb (for Rotten Tomatoes scores)
    if (this.config.omdb?.apiKey) {
      this.omdbClient = new OMDbClient(this.config.omdb.apiKey);
    }

    // TheMovieDB
    if (this.config.tmdb?.apiKey && this.config.tmdb?.readToken) {
      this.tmdbClient = new TMDBClient(
        this.config.tmdb.apiKey,
        this.config.tmdb.readToken,
        this.omdbClient // Pass OMDb client for RT scores
      );
    }
  }

  async start() {
    console.log('Starting media monitor...');
    console.log('');

    // Initialize TheMovieDB
    if (this.tmdbClient) {
      console.log('Initializing TheMovieDB client...');
      const tmdbInitialized = await this.tmdbClient.initialize();
      console.log(`${tmdbInitialized ? '✓' : '✗'} TheMovieDB ${tmdbInitialized ? 'initialized' : 'initialization failed'}`);
      console.log('');
    }

    // Connect to Kaleidescape
    if (this.kaleidescapeClient) {
      try {
        console.log(`Connecting to Kaleidescape at ${this.config.kaleidescape.playerHost}:${this.config.kaleidescape.port}...`);
        await this.kaleidescapeClient.connect();
        console.log('✓ Kaleidescape connected');
      } catch (error) {
        console.error('✗ Kaleidescape connection failed:', error.message);
      }
    } else {
      console.log('⊘ Kaleidescape not configured');
    }

    // Test other connections
    if (this.plexClient) {
      console.log(`Testing Plex connection at ${this.config.plex.url}...`);
      const plexConnected = await this.plexClient.testConnection();
      console.log(`${plexConnected ? '✓' : '✗'} Plex ${plexConnected ? 'connected' : 'connection failed'}`);
    } else {
      console.log('⊘ Plex not configured');
    }

    if (this.jellyfinClient) {
      console.log(`Testing Jellyfin connection at ${this.config.jellyfin.url}...`);
      const jellyfinConnected = await this.jellyfinClient.testConnection();
      console.log(`${jellyfinConnected ? '✓' : '✗'} Jellyfin ${jellyfinConnected ? 'connected' : 'connection failed'}`);
    } else {
      console.log('⊘ Jellyfin not configured');
    }

    console.log('');

    // Load libraries
    await this.loadLibraries();

    // Start polling
    this.startPolling();
  }

  async loadLibraries() {
    console.log('Loading media libraries...');

    // Load cache
    this.cache.load();

    // Load Kaleidescape library from HTTP interface
    if (this.kaleidescapeClient && this.kaleidescapeClient.connected) {
      try {
        // The movie server holds the library; on an all-in-one system that's
        // the player itself, so fall back to it when no server is configured
        const serverHost = this.config.kaleidescape.serverHost || this.config.kaleidescape.playerHost;
        await this.kaleidescapeClient.loadMovieLibrary(serverHost);
        this.kaleidescapeLibrary = this.kaleidescapeClient.getLibrary();
        console.log(`Loaded ${this.kaleidescapeLibrary.length} movies from Kaleidescape`);

        // Enrich with TheMovieDB metadata (only new movies)
        if (this.tmdbClient && this.kaleidescapeLibrary.length > 0) {
          const moviesToEnrich = this.cache.findMoviesToEnrich('kaleidescape', this.kaleidescapeLibrary);

          if (moviesToEnrich.length > 0) {
            console.log(`\n🔍 Enriching ${moviesToEnrich.length} new/updated Kaleidescape movies with TMDb metadata...`);
            const enrichedMovies = await this.tmdbClient.enrichMovies(moviesToEnrich);
            this.kaleidescapeLibrary = this.cache.mergeMovies('kaleidescape', this.kaleidescapeLibrary, enrichedMovies);
            this.cache.set('kaleidescape', this.kaleidescapeLibrary);
            this.cache.save();
            console.log('');
          } else {
            console.log(`✨ Using cached metadata for ${this.kaleidescapeLibrary.length} Kaleidescape movies`);
            this.kaleidescapeLibrary = this.cache.mergeMovies('kaleidescape', this.kaleidescapeLibrary, []);
          }
        }
        this.kaleidescapeLibraryFromCache = false;
      } catch (error) {
        console.error('Error loading Kaleidescape library:', error.message);
        this.kaleidescapeLibrary = [];
      }
    } else if (this.kaleidescapeClient) {
      // Player unreachable at startup — show the cached library instead of nothing.
      // The flag makes the poll loop refresh from the player once it connects.
      this.kaleidescapeLibrary = this.cache.get('kaleidescape');
      this.kaleidescapeLibraryFromCache = true;
      console.log(`Kaleidescape unreachable — serving ${this.kaleidescapeLibrary.length} movies from cache`);
    }

    // Load Plex library
    if (this.plexClient) {
      try {
        this.plexLibrary = await this.plexClient.getMovieLibrary();
        console.log(`Loaded ${this.plexLibrary.length} movies from Plex`);

        // Enrich with TheMovieDB metadata (only new movies)
        if (this.tmdbClient && this.plexLibrary.length > 0) {
          const moviesToEnrich = this.cache.findMoviesToEnrich('plex', this.plexLibrary);

          if (moviesToEnrich.length > 0) {
            console.log(`\n🔍 Enriching ${moviesToEnrich.length} new/updated Plex movies with TMDb metadata...`);
            const enrichedMovies = await this.tmdbClient.enrichMovies(moviesToEnrich);
            this.plexLibrary = this.cache.mergeMovies('plex', this.plexLibrary, enrichedMovies);
            this.cache.set('plex', this.plexLibrary);
            this.cache.save();
            console.log('');
          } else {
            console.log(`✨ Using cached metadata for ${this.plexLibrary.length} Plex movies`);
            this.plexLibrary = this.cache.mergeMovies('plex', this.plexLibrary, []);
          }
        }
      } catch (error) {
        console.error('Error loading Plex library:', error.message);
      }
    }

    // Load Jellyfin library
    if (this.jellyfinClient) {
      try {
        this.jellyfinLibrary = await this.jellyfinClient.getMovieLibrary(this.config.jellyfin.libraryIds);
        console.log(`Loaded ${this.jellyfinLibrary.length} movies and shows from Jellyfin`);

        // Enrich with TheMovieDB metadata (only new movies)
        if (this.tmdbClient && this.jellyfinLibrary.length > 0) {
          const moviesToEnrich = this.cache.findMoviesToEnrich('jellyfin', this.jellyfinLibrary);

          if (moviesToEnrich.length > 0) {
            console.log(`\n🔍 Enriching ${moviesToEnrich.length} new/updated Jellyfin movies with TMDb metadata...`);
            const enrichedMovies = await this.tmdbClient.enrichMovies(moviesToEnrich);
            this.jellyfinLibrary = this.cache.mergeMovies('jellyfin', this.jellyfinLibrary, enrichedMovies);
            this.cache.set('jellyfin', this.jellyfinLibrary);
            this.cache.save();
            console.log('');
          } else {
            console.log(`✨ Using cached metadata for ${this.jellyfinLibrary.length} Jellyfin movies`);
            this.jellyfinLibrary = this.cache.mergeMovies('jellyfin', this.jellyfinLibrary, []);
          }
        }
      } catch (error) {
        console.error('Error loading Jellyfin library:', error.message);
      }

      // Server unreachable or returned nothing — fall back to the cached library
      if (this.jellyfinLibrary.length === 0 && this.config.jellyfin.libraryIds?.length !== 0) {
        this.jellyfinLibrary = this.cache.get('jellyfin');
        if (this.jellyfinLibrary.length > 0) {
          console.log(`Jellyfin returned no movies — serving ${this.jellyfinLibrary.length} from cache`);
        }
      }
    }

    this.rebuildCombinedLibrary();
    console.log(`Total movies in combined library: ${this.allLibraries.length}`);
  }

  /**
   * Rebuild the combined library the display reads from (/api/random?source=all).
   * Must be called after ANY change to a per-source library, including the
   * on-demand Kaleidescape load that runs when the player connects late.
   */
  rebuildCombinedLibrary() {
    // A disabled system keeps its cached library but contributes nothing to the
    // display, so toggling one off takes effect without a restart
    const combined = [
      ...(this.isEnabled('kaleidescape') ? this.kaleidescapeLibrary : []),
      ...(this.isEnabled('plex') ? this.plexLibrary : []),
      ...(this.isEnabled('jellyfin') ? this.jellyfinLibrary : [])
    ];

    // Plex and Jellyfin commonly index the same files, so the same film arrives
    // twice. Keep one copy per title, preferring the better-sourced entry, but
    // remember every system it came from so the UI can show all of them.
    const best = new Map();
    for (const movie of combined) {
      const key = dedupeKey(movie);
      const group = best.get(key);

      if (!group) {
        best.set(key, { movie, sources: new Set([movie.source]) });
        continue;
      }

      group.sources.add(movie.source);

      const better = isEnriched(movie) !== isEnriched(group.movie)
        ? isEnriched(movie)
        : (SOURCE_PRIORITY[movie.source] ?? 99) < (SOURCE_PRIORITY[group.movie.source] ?? 99);

      if (better) group.movie = movie;
    }

    const merged = combined.length - best.size;
    if (merged !== this.lastMergedCount) {
      this.lastMergedCount = merged;
      if (merged > 0) {
        console.log(`Merged ${merged} title${merged === 1 ? '' : 's'} present in more than one system`);
      }
    }

    // Copy rather than tagging the originals: these objects are the same ones
    // held in the per-source arrays and written back to the metadata cache.
    this.allLibraries = [...best.values()]
      .map(({ movie, sources }) => ({
        ...movie,
        sources: [...sources].sort((a, b) =>
          (SOURCE_PRIORITY[a] ?? 99) - (SOURCE_PRIORITY[b] ?? 99))
      }))
      .sort((a, b) => sortKey(a.title).localeCompare(sortKey(b.title), undefined, {
        numeric: true,        // "Ocean's 8" before "Ocean's 11"
        sensitivity: 'base'
      }));

    return this.allLibraries;
  }

  startPolling() {
    const interval = this.config.pollInterval || 10000; // Default 10 seconds
    console.log(`Starting polling every ${interval}ms`);

    this.pollInterval = setInterval(() => {
      this.checkAllSystems();
    }, interval);

    // Do initial check immediately
    this.checkAllSystems();
  }

  async checkAllSystems() {
    if (this.isPolling) return; // Prevent overlapping polls

    this.isPolling = true;

    try {
      // Priority order: Kaleidescape > Plex > Jellyfin
      let nowPlaying = null;

      // Check Kaleidescape
      if (this.kaleidescapeClient && this.isEnabled('kaleidescape')) {
        if (!this.kaleidescapeClient.connected) {
          console.log('Kaleidescape not connected, attempting to reconnect...');
          try {
            await this.kaleidescapeClient.connect();
          } catch (error) {
            console.error('Failed to reconnect to Kaleidescape:', error.message);
          }
        }

        if (this.kaleidescapeClient.connected) {
          // Load from the player if we have nothing, or only the cached copy from
          // a startup where the player was unreachable
          const needsLibraryLoad = this.kaleidescapeLibrary.length === 0 || this.kaleidescapeLibraryFromCache;
          if (needsLibraryLoad && !this.kaleidescapeLibraryLoading) {
            this.kaleidescapeLibraryLoading = true;
            console.log('Loading Kaleidescape library from player...');
            this.kaleidescapeClient.loadMovieLibrary(this.config.kaleidescape.serverHost || this.config.kaleidescape.playerHost)
              .then(async () => {
                this.kaleidescapeLibrary = this.kaleidescapeClient.getLibrary();
                console.log(`Loaded ${this.kaleidescapeLibrary.length} Kaleidescape movies on-demand`);
                if (this.tmdbClient && this.kaleidescapeLibrary.length > 0) {
                  const toEnrich = this.cache.findMoviesToEnrich('kaleidescape', this.kaleidescapeLibrary);
                  if (toEnrich.length > 0) {
                    const enriched = await this.tmdbClient.enrichMovies(toEnrich);
                    this.kaleidescapeLibrary = this.cache.mergeMovies('kaleidescape', this.kaleidescapeLibrary, enriched);
                    this.cache.set('kaleidescape', this.kaleidescapeLibrary);
                    this.cache.save();
                  } else {
                    this.kaleidescapeLibrary = this.cache.mergeMovies('kaleidescape', this.kaleidescapeLibrary, []);
                  }
                }
                this.kaleidescapeLibraryFromCache = false;
                // Without this the display (/api/random?source=all) stays empty
                // until restart, even though the library just loaded
                this.rebuildCombinedLibrary();
                console.log(`Combined library now has ${this.allLibraries.length} movies`);
                this.kaleidescapeLibraryLoading = false;
              })
              .catch(err => {
                console.error('On-demand Kaleidescape library load failed:', err.message);
                this.kaleidescapeLibraryLoading = false;
              });
          }

          this.kaleidescapeClient.getPlayStatus();
          const kState = this.kaleidescapeClient.getCurrentState();

          // Only on change - this fires every poll interval otherwise
          const kSummary = `${kState.playing}|${kState.contentTitle}`;
          if (kSummary !== this.lastKaleidescapeSummary) {
            this.lastKaleidescapeSummary = kSummary;
            console.log(`Kaleidescape state: playing=${kState.playing}, title=${kState.contentTitle}`);
          }

          if (kState.playing) {
            nowPlaying = {
              source: 'kaleidescape',
              playing: true,
              title: kState.contentTitle || 'Now Playing',
              type: kState.contentType || 'movie',
              thumb: kState.coverArt,
              coverUrl: kState.coverArt,
              playerState: kState.playStatus === '2' ? 'playing' : 'paused',
              duration: kState.titleLength || null,
              viewOffset: kState.playTime || null
            };
            console.log('Kaleidescape now playing detected:', nowPlaying.title);
          }
        }
      }

      // Check Plex if nothing playing on Kaleidescape
      if (!nowPlaying && this.plexClient && this.isEnabled('plex')) {
        const plexPlaying = await this.plexClient.getNowPlaying();
        if (plexPlaying) {
          nowPlaying = plexPlaying;
        }
      }

      // Check Jellyfin if nothing playing on Plex or Kaleidescape
      if (!nowPlaying && this.jellyfinClient && this.isEnabled('jellyfin')) {
        const jellyfinPlaying = await this.jellyfinClient.getNowPlaying();
        if (jellyfinPlaying) {
          nowPlaying = jellyfinPlaying;
        }
      }

      // Update state
      const previouslyPlaying = this.currentState.playing;

      if (nowPlaying) {
        // Enrich with full library metadata if available
        const enrichedContent = this.enrichPlayingContent(nowPlaying);

        this.currentState = {
          playing: true,
          source: nowPlaying.source,
          content: enrichedContent,
          lastChecked: new Date()
        };

        if (!previouslyPlaying) {
          this.emit('playbackStarted', this.currentState);
        } else {
          this.emit('stateChanged', this.currentState);
        }
      } else {
        this.currentState = {
          playing: false,
          source: null,
          content: null,
          lastChecked: new Date()
        };

        if (previouslyPlaying) {
          this.emit('playbackStopped', this.currentState);
        }
      }
    } catch (error) {
      console.error('Error checking systems:', error.message);
    } finally {
      this.isPolling = false;
    }
  }

  enrichPlayingContent(nowPlaying) {
    // Try to match the playing content to library metadata
    let library = [];

    switch (nowPlaying.source) {
      case 'kaleidescape':
        library = this.kaleidescapeLibrary;
        break;
      case 'plex':
        library = this.plexLibrary;
        break;
      case 'jellyfin':
        library = this.jellyfinLibrary;
        break;
    }

    if (library.length === 0) {
      console.log(`enrichPlayingContent: ${nowPlaying.source} library is empty`);
      return nowPlaying;
    }

    const normalize = (s) => (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '') // strip punctuation
      .replace(/\s+/g, ' ')
      .trim();

    const title = normalize(nowPlaying.title);

    // Exact normalized match first
    let match = library.find(m => normalize(m.title) === title);

    // Fallback: one contains the other (handles "Frozen 2" vs "Frozen II" less likely, but catches prefixes)
    if (!match) {
      match = library.find(m => {
        const mt = normalize(m.title);
        return mt.startsWith(title) || title.startsWith(mt);
      });
    }

    if (!match) {
      console.log(`enrichPlayingContent: no match for "${nowPlaying.title}" in ${nowPlaying.source} library (${library.length} titles)`);
    }

    if (match) {
      // Merge playback info with full library metadata
      return {
        ...match,
        playing: true,
        playerState: nowPlaying.playerState,
        duration: nowPlaying.duration,
        viewOffset: nowPlaying.viewOffset
      };
    }

    // No match found, return original
    return nowPlaying;
  }

  getCurrentState() {
    return { ...this.currentState };
  }

  getLibrary(source = 'all', slideshowOnly = false) {
    let library = [];
    switch (source) {
      case 'kaleidescape':
        library = [...this.kaleidescapeLibrary];
        break;
      case 'plex':
        library = [...this.plexLibrary];
        break;
      case 'jellyfin':
        library = [...this.jellyfinLibrary];
        break;
      default:
        library = [...this.allLibraries];
    }

    // Filter for slideshow if requested (only show movies not explicitly disabled)
    if (slideshowOnly) {
      library = library.filter(movie => movie.slideshowEnabled !== false);
    }

    return library;
  }

  /**
   * Resolve a movie's content rating to an MPAA bucket for filtering.
   *
   * Sources disagree about which field holds what:
   *   - Kaleidescape puts the MPAA code in `rating` ("R", "PG-13"), and encodes
   *     unrated content with an advisory equivalent ("NR-R", "NR-G").
   *   - Jellyfin puts a numeric CommunityRating in `rating` (6.7, 7.544) and the
   *     real content rating in `officialRating`.
   * Returns 'NR' when nothing usable is present.
   */
  normalizeRating(movie) {
    // Prefer explicit content-rating fields; ignore anything numeric (vote scores)
    const raw = [movie.officialRating, movie.contentRating, movie.rating].find(value => {
      if (value === undefined || value === null) return false;
      const text = String(value).trim();
      return text !== '' && Number.isNaN(Number(text));
    });

    if (!raw) return 'NR';

    let rating = String(raw).trim().toUpperCase();

    // "NR-R" means unrated with R-equivalent content; filter on the content level
    const advisory = rating.match(/^NR-(.+)$/);
    if (advisory) rating = advisory[1];

    return RATING_EQUIVALENTS[rating] || rating;
  }

  getRandomMovie(source = 'kaleidescape') {
    let library = this.getLibrary(source, true); // Only slideshow-enabled movies

    // Filter by allowed MPAA ratings
    if (this.config.allowedRatings && this.config.allowedRatings.length > 0) {
      const allowed = this.config.allowedRatings.map(r => String(r).trim().toUpperCase());
      library = library.filter(movie => allowed.includes(this.normalizeRating(movie)));
    }

    if (library.length === 0) return null;

    const randomIndex = Math.floor(Math.random() * library.length);
    return library[randomIndex];
  }

  async searchMovieAlternatives(title, year) {
    if (!this.tmdbClient) {
      throw new Error('TMDb client not initialized');
    }

    // Search TMDb for multiple alternative matches (movies and TV)
    const searchResults = await this.tmdbClient.searchMovieMultiple(title, year);

    if (!searchResults || searchResults.length === 0) {
      return [];
    }

    // Get full details for each result
    const enrichedResults = [];

    for (const result of searchResults) {
      try {
        const isTV = result.media_type === 'tv';

        // Get full details including tagline
        let details;
        if (isTV) {
          details = await this.tmdbClient.getTVDetails(result.id);
        } else {
          details = await this.tmdbClient.getMovieDetails(result.id);
        }

        // Fetch RT score
        let rottenTomatoes = null;
        if (this.omdbClient && details?.imdb_id) {
          try {
            const omdbData = await this.omdbClient.getMovieByImdbId(details.imdb_id);
            rottenTomatoes = omdbData?.rottenTomatoes || null;
          } catch (error) {
            // Ignore RT fetch errors, continue with other data
          }
        }

        enrichedResults.push({
          tmdbId: result.id,
          title: result.title,
          year: result.release_date ? result.release_date.substring(0, 4) : null,
          overview: result.overview || details?.overview,
          tagline: details?.tagline || null,
          posterUrl: this.tmdbClient.getPosterUrl(result.poster_path),
          posterUrlLarge: this.tmdbClient.getPosterUrl(result.poster_path, 'w780'),
          backdropUrl: result.backdrop_path ?
            `${this.tmdbClient.imageBaseUrl}w1280${result.backdrop_path}` : null,
          voteAverage: result.vote_average,
          rottenTomatoes: rottenTomatoes,
          imdbId: details?.imdb_id,
          mediaType: isTV ? 'tv' : 'movie'
        });
      } catch (error) {
        console.error(`Error enriching search result for ${result.title}:`, error.message);
        // Add basic result even if enrichment fails
        enrichedResults.push({
          tmdbId: result.id,
          title: result.title,
          year: result.release_date ? result.release_date.substring(0, 4) : null,
          overview: result.overview,
          tagline: null,
          posterUrl: this.tmdbClient.getPosterUrl(result.poster_path),
          posterUrlLarge: this.tmdbClient.getPosterUrl(result.poster_path, 'w780'),
          backdropUrl: result.backdrop_path ?
            `${this.tmdbClient.imageBaseUrl}w1280${result.backdrop_path}` : null,
          voteAverage: result.vote_average,
          rottenTomatoes: null,
          imdbId: null,
          mediaType: result.media_type || 'movie'
        });
      }
    }

    return enrichedResults;
  }

  async updateMovieMetadata(source, originalTitle, tmdbId, mediaType = 'movie') {
    if (!this.tmdbClient) {
      throw new Error('TMDb client not initialized');
    }

    // Get the library for the source
    let library = [];
    switch (source) {
      case 'kaleidescape':
        library = this.kaleidescapeLibrary;
        break;
      case 'plex':
        library = this.plexLibrary;
        break;
      case 'jellyfin':
        library = this.jellyfinLibrary;
        break;
      default:
        throw new Error('Invalid source');
    }

    // Find the movie by original title
    const movieIndex = library.findIndex(m =>
      m.title.toLowerCase().trim() === originalTitle.toLowerCase().trim()
    );

    if (movieIndex === -1) {
      throw new Error('Movie not found in library');
    }

    const movie = library[movieIndex];

    // Fetch new metadata from TMDb (either movie or TV series)
    const isTV = mediaType === 'tv';
    const movieDetails = isTV ?
      await this.tmdbClient.getTVDetails(tmdbId) :
      await this.tmdbClient.getMovieDetails(tmdbId);

    if (!movieDetails) {
      throw new Error('Could not fetch movie details from TMDb');
    }

    // Fetch RT score
    let rottenTomatoes = null;
    if (this.omdbClient && movieDetails.imdb_id) {
      const omdbData = await this.omdbClient.getMovieByImdbId(movieDetails.imdb_id);
      rottenTomatoes = omdbData?.rottenTomatoes || null;
    }

    // Update the movie with new metadata
    const updatedMovie = {
      ...movie,
      tmdbId: movieDetails.id,
      mediaType: mediaType,
      overview: movieDetails.overview,
      tagline: movieDetails.tagline || null,
      imdbId: movieDetails.imdb_id || null,
      rottenTomatoes: rottenTomatoes,
      posterPath: movieDetails.poster_path,
      posterUrl: this.tmdbClient.getPosterUrl(movieDetails.poster_path),
      posterUrlLarge: this.tmdbClient.getPosterUrl(movieDetails.poster_path, 'w780'),
      backdropPath: movieDetails.backdrop_path,
      backdropUrl: movieDetails.backdrop_path ?
        `${this.tmdbClient.imageBaseUrl}w1280${movieDetails.backdrop_path}` : null,
      voteAverage: movieDetails.vote_average,
      releaseDate: movieDetails.release_date,
      popularity: movieDetails.popularity
    };

    // Update in library
    library[movieIndex] = updatedMovie;

    // Update cache
    this.cache.set(source, library);
    this.cache.save();

    // Update combined library
    this.rebuildCombinedLibrary();

    return {
      success: true,
      movie: updatedMovie
    };
  }

  async toggleMovieSlideshow(source, title, enabled) {
    // Get the library for the source
    let library = [];
    switch (source) {
      case 'kaleidescape':
        library = this.kaleidescapeLibrary;
        break;
      case 'plex':
        library = this.plexLibrary;
        break;
      case 'jellyfin':
        library = this.jellyfinLibrary;
        break;
      default:
        throw new Error('Invalid source');
    }

    // Find the movie by title
    const movieIndex = library.findIndex(m =>
      m.title.toLowerCase().trim() === title.toLowerCase().trim()
    );

    if (movieIndex === -1) {
      throw new Error('Movie not found in library');
    }

    // Update the slideshowEnabled flag
    library[movieIndex].slideshowEnabled = enabled;

    // Update cache
    this.cache.set(source, library);
    this.cache.save();

    // Update combined library
    this.rebuildCombinedLibrary();

    return {
      success: true,
      movie: library[movieIndex]
    };
  }

  stop() {
    console.log('Stopping media monitor...');

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.kaleidescapeClient) {
      this.kaleidescapeClient.disconnect();
    }

    this.isPolling = false;
  }
}

module.exports = MediaMonitor;
