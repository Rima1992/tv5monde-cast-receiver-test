/**
 * TV5Monde+ — Custom CAFv3 Receiver
 *
 * Architecture CAFv3 :
 *   - Le player côté RECEIVER est le player natif Google (Shaka).
 *     Bitmovin Player NE TOURNE PAS ici — il tourne côté sender (Android/iOS).
 *   - Ce receiver gère :
 *       1. L'injection du token Nagra dans les requêtes de licence Widevine
 *          via la Network API CAFv3 (setRequestHandler)
 *       2. La réception du token via customData (LOAD) et via custom messages
 *          (refresh toutes les ~4 min)
 *
 * Ref Bitmovin : https://developer.bitmovin.com/playback/docs/caf-support
 * Ref Google   : https://developers.google.com/cast/docs/web_receiver/basic
 */

(function () {
  'use strict';

  var TAG = '[TV5Monde Receiver]';

  /**
   * Namespace Bitmovin — doit correspondre à PlayerCastManager.BITMOVIN_CAST_NAMESPACE
   * côté Android : "urn:x-cast:com.bitmovin.player.caf"
   */
  var BITMOVIN_NAMESPACE = 'urn:x-cast:com.bitmovin.player.caf';

  /** Token Nagra courant — mis à jour via LOAD interceptor ou sendMessage */
  var nagraToken = null;

  function log(msg) { console.log(TAG + ' ' + msg); }
  function warn(msg) { console.warn(TAG + ' ' + msg); }

  // ── Accès au Cast SDK ────────────────────────────────────────────────────────
  var castContext   = cast.framework.CastReceiverContext.getInstance();
  var playerManager = castContext.getPlayerManager();

  // ════════════════════════════════════════════════════════════════════════════
  // 1. LOAD interceptor
  //    Le sender Bitmovin (Android/iOS) place le token dans request.media.customData
  //    Format attendu : { "nv-authorizations": "<token>" }
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
          warn('Pas de token Nagra dans customData — VOD sans DRM ou live non protege');
        }

        var contentId = (request.media && (request.media.contentId || request.media.contentUrl)) || '(inconnu)';
        log('contentId=' + contentId);
      } catch (e) {
        warn('Erreur LOAD interceptor: ' + e.message);
      }

      return request;
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 2. Custom message listener
  //    Reçoit les messages envoyés via BitmovinCastManager.sendMessage() (Android)
  //    Format : { "type": "nagra-drm-token", "nv-authorizations": "<token>" }
  //    Utilisé pour : refresh du token (~4 min) et CastStarted
  // ════════════════════════════════════════════════════════════════════════════
  castContext.addCustomMessageListener(
    BITMOVIN_NAMESPACE,
    function (event) {
      try {
        var message = (typeof event.data === 'string')
          ? JSON.parse(event.data)
          : event.data;

        log('Custom message recu — type=' + message['type']);

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
  // 3. Network API — injection du token Nagra dans les requêtes Widevine
  //    Le CAFv3 expose setRequestHandler pour intercepter les requêtes réseau.
  //    C'est ici qu'on injecte "nv-authorizations" dans les requêtes de licence.
  // ════════════════════════════════════════════════════════════════════════════
  playerManager.setRequestHandler(
    cast.framework.messages.RequestType.LOAD,
    null  // pas d'interception sur le manifest — uniquement sur les licences
  );

  /**
   * Intercepte les requêtes de licence DRM Widevine côté CAFv3 natif.
   * cast.framework.NetworkRequestType.LICENSE = requêtes Widevine/PlayReady
   */
  castContext.addEventListener(
    cast.framework.system.EventType.READY,
    function () {
      log('Receiver pret (READY)');
    }
  );

  // Injection Nagra via la Network Interceptor de Shaka (player natif CAFv3)
  playerManager.addEventListener(
    cast.framework.events.EventType.MEDIA_STATUS,
    function (event) {
      // L'événement MEDIA_STATUS confirme que le player a bien chargé la source
      log('MEDIA_STATUS — playerState=' + (event.mediaStatus && event.mediaStatus.playerState));
    }
  );

  /**
   * setNetworkRequestHandler — injecte les headers Nagra dans chaque
   * requête de licence Widevine émise par le player CAFv3 natif.
   *
   * cast.framework.NetworkRequestType.LICENSE couvre Widevine + PlayReady.
   */
  playerManager.setNetworkRequestHandler(
    cast.framework.NetworkRequestType.LICENSE,
    function (networkRequest) {
      if (nagraToken) {
        networkRequest.headers = networkRequest.headers || {};
        networkRequest.headers['nv-authorizations'] = nagraToken;
        networkRequest.headers['Accept']             = 'application/octet-stream';
        networkRequest.headers['Content-Type']       = 'application/octet-stream';
        log('Header Nagra injecte dans la requete Widevine ✅');
      } else {
        warn('Requete Widevine sans token Nagra — contenu sans DRM Nagra');
      }
      return networkRequest;
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 4. Démarrage du receiver CAFv3
  //    castContext.start() EST OBLIGATOIRE — sans ça le Chromecast ne répond
  //    pas aux demandes de connexion du sender et le bouton Cast ne trouve rien.
  // ════════════════════════════════════════════════════════════════════════════
  try {
    castContext.start();
    log('CAFv3 Receiver demarre ✅ (castContext.start() appele)');
  } catch (e) {
    warn('Erreur castContext.start(): ' + e.message);
  }

})();
