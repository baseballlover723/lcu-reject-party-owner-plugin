import LcuPlugin from 'lcu-plugin';
import axios from 'axios';

const CURRENT_SUMMONER_ENDPOINT = 'lol-summoner/v1/current-summoner';
const MEMBERS_ENDPOINT = 'lol-lobby/v2/lobby/members';
const CHAT_ENDPOINTS = {
  base: '/lol-chat/v1/conversations',
  suffix: '%40sec.na1.pvp.net/messages',
};
const PROMOTE_ENDPOINTS = {
  base: 'lol-lobby/v2/lobby/members',
  suffix: 'promote',
};

const CONVERSATIONS_EVENT = 'OnJsonApiEvent_lol-chat_v1_conversations';
const LOBBY_EVENT = 'OnJsonApiEvent_lol-lobby_v2_comms';
// TODO on repeated lobby promotions to me, eventually do random leader

export default class RejectPartyOwnerLcuPlugin extends LcuPlugin {
  onConnect(clientData) {
    axios.defaults.baseURL = `${clientData.protocol}://${clientData.address}:${clientData.port}`;
    axios.defaults.auth = { username: clientData.username, password: clientData.password };
    return this.createPromise((resolve, reject) => {
      this.getCurrentSummoner().catch((error) => {
        reject(error);
      }).then((summonerId) => {
        this.getCurrentLobbyLeader().then((lastPartyLeader) => {
          this.enabled = true;
          this.lastPartyLeader = lastPartyLeader;
          this.subscribeEvent(CONVERSATIONS_EVENT, this.handleLobbyChat(summonerId));
          this.subscribeEvent(LOBBY_EVENT, this.handleLobbyMemberChange(summonerId));
          this.log('is ready');
          resolve();
        });
      });
    });
  }

  getCurrentLobbyLeader() {
    return this.createPromise((resolve, reject) => {
      axios.get(MEMBERS_ENDPOINT).then((resp) => {
        resolve(this.convertLobbyMemberToComms(resp.data.find((player) => player.isLeader)));
      }).catch((error) => {
        resolve();
      });
    });
  }

  convertLobbyMemberToComms(lobbyPlayer) {
    return { displayName: lobbyPlayer.summonerName, gameName: lobbyPlayer.summonerName, summonerId: lobbyPlayer.summonerId };
  }

  getCurrentSummoner(retriesLeft = 20) {
    return this.createPromise((resolve, reject) => {
      this.getCurrentSummonerHelper(retriesLeft, resolve, reject);
    });
  }

  getCurrentSummonerHelper(retriesLeft, resolve, reject) {
    axios.get(CURRENT_SUMMONER_ENDPOINT).then((resp) => {
      resolve(resp.data.summonerId);
    }).catch((error) => {
      if ((error.code !== 'ECONNREFUSED' && error?.response?.status >= 500) || retriesLeft <= 0) {
        this.log('error in getting current summoner', error);
        reject(error);
      }
      setTimeout(() => {
        this.getCurrentSummonerHelper(retriesLeft - 1, resolve, reject);
      }, 1000);
    });
  }

  async getLobbyMembers() {
    return axios.get(MEMBERS_ENDPOINT);
  }

  playerExists(players, summonerId) {
    return players.data.some((player) => summonerId === player.summonerId);
  }

  amLeader(currentSummonerId, players) {
    return players.data.some((player) => currentSummonerId === player.summonerId && player.isLeader);
  }

  async promote(summonerId) {
    const promoteUrl = `${PROMOTE_ENDPOINTS.base}/${summonerId}/${PROMOTE_ENDPOINTS.suffix}`;
    return axios.post(promoteUrl);
  }

  sendMessage(chatUrl, message) {
    return axios.post(chatUrl, { body: message });
  }

  handleLobbyChat(currentSummonerId) {
    return async (event) => {
      if (event.eventType !== 'Create') {
        return;
      }
      // this.log('received party chat: ', event);
      if (event.data.type !== 'groupchat') {
        return;
      }
      // this.log('received party chat: ', event);
      if (event.data.fromSummonerId !== currentSummonerId) {
        return;
      }

      if (/enable party (leader|owner)/i.test(event.data.body)) {
        this.enabled = false;
        this.log('disabling plugin');
      } else if (/disable party (leader|owner)/i.test(event.data.body)) {
        this.enabled = true;
        this.log('enabling plugin');
      }
    };
  }

  chooseRandomPlayer(players, currentSummonerId) {
    const otherPlayers = players.data.filter((player) => player.summonerId !== currentSummonerId);
    return otherPlayers[this.getRandomInt(otherPlayers.length)];
  }

  handleLobbyMemberChange(currentSummonerId) {
    return async (event) => {
      const partySize = Object.keys(event.data.players).length;

      if (partySize <= 1) {
        this.log("I'm alone in the party, no one else to make party leader");
        return;
      }
      if (!Object.values(event.data.players).some((player) => player.summonerId === currentSummonerId && player.role === 'LEADER')) {
        this.lastPartyLeader = Object.values(event.data.players).find((player) => player.role === 'LEADER');
        this.log('Someone else was made party leader: ', this.lastPartyLeader.gameName);
        return;
      }
      if (typeof this.lastPartyLeader === 'undefined') {
        this.log('I was always party leaders, thus ignoring');
        return;
      }

      /// To avoid race conditions
      let { lastPartyLeader } = this;
      this.log('I was made party leader, lastPartyLeader: ', lastPartyLeader.gameName);

      if (!this.enabled) {
        this.log('plugin disabled so ignoring');
        return;
      }

      const players = await this.getLobbyMembers();
      if (!this.amLeader(currentSummonerId, players)) {
        this.log('Ignoring since I am not party leader anymore');
        return;
      }

      if (!this.playerExists(players, lastPartyLeader.summonerId)) {
        const oldLastPartyLeader = this.lastPartyLeader;
        this.lastPartyLeader = this.chooseRandomPlayer(players, currentSummonerId);
        lastPartyLeader = this.lastPartyLeader;
        this.log(`player ${oldLastPartyLeader.gameName} isn't in the party anymore, selecting ${lastPartyLeader.gameName} instead`);
      }

      await this.promote(lastPartyLeader.summonerId);
      const chatUrl = `${CHAT_ENDPOINTS.base}/${event.data.partyId}${CHAT_ENDPOINTS.suffix}`;
      await this.sendMessage(chatUrl, `${lastPartyLeader.gameName}, I do not wish to be party leader`);
    };
  }

  getRandomInt(max) {
    return Math.floor(Math.random() * max);
  }
}
