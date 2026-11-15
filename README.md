# Cryovanta

Hub di giochi multiplayer **a stanze** (hard cap: **7 client per istanza**), con netcode **server-autoritativo**.
Primo titolo: **Neon Circuit**, platformer a ostacoli competitivo a eliminazione, con casse oggetto, proiettili a ricerca,
boost e trappole rilasciabili.

![gameplay](docs/screenshot-gameplay.png)

### Avvio automatico (consigliato)

| Sistema | Cosa fare |
|---|---|
| **Windows** | doppio clic su **`start-game.bat`** |
| **macOS / Linux** | `./start-game.sh` |
| qualsiasi | `npm run play` |

Lo script controlla Node, installa le dipendenze se mancano, ricompila il client solo se è cambiato, sceglie una porta libera, avvia il server,
apre il browser e stampa indirizzo + **QR code** per i telefoni. Opzioni: `--port=9000`, `--no-open`, `--no-qr`, `--rebuild`.

### Sviluppo manuale

```bash
npm install
npm run dev:server     # ws://localhost:8080  (+ /healthz)
npm run dev:client     # http://localhost:5173  (apri 2+ schede, "Partita rapida", "Pronto!")
npm test               # 95 test: fisica, impatti, lobby/cap, match completo via rete, ws reali
npm run typecheck
```

### Telefoni come joypad (fino a 7 giocatori) + PC come schermo

Il gioco si vede sul **PC** (o su una TV collegata al PC); ogni **telefono è un joypad**: niente grafica 3D sul telefono, solo comandi.

1. Sul PC lancia `start-game.bat` (o `npm run play`): si apre la **modalità schermo** con un **QR code** e il codice stanza.
2. Sul telefono (stessa Wi-Fi) inquadra il QR: si apre il joypad. Scrivi il nome e premi **ENTRA**.
3. La prima volta il browser avvisa *"connessione non privata"* (certificato locale generato dal gioco): **Avanzate → Prosegui**. È necessario perché i telefoni concedono accelerometro/giroscopio solo su HTTPS.
4. Tieni il telefono **in orizzontale**. Premi **PRONTO!** (si calibra la posizione di riposo; **⟲ Centra** la ricalibra).

| Comando | Cosa fa |
|---|---|
| **Inclina** il telefono | muove il robot (analogico: più inclini, più corri) |
| **SALTA** | salta; premuto di nuovo in aria = propulsore |
| **TUFFO** | scatto in avanti che spinge gli altri |
| 🎁 | usa l'oggetto raccolto |

Se i sensori non sono disponibili (o rifiuti il permesso) il joypad passa da solo al **joystick** a schermo; il pulsante in basso cambia modo.
Il telefono vibra quando raccogli un oggetto, vieni colpito o tagli il traguardo. Lo schermo (PC) può scegliere mappa e modalità e premere **Avvia partita**;
i telefoni non occupano altro che il proprio slot: **il limite di 7 vale per i giocatori**, gli schermi non contano.

Senza HTTPS (o con `HTTPS_PORT=0`) tutto funziona comunque, ma solo col joystick.

### App desktop (.exe, offline)

```bash
npm run desktop     # avvia l'app Electron in locale (server + client integrati)
npm run dist:win    # produce packages/desktop/release/CryovantaNeonCircuit-portable.exe (+ installer su Windows)
```

L'exe non richiede Node né internet: avvia il server di gioco al suo interno (porta 8080, o una libera se occupata) e apre la finestra.
Menu *Gioco → Come far giocare amici in LAN* mostra l'indirizzo da aprire nel browser degli altri PC. In alternativa la
GitHub Action `Build Windows exe` (avvio manuale) costruisce installer e portable su un runner Windows.

Controlli: **WASD/frecce** muovi · **Spazio** salta (premi di nuovo in aria = propulsore) · **Shift** tuffo · **E / click** usa oggetto · tasto destro + mouse: ruota camera.

### Mappe e modalità

Tre mappe (scelte dall'host in lobby o "casuale", una diversa a ogni round) e quattro modalità:

| Mappa | Carattere |
|---|---|
| **Neon Circuit** | piattaforme sospese nello spazio, veloce e tecnica |
| **Titan Gauntlet** | parco giochi **gigante** (~650 unità) di giorno: barre rotanti, martelli a pendolo con palle chiodate, rulli, trampolini, nastri trasportatori, ghiaccio, melma, vento, tessere che spariscono, pistoni |
| **Frost Run** | pista ghiacciata con neve: derapate, bufere laterali, pendoli |

| Modalità | Regole |
|---|---|
| **Eliminazione** | passa la metà più veloce, ultimo in piedi vince (7→4→2→1) |
| **Corsa singola** | un solo round, vince chi arriva prima |
| **Gran Premio** | 3 round, punti 10-8-6-5-4-3-2, vince chi ne ha di più |
| **Caos** | eliminazione con casse oggetto che ricompaiono in ~1 s |

Aggiungere una mappa = una voce in `packages/shared/src/maps.ts`; una modalità = una voce in `modes.ts`.

Architettura, netcode, tabella degli impatti, come aggiungere un gioco: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| Pacchetto | Contenuto |
|---|---|
| `packages/shared` | Simulazione deterministica (controller, collisioni, oggetti, impatti, round/match), protocollo, predizione client |
| `packages/server` | Hub, stanze (cap 7), loop a timestep fisso 60 Hz, sessione autoritativa di Neon Circuit |
| `packages/client` | Three.js: robot procedurali, piattaforme neon, bloom, input, interpolazione, lobby/HUD |
| `tests` | Vitest: harness in-process a tempo virtuale + test su WebSocket reali |
