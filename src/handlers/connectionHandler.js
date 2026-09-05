import { makeWASocket, 
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import fs from 'node:fs';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { db } from '../database/database.js';
import { useDatabaseAuthState } from '../database/authStore.js';
import { handleMessagesUpsert, handleGroupParticipantsUpdate } from './messageHandler.js';

const log = logger.child({ class: 'connection' });

async function getAuthState() {
  if (config.authStorage === 'database') {
    log.info('Stockage de session WhatsApp : base de données persistante (JSON).');
    return useDatabaseAuthState(db);
  }
  log.info(`Stockage de session WhatsApp : dossier "${config.authDir}".`);
  if (!fs.existsSync(config.authDir)) fs.mkdirSync(config.authDir, { recursive: true });
  return useMultiFileAuthState(config.authDir);
}

let reconnectAttempts = 0;

export async function startConnection() {
  // 🔥 ÉTAPE 1 : Forcer la suppression de la vieille session (pour régler le "Connexion impossible")
  if (process.env.RESET_SESSION === 'true') {
    log.warn('🔥 Réinitialisation de la session demandée. Suppression du dossier auth...');
    if (fs.existsSync(config.authDir)) {
      fs.rmSync(config.authDir, { recursive: true, force: true });
    }
    // On supprime la variable pour ne pas recommencer à chaque redémarrage
    delete process.env.RESET_SESSION; 
  }

  const { state, saveCreds } = await getAuthState();
  const { version, isLatest } = await fetchLatestBaileysVersion();
  log.debug(`Version Baileys/WA utilisée : ${version.join('.')} (à jour : ${isLatest})`);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: logger.child({ class: 'baileys' }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
  });

  // --- Pairing code (uniquement si aucune session n'est encore enregistrée) ---
  if (!sock.authState.creds.registered) {
    await requestPairingCode(sock);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => onConnectionUpdate(sock, update));

  sock.ev.on('messages.upsert', (payload) => {
    handleMessagesUpsert(sock, payload).catch((err) => log.error('messages.upsert', err.message));
  });

  sock.ev.on('group-participants.update', (evt) => {
    handleGroupParticipantsUpdate(sock, evt).catch((err) => log.error('group-participants.update', err.message));
  });

  return sock;
}

async function requestPairingCode(sock) {
  let number = config.whatsappNumber;

  // 🚨 ÉTAPE 2 : Plus besoin de readline ! On prend directement le numéro depuis le .env ou les variables Render
  if (!number) {
    log.error(
      "❌ WHATSAPP_NUMBER n'est pas défini dans les variables d'environnement. " +
      "Le code d'appairage ne peut pas être généré."
    );
    return;
  }

  // On nettoie le numéro (enlève les +, espaces, tirets)
  number = String(number).replace(/\D/g, '');

  try {
    await new Promise((resolve) => setTimeout(resolve, 1500)); // laisse le socket s'initialiser
    const code = await sock.requestPairingCode(number);
    log.info('════════════════════════════════════════');
    log.info(`   📱 CODE D'APPAIRAGE : ${code}`);
    log.info('   WhatsApp > Appareils liés > Lier un appareil > Lier avec un numéro de téléphone');
    log.info('   ⚠️ Ce code expire dans 2 minutes ! Entrez-le immédiatement.');
    log.info('════════════════════════════════════════');
  } catch (err) {
    log.error("Échec de génération du code d'appairage.", err.message);
  }
}

function onConnectionUpdate(sock, update) {
  const { connection, lastDisconnect } = update;

  if (connection === 'close') {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;

    if (loggedOut) {
      log.error(
        '❌ Session WhatsApp déconnectée (logout). Supprimez le dossier de session (AUTH_DIR) ' +
          'et relancez le bot pour ré-appairer un nouveau numéro.'
      );
      return;
    }

    reconnectAttempts += 1;
    const delay = Math.min(30_000, 2000 * reconnectAttempts);
    log.warn(`Connexion fermée (code ${statusCode || 'inconnu'}). Reconnexion dans ${delay / 1000}s...`);
    setTimeout(() => {
      startConnection().catch((err) => log.error('Échec de la reconnexion', err.message));
    }, delay);
  } else if (connection === 'open') {
    reconnectAttempts = 0;
    log.info(`✅ ${config.botName} est connecté à WhatsApp.`);
  } else if (connection === 'connecting') {
    log.info('⏳ Connexion à WhatsApp en cours...');
  }
}