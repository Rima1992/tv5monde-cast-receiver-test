import {
  PlayerConfig,
  SourceConfig,
  SourceType,
  HttpRequestType,
  HttpRequest,
} from 'bitmovin-player';

// ═══════════════════════════════════════════════════════════════════════════════
// TV5Monde+ — Bitmovin CAF Receiver Custom
//
// Objectif : gérer le live DRM Nagra en Cast en injectant le header
// "nv-authorizations" dans chaque requête de licence Widevine.
//
// Flux :
//  1. Android envoie customReceiverConfig = {"nv-authorizations": token}
//     → intercepté dans le LOAD interceptor (setMessageInterceptor)
//  2. Android envoie sendMessage({type: "nagra-drm-token", "nv-authorizations": token})
//     → intercepté dans addCustomMessageListener (si Cast déjà actif)
//  3. Le licenseRequestHandler injecte le header dans chaque requête Widevine
//  4. Toutes les 4 min, Android envoie un nouveau token via sendMessage (refresh)
// ═══════════════════════════════════════════════════════════════════════════════

const TAG = '[TV5Monde Receiver]';

// ─── Namespace Bitmovin — doit correspondre à PlayerCastManager.BITMOVIN_CAST_NAMESPACE ───
const BITMOVIN_NAMESPACE = 'urn:x-cast:com.bitmovin.player.caf';

// ─── Token Nagra courant — mis à jour via LOAD interceptor ou sendMessage ────
let nagraToken: string | null = null;

// ─── Référence au Cast player manager (accès aux playback APIs) ───────────────
const castContext  = cast.framework.CastReceiverContext.getInstance();
const playerManager = castContext.getPlayerManager();

// ─── Logger ──────────────────────────────────────────────────────────────────
function log(msg: string, ...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(`${TAG} ${msg}`, ...args);
}
function warn(msg: string, ...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.warn(`${TAG} ${msg}`, ...args);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. LOAD interceptor — lit le token depuis customReceiverConfig
//
//    Quand Android appelle player.load(source), Bitmovin Player Android place
//    le contenu de PlayerConfig.remoteControlConfig.customReceiverConfig dans
//    request.media.customData avant d'envoyer le message LOAD au receiver.
//
//    customData reçu : { "nv-authorizations": "<token_nagra>" }
// ═══════════════════════════════════════════════════════════════════════════════
playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.LOAD,
  (request: cast.framework.messages.LoadRequestData) => {
    log('LOAD interceptor — analyse du customData');

    const customData = request.media?.customData as Record<string, string> | null | undefined;
    if (customData && typeof customData['nv-authorizations'] === 'string') {
      nagraToken = customData['nv-authorizations'];
      log('Token Nagra reçu via customData (LOAD) ✅ — longueur:', nagraToken.length);
    } else {
      warn('Pas de token Nagra dans customData — live sans DRM ou VOD');
    }

    // Inspecter le contentId pour debug
    const contentId = request.media?.contentId ?? request.media?.contentUrl ?? '(inconnu)';
    log('contentId:', contentId);

    return request; // toujours retourner la requête non modifiée
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Custom message listener — reçoit les sendMessage() depuis Android
//
//    Déclenché quand BitmovinCastManager.sendMessage(message, BITMOVIN_NAMESPACE)
//    est appelé depuis Android (au CastStarted ou lors d'un refresh de token).
//
//    Format attendu :
//    { "type": "nagra-drm-token", "nv-authorizations": "<nouveau_token>" }
// ═══════════════════════════════════════════════════════════════════════════════
castContext.addCustomMessageListener(
  BITMOVIN_NAMESPACE,
  (event: cast.framework.system.Message) => {
    try {
      const raw     = event.data as string;
      const message = JSON.parse(raw) as Record<string, string>;
      log('Custom message reçu — type:', message['type']);

      if (
        message['type'] === 'nagra-drm-token' &&
        typeof message['nv-authorizations'] === 'string'
      ) {
        nagraToken = message['nv-authorizations'];
        log('Token Nagra mis à jour via sendMessage ✅ — longueur:', nagraToken.length);
      }
    } catch (err) {
      warn('Erreur parsing custom message:', err);
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// 3. License Request Handler — injecte le token Nagra dans les requêtes Widevine
//
//    Appelé par le SDK Bitmovin receiver AVANT chaque requête HTTP vers
//    le serveur de licences Nagra. On y ajoute le header "nv-authorizations".
//    Sans ce header, Nagra répond 401 et la lecture s'arrête.
// ═══════════════════════════════════════════════════════════════════════════════
function nagralicenseRequestHandler(type: HttpRequestType, request: HttpRequest): HttpRequest {
  if (type === HttpRequestType.DRM_LICENSE_WIDEVINE) {
    if (nagraToken) {
      request.headers = {
        ...request.headers,
        'nv-authorizations': nagraToken,
        'Accept':            'application/octet-stream',
        'Content-Type':      'application/octet-stream',
      };
      log('Header Nagra injecté dans la requête de licence Widevine ✅');
    } else {
      warn('Requête de licence Widevine sans token Nagra ! (VOD ou token non reçu)');
    }
  }
  return request;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Configuration du Player Bitmovin
//
//    Clé de licence à remplacer par la vraie clé Bitmovin de TV5Monde.
//    networkConfig.preprocessHttpRequest = handler d'injection du token.
// ═══════════════════════════════════════════════════════════════════════════════
const playerConfig: PlayerConfig = {
  key: '847c83e1-cf03-4562-a258-e7f43b7a76a9',
  network: {
    preprocessHttpRequest: nagralicenseRequestHandler,
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Démarrage du receiver Bitmovin
//
//    bitmovin.player.cast.Receiver.init() prend en charge :
//    - la gestion des messages LOAD / PLAY / PAUSE / SEEK
//    - la synchronisation de l'état avec l'émetteur Android
//    - l'affichage de la progression / durée sur l'écran du Chromecast
// ═══════════════════════════════════════════════════════════════════════════════

// Vérification que le SDK Bitmovin receiver est bien chargé (via <script> dans index.html)
declare const bitmovin: {
  player: {
    cast: {
      Receiver: {
        create: (
          playerConfig: PlayerConfig,
          castContext: cast.framework.CastReceiverContext,
        ) => {
          init: () => void;
        };
      };
    };
  };
};

try {
  const receiver = bitmovin.player.cast.Receiver.create(playerConfig, castContext);
  receiver.init();
  log('Bitmovin CAF Receiver démarré ✅');
} catch (err) {
  warn('Erreur lors du démarrage du Bitmovin CAF Receiver:', err);
}
