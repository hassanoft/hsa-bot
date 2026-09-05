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
  // Si config.authStorage est défini sur 'database', on utilise la DB, sinon le dossier
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
  // 🔥 1. Réinitialisation forcée de la session (si demandée via variable d'env)
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

  // 2. Sauvegarde des credentials
  sock.ev.on('creds.update', saveCreds);

  // 3. Gestion de la connexion et du Pairing Code (LA PARTIE CRUCIALE)
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // --- Gestion du QR Code (si vous voulez scanner au lieu d'un code) ---
    if (qr) {
      log.info('📱 QR Code généré. Scannez-le avec WhatsApp !');
    }

    // --- Gestion du Pairing Code (Code à 8 chiffres) ---
    if (connection === 'connecting' && !sock.authState.creds.registered) {
      const number = config.whatsappNumber || process.env.WHATSAPP_NUMBER;
      
      if (number) {
        try {
          // Petit délai pour que le socket soit prêt (important pour éviter le rejet)
          await new Promise((resolve) => setTimeout(resolve, 1500));
          
          const cleanNumber = String(number).replace(/\D/g, '');
          const code = await sock.requestPairingCode(cleanNumber);
          
          log.info('════════════════════════════════════════');
          log.info(`   📱 CODE D'APPAIRAGE : ${code}`);
          log.info('   WhatsApp > Appareils liés > Lier un appareil > Lier avec un numéro');
          log.info('   ⚠️ Ce code expire dans 2 minutes ! Entrez-le immédiatement.');
          log.info('════════════════════════════════════════');
        } catch (err) {
          log.error("Échec de génération du code d'appairage.", err.message);
        }
      } else {
        log.error("❌ WHATSAPP_NUMBER n'est pas défini. Impossible de générer le code.");
      }
    }

    // --- Gestion de la déconnexion / reconnexion ---
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        log.error('❌ Session WhatsApp déconnectée (logout). Redémarrez le bot pour ré-appairer.');
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
  });

  // 4. Gestion des messages entrants
  sock.ev.on('messages.upsert', (payload) => {
    handleMessagesUpsert(sock, payload).catch((err) => log.error('messages.upsert', err.message));
  });

  // 5. Gestion des participants de groupe
  sock.ev.on('group-participants.update', (evt) => {
    handleGroupParticipantsUpdate(sock, evt).catch((err) => log.error('group-participants.update', err.message));
  });

  return sock;
}