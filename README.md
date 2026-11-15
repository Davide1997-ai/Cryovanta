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
npm test               # 119 test: fisica, impatti, lobby/cap, match completo via rete, ws reali
npm run typecheck
```

### Telefoni come joypad + schermo diviso sul PC (fino a 7 giocatori)

Il gioco si vede sul **PC** (o su una TV collegata): lo schermo si **divide in un riquadro per giocatore**, ognuno con la **propria camera** che segue solo il suo robot
(se un giocatore si sposta, le altre visuali non si muovono). Ogni **telefono è un joypad**: nessuna grafica 3D sul telefono, solo comandi.

1. Sul PC lancia `start-game.bat` (o `npm run play`): si apre la **modalità schermo** con un **QR code** e il codice stanza.
2. Sul telefono (stessa Wi-Fi) inquadra il QR (si apre in HTTP semplice, **nessun avviso del browser**), scrivi il nome, **ENTRA**, **PRONTO!**. Telefono in orizzontale.
3. Dal PC scegli mappa e modalità e premi **Avvia partita** (oppure parte da solo quando tutti sono pronti).

| Comando | Cosa fa |
|---|---|
| **Joystick** (tocca e trascina a sinistra, compare dove metti il pollice) | muove il robot, analogico, nessuno smussamento aggiunto |
| **SALTA** | salta; premuto di nuovo in aria = propulsore |
| **SPINGI** | spinta corta davanti a te: manda indietro e fa barcollare chi hai davanti (anche giù da un bordo). Ricarica ~0,75 s |
| **AFFERRA** (tieni premuto) | afferri il robot davanti e lo trascini: lui va al 40% e non può saltare, tu al 75%. Dura ~2,4 s, poi ricarica. Premi **SPINGI** mentre lo tieni per **lanciarlo** |
| **TUFFO** | scatto in avanti che spinge gli altri |
| 🎁 | usa l'oggetto raccolto |

Anche **correre addosso** a qualcuno a tutta velocità lo fa cadere e barcollare. Da tastiera (PC): **F** spingi, **G** afferra.

Il telefono vibra quando raccogli un oggetto, vieni colpito o tagli il traguardo. Griglia dei riquadri: 1→1×1, 2→2×1, 3-4→2×2, 5-6→3×2, 7→4×2 con la **classifica nell'ottavo riquadro**.
Il limite di 7 vale per i giocatori: lo schermo del PC non occupa uno slot.

*Opzionale (beta)*: il pulsante "📱 Inclinazione" attiva il controllo con accelerometro; richiede HTTPS (`https://IP:porta+1/pad.html`, il browser mostra un avviso per il certificato locale).
Con `HTTPS_PORT=0` l'HTTPS viene disattivato.

**Provare da soli**: `npm run bots -- <CODICE> 5 race` aggiunge 5 giocatori finti che corrono (e si spingono); `... 7 brawl` li fa litigare (ottimo per l'Arena).

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
| **Platform Panic** | arena a sopravvivenza (solo modalità Arena) |

| Modalità | Regole |
|---|---|
| **Eliminazione** | passa la metà più veloce, ultimo in piedi vince (7→4→2→1) |
| **Corsa singola** | un solo round, vince chi arriva prima |
| **Gran Premio** | 3 round, punti 10-8-6-5-4-3-2, vince chi ne ha di più |
| **Caos** | eliminazione con casse oggetto che ricompaiono in ~1 s |
| **Arena (ultimo in piedi)** | nessun traguardo: su **Platform Panic** le tessere crollano dall'esterno, due barre rotanti al centro; cadere = eliminato. Spingi, afferra e lancia gli altri giù: vince l'ultimo |

Aggiungere una mappa = una voce in `packages/shared/src/maps.ts`; una modalità = una voce in `modes.ts`.

Architettura, netcode, tabella degli impatti, come aggiungere un gioco: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| Pacchetto | Contenuto |
|---|---|
| `packages/shared` | Simulazione deterministica (controller, collisioni, oggetti, impatti, round/match), protocollo, predizione client |
| `packages/server` | Hub, stanze (cap 7), loop a timestep fisso 60 Hz, sessione autoritativa di Neon Circuit |
| `packages/client` | Three.js: robot procedurali, piattaforme neon, bloom, input, interpolazione, lobby/HUD |
| `tests` | Vitest: harness in-process a tempo virtuale + test su WebSocket reali |
