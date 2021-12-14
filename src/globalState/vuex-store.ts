import Vue from "vue";
import Vuex, {ActionContext} from "vuex";
import {createDirectStore} from "direct-vuex";
import {LoginGW, News, RootState, W3cToken} from "@/globalState/rootTypings";

import updateHandling from "../update-handling/updateStore";
import colorPicker from "../color-picker/colorSetStore";
import hotKeys from "../hot-keys/hotkeyStore";
import {UpdateService} from "@/update-handling/UpdateService";
import {UpdateHandlingState} from "@/update-handling/updateTypes";
import {VersionService} from "@/globalState/VersionService";
import {EndpointService, IEndpoint} from "@/globalState/EndpointService";
import {
  IDENTIFICATION_PUBLIC_KEY_PROD,
  OAUTH_ENABLED,
} from "@/constants";
import {ItemHotkeyRegistrationService} from "@/hot-keys/ItemHotkeyRegistrationService";
import {FileService} from "@/update-handling/FileService";
import {AuthenticationService} from "@/globalState/AuthenticationService";
import logger from "@/logger";
import { ICurrentGameInfo, IFloWorkerEvent, IGameSlotClientStatusUpdate, IGameStatusUpdate, IPlayerSession, IPlayerSessionUpdate } from "@/flo-integration/flo-worker-messages";

const { ipcRenderer } = window.require("electron");

Vue.use(Vuex);
const services = {
  updateService: new UpdateService(),
  versionService: new VersionService(),
  fileService: new FileService(),
  itemHotkeyService: new ItemHotkeyRegistrationService(),
  authService: new AuthenticationService(),
  endpointService: new EndpointService(),
};

const mod = {
  modules: {
    updateHandling,
    hotKeys,
    colorPicker,
  },
  state: {
    isTest: false,
    selectedEndpoint: null,
    identificationPublicKey: IDENTIFICATION_PUBLIC_KEY_PROD,
    news: [] as News[],
    w3cToken: null,
    selectedLoginGateway: LoginGW.none,
    floStatus: null,
  } as RootState,
  actions: {
    async init(context: ActionContext<unknown, RootState>) {
      const { commit, state } = moduleActionContext(context, mod);
      try {
        const selected = await services.endpointService.selectFastestEndpoint(state.isTest)
        // only check for update if overrideUpdateFileDownloadUrl is not set
        // it's not worth it to fix electron-updater for China
        if (!selected.overrideUpdateFileDownloadUrl) {
          await ipcRenderer.invoke('w3c-check-for-update');
        }
        commit.SET_ENDPOINT(selected);
      } catch (e) {
        logger.error(e);
      }
    },
    async loadNews(context: ActionContext<UpdateHandlingState, RootState>) {
      const { commit, state } = moduleActionContext(context, mod);

      try {
        const news = await (
            await fetch(`${services.endpointService.selected.newsUrl}api/admin/news`)
        ).json();

        commit.SET_NEWS(news);
      } catch (e) {
        commit.SET_NEWS([]);
        logger.error(e);
      }
    },
    async setTestMode(context: ActionContext<UpdateHandlingState, RootState>, mode: boolean) {
      const { commit, rootGetters, dispatch } = moduleActionContext(context, mod);

      rootGetters.versionService.switchToMode(mode);
      commit.SET_IS_TEST(mode);

      await dispatch.init()
      dispatch.resetAuthentication();
    },
    loadIsTestMode(context: ActionContext<UpdateHandlingState, RootState>) {
      const { commit, rootGetters } = moduleActionContext(context, mod);

      const mode = rootGetters.versionService.loadMode();

      commit.SET_IS_TEST(mode);
    },
    loadOsMode(context: ActionContext<UpdateHandlingState, RootState>) {
      const { commit, rootGetters } = moduleActionContext(context, mod);

      commit.SET_OS(rootGetters.fileService.isWindows());
    },
    loadAuthToken(context: ActionContext<UpdateHandlingState, RootState>) {
      const { commit, rootGetters } = moduleActionContext(context, mod);

      const token = rootGetters.authService.loadAuthToken();
      const userInfo = rootGetters.authService.getUserInfo(token?.jwt ?? '')
      if (userInfo) {
        logger.info(`logged in as ${userInfo.battleTag}`)
        commit.SET_W3CAUTH_TOKEN(userInfo);
      }
    },
    async authorizeWithCode(
        context: ActionContext<UpdateHandlingState, RootState>,
        code: string
    ) {
      const { commit, rootGetters, dispatch, state } = moduleActionContext(context, mod);

      const token = await rootGetters.authService.authorize(code, state.selectedLoginGateway);
      if (token) {
        logger.info(`logged in as ${token.battleTag}`)
        commit.SET_W3CAUTH_TOKEN(token);
        await rootGetters.authService.saveAuthToken(token);
      }
      else {
        dispatch.resetAuthentication();
      }
    },
    setLoginGateway(
        context: ActionContext<UpdateHandlingState, RootState>,
        selectdGateway: LoginGW
    ) {
      const { commit } = moduleActionContext(context, mod);

      commit.SET_LOGIN_GW(selectdGateway);
    },
    resetAuthentication(
        context: ActionContext<UpdateHandlingState, RootState>,
        requestRelogin: boolean = true
    ) {
      const { commit, rootGetters, state } = moduleActionContext(context, mod);
      logger.info("reset auth token")

      commit.LOGOUT();
      rootGetters.authService.deleteAuthToken();
      if (requestRelogin && OAUTH_ENABLED) {
        ipcRenderer.send('oauth-requested', state.selectedLoginGateway);
      }
    },
    updateFloStatus(context: ActionContext<unknown, RootState>, msg: IFloWorkerEvent) {
      const { commit } = moduleActionContext(context, mod);
      commit.UPDATE_CURRENT_STATUS(msg);
    },
    async setChinaProxy(context: ActionContext<RootState, RootState>, enabled: boolean) {
      const { commit, rootGetters } = moduleActionContext(context, mod);

      commit.SET_IS_CHINA_PROXY_ENABLED(enabled);

      rootGetters.versionService.saveIsChinaProxyEnabled(enabled);
    },
  },
  mutations: {
    SET_IS_TEST(state: RootState, test: boolean) {
      state.isTest = test;
    },
    SET_NEWS(state: RootState, news: News[]) {
      state.news = news;
    },
    SET_OS(state: RootState, isWindows: boolean) {
      state.isWindows = isWindows;
    },
    SET_W3CAUTH_TOKEN(state: RootState, w3cToken: W3cToken | null) {
      state.w3cToken = w3cToken;
    },
    SET_LOGIN_GW(state: RootState, loginGateway: LoginGW) {
      state.selectedLoginGateway = loginGateway;
    },
    LOGOUT(state: RootState) {
      state.w3cToken = null;
    },
    UPDATE_CURRENT_STATUS(state: RootState, msg: IFloWorkerEvent) {
      switch (msg.type) {
        case 'PlayerSession': {
          const typed = msg as IPlayerSession
          state.floStatus = {
            ...(state.floStatus ? state.floStatus : {
              game: null,
              player_slot_status_map: {}
            }),
            player_id: typed.player?.id,
            name: typed.player?.name,
          }
          break
        }
        case 'PlayerSessionUpdate': {
          const typed = msg as IPlayerSessionUpdate
          if (!typed.game_id) {
            if (state.floStatus) {
              // state.floStatus.game = null
            }
          }
          break
        }
        case 'CurrentGameInfo': {
          if (state.floStatus) {
            state.floStatus.game = msg as ICurrentGameInfo
          }
          break
        }
        case 'GameStatusUpdate': {
          if (state.floStatus) {
            const typed = msg as IGameStatusUpdate
            if (typed.game_id === state.floStatus.game?.id) {
              state.floStatus.game.status = typed.status;
              for (const [player_id, status] of Object.entries(typed.updated_player_game_client_status_map)) {
                const slot = state.floStatus.game.slots.find(s => String(s.player?.id) === player_id)
                if (slot) {
                  slot.client_status = status
                }
              }
            }
          }
          break
        }
        case 'GameSlotClientStatusUpdate': {
          if (state.floStatus) {
            const typed = msg as IGameSlotClientStatusUpdate;
            if (typed.game_id === state.floStatus.game?.id) {
              state.floStatus.game.status = typed.status;
              const slot = state.floStatus.game.slots.find(s => s.player?.id === typed.player_id)
              if (slot) {
                slot.client_status = typed.status
              }
            }
          }
          break
        }
      }
    },
    SET_IS_CHINA_PROXY_ENABLED(state: RootState, enabled: boolean) {
      state.isChinaProxyEnabled = enabled
      if (enabled) {
        state.updateUrl = UPDATE_URL_PROD_CHINA;
        state.newsUrl = NEWS_URL_PROD_CHINA;
        state.identificationUrl = IDENTIFICATION_URL_PROD_CHINA;
        state.identificationPublicKey = IDENTIFICATION_PUBLIC_KEY_PROD;
      } else {
        const test = state.isTest
        state.updateUrl = test ? UPDATE_URL_TEST : UPDATE_URL_PROD;
        state.newsUrl = test ? NEWS_URL_TEST : NEWS_URL_PROD;
        state.identificationUrl = test ? IDENTIFICATION_URL_TEST : IDENTIFICATION_URL_PROD;
        state.identificationPublicKey = test ? IDENTIFICATION_PUBLIC_KEY_TEST : IDENTIFICATION_PUBLIC_KEY_PROD;
      }
    },
    UPDATE_CURRENT_STATUS(state: RootState, msg: IFloWorkerEvent) {
      switch (msg.type) {
        case 'PlayerSession': {
          const typed = msg as IPlayerSession
          state.floStatus = {
            ...(state.floStatus ? state.floStatus : {
              game: null,
              player_slot_status_map: {}
            }),
            player_id: typed.player?.id,
            name: typed.player?.name,
          }
          break
        }
        case 'PlayerSessionUpdate': {
          const typed = msg as IPlayerSessionUpdate
          if (!typed.game_id) {
            if (state.floStatus) {
              // state.floStatus.game = null
            }
          }
          break
        }
        case 'CurrentGameInfo': {
          if (state.floStatus) {
            state.floStatus.game = msg as ICurrentGameInfo
          }
          break
        }
        case 'GameStatusUpdate': {
          if (state.floStatus) {
            const typed = msg as IGameStatusUpdate
            if (typed.game_id === state.floStatus.game?.id) {
              state.floStatus.game.status = typed.status;
              for (const [player_id, status] of Object.entries(typed.updated_player_game_client_status_map)) {
                const slot = state.floStatus.game.slots.find(s => String(s.player?.id) === player_id)
                if (slot) {
                  slot.client_status = status
                }
              }
            }
          }
          break
        }
        case 'GameSlotClientStatusUpdate': {
          if (state.floStatus) {
            const typed = msg as IGameSlotClientStatusUpdate;
            if (typed.game_id === state.floStatus.game?.id) {
              state.floStatus.game.status = typed.status;
              const slot = state.floStatus.game.slots.find(s => s.player?.id === typed.player_id)
              if (slot) {
                slot.client_status = typed.status
              }
            }
          }
          break
        }
      }
    },
    SET_ENDPOINT(state: RootState, selected: IEndpoint) {
      state.selectedEndpoint = selected
    },
  },
  getters: {
    updateService() {
      return services.updateService;
    },
    versionService() {
      return services.versionService;
    },
    itemHotkeyService() {
      return services.itemHotkeyService;
    },
    fileService() {
      return services.fileService;
    },
    authService() {
      return services.authService;
    },
    endpointService() {
      return services.endpointService;
    },
    selectedEndpoint() {
      return services.endpointService.selected;
    }
  },
} as const;

const { store, rootActionContext, moduleActionContext } = createDirectStore(
  mod
);

store.getters.fileService.initialize(store);

export default store;

export { rootActionContext, moduleActionContext };

export type AppStore = typeof store;

declare module "vuex" {
  interface Store<S> {
    direct: AppStore;
  }
}
