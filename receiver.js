/**
 * TV5Monde+ — Bitmovin CAF Receiver Custom
 * 
 * Objectif : injecter le header "nv-authorizations" (token Nagra) dans
 * chaque requête de licence Widevine pour le live DRM TV5Monde.
 * 
 * Ce fichier est chargé par index.html sur le Chromecast.
 * Il remplace le receiver standard Bitmovin (App ID: A619A5D1) qui
 * ne gère pas le DRM Nagra.
 */

(function () {
  'use strict';

  var TAG = '[TV5Monde Receiver]';
  var BITMOVIN_NAMESPACE = 'urn:x-cast:com.bitmovin.player.caf';
  var nagraToken = null;

  function log(msg)  { console.log(TAG + ' ' + msg); }
  function warn(msg) { console.warn(TAG + ' ' + msg); }

  var castContext   = cast.framework.CastReceiverContext.getInstance();
  var playerManager = castContext.getPlayerManager();

  // ── 1. LOAD interceptor : lire le token depuis customData ─────────────────
  // Android envoie le token via GoogleCastMediaInfoConfig.customData
  // (buildNagraReceiverConfig() dans PlayerManager)
  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    function (request) {
      log('LOAD intercepted');
      try {
        var customData = request.media && request.media.customData;

        // Le token peut arriver comme string JSON ou comme objet déjà parsé
        if (typeof customData === 'string') {
          try { customData = JSON.parse(customData); } catch(e) {}
        }

        if (customData && typeof customData['nv-authorizations'] === 'string') {
          nagraToken = customData['nv-authorizations'];
          log('Token Nagra lu depuis customData ✅ longueur=' + nagraToken.length);
        } else {
          warn('Pas de token dans customData — VOD ou live sans DRM');
          log('customData reçu: ' + JSON.stringify(customData));
        }
      } catch (e) {
        warn('Erreur LOAD interceptor: ' + e.message);
      }
      return request;
    }
  );

  // ── 2. setMediaPlaybackInfoHandler : injecter le header Widevine ──────────
  // C'est ICI que le DRM est configuré pour la lecture — pas dans preprocessHttpRequest.
  // setMediaPlaybackInfoHandler est appelé juste avant que le player démarre le stream.
  playerManager.setMediaPlaybackInfoHandler(function (loadRequest, playbackConfig) {
    log('setMediaPlaybackInfoHandler appelé');

    // Double-check : relire customData si le token n'a pas été capté dans LOAD
    try {
      var customData = loadRequest.media && loadRequest.media.customData;
      if (typeof customData === 'string') {
        try { customData = JSON.parse(customData); } catch(e) {}
      }
      if (!nagraToken && customData && customData['nv-authorizations']) {
        nagraToken = customData['nv-authorizations'];
        log('Token Nagra récupéré dans PlaybackInfoHandler ✅');
      }
    } catch(e) {}

    if (nagraToken) {
      // licenseRequestHandler est appelé à chaque requête vers le license server Nagra
      playbackConfig.licenseRequestHandler = function (requestInfo) {
        requestInfo.headers = requestInfo.headers || {};
        requestInfo.headers['nv-authorizations'] = nagraToken;
        requestInfo.headers['Accept']            = 'application/octet-stream';
        requestInfo.headers['Content-Type']      = 'application/octet-stream';
        log('Header nv-authorizations injecté ✅');
        return requestInfo;
      };
      log('licenseRequestHandler configuré avec token Nagra');
    } else {
      warn('Aucun token Nagra disponible au moment de la lecture');
    }

    return playbackConfig;
  });

  // ── 3. Custom message listener : refresh du token via sendMessage ──────────
  // Android envoie le token via BitmovinCastManager.sendMessage() après CastStarted
  castContext.addCustomMessageListener(
    BITMOVIN_NAMESPACE,
    function (event) {
      try {
        var data = event.data;
        var message = (typeof data === 'string') ? JSON.parse(data) : data;
        log('Custom message reçu — type: ' + message['type']);

        if (message['type'] === 'nagra-drm-token' &&
            typeof message['nv-authorizations'] === 'string') {
          nagraToken = message['nv-authorizations'];
          log('Token Nagra mis à jour via sendMessage ✅ longueur=' + nagraToken.length);
        }
      } catch (e) {
        warn('Erreur parsing custom message: ' + e.message);
      }
    }
  );

  // ── 4. Démarrage du receiver Google CAF ───────────────────────────────────
  // PAS de bitmovin.player.cast.Receiver ici — on utilise le player natif du Chromecast
  castContext.start({
    queue: new cast.framework.QueueManager(),
  });

  log('Google CAF Receiver démarré ✅ (mode natif, sans SDK Bitmovin JS)');

})();
