# Architettura

## 1. Visione d'insieme

```
 client (Three.js)                          server (Node, 1 processo, loop 60 Hz)
 ┌─────────────────────┐   input @30pkt/s   ┌────────────────────────────────────────┐
 │ Input → Predictor   │ ─────────────────► │ Hub ── Room[≤7 slot] ── GameSession    │
 │  (stepPlayer locale)│                    │          lobby/ready      Match→RaceSim│
 │ Interpolazione 110ms│ ◄───────────────── │ stepPlayer, oggetti, impatti, regole   │
 │ Robot / Stage / HUD │  snapshot @20 Hz   └────────────────────────────────────────┘
 └─────────────────────┘      + ack input
        ▲  stesso codice di simulazione  ▲
        └────────── packages/shared ─────┘
```

* **Il client invia solo intenzioni** (`InputFrame`: direzione, salto, tuffo, usa-oggetto). Posizione, oggetti, colpi,
  traguardo ed eliminazioni sono decisi **solo** dal server.
* La simulazione (`packages/shared`) è **pura e deterministica**: niente `Math.random`, niente tempo di sistema, RNG con stato
  nello stato di gioco, piattaforme mobili come funzione pura del tick. Server e client eseguono lo **stesso**
  `stepPlayer`, quindi la predizione è esatta quando nessuno ti colpisce.
* Il percorso non viaggia in rete: il server manda `(seed, round)` e ogni client ricostruisce la geometria con `courseForRound`.

## 2. Netcode

| Aspetto | Scelta |
|---|---|
| Tick | 60 Hz fisso (`TICK_RATE`), catch-up limitato a 5 tick (niente spirale della morte) |
| Snapshot | 20 Hz (`SNAPSHOT_EVERY=3`), serializzati **una volta** per stanza, droppabili se il socket è in backpressure (>256 KB) |
| Input | 1 frame/tick consumato dalla coda; pacchetti a 30/s con gli ultimi 3 frame (ridondanza anti-perdita); `seq` monotono → replay/rewind ignorati; coda max 12 → flood scartato |
| Starvation | coda vuota → ripete l'ultimo input per max 6 tick, poi neutro |
| Predizione | solo il robot locale. `Predictor.step` applica subito l'input; `reconcile` riparte dallo stato autoritativo, scarta gli input con `seq ≤ ack` e ri-simula il resto |
| Stato nel wire | include lo stato **interno** del controller (coyote, jump-buffer, carburante hover, cooldown tuffo…) altrimenti la ri-simulazione divergerebbe |
| Teletrasporti | il respawn **non** viene predetto (il server decide quando riappari) |
| Correzioni | errori < 3u sono assorbiti da un offset visivo che decade (`smooth`), oltre si fa snap |
| Remoti | interpolazione a 110 ms nel passato tra due snapshot |
| Anti-cheat di base | vettore di movimento clampato a norma ≤ 1 dal server, range/tipi validati (`parseClientMsg`), rate-limit a token-bucket (120 msg/s), payload ≤ 4 KB, `hello` obbligatorio, 1 input/tick ⇒ niente speedhack |

Misura reale (test `server.test.ts`, 7 client, 3 tick di latenza per direzione): errore di riconciliazione mediano < 0.05u,
p99 < 5u (colpi e spinte che il client non può prevedere).

**Limiti noti / prossimi passi**: JSON invece di binario (~5× più grande; l'interfaccia `ServerMsg` è già tipizzata, basta
sostituire encode/decode); nessuna lag-compensation sui colpi (le collisioni sono tutte lato server nel presente del server);
la fase delle piattaforme mobili per il robot locale usa il tick predetto, quindi vista dai remoti può differire di pochi frame.

## 3. Character controller (`shared/controller.ts`)

Robot con fisica reattiva, feeling "platformer 3D da console":

* accelerazione/attrito separati a terra e in aria, rotazione del corpo con smorzamento esponenziale;
* **coyote time** 100 ms, **jump buffer** 120 ms, **salto a altezza variabile** (rilascio ⇒ gravità ×2.6);
* **propulsore (hover)**: pressione *fresca* di salto in aria → 0.55 s di carburante, ricaricato atterrando;
* **tuffo**: scatto in avanti con cooldown 1.1 s, 0.45 s di "stato tuffo" che spinge gli altri robot;
* collisioni AABB a assi separati con tolleranza sui gradini (`0.18`), niente tunneling a velocità terminale (verificato da test);
* si viene **trasportati** dalle piattaforme mobili (delta del tick precedente);
* caduta sotto `killY` → respawn all'ultimo checkpoint dopo 1.4 s con 1.5 s di invulnerabilità.

La parte "reattiva" visiva (squash & stretch a molla, inclinazione in corsa, braccia, testa che oscilla da stordito, fiamma
del propulsore, bolla scudo, scia del boost) vive in `client/robot.ts` ed è guidata **solo** dallo stato di simulazione.

## 4. Oggetti (`shared/items.ts`)

| Oggetto | Ruolo (stile "kart racer") | Dettagli |
|---|---|---|
| `boost` | accelerazione | ×1.65 velocità per 1.7 s + calcio iniziale |
| `seeker` | proiettile a ricerca | insegue il robot **immediatamente davanti** in classifica (se sei primo vola dritto), 19 u/s, sterzo limitato, 6 s di vita, max 2 vivi per owner |
| `hazard` | ostacolo fisico rilasciabile | corpo rigido: viene lanciato dietro, cade, atterra, scivola, viaggia sulle piattaforme mobili; armato dopo 0.6 s; immune l'owner per 1.5 s; max 3 per owner |
| `shield` | difensivo | assorbe **un** colpo, poi 0.6 s di grazia |

Le casse si ricaricano in 4 s. L'estrazione è **pesata sulla posizione** (rubber-banding): primo ≈ trappole/scudo, ultimo ≈ seeker
(rapporto ~11× in test).

### Risoluzione degli impatti (`shared/impacts.ts`) — l'ordine delle regole conta

1. bersaglio morto / in respawn / già arrivato → `ignored`
2. mai colpire se stessi con seeker/tuffo (la propria trappola sì, dopo la grazia)
3. i-frame attivi → `ignored`, **la sorgente non viene consumata** (il proiettile prosegue)
4. scudo → `blocked`, scudo consumato, 0.6 s di grazia, sorgente consumata
5. hazard contro robot in boost → `smashed`: il robot non subisce danni, perde il 65% del boost, l'ostacolo si frantuma
6. altrimenti `hit`: knockback + stordimento + i-frame (seeker 1.4 s, hazard 1.0 s, tuffo 0.6 s), boost azzerato

Spinte tra robot (`contacts`): separazione morbida + impulso proporzionale alla sovrapposizione, senza stun.

## 4b. Mappe, superfici e ostacoli giganti

Tutto ciò che si muove è una **funzione pura del tick** (nessuno stato da sincronizzare): server e client calcolano le stesse pose.

* **Superfici** (`Platform.surface`, applicate in `stepPlayer`, quindi predette): `ice` (accelerazione ×0.15, attrito ×0.06), `conveyor`
  (trascina a `flowX/flowZ` u/s), `bounce` (lancia a 19 u/s), `slime` (velocità ×0.55, salto ×0.8).
* **Tessere** `blink`: solide solo per `duty` di ogni ciclo (trabocchetti); lampeggiano in rosso nell'ultimo 20% prima di sparire.
* **Vento** (`WindZone`): deriva costante a `0.3·f` u/s mentre la zona è attiva (la semplice forza verrebbe annullata dall'attrito/controllo aereo).
* **Ostacoli** (`CourseHazard`, `hazards.ts`): `spinner` (barra rotante, si può saltare), `pendulum` (martello a pendolo), `roller`
  (cilindro gigante che rotola verso -z). Il contatto è deciso dal server (`RaceSim.obstacles`) e passa dalla stessa tabella degli impatti
  (`kind: 'obstacle'`: push 12, stun 0.9 s, i-frame 1.3 s; lo scudo li para).
* **Registro mappe** (`maps.ts`): `MapDef { id, name, theme, build(seed, difficulty) }`. Titan e Frost usano lo stesso costruttore
  (`buildPark`) con *pool di segmenti* diversi; il percorso è generato da seed, quindi viaggia in rete solo `(map, seed, difficulty)`.
  I test verificano per ogni mappa/difficoltà: struttura valida, determinismo, spawn/casse/checkpoint su una piattaforma, **nessun vuoto > 5.6 u**.
* **Modalità** (`modes.ts` + `Match`): dati + interpretazione di `kind`. L'host sceglie mappa e modalità (`config`, solo host, resetta i "pronto").

## 5. Formato di gara

Eliminazione: ogni round passano i primi `ceil(n/2)` (7 → 4 → 2 → 1). Il round finisce quando la quota è piena, tutti sono
arrivati, o scade il tempo (in quel caso i posti restanti vanno ai più avanzati, così il match non si blocca mai).
Difficoltà e lunghezza crescono col round. Partenza con countdown di 3 s; 5 s di intermezzo.

## 6. Hub, lobby e limite dei 7 giocatori (`server/hub`)

* `Room` ha **esattamente 7 slot**; ogni ingresso passa da `Room.tryJoin`. Il limite non è un `if` sparso: la struttura dati
  non può contenere un ottavo client. Conta anche i giocatori **disconnessi ma riservati** (grace 20 s) e non esistono spettatori
  (gli eliminati restano nella stanza, quindi continuano a occupare uno slot).
* `GameModule` (`hub/game.ts`) astrae il titolo: `{id, minPlayers, maxPlayers≤7, createSession(host)}`. **Per aggiungere un gioco**
  basta implementare `GameSession` e registrarlo in `startServer`; lobby, matchmaking, rate-limit e reconnessione sono già generici.
* Fasi stanza: `lobby → countdown(5 s) → playing → results(8 s) → lobby`. Il countdown parte quando ≥2 giocatori sono tutti
  *pronti* e si annulla se qualcuno annulla/entra/esce.
* Matchmaking `quickplay`: riempie prima la stanza pubblica più piena (raggiunge subito il quorum) altrimenti ne crea una;
  `create` (pubblica/privata con codice di 5 caratteri) e `join` per codice.
* Durante la partita le stanze non accettano ingressi (`ROOM_IN_PROGRESS`).
* **Riconnessione**: `welcome` consegna un token segreto; `hello` con token entro 20 s riprende lo slot. Scaduto il grace lo slot è
  liberato e il giocatore rimosso dal match.
* Operatività: `maxRooms`/`maxClients` configurabili, `/healthz`, un solo processo = un solo loop (scala orizzontalmente per
  stanza: lo stato di una stanza non è condiviso, basta un router davanti).

## 6b. Telefono come joypad, PC come schermo

* **Ruoli**: `player` (joypad o PC con tastiera) e **`display`** (schermo). Un display fa `{k:'screen'}`: crea (o si collega a) una stanza pubblica,
  riceve `round`/snapshot ma **non occupa uno slot** (`Room.displays`, max 3), non può inviare input né entrare come giocatore, può scegliere mappa/modalità
  (`config`) e forzare l'avvio (`start`, ≥2 giocatori). Una stanza vive finché ha giocatori **o** uno schermo. Il cap di 7 resta sui giocatori.
* **Joypad** (`pad.html` + `pad.ts`, ~9 KB, nessun three.js): legge `deviceorientation`, invia `InputFrame` a 60 Hz con le stesse regole del client completo
  (latch dei tap, ridondanza, flush per frame). Nessuna predizione: il robot si vede sullo schermo.
* **Inclinazione** (`tilt.ts`, pura e testata): il vettore "su" nel sistema del dispositivo `u = (-cosβ·sinγ, sinβ, cosβ·cosγ)` è indipendente dalla bussola e dalla piattaforma;
  si ruota nel sistema dello schermo con `screen.orientation.angle` (verticale/orizzontale, entrambi i versi) e si ricava roll/pitch. Poi: sottrazione della posa di riposo
  calibrata, zona morta 2.5°, curva ^1.35 (controllo fine al centro), saturazione a 26°, smussamento esponenziale indipendente dal framerate.
* **HTTPS**: i browser mobili espongono i sensori solo su origini sicure. Il server apre anche HTTPS (`porta+1`) con un certificato **autofirmato** (`selfsigned`, SAN = localhost + IP LAN,
  in `.cert/`, ignorato da git). WebSocket condiviso fra `ws://` e `wss://`; `/info` espone IP e porte per costruire il QR.
  `requestPermission()` (iOS) va chiamato dentro il tap; si ascoltano comunque gli eventi e conta solo se arrivano dati davvero.
* **Limite noto**: ho verificato la catena con eventi `deviceorientation` **simulati** (Chromium headless non fornisce valori reali): sensore hardware, segni su iOS/Android
  e comodità reale vanno provati su telefoni veri.

## 7a. Grafica "quasi fotorealistica": cosa c'è e cosa no

Titan/Frost usano: cielo fisico (`Sky`, stesso cielo come luce ambientale per riflessi coerenti), **texture procedurali tileable** (cemento, legno,
erba, metallo, ghiaccio con crepe, melma, nastro, trampolino) con bump map, materiali fisici con clearcoat, **ombre morbide** (desktop), mare con normal map animata,
nebbia atmosferica, nuvole, isole e palloni di scenario, ombre di contatto sui robot (anche su telefono). Su telefono: niente ombre/clearcoat, risoluzione dinamica e culling per distanza.

È un look curato e coerente, **non** fotorealismo vero: quello richiede asset autoriali (set PBR scansionati, HDRI, modelli scolpiti). Gli slot sono pronti:
`textures.ts` (`surfaceTexture`) e `Stage.makeSky` si sostituiscono con file reali senza toccare gioco o rete.

## 7. Direzione artistica

Robot di plastica laccata (`MeshPhysicalMaterial` con clearcoat) e cromo, visiera scura con occhi emissivi, antenna al neon;
piattaforme di metallo scuro con cornice neon emissiva e glow sul lato inferiore; cielo a gradiente con stelle e rocce
poligonali sullo sfondo; environment map "studio" (RoomEnvironment) per riflessi puliti; bloom + tone mapping ACES.
Tutto è **procedurale e originale**: nessun asset, nome o personaggio di altri giochi è usato. Le meccaniche (platformer a
eliminazione, oggetti da kart racer) non sono protette; l'estetica è *ispirata* a quel genere, non una copia di asset esistenti.

## 8. Test

`tests/shared.test.ts` — controller (determinismo, altezza salto, coyote, hover, respawn, tunneling), tabella impatti, rubber-banding,
seeker/hazard in simulazione, percorribilità del tracciato con un bot, match 7→4→2→1.
`tests/server.test.ts` — cap a 7 (privata, quickplay 15→7+7+1, slot riusabile), ready/countdown, ingresso a partita in corso,
match completo con 7 client e latenza, riconnessione, validazione/anti-cheat (JSON malformato, NaN, speedhack, replay, flood, rate-limit).
`tests/ws.test.ts` — WebSocket reali.

> Il bot di test è volutamente ingenuo (non fa salti corti): completa ~80% dei seed casuali, quindi il test di regressione
> richiede ≥ 70%. È un controllo di non-regressione sul generatore, **non** una prova di bilanciamento: serve playtest umano.
