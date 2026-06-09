/**
 * TV5Monde — Custom CAF Receiver
 *
 * Basé sur le receiver Bitmovin standard, étendu avec :
 *  1. Fix live HLS sans DRM : force streamType=LIVE si absent
 *  2. Support token Nagra (live DRM) via customData et via sendMessage
 *
 * Déployé sur : https://rima1992.github.io/tv5monde-cast-receiver-test/index.html
 */

'use strict';

var TV5MondeReceiver = (function () {

  // ─── Namespace custom pour les messages Android → receiver ─────────────────
  var CUSTOM_NAMESPACE = 'urn:x-cast:com.bitmovin.player.caf';

 
  function TV5MondeReceiver() {
    var self = this;

    // Token Nagra en mémoire — mis à jour via customData ou sendMessage
    self._nagraToken = null;

    // Références CAF
    self.context = cast.framework.CastReceiverContext.getInstance();
    self.player  = self.context.getPlayerManager();

    // ── onLoad ────────────────────────────────────────────────────────────────
    // Intercepte chaque LOAD avant que le receiver commence la lecture.
    // Ordre des opérations :
    //   1. Lire customData (token Nagra, DRM RedBee, withCredentials)
    //   2. Appliquer le DRM si présent
    //   3. Forcer streamType=LIVE pour les flux live HLS (fix principal)
    self.onLoad = function (loadRequestData) {
      console.log('[CAF] onLoad →', JSON.stringify(loadRequestData.media, null, 2));

      var customData = loadRequestData.media.customData;

      // ── 1a. Token Nagra (live DRM TV5Monde) ─────────────────────────────────
      // Envoyé par Android via customReceiverConfig dans PlayerConfig.
      // Stocké en mémoire pour être injecté dans les requêtes de licence.
      if (customData && customData['nv-authorizations']) {
        self._nagraToken = customData['nv-authorizations'];
        console.log('[CAF] Token Nagra reçu via customData (longueur=' + self._nagraToken.length + ')');
        self._applyNagraDrm();
      }

      // ── 1b. DRM RedBee standard (VOD Widevine) ───────────────────────────────
      if (customData && customData.drm) {
        console.log('[CAF] DRM RedBee détecté →', customData.drm.protectionSystem);
        self.setDRM(customData.drm);
      }

      // ── 1c. withCredentials (segments / manifests) ───────────────────────────
      if (customData && customData.options) {
        self.setWithCredentials(customData.options);
      }

      // ── 2. Fix live HLS : forcer streamType=LIVE ─────────────────────────────
      // Quand le SDK Bitmovin Android envoie GoogleCastMediaType.TvShow,
      // le CAF reçoit normalement streamType=LIVE.
      // Ce guard défensif corrige le cas où ce serait absent (régression SDK, etc.)
      var media     = loadRequestData.media;
      var contentUrl = media.contentUrl || media.entity || '';
      var isLiveUrl  = (
        contentUrl.indexOf('/Live/')        !== -1 ||
        contentUrl.indexOf('variant.m3u8') !== -1 ||
        contentUrl.indexOf('/live/')        !== -1
      );

      if (isLiveUrl && media.streamType !== cast.framework.messages.StreamType.LIVE) {
        console.log('[CAF] streamType corrigé → LIVE pour URL :', contentUrl);
        media.streamType = cast.framework.messages.StreamType.LIVE;
      }

      console.log('[CAF] onLoad terminé — streamType=' + media.streamType);
      return loadRequestData;
    };

    // ── preprocessMediaStatusUpdate ────────────────────────────────────────────
    // Injecte startAbsoluteTime dans customData du status (comportement Bitmovin standard).
    self.preprocessMediaStatusUpdate = function (mediaStatus) {
      var extra = { startAbsoluteTime: self.player.getStartAbsoluteTime() };
      mediaStatus.customData = Object.assign({}, mediaStatus.customData || {}, extra);
      return mediaStatus;
    };

    // ── onCustomMessage ────────────────────────────────────────────────────────
    // Reçoit les messages envoyés depuis Android via BitmovinCastManager.sendMessage().
    // Utilisé pour transmettre le token Nagra APRÈS que le cast a démarré
    // (cas où le cast démarre alors que la source est déjà chargée).
    self.onCustomMessage = function (event) {
      console.log('[CAF] Message custom reçu :', event.data);

      var msg = null;
      try {
        msg = (typeof event.data === 'string') ? JSON.parse(event.data) : event.data;
      } catch (e) {
        console.warn('[CAF] Message custom non-JSON ignoré :', event.data);
        return;
      }

      // Token Nagra envoyé dynamiquement (CastStarted côté Android)
      if (msg && msg.type === 'nagra-drm-token' && msg['nv-authorizations']) {
        self._nagraToken = msg['nv-authorizations'];
        console.log('[CAF] Token Nagra reçu via sendMessage (longueur=' + self._nagraToken.length + ')');
        self._applyNagraDrm();
      }
    };
  }

  // ─── Prototype ──────────────────────────────────────────────────────────────

  // Démarre le receiver : attache les événements puis lance le contexte CAF.
  TV5MondeReceiver.prototype.init = function () {
    this._attachEvents();
    this.context.start();
    console.log('[CAF] Receiver TV5Monde démarré');
  };

  TV5MondeReceiver.prototype._attachEvents = function () {
    var self = this;

    // Intercepteur LOAD : appelé avant chaque lecture
    self.player.setMessageInterceptor(
      cast.framework.messages.MessageType.LOAD,
      self.onLoad
    );

    // Intercepteur MEDIA_STATUS : enrichit le status avec startAbsoluteTime
    self.player.setMessageInterceptor(
      cast.framework.messages.MessageType.MEDIA_STATUS,
      self.preprocessMediaStatusUpdate
    );

    // Listener messages custom Android → receiver (token Nagra dynamique)
    self.context.addCustomMessageListener(CUSTOM_NAMESPACE, self.onCustomMessage);
  };

  // ── setDRM ─────────────────────────────────────────────────────────────────
  // Applique la config DRM RedBee standard (VOD Widevine).
  // Reçoit { protectionSystem, licenseUrl, headers, withCredentials }.
  TV5MondeReceiver.prototype.setDRM = function (drmConfig) {
    var protectionSystem  = drmConfig.protectionSystem;
    var licenseUrl        = drmConfig.licenseUrl;
    var headers           = drmConfig.headers;
    var withCredentials   = drmConfig.withCredentials;

    this.context.getPlayerManager().setMediaPlaybackInfoHandler(function (loadRequestData, playbackConfig) {
      playbackConfig.licenseUrl        = licenseUrl;
      playbackConfig.protectionSystem  = protectionSystem;

      if (typeof headers === 'object' && headers !== null) {
        playbackConfig.licenseRequestHandler = function (requestInfo) {
          requestInfo.headers = headers;
        };
      }

      if (withCredentials) {
        playbackConfig.licenseRequestHandler = _withCredentialsHandler;
      }

      return playbackConfig;
    });
  };

  // ── _applyNagraDrm ─────────────────────────────────────────────────────────
  // Injecte le token Nagra dans toutes les requêtes de licence Widevine.
  // Appelé dès que _nagraToken est disponible (customData ou sendMessage).
  TV5MondeReceiver.prototype._applyNagraDrm = function () {
    var self = this;
    if (!self._nagraToken) {
      console.warn('[CAF] _applyNagraDrm appelé sans token — ignoré');
      return;
    }

    console.log('[CAF] Application du DRM Nagra sur licenseRequestHandler');

    self.context.getPlayerManager().setMediaPlaybackInfoHandler(function (loadRequestData, playbackConfig) {
      // Injecter le token dans chaque requête vers le license server Nagra
      playbackConfig.licenseRequestHandler = function (requestInfo) {
        requestInfo.headers                  = requestInfo.headers || {};
        requestInfo.headers['nv-authorizations'] = self._nagraToken;
        requestInfo.headers['Accept']            = 'application/octet-stream';
        requestInfo.headers['Content-Type']      = 'application/octet-stream';
      };
      return playbackConfig;
    });
  };

  // ── setWithCredentials ─────────────────────────────────────────────────────
  // Active withCredentials sur segments / manifests / captions.
  TV5MondeReceiver.prototype.setWithCredentials = function (options) {
    var playerManager  = this.context.getPlayerManager();
    var playbackConfig = Object.assign(
      new cast.framework.PlaybackConfig(),
      playerManager.getPlaybackConfig()
    );

    if (options.withCredentials) {
      playbackConfig.segmentRequestHandler  = _withCredentialsHandler;
      playbackConfig.captionsRequestHandler = _withCredentialsHandler;
    }
    if (options.manifestWithCredentials) {
      playbackConfig.manifestRequestHandler = _withCredentialsHandler;
    }

    playerManager.setPlaybackConfig(playbackConfig);
  };

  // ─── Helpers privés ─────────────────────────────────────────────────────────

  function _withCredentialsHandler(requestInfo) {
    requestInfo.withCredentials = true;
  }

  // ─── Export ─────────────────────────────────────────────────────────────────
  return TV5MondeReceiver;

})();
