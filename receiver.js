/**
 * TV5Monde+ — CAFv3 Receiver
 *
 * Supporte 3 cas :
 *   1. HLS + Widevine (DRM Nagra)    → token nv-authorizations injecté via licenseRequestHandler
 *   2. HLS live sans Widevine        → streamType forcé à LIVE (fix Bitmovin liveConfig=null)
 *   3. HLS VOD sans Widevine         → lecture directe, aucune modification
 */
(function () {
  'use strict';

  var TAG = '[TV5Monde+]';
  var BITMOVIN_NAMESPACE = 'urn:x-cast:com.bitmovin.player.caf';
  var nagraToken = null;

  function log(msg)  { console.log(TAG  + ' ' + msg); }
  function warn(msg) { console.warn(TAG + ' ' + msg); }

  var castContext   = cast.framework.CastReceiverContext.getInstance();
  var playerManager = castContext.getPlayerManager();

  // ─── DRM : injection Nagra via playbackConfig ──────────────────────────────
  // playbackConfig.licenseRequestHandler est l'API correcte CAFv3
  // pour intercepter les requêtes de licence Widevine côté Shaka.
  // cast.framework.NetworkRequestType n'existe pas dans le SDK CAFv3.
  var playbackConfig = new cast.framework.PlaybackConfig();

  playbackConfig.licenseRequestHandler = function (requestInfo) {
    if (nagraToken) {
      requestInfo.headers = requestInfo.headers || {};
      requestInfo.headers['nv-authorizations'] = nagraToken;
      requestInfo.headers['Accept']             = 'application/octet-stream';
      requestInfo.headers['Content-Type']       = 'application/octet-stream';
      log('Nagra header injecte dans requete licence');
    }
    return requestInfo;
  };

  castContext.setOptions({ playbackConfig: playbackConfig });

  // ─── LOAD interceptor ─────────────────────────────────────────────────────
  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    function (request) {
      log('LOAD received');
      try {
        var media = request.media;
        if (!media) { return request; }

        // 1. Garantir contentUrl
        var contentId  = media.contentId  || '';
        var contentUrl = media.contentUrl || '';
        if (!contentUrl && contentId && contentId.indexOf('http') === 0) {
          media.contentUrl = contentId;
          log('contentUrl force depuis contentId');
        }
        var url = (media.contentUrl || media.contentId || '').toLowerCase();

        log('url=' + url.substring(0, 80));
        log('streamType='  + media.streamType);
        log('contentType=' + (media.contentType || '(vide)'));

        // 2. Garantir contentType
        if (!media.contentType) {
          if (url.indexOf('.m3u8') !== -1) {
            media.contentType = 'application/x-mpegURL';
            log('contentType -> application/x-mpegURL');
          } else if (url.indexOf('.mpd') !== -1) {
            media.contentType = 'application/dash+xml';
            log('contentType -> application/dash+xml');
          }
        }

        // 3. Forcer streamType LIVE
        // Bitmovin SDK ne set pas liveConfig pour HLS live sans DRM
        // => streamType arrive BUFFERED => Shaka echoue sur le live
        var customData = media.customData || {};
        log('customData=' + JSON.stringify(customData).substring(0, 150));

        var isLive = customData['isLive'] === 'true'
          || media.streamType === cast.framework.messages.StreamType.LIVE
          || url.indexOf('/live/') !== -1
          || url.indexOf('channel(') !== -1;

        if (isLive) {
          media.streamType = cast.framework.messages.StreamType.LIVE;
          log('streamType -> LIVE');
        } else {
          log('streamType -> BUFFERED (VOD)');
        }

        // 4. Token Nagra pour Widevine
        var token = customData['nv-authorizations'];
        if (typeof token === 'string' && token.length > 0) {
          nagraToken = token;
          log('token Nagra recu longueur=' + nagraToken.length);
        } else {
          nagraToken = null;
          log('pas de token Nagra');
        }

      } catch (e) {
        warn('LOAD error: ' + e.message);
      }
      return request;
    }
  );

  // ─── Refresh token Nagra via sendMessage ──────────────────────────────────
  castContext.addCustomMessageListener(
    BITMOVIN_NAMESPACE,
    function (event) {
      try {
        var msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (msg['type'] === 'nagra-drm-token'
            && typeof msg['nv-authorizations'] === 'string') {
          nagraToken = msg['nv-authorizations'];
          log('token Nagra refresh longueur=' + nagraToken.length);
        }
      } catch (e) {
        warn('message error: ' + e.message);
      }
    }
  );

  // ─── Events debug ─────────────────────────────────────────────────────────
  castContext.addEventListener(cast.framework.system.EventType.READY, function () {
    log('READY');
  });

  playerManager.addEventListener(cast.framework.events.EventType.ERROR, function (e) {
    warn('ERROR code=' + (e.detailedErrorCode || '?') + ' reason=' + (e.reason || '?'));
  });

  playerManager.addEventListener(cast.framework.events.EventType.MEDIA_STATUS, function (e) {
    log('MEDIA_STATUS state=' + (e.mediaStatus && e.mediaStatus.playerState));
  });

  // ─── Démarrage obligatoire  ────────────────────────────────────────────────
  castContext.start();
  log('started');

})();
