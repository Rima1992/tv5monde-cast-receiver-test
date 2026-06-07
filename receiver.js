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

  // ── 1. LOAD interceptor : lire le token depuis customData ────────────────
  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    function (request) {
      log('LOAD intercepted');
      try {
        var customData = request.media && request.media.customData;

        // Le token peut arriver comme string JSON ou objet déjà parsé
        if (typeof customData === 'string') {
          try { customData = JSON.parse(customData); } catch (e) {}
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

  // ── 2. Custom message listener : token envoyé depuis Android ────────────
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

  // ── 3. Config Bitmovin : injecter le token Nagra dans les requêtes DRM ──
  var playerConfig = {
    key: '847c83e1-cf03-4562-a258-e7f43b7a76a9',
    network: {
      preprocessHttpRequest: function (type, request) {
        // 'widevine' = requête vers le license server Nagra
        if (type === 'widevine') {
          if (nagraToken) {
            request.headers = request.headers || {};
            request.headers['nv-authorizations'] = nagraToken;
            request.headers['Accept']            = 'application/octet-stream';
            request.headers['Content-Type']      = 'application/octet-stream';
            log('Header nv-authorizations injecté dans la requête Widevine ✅');
          } else {
            warn('Requête Widevine sans token Nagra — live DRM ne fonctionnera pas');
          }
        }
        return request;
      }
    }
  };

  // ── 4. Démarrage du receiver Bitmovin CAF ────────────────────────────────
  // bitmovin.player.cast.Receiver est disponible car bitmovinplayer.js est chargé
  try {
    var receiver = bitmovin.player.cast.Receiver.create(playerConfig, castContext);
    receiver.init();
    log('Bitmovin CAF Receiver démarré ✅');
  } catch (e) {
    warn('Erreur démarrage Bitmovin receiver: ' + e.message);
    // Fallback : démarrer le receiver Google natif si Bitmovin échoue
    log('Fallback vers Google CAF natif');
    castContext.start();
  }

})();
