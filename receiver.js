/**
 * TV5Monde+ — Custom CAFv3 Receiver
 *
 * Architecture CAFv3 :
 *   - Le player côté RECEIVER est le player natif Google (Shaka).
 *     Bitmovin Player NE TOURNE PAS ici — il tourne côté sender (Android/iOS).
 *   - Ce receiver gère :
 *       1. L'injection du token Nagra dans les requêtes de licence Widevine
 *          via PlaybackConfig.licenseRequestHandler (API officielle CAFv3)
 *       2. La réception du token via customData (LOAD interceptor)
 *       3. Le refresh du token via custom messages (namespace Bitmovin)
 *
 * Ref Google : https://developers.google.com/cast/docs/web_receiver/core_features
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

  function log(msg)  { console.log(TAG  + ' ' + msg); }
  function warn(msg) { console.warn(TAG + ' ' + msg); }

  // ── Accès au Cast SDK ────────────────────────────────────────────────────────
  var castContext   = cast.framework.CastReceiverContext.getInstance();
  var playerManager = castContext.getPlayerManager();

  // ════════════════════════════════════════════════════════════════════════════
  // 1. PlaybackConfig — injection du token Nagra dans chaque requête de licence
  //    licenseRequestHandler est l'API officielle CAFv3 pour modifier les
  //    requêtes DRM (Widevine / PlayReady) avant qu'elles partent vers le serveur.
  //
  //    Ref : https://developers.google.com/cast/docs/reference/web_receiver/cast.framework.PlaybackConfig
  // ════════════════════════════════════════════════════════════════════════════
  var playbackConfig = new cast.framework.PlaybackConfig();

  playbackConfig.licenseRequestHandler = function (requestInfo) {
    if (nagraToken) {
      requestInfo.headers = requestInfo.headers || {};
      requestInfo.headers['nv-authorizations'] = nagraToken;
      requestInfo.headers['Accept']             = 'application/octet-stream';
      requestInfo.headers['Content-Type']       = 'application/octet-stream';
      log('Header Nagra injecte dans la requete de licence Widevine ✅');
    } else {
      warn('Requete Widevine sans token Nagra — contenu sans DRM Nagra');
    }
    return requestInfo;
  };

  // ════════════════════════════════════════════════════════════════════════════
  // 2. LOAD interceptor
  //    Le sender Bitmovin (Android/iOS) place le token dans request.media.customData
  //    Format attendu : { "nv-authorizations": "<token>" }
  //    On récupère aussi le token ici pour l'avoir dès le premier LOAD.
  // ════════════════════════════════════════════════════════════════════════════
  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    function (request) {
      log('LOAD interceptor — analyse du customData');
      try {
        var customData = request.media && request.media.customData;

        // Le token peut arriver comme string JSON ou objet déjà parsé
        if (typeof customData === 'string') {
          try { customData = JSON.parse(customData); } catch (e) {}
        }

        if (customData && typeof customData['nv-authorizations'] === 'string') {
          nagraToken = customData['nv-authorizations'];
          log('Token Nagra recu via customData ✅ longueur=' + nagraToken.length);
        } else {
          warn('Pas de token Nagra dans customData — VOD sans DRM ou live non protege');
          log('customData=' + JSON.stringify(customData));
        }

        var contentId = (request.media && (request.media.contentId || request.media.contentUrl)) || '(inconnu)';
        log('contentId=' + contentId);

        // Appliquer le playbackConfig avec le handler Nagra à chaque nouveau load
        playerManager.setPlaybackConfig(playbackConfig);

      } catch (e) {
        warn('Erreur LOAD interceptor: ' + e.message);
      }
      return request;
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // 3. Custom message listener
  //    Reçoit les messages envoyés via BitmovinCastManager.sendMessage() (Android)
  //    Format : { "type": "nagra-drm-token", "nv-authorizations": "<token>" }
  //    Utilisé pour : refresh du token (~4 min) pendant la session Cast
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
  // 4. Démarrage du receiver CAFv3
  //    castContext.start() EST OBLIGATOIRE — sans ça le Chromecast ne répond
  //    pas aux demandes de connexion du sender et le bouton Cast ne trouve rien.
  //    On passe le playbackConfig en option pour qu'il soit actif dès le départ.
  // ════════════════════════════════════════════════════════════════════════════
  try {
    castContext.start({ playbackConfig: playbackConfig });
    log('CAFv3 Receiver demarre ✅ (castContext.start() appele)');
  } catch (e) {
    warn('Erreur castContext.start(): ' + e.message);
  }

})();
