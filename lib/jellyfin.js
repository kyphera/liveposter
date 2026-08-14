const axios = require('axios');

/**
 * Jellyfin Media Server Integration
 */
class JellyfinClient {
  constructor(url, apiKey) {
    this.url = url.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = apiKey;
    this.axios = axios.create({
      baseURL: this.url,
      headers: {
        'X-Emby-Token': apiKey
      }
    });
  }

  async getSessions() {
    try {
      const response = await this.axios.get('/Sessions');
      return response.data;
    } catch (error) {
      // Only log errors occasionally to avoid spam
      if (!this.lastError || this.lastError !== error.message) {
        console.error('Error getting Jellyfin sessions:', error.message);
        this.lastError = error.message;
      }
      return null;
    }
  }

  async getNowPlaying() {
    try {
      const sessions = await this.getSessions();

      if (!sessions || !Array.isArray(sessions) || sessions.length === 0) {
        return null;
      }

      // Find first session with NowPlayingItem
      const playingSession = sessions.find(s => s.NowPlayingItem);

      if (!playingSession || !playingSession.NowPlayingItem) {
        return null;
      }

      const item = playingSession.NowPlayingItem;

      return {
        playing: true,
        type: item.Type.toLowerCase(), // movie, episode, audio
        title: item.Name,
        seriesName: item.SeriesName, // For episodes
        seasonName: item.SeasonName, // For episodes
        year: item.ProductionYear,
        thumb: this.getImageUrl(item.Id, 'Primary'),
        backdrop: this.getImageUrl(item.Id, 'Backdrop'),
        rating: item.CommunityRating,
        officialRating: item.OfficialRating,
        summary: item.Overview,
        duration: item.RunTimeTicks ? item.RunTimeTicks / 10000 : null, // Convert ticks to milliseconds
        viewOffset: playingSession.PlayState?.PositionTicks ? playingSession.PlayState.PositionTicks / 10000 : null, // Convert ticks to milliseconds
        playerState: playingSession.PlayState?.IsPaused ? 'paused' : 'playing',
        source: 'jellyfin'
      };
    } catch (error) {
      console.error('Error getting Jellyfin now playing:', error.message);
      return null;
    }
  }

  async getMovieLibrary(selectedLibraryIds = null) {
    try {
      const libraries = await this.getLibraries(selectedLibraryIds);
      const results = await Promise.all(libraries.map(async library => {
        let response;
        try {
          response = await this.axios.get('/Items', {
            params: {
              ParentId: library.id,
              IncludeItemTypes: library.collectionType === 'tvshows' ? 'Series' : 'Movie',
              Recursive: true,
              Fields: 'Overview,CommunityRating,OfficialRating',
              SortBy: 'SortName',
              SortOrder: 'Ascending'
            }
          });
        } catch (error) {
          console.error(`Error getting Jellyfin library "${library.name}":`, error.message);
          return [];
        }

        return (response.data.Items || []).map(item => ({
          title: item.Name,
          year: item.ProductionYear,
          thumb: this.getImageUrl(item.Id, 'Primary'),
          backdrop: this.getImageUrl(item.Id, 'Backdrop'),
          rating: item.CommunityRating,
          officialRating: item.OfficialRating,
          summary: item.Overview,
          mediaType: item.Type === 'Series' ? 'show' : 'movie',
          libraryId: library.id,
          libraryName: library.name,
          source: 'jellyfin'
        }));
      }));

      return results.flat();
    } catch (error) {
      console.error('Error getting Jellyfin movie and TV libraries:', error.message);
      return [];
    }
  }

  async getLibraries(selectedLibraryIds = null) {
    const response = await this.axios.get('/Library/MediaFolders');
    const selected = Array.isArray(selectedLibraryIds) ? new Set(selectedLibraryIds) : null;

    return (response.data.Items || [])
      .filter(library => ['movies', 'tvshows'].includes(library.CollectionType))
      .filter(library => !selected || selected.has(library.Id))
      .map(library => ({
        id: library.Id,
        name: library.Name,
        collectionType: library.CollectionType
      }));
  }

  getImageUrl(itemId, imageType = 'Primary') {
    if (!itemId) return null;
    return `${this.url}/Items/${itemId}/Images/${imageType}?api_key=${this.apiKey}`;
  }

  async testConnection() {
    try {
      const response = await this.axios.get('/System/Info');
      return response.status === 200;
    } catch (error) {
      if (error.code === 'EHOSTUNREACH' || error.code === 'ENOTFOUND') {
        console.error(`Jellyfin connection failed: Cannot reach ${this.url}`);
      } else if (error.code === 'ECONNREFUSED') {
        console.error(`Jellyfin connection failed: Connection refused at ${this.url}`);
      } else {
        console.error('Jellyfin connection test failed:', error.message);
      }
      return false;
    }
  }
}

module.exports = JellyfinClient;
