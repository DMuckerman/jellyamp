import {Howl, Howler} from 'howler';
import Vue from 'vue';
import _ from 'lodash';

import JellyfinService from './jellyfin';

import placeholderImg from '../assets/logo.png';

Vue.filter('duration', value => {
  if (!value) {
    value = 0;
  }

  const minutes = Math.floor(value / 60) || 0;
  const seconds = Math.round((value - minutes * 60) || 0);

  return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
});

class Player {
  playlist = [];
  index = null;
  player = null;
  viewModel = null;
  showPlaylist = false;
  playing = true;

  lastPrev = -1;

  updateProgress = _.throttle(ticks => {
    const data = {
      IsPaused: false,
      PositionTicks: ticks, // Convert to ticks/ns
      PlayMethod: 'Transcode',
      PlaySessionId: this.playlist[this.index].params.PlaySessionId,
      ItemId: this.playlist[this.index].Id,
      EventName: 'timeupdate',
    };

    JellyfinService.updateProgress(data);
  }, 10000);

  updateProgressMpris = _.throttle(ticks => {
    if (window.ipcRenderer) {
      window.ipcRenderer.send('updateTime', Math.floor(ticks / 1000)); // nanoseconds to microseconds
    }
  }, 1000);

  // Make it a singleton
  constructor() {
    if (!Player.instance) {
      Player.instance = this;
    }

    return Player.instance;
  }

  clearHowl() {
    this.player.unload();
    this.player = null;
    this.playlist[this.index].howl = null;
  }

  setPlaylist(playlist) {
    if (this.player) {
      this.player.stop();
      this.player = null;
    }

    Howler.stop();

    this.playlist = _.map(playlist, (item, index) => {
      const songUrl = JellyfinService.getItemImageUrl(item);
      item.thumbnailImage = songUrl ? songUrl : placeholderImg;

      item.artist = item.Artists[0] || item.AlbumArtist;
      item.loved = item.UserData.IsFavorite || false;

      // Preload the first 3 items in the playlist
      if (index < 3) {
        item.howl = this.createHowl(item);
      }

      return item;
    });

    this.play(0);
  }

  injectPlaylist(playlist) {
    const updatePlaylist = _.map(playlist, item => {
      const songUrl = JellyfinService.getItemImageUrl(item);
      item.thumbnailImage = songUrl ? songUrl : placeholderImg;

      item.artist = item.Artists[0] || item.AlbumArtist;
      item.loved = item.UserData.IsFavorite || false;

      return item;
    });

    if (this.index === this.playlist.length - 1) {
      this.playlist = [...this.playlist, ...updatePlaylist];
    } else {
      this.playlist.splice(this.index + 1, 0, ...playlist);
    }
  }

  removeItem(index) {
    this.playlist.splice(index, 1);

    if (index < this.index) {
      this.index -= 1;
    }
  }

  async likeItem() {
    if (!this.player) {
      return;
    }

    try {
      if (this.playlist[this.index].loved) {
        await JellyfinService.unlikeId(this.playlist[this.index].Id);
        this.playlist[this.index].loved = false;
      } else {
        await JellyfinService.likeId(this.playlist[this.index].Id);
        this.playlist[this.index].loved = true;
      }
    } catch (e) {
      console.log(e);
    }
  }

  createHowl(item) {
    const [url, params] = JellyfinService.getItemPlayUrl(item.Id);
    item.params = params;

    const howl = new Howl({
      src: [url],
      html5: true,
      format: ['aac'],
      onplay: () => {
        this.playing = true;

        if (this.viewModel && this.viewModel.$el) {
          const images = this.viewModel.$el.querySelectorAll('.update-img');
          images.forEach((image, index) => {
            image.setAttribute('src', this.playlist[this.index].thumbnailImage);

            if (this.playlist[this.index].thumbnailImage === placeholderImg && index === 0) {
              image.removeAttribute('src');
            }
          });
        }

        JellyfinService.updatePlaying({
          IsPaused: false,
          PositionTicks: 0,
          PlayMethod: 'Transcode',
          PlaySessionId: item.params.PlaySessionId,
          ItemId: item.Id,
        });

        requestAnimationFrame(() => this.step());

        if (window.ipcRenderer) {
          const data = {
            name: item.Name,
            artist: item.Artists,
            album: item.Album,
            img: item.thumbnailImage,
            duration: Math.floor(item.RunTimeTicks / 1000), // nanoseconds to microseconds
          };

          window.ipcRenderer.send('play', data);
        }
      },
      onend: () => {
        this.skip('next');

        JellyfinService.stopPlaying({
          IsPaused: false,
          PlayMethod: 'Transcode',
          PositionTicks: item.progressInTicks,
          PlaySessionId: item.params.PlaySessionId,
          ItemId: item.Id,
        });
      },
      onpause: () => {
        this.playing = false;

        if (window.ipcRenderer) {
          window.ipcRenderer.send('pause');
        }
      },
      onstop: () => {
        this.playing = false;

        if (window.ipcRenderer) {
          window.ipcRenderer.send('stop');
        }

        JellyfinService.stopPlaying({
          IsPaused: false,
          PlayMethod: 'Transcode',
          PositionTicks: item.progressInTicks,
          PlaySessionId: item.params.PlaySessionId,
          ItemId: item.Id,
        });
      },
      onloaderror: err => {
        console.log(err);
        if (this.viewModel) {
          this.viewModel.$buefy.toast.open({
            message: 'Playback failed.',
            type: 'is-danger'
          });
        }

        this.skip('next');
      },
      onplayerror: err => {
        console.log(err);
        if (this.viewModel) {
          this.viewModel.$buefy.toast.open({
            message: 'Could not play song.',
            type: 'is-danger'
          });
        }

        this.skip('next');
      }
    });

    return howl;
  }

  play(index) {
    if (!this.playlist.length || index < 0 || index >= this.playlist.length) {
      return;
    }

    if (this.player) {
      this.player.stop();
    }

    this.index = index;
    const data = this.playlist[index];

    if (!data.howl) {
      data.howl = this.createHowl(data);
    }

    this.player = data.howl;

    this.player.play();
  }

  playPause() {
    if (!this.player) {
      return;
    }

    if (this.playing) {
      this.player.pause();
    } else {
      this.player.play();
    }
  }

  stop() {
    if (!this.player) {
      return;
    }

    Howler.stop();
  }

  seek(percentage) {
    if (!this.player) {
      return;
    }

    if (this.player.playing()) {
      this.player.seek(this.player.duration() * (percentage / 100));
    }
  }

  step() {
    if (!this.player) {
      return;
    }

    const seek = this.player.seek() || 0;

    if (this.viewModel && seek) {
      this.viewModel.currentPlayTime = Math.round(seek);
      this.viewModel.currentProgress = ((seek / this.player.duration()) * 100) || 0;
    }

    if (this.player.playing()) {
      // requestAnimationFrame(() => this.step()); // This binds up the CPU
      setTimeout(() => this.step(), 250);

      const ticks = Math.round(seek * 10000000);

      this.playlist[this.index].progressInTicks = ticks;
      this.updateProgress(ticks);
      this.updateProgressMpris(ticks);
    }
  }

  handleBack() {
    if (!this.player) {
      return;
    }

    const seek = this.player.seek() || 0;

    if (seek < 5 && this.lastPrev === this.index) {
      this.skip('prev');
    }

    this.lastPrev = this.index;
    this.seek(0);
  }

  skip(dir) {
    let index = this.index;

    if (dir === 'next') {
      index = index + 1;
      if (index >= this.playlist.length) {
        this.clearHowl();
      }
    } else {
      index = index - 1;
      if (index < 0) {
        this.clearHowl();
      }
    }

    this.skipTo(index);
  }

  skipTo(index) {
    if (!this.player) {
      return;
    }

    this.clearHowl();
    this.play(index);
  }
}

const PlayerService = new Player();

export default PlayerService;

// MPRIS event listeners
if (window.ipcRenderer) {
  window.ipcRenderer.on('skip', () => {
    PlayerService.skip('next');
  });

  window.ipcRenderer.on('prev', () => {
    PlayerService.handleBack();
  });

  window.ipcRenderer.on('playPause', () => {
    PlayerService.playPause();
  });

  window.ipcRenderer.on('stop', () => {
    PlayerService.stop();
  });
}

console.log(PlayerService);
