// Metadata Manager JavaScript

let allMovies = [];
let currentMovie = null;
let renderedMovies = [];   // the filtered list currently drawn in the grid
let savedJellyfinLibraryIds = null;
let jellyfinLibrariesLoaded = false;

// Load movies on page load
document.addEventListener('DOMContentLoaded', () => {
  loadMovies();

  // Only the source filter needs a round trip; the rest filter what's loaded
  document.getElementById('source-filter').addEventListener('change', loadMovies);
  document.getElementById('quality-filter').addEventListener('change', applyFilters);
  document.getElementById('search-input').addEventListener('input', applyFilters);

  // Stat boxes double as quality filters
  document.querySelectorAll('.stat-filter').forEach(box => {
    box.addEventListener('click', () => {
      document.getElementById('quality-filter').value = box.dataset.quality;
      applyFilters();
    });
  });
});

async function loadMovies() {
  try {
    const source = document.getElementById('source-filter').value;
    const response = await fetch(`/api/movies/all?source=${source}`);
    const data = await response.json();

    allMovies = data.movies;
    updateStats();

    // Re-apply whatever the user had selected. Showing everything here is what
    // made the grid jump back to the full list after correcting a title.
    applyFilters();
  } catch (error) {
    console.error('Error loading movies:', error);
    document.getElementById('movies-grid').innerHTML = '<div class="loading">Error loading movies</div>';
  }
}

function updateStats() {
  const total = allMovies.length;
  const complete = allMovies.filter(m => m.metadataQuality.complete).length;
  const incomplete = total - complete;

  document.getElementById('total-count').textContent = total;
  document.getElementById('complete-count').textContent = complete;
  document.getElementById('incomplete-count').textContent = incomplete;
}

/**
 * Click handling for the grid.
 *
 * The card used to carry onclick="showMovieDetails('<title>', ...)" with the
 * title interpolated in. Any title containing an apostrophe closed the JS
 * string early and the handler silently failed to parse, and any title
 * containing "&amp;" arrived decoded, so the lookup against the raw cached
 * title found nothing. Either way the card just didn't respond. Titles now
 * never leave JavaScript - the card carries its position instead.
 */
function bindGridClicks() {
  const grid = document.getElementById('movies-grid');
  if (grid.dataset.clicksBound) return;
  grid.dataset.clicksBound = 'true';

  grid.addEventListener('click', (event) => {
    const card = event.target.closest('.movie-card');
    if (!card) return;

    const movie = renderedMovies[Number(card.dataset.index)];
    if (!movie) return;

    const toggle = event.target.closest('.slideshow-toggle-card');
    if (toggle) {
      event.stopPropagation();
      toggleSlideshowFromGrid(movie.title, movie.source, toggle);
      return;
    }

    showMovieDetails(movie.title, movie.source);
  });
}

/**
 * Systems a title came from. The combined view carries every source a merged
 * title was found in; a single-source view only has the one.
 */
function sourceList(movie) {
  if (Array.isArray(movie.sources) && movie.sources.length) return movie.sources;
  return movie.source ? [movie.source] : [];
}

function sourceBadges(movie) {
  const known = ['kaleidescape', 'plex', 'jellyfin'];
  return sourceList(movie).map(s => {
    const cls = known.includes(s) ? s : 'unknown';
    return `<span class="source-badge ${cls}">${escapeHtml(s)}</span>`;
  }).join('');
}

function displayMovies(movies) {
  const grid = document.getElementById('movies-grid');
  bindGridClicks();

  if (movies.length === 0) {
    renderedMovies = [];
    grid.innerHTML = '<div class="loading">No movies found</div>';
    return;
  }

  // Cards are addressed by position, so a title never has to survive a trip
  // through an HTML attribute (see bindGridClicks)
  renderedMovies = movies;

  grid.innerHTML = movies.map((movie, index) => {
    const quality = movie.metadataQuality;
    const isIncomplete = !quality.complete;
    const posterUrl = movie.posterUrl || movie.posterUrlLarge || movie.thumb;
    const slideshowEnabled = movie.slideshowEnabled !== false;

    return `
      <div class="movie-card ${isIncomplete ? 'bad-metadata' : ''}" data-index="${index}">
        <div class="slideshow-toggle-card">
          <input type="checkbox" ${slideshowEnabled ? 'checked' : ''} title="${slideshowEnabled ? 'Enabled in slideshow' : 'Disabled in slideshow'}">
        </div>
        ${posterUrl
          ? `<img src="${posterUrl}" alt="${escapeHtml(movie.title)}" class="movie-poster">`
          : `<div class="movie-poster">No Poster</div>`
        }
        <div class="movie-info">
          <div class="movie-title">${escapeHtml(movie.title)}</div>
          <div class="movie-year">${movie.year || 'Unknown'}</div>
          <div class="quality-badges">
            <span class="badge ${quality.hasPoster ? 'good' : 'bad'}">Poster</span>
            <span class="badge ${quality.hasTagline ? 'good' : 'bad'}">Tagline</span>
            <span class="badge ${quality.hasRT ? 'good' : 'bad'}">RT</span>
          </div>
          <div class="source-badges">${sourceBadges(movie)}</div>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Filter the already-loaded list and redraw. Never refetches, so it is safe to
 * call from anywhere - including after a reload, which is what keeps the
 * current view intact when a title is corrected.
 */
function applyFilters() {
  const quality = document.getElementById('quality-filter').value;
  const searchText = document.getElementById('search-input').value.toLowerCase();

  let filtered = allMovies;

  if (quality !== 'all') {
    filtered = filtered.filter(movie => {
      const q = movie.metadataQuality;
      switch (quality) {
        case 'complete':
          return q.complete;
        case 'incomplete':
          return !q.complete;
        case 'no-poster':
          return !q.hasPoster;
        case 'no-tagline':
          return !q.hasTagline;
        case 'no-rt':
          return !q.hasRT;
        default:
          return true;
      }
    });
  }

  if (searchText) {
    // Titles are stored entity-encoded, so search what the user actually sees
    filtered = filtered.filter(movie =>
      decodeEntities(movie.title).toLowerCase().includes(searchText)
    );
  }

  // Highlight the stat box matching the active filter
  document.querySelectorAll('.stat-filter').forEach(box =>
    box.classList.toggle('active', box.dataset.quality === quality));

  displayMovies(filtered);
}

// Kept for anything still calling the old name
function filterMovies() {
  applyFilters();
}

function showMovieDetails(title, source) {
  const movie = allMovies.find(m => m.title === title && m.source === source);
  if (!movie) return;

  currentMovie = movie;

  const posterUrl = movie.posterUrlLarge || movie.posterUrl || movie.thumb;
  const quality = movie.metadataQuality;

  // textContent shows entities literally, so decode first
  document.getElementById('modal-title').textContent = decodeEntities(movie.title);
  document.getElementById('movie-details').innerHTML = `
    <div>
      ${posterUrl
        ? `<img src="${posterUrl}" alt="${escapeHtml(movie.title)}" class="detail-poster">`
        : `<div class="detail-poster" style="background: #333; display: flex; align-items: center; justify-content: center; color: #666;">No Poster</div>`
      }
    </div>
    <div class="detail-info">
      <h3>${escapeHtml(movie.title)}</h3>
      <p><strong>Year:</strong> ${movie.year || 'Unknown'}</p>
      <p><strong>Source${sourceList(movie).length > 1 ? 's' : ''}:</strong> ${sourceList(movie).join(', ')}${
        sourceList(movie).length > 1 ? ' <span style="color:#888">(same title in more than one system — shown once)</span>' : ''
      }</p>
      <p><strong>TMDb ID:</strong> ${movie.tmdbId || 'Not matched'}</p>
      <p><strong>IMDb ID:</strong> ${movie.imdbId || 'N/A'}</p>
      <p><strong>Rating:</strong> ${movie.voteAverage ? `★ ${movie.voteAverage.toFixed(1)}` : 'N/A'}</p>
      <p><strong>RT Score:</strong> ${movie.rottenTomatoes || 'N/A'}</p>
      <p><strong>Tagline:</strong> ${movie.tagline || 'None'}</p>
      ${movie.overview ? `<p><strong>Overview:</strong> ${escapeHtml(movie.overview)}</p>` : ''}

      <h4 style="margin-top: 20px; margin-bottom: 10px;">Metadata Quality:</h4>
      <div class="quality-badges">
        <span class="badge ${quality.hasPoster ? 'good' : 'bad'}">Poster: ${quality.hasPoster ? '✓' : '✗'}</span>
        <span class="badge ${quality.hasTagline ? 'good' : 'bad'}">Tagline: ${quality.hasTagline ? '✓' : '✗'}</span>
        <span class="badge ${quality.hasRating ? 'good' : 'bad'}">Rating: ${quality.hasRating ? '✓' : '✗'}</span>
        <span class="badge ${quality.hasRT ? 'good' : 'bad'}">RT: ${quality.hasRT ? '✓' : '✗'}</span>
        <span class="badge ${quality.hasTmdb ? 'good' : 'bad'}">TMDb: ${quality.hasTmdb ? '✓' : '✗'}</span>
      </div>
    </div>
  `;

  // Pre-fill search form
  document.getElementById('alt-search-title').value = decodeEntities(movie.title);
  document.getElementById('alt-search-year').value = movie.year || '';
  document.getElementById('search-results').innerHTML = '';

  // Set slideshow toggle (defaults to true if not explicitly set)
  document.getElementById('slideshow-enabled').checked = movie.slideshowEnabled !== false;

  document.getElementById('movie-modal').classList.add('active');
}

function closeModal() {
  document.getElementById('movie-modal').classList.remove('active');
  currentMovie = null;
}

async function searchAlternatives() {
  const title = document.getElementById('alt-search-title').value;
  const year = document.getElementById('alt-search-year').value;
  const resultsDiv = document.getElementById('search-results');

  if (!title) {
    alert('Please enter a movie title');
    return;
  }

  resultsDiv.innerHTML = '<div class="loading">Searching TMDb...</div>';

  try {
    const response = await fetch(`/api/movies/search?title=${encodeURIComponent(title)}&year=${year}`);
    const data = await response.json();

    if (data.results && data.results.length > 0) {
      resultsDiv.innerHTML = data.results.map(result => `
        <div class="result-item">
          <div>
            ${result.posterUrl
              ? `<img src="${result.posterUrl}" alt="${escapeHtml(result.title)}" class="result-poster">`
              : `<div class="result-poster" style="background: #333; width: 80px; height: 120px;"></div>`
            }
          </div>
          <div class="result-info">
            <h4>${escapeHtml(result.title)} (${result.year || 'N/A'}) <span style="background: ${result.mediaType === 'tv' ? '#9333ea' : '#2563eb'}; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 600;">${result.mediaType === 'tv' ? 'TV' : 'MOVIE'}</span></h4>
            <p><strong>TMDb ID:</strong> ${result.tmdbId}</p>
            <p><strong>Type:</strong> ${result.mediaType === 'tv' ? 'TV Series' : 'Movie'}</p>
            <p><strong>Rating:</strong> ${result.voteAverage ? `★ ${result.voteAverage.toFixed(1)}` : 'N/A'}</p>
            <p><strong>RT:</strong> ${result.rottenTomatoes || 'N/A'}</p>
            <p><strong>Tagline:</strong> ${result.tagline || 'None'}</p>
            ${result.overview ? `<p style="margin-top: 8px;">${escapeHtml(result.overview.substring(0, 150))}...</p>` : ''}
          </div>
          <div>
            <button onclick="applyMetadata(${result.tmdbId}, '${result.mediaType}')">Apply This Match</button>
          </div>
        </div>
      `).join('');
    } else {
      resultsDiv.innerHTML = '<div class="loading">No results found</div>';
    }
  } catch (error) {
    console.error('Error searching:', error);
    resultsDiv.innerHTML = '<div class="loading">Error searching TMDb</div>';
  }
}

async function applyMetadata(tmdbId, mediaType) {
  if (!currentMovie) return;

  if (!confirm(`Apply this metadata to "${decodeEntities(currentMovie.title)}"?`)) {
    return;
  }

  try {
    const response = await fetch('/api/movies/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        source: currentMovie.source,
        originalTitle: currentMovie.title,
        tmdbId: tmdbId,
        mediaType: mediaType || 'movie'
      })
    });

    const result = await response.json();

    if (result.success) {
      alert('Metadata updated successfully!');
      closeModal();
      loadMovies(); // Reload the list
    } else {
      alert('Error updating metadata: ' + (result.error || 'Unknown error'));
    }
  } catch (error) {
    console.error('Error updating metadata:', error);
    alert('Error updating metadata: ' + error.message);
  }
}

async function toggleSlideshow() {
  if (!currentMovie) return;

  const enabled = document.getElementById('slideshow-enabled').checked;

  try {
    const response = await fetch('/api/movies/toggle-slideshow', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        source: currentMovie.source,
        title: currentMovie.title,
        enabled: enabled
      })
    });

    const result = await response.json();

    if (result.success) {
      currentMovie.slideshowEnabled = enabled;
      // Update in allMovies array
      const movieIndex = allMovies.findIndex(m =>
        m.title === currentMovie.title && m.source === currentMovie.source
      );
      if (movieIndex !== -1) {
        allMovies[movieIndex].slideshowEnabled = enabled;
      }
    } else {
      alert('Error updating slideshow setting: ' + (result.error || 'Unknown error'));
      // Revert checkbox
      document.getElementById('slideshow-enabled').checked = !enabled;
    }
  } catch (error) {
    console.error('Error toggling slideshow:', error);
    alert('Error updating slideshow setting: ' + error.message);
    // Revert checkbox
    document.getElementById('slideshow-enabled').checked = !enabled;
  }
}

async function toggleSlideshowFromGrid(title, source, element) {
  const checkbox = element.querySelector('input[type="checkbox"]');
  const enabled = checkbox.checked;

  try {
    const response = await fetch('/api/movies/toggle-slideshow', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        source: source,
        title: title,
        enabled: enabled
      })
    });

    const result = await response.json();

    if (result.success) {
      // Update in allMovies array
      const movieIndex = allMovies.findIndex(m =>
        m.title === title && m.source === source
      );
      if (movieIndex !== -1) {
        allMovies[movieIndex].slideshowEnabled = enabled;
      }
      // Update tooltip
      checkbox.title = enabled ? 'Enabled in slideshow' : 'Disabled in slideshow';
    } else {
      alert('Error updating slideshow setting: ' + (result.error || 'Unknown error'));
      // Revert checkbox
      checkbox.checked = !enabled;
    }
  } catch (error) {
    console.error('Error toggling slideshow:', error);
    alert('Error updating slideshow setting: ' + error.message);
    // Revert checkbox
    checkbox.checked = !enabled;
  }
}

/**
 * Turn the stored form of a title ("Wallace &amp; Gromit") into readable text.
 * Use this whenever a title is assigned to textContent or put in a confirm().
 */
function decodeEntities(text) {
  const div = document.createElement('div');
  div.innerHTML = text ?? '';
  return div.textContent;
}

function escapeHtml(text) {
  // Library titles arrive already entity-encoded ("Wallace &amp; Gromit"), so
  // decode first or the page shows the raw entity. Then re-escape - including
  // quotes, which textContent->innerHTML leaves alone and which would break out
  // of any attribute this lands in.
  const div = document.createElement('div');
  div.innerHTML = text ?? '';

  return div.textContent
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeHtml(text) {
  const div = document.createElement('div');
  div.innerHTML = text;
  return div.textContent;
}

// Close modal when clicking outside
document.getElementById('movie-modal').addEventListener('click', (e) => {
  if (e.target.id === 'movie-modal') {
    closeModal();
  }
});

document.getElementById('settings-modal').addEventListener('click', (e) => {
  if (e.target.id === 'settings-modal') {
    closeSettings();
  }
});

const SECRET_MASK_PREFIX = '••••';

/**
 * Credential fields hold a server-side mask like "••••••••1a2b" until you type.
 *
 * The mask must render as plain text or the browser bullets out the very
 * last-four characters that make it useful. Once the value stops being the
 * mask, the field is holding a real key and switches to password.
 */
function initSecretField(id) {
  const field = document.getElementById(id);
  if (!field) return;

  const applyType = () => {
    const isMask = field.value === '' || field.value.startsWith(SECRET_MASK_PREFIX);
    field.type = isMask ? 'text' : 'password';
  };

  applyType();

  if (field.dataset.secretBound) return;   // openSettings() can run repeatedly
  field.dataset.secretBound = 'true';

  // Select the mask so typing replaces it outright rather than appending
  field.addEventListener('focus', () => {
    if (field.value.startsWith(SECRET_MASK_PREFIX)) field.select();
  });
  field.addEventListener('input', applyType);
}

// Settings Management
async function openSettings() {
  try {
    const response = await fetch('/api/settings');
    const settings = await response.json();

    // Populate form
    document.getElementById('tmdb-key').value = settings.tmdb?.apiKey || '';
    document.getElementById('tmdb-token').value = settings.tmdb?.readToken || '';
    document.getElementById('omdb-key').value = settings.omdb?.apiKey || '';
    document.getElementById('k-player-host').value = settings.kaleidescape?.playerHost || '';
    document.getElementById('k-port').value = settings.kaleidescape?.port || '';
    document.getElementById('k-server-host').value = settings.kaleidescape?.serverHost || '';
    document.getElementById('plex-url').value = settings.plex?.url || '';
    document.getElementById('plex-token').value = settings.plex?.token || '';
    document.getElementById('jellyfin-url').value = settings.jellyfin?.url || '';
    document.getElementById('jellyfin-key').value = settings.jellyfin?.apiKey || '';
    savedJellyfinLibraryIds = Array.isArray(settings.jellyfin?.libraryIds)
      ? settings.jellyfin.libraryIds
      : null;

    // Media system toggles (absent means enabled, matching the server default)
    document.getElementById('source-kaleidescape').checked = settings.sources?.kaleidescape !== false;
    document.getElementById('source-plex').checked = settings.sources?.plex !== false;
    document.getElementById('source-jellyfin').checked = settings.sources?.jellyfin !== false;

    // The masked placeholder isn't a secret, so it's shown as plain text -
    // that's the only way the last four characters are actually readable.
    // The field flips to password as soon as a real key is being typed.
    ['tmdb-key', 'tmdb-token', 'omdb-key', 'plex-token', 'jellyfin-key']
      .forEach(initSecretField);
    // Convert milliseconds to seconds for display
    document.getElementById('poll-interval').value = (settings.pollInterval || 10000) / 1000;
    document.getElementById('slideshow-interval').value = (settings.slideshowInterval || 30000) / 1000;

    // Load display scale from server settings
    const displayScale = settings.displayScale || 1.0;
    document.getElementById('display-scale').value = displayScale;
    document.getElementById('scale-value').textContent = displayScale;

    // Load allowed ratings
    const allowedRatings = settings.allowedRatings || ['G', 'PG', 'PG-13', 'R', 'NC-17', 'NR'];
    document.getElementById('rating-g').checked = allowedRatings.includes('G');
    document.getElementById('rating-pg').checked = allowedRatings.includes('PG');
    document.getElementById('rating-pg13').checked = allowedRatings.includes('PG-13');
    document.getElementById('rating-r').checked = allowedRatings.includes('R');
    document.getElementById('rating-nc17').checked = allowedRatings.includes('NC-17');
    document.getElementById('rating-nr').checked = allowedRatings.includes('NR');

    document.getElementById('settings-modal').classList.add('active');
    loadJellyfinLibraries();
  } catch (error) {
    console.error('Error loading settings:', error);
    alert('Error loading settings: ' + error.message);
  }
}

async function loadJellyfinLibraries() {
  const container = document.getElementById('jellyfin-libraries');
  jellyfinLibrariesLoaded = false;
  container.innerHTML = '<small style="color:#888;">Loading libraries…</small>';

  try {
    const response = await fetch('/api/jellyfin/libraries');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to load libraries');
    jellyfinLibrariesLoaded = true;

    if (!data.libraries.length) {
      container.innerHTML = '<small style="color:#888;">No movie or TV libraries found.</small>';
      return;
    }

    container.innerHTML = data.libraries.map(library => {
      const checked = savedJellyfinLibraryIds === null || savedJellyfinLibraryIds.includes(library.id);
      const type = library.collectionType === 'tvshows' ? 'TV shows' : 'Movies';
      return `<label><input type="checkbox" class="jellyfin-library" value="${escapeHtml(library.id)}" ${checked ? 'checked' : ''}><span>${escapeHtml(library.name)} <small style="color:#888;">(${type})</small></span></label>`;
    }).join('');
  } catch (error) {
    container.innerHTML = `<small style="color:#dc2626;">${escapeHtml(error.message)}. Save the server URL and API key first, then reopen settings.</small>`;
  }
}

function closeSettings() {
  document.getElementById('settings-modal').classList.remove('active');
}

function updateScaleValue(value) {
  document.getElementById('scale-value').textContent = value;
}

async function saveSettings(event) {
  event.preventDefault();

  const settings = {
    sources: {
      kaleidescape: document.getElementById('source-kaleidescape').checked,
      plex: document.getElementById('source-plex').checked,
      jellyfin: document.getElementById('source-jellyfin').checked
    },
    tmdb: {
      apiKey: document.getElementById('tmdb-key').value,
      readToken: document.getElementById('tmdb-token').value
    },
    omdb: {
      apiKey: document.getElementById('omdb-key').value
    },
    kaleidescape: {
      playerHost: document.getElementById('k-player-host').value,
      port: parseInt(document.getElementById('k-port').value) || 10000,
      serverHost: document.getElementById('k-server-host').value || undefined
    },
    plex: {
      url: document.getElementById('plex-url').value,
      token: document.getElementById('plex-token').value
    },
    jellyfin: {
      url: document.getElementById('jellyfin-url').value,
      apiKey: document.getElementById('jellyfin-key').value,
      libraryIds: jellyfinLibrariesLoaded
        ? Array.from(document.querySelectorAll('.jellyfin-library:checked')).map(input => input.value)
        : savedJellyfinLibraryIds
    },
    // Convert seconds to milliseconds for server
    pollInterval: (parseInt(document.getElementById('poll-interval').value) || 10) * 1000,
    slideshowInterval: (parseInt(document.getElementById('slideshow-interval').value) || 30) * 1000,
    displayScale: parseFloat(document.getElementById('display-scale').value) || 1.0,
    // Collect allowed ratings
    allowedRatings: [
      document.getElementById('rating-g').checked && 'G',
      document.getElementById('rating-pg').checked && 'PG',
      document.getElementById('rating-pg13').checked && 'PG-13',
      document.getElementById('rating-r').checked && 'R',
      document.getElementById('rating-nc17').checked && 'NC-17',
      document.getElementById('rating-nr').checked && 'NR'
    ].filter(Boolean)
  };

  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(settings)
    });

    const result = await response.json();

    if (result.success) {
      alert('Settings saved successfully!\n\nDisplay scale will update automatically within a few seconds.\nOther settings require a server restart to take effect.');
      closeSettings();
    } else {
      alert('Error saving settings: ' + (result.error || 'Unknown error'));
    }
  } catch (error) {
    console.error('Error saving settings:', error);
    alert('Error saving settings: ' + error.message);
  }
}

async function clearCache() {
  if (!confirm('Clear all cached metadata and re-fetch it from TMDb?\n\nThis takes a few minutes for a large library. The poster display keeps running on the existing metadata until the rebuild finishes.')) {
    return;
  }

  try {
    const response = await fetch('/api/clear-cache', { method: 'POST' });
    const result = await response.json();

    if (!result.success) {
      alert('Error clearing cache: ' + (result.error || 'Unknown error'));
      return;
    }

    closeSettings();
    watchRebuild();
  } catch (error) {
    console.error('Error clearing cache:', error);
    alert('Error clearing cache: ' + error.message);
  }
}

/**
 * Poll until the background rebuild finishes, then refresh the grid.
 * The server no longer restarts, so there is nothing to wait out blindly.
 */
async function watchRebuild() {
  const grid = document.getElementById('movies-grid');
  grid.innerHTML = '<div class="loading">Rebuilding metadata from TMDb… this can take a few minutes. The display keeps running.</div>';

  for (let i = 0; i < 600; i++) {           // give up after ~20 minutes
    await new Promise(r => setTimeout(r, 2000));
    try {
      const status = await (await fetch('/api/loading')).json();
      if (!status.rebuilding) {
        await loadMovies();
        return;
      }
    } catch (error) {
      // server busy mid-rebuild; keep waiting
    }
  }

  grid.innerHTML = '<div class="loading">Rebuild is taking unusually long — check the container log.</div>';
}
