/**
 * TV5Monde+ — CAFv3 Receiver
 *
 * Gère 3 types de contenu :
 *
 *   1. HLS + Widevine (DRM Nagra)
 *      - drmConfig présent côté sender
 *      - token nv-authorizations injecté dans customData par buildNagraReceiverConfig()
 *      - injecté dans chaque requête de licence via setNetworkRequestHandler(LICENSE)
 *
 *   2. HLS sans Widevine — live (ex: channel(orient)/variant.m3u8)
 *      - pas de DRM, mais streamType DOIT être LIVE sinon Shaka échoue
 *      - Bitmovin SDK ne set pas liveConfig → MediaInfo arrive avec streamType=BUFFERED
 *      - détecté via customData['isLive'] + patterns URL + streamType déjà LIVE
 *
 *   3. HLS sans Widevine — VOD
 *      - pas de DRM, pas de live → lecture directe par Shaka sans modification
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

  // ═══════════════════════════════════════════════════════════
  // LOAD interceptor — exécuté à chaque nouvelle source
  // ═══════════════════════════════════════════════════════════
  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    function (request) {
      log('--- LOAD ---');

      try {
        var media = request.media;
        if (!media) { warn('media null'); return request; }

        var contentId  = media.contentId  || '';
        var contentUrl = media.contentUrl || '';

        log('contentId='   + contentId);
        log('contentUrl='  + contentUrl);
        log('streamType='  + media.streamType);
        log('contentType=' + (media.contentType || '(vide)'));
        log('customData='  + JSON.stringify(media.customData || {}).substring(0, 200));

        // ── 1. Garantir contentUrl ─────────────────────────────────────────
        // Bitmovin SDK met parfois l'URL dans contentId au lieu de contentUrl
        if (!contentUrl && contentId && contentId.indexOf('http') === 0) {
          media.contentUrl = contentId;
          log('contentUrl forcé depuis contentId');
        }
        var url = (media.contentUrl || media.contentId || '').toLowerCase();

        // ── 2. Garantir contentType ────────────────────────────────────────
        // Shaka doit connaître le format pour parser le manifest correctement
        if (!media.contentType || media.contentType === '') {
          if (url.indexOf('.m3u8') !== -1) {
            media.contentType = 'application/x-mpegURL';
            log('contentType → application/x-mpegURL');
          } else if (url.indexOf('.mpd') !== -1) {
            media.contentType = 'application/dash+xml';
            log('contentType → application/dash+xml');
          }
        }

        // ── 3. Détecter et forcer streamType LIVE ─────────────────────────
        //
        // Bitmovin Android SDK n'inclut pas liveConfig dans le SourceConfig
        // pour les streams HLS live sans DRM → streamType=BUFFERED (1) au lieu de LIVE (2)
        // → Shaka tente de lire un live comme un VOD → erreur immédiate
        //
        // Sources de détection (ordre de fiabilité) :
        //   A. customData['isLive'] === 'true'
        //      → envoyé par buildNagraReceiverConfig() dans PlayerManager.kt
        //   B. media.streamType déjà LIVE
        //      → cas DRM où Bitmovin SDK le set correctement
        //   C. Patterns URL TV5Monde
        //      → filet de sécurité universel

        var customData = media.customData || {};

        var isLive = customData['isLive'] === 'true'                      // A
          || media.streamType === cast.framework.messages.StreamType.LIVE  // B
          || url.indexOf('/live/') !== -1                                   // C
          || url.indexOf('channel(') !== -1;                               // C

        if (isLive) {
          media.streamType = cast.framework.messages.StreamType.LIVE;
          log('streamType → LIVE ✅');
        } else {
          log('streamType → BUFFERED (VOD)');
        }

        // ── 4. Token Nagra (cas HLS + Widevine) ───────────────────────────
        var token = customData['nv-authorizations'];
        if (typeof token === 'string' && token.length > 0) {
          nagraToken = token;
          log('Token Nagra reçu ✅ longueur=' + nagraToken.length);
        } else {
          log('Pas de token Nagra (HLS clair)');
        }

      } catch (e) {
        warn('LOAD exception: ' + e.message);
      }

      log('--- END LOAD ---');
      return request;
    }
  );

  // ═══════════════════════════════════════════════════════════
  // Custom message listener — refresh token Nagra
  // Envoyé par sendNagraTokenToCastReceiverIfNeeded() (Android)
  // Format : { "type": "nagra-drm-token", "nv-authorizations": "<token>" }
  // ═══════════════════════════════════════════════════════════
  castContext.addCustomMessageListener(
    BITMOVIN_NAMESPACE,
    function (event) {
      try {
        var msg = typeof event.data === 'string'
          ? JSON.parse(event.data)
          : event.data;

        if (msg['type'] === 'nagra-drm-token'
            && typeof msg['nv-authorizations'] === 'string') {
          nagraToken = msg['nv-authorizations'];
          log('Token Nagra rafraîchi ✅ longueur=' + nagraToken.length);
        }
      } catch (e) {
        warn('Custom message exception: ' + e.message);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════
  // Network handler — injection Nagra dans les requêtes Widevine
  // Actif uniquement pour les contenus avec DRM (cas 1)
  // Pour HLS clair (cas 2 & 3) : nagraToken est null → handler passthrough
  // ═══════════════════════════════════════════════════════════
  playerManager.setNetworkRequestHandler(
    cast.framework.NetworkRequestType.LICENSE,
    function (networkRequest) {
      if (nagraToken) {
        networkRequest.headers = networkRequest.headers || {};
        networkRequest.headers['nv-authorizations'] = nagraToken;
        networkRequest.headers['Accept']             = 'application/octet-stream';
        networkRequest.headers['Content-Type']       = 'application/octet-stream';
        log('Nagra header injecté ✅');
      }
      return networkRequest;
    }
  );

  // ═══════════════════════════════════════════════════════════
  // Events debug
  // ═══════════════════════════════════════════════════════════
  castContext.addEventListener(cast.framework.system.EventType.READY, function () {
    log('Receiver READY ✅');
  });

  playerManager.addEventListener(cast.framework.events.EventType.MEDIA_STATUS, function (e) {
    log('MEDIA_STATUS playerState=' + (e.mediaStatus && e.mediaStatus.playerState));
  });

  playerManager.addEventListener(cast.framework.events.EventType.ERROR, function (e) {
    warn('PLAYER ERROR code=' + (e.detailedErrorCode || '?') + ' reason=' + (e.reason || '?'));
  });

  // ═══════════════════════════════════════════════════════════
  // Démarrage — OBLIGATOIRE
  // ═══════════════════════════════════════════════════════════
  castContext.start();
  log('CAFv3 Receiver démarré ✅');

})();
