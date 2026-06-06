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

  // Namespace Bitmovin — doit correspondre à PlayerManager.BITMOVIN_CAST_NAMESPACE (Android)
  var BITMOVIN_NAMESPACE = 'urn:x-cast:com.bitmovin.player.caf';

  // Token Nagra courant — mis à jour via LOAD interceptor ou sendMessage
  var nagraToken = null;

  function log(msg) {
    console.log(TAG + ' ' + msg);
  }

  function warn(msg) {
    console.warn(TAG + ' ' + msg);
  }

  // ── Accès au Cast SDK ────────────────────────────────────────────────────────
  var castContext   = cast.framework.CastReceiverContext.getInstance();
  var playerManager = castContext.getPlayerManager();

  // ════════════════════════════════════════════════════════════════════════════
  // 1. LOAD interceptor
  //    Android place customReceiverConfig dans request.media.customData
  //    Format : { "nv-authorizations": "<token>" }
  // ════════════════════════════════════════════════════════════════════════════
  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    function (request) {
      log('LOAD interceptor — analyse du customData');

      try {
        var customData = request.media && request.media.customData;
        if (customData && typeof customData['nv-authorizations'] === 'string') {
          nagraToken = customData['nv-authorizations'];
          log('Token Nagra recu via customData ✅ longueur=' + nagraToken.length);
        } else {
          warn('Pas de token Nagra dans customData — VOD ou live sans DRM');
        }

        var contentId = (request.media && (request.media.contentId || request.media.contentUrl)) || '(inconnu)';
        log('contentId: ' + contentId);
      } catch (e) {
        warn('Erreur LOAD interceptor: ' + e.message);
      }

      return request;
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 2. Custom message listener
  //    Reçoit BitmovinCastManager.sendMessage() depuis Android
  //    Format : { "type": "nagra-drm-token", "nv-authorizations": "<token>" }
  //    Utilisé pour : refresh du token (toutes les 4 min) + CastStarted
  // ════════════════════════════════════════════════════════════════════════════
  castContext.addCustomMessageListener(
    BITMOVIN_NAMESPACE,
    function (event) {
      try {
        var message = JSON.parse(event.data);
        log('Custom message recu — type: ' + message['type']);

        if (message['type'] === 'nagra-drm-token' &&
            typeof message['nv-authorizations'] === 'string') {
          nagraToken = message['nv-authorizations'];
          log('Token Nagra mis a jour via sendMessage ✅ longueur=' + nagraToken.length);
        }
      } catch (e) {
        warn('Erreur parsing custom message: ' + e.message);
      }
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 3. License Request Handler
  //    Injecte "nv-authorizations" dans chaque requête Widevine
  //    Sans ce header → Nagra répond 401 → pas de lecture
  // ════════════════════════════════════════════════════════════════════════════
  function nagralicenseRequestHandler(type, request) {
    // HttpRequestType.DRM_LICENSE_WIDEVINE = 'widevine'
    if (type === 'widevine') {
      if (nagraToken) {
        request.headers                    = request.headers || {};
        request.headers['nv-authorizations'] = nagraToken;
        request.headers['Accept']           = 'application/octet-stream';
        request.headers['Content-Type']     = 'application/octet-stream';
        log('Header Nagra injecte dans la requete de licence Widevine ✅');
      } else {
        warn('Requete Widevine sans token Nagra — pas de live DRM actif');
      }
    }
    return request;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 4. Configuration Bitmovin Player
  // ════════════════════════════════════════════════════════════════════════════
  var playerConfig = {
    key: '847c83e1-cf03-4562-a258-e7f43b7a76a9',
    network: {
      preprocessHttpRequest: nagralicenseRequestHandler,
    },
  };

  // ════════════════════════════════════════════════════════════════════════════
  // 5. Démarrage du receiver Bitmovin
  // ════════════════════════════════════════════════════════════════════════════
  try {
    if (typeof bitmovin === 'undefined' || !bitmovin.player || !bitmovin.player.cast) {
      throw new Error('Bitmovin player SDK non charge — verifier les scripts dans index.html');
    }

    var receiver = bitmovin.player.cast.Receiver.create(playerConfig, castContext);
    receiver.init();
    log('Bitmovin CAF Receiver demarre ✅');

  } catch (e) {
    warn('Erreur demarrage receiver: ' + e.message);
  }

})();
