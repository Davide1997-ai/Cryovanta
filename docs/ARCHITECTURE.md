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
| Snapshot | 30 Hz (`SNAPSHOT_EVERY=2`: lo schermo non predice, quindi più snapshot = meno latenza visiva), serializzati **una volta** per stanza, droppabili se il socket è in backpressure (>256 KB) |
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

## 4c. Giocare sporco (Stumble Guys-style)

* **Spingi** (`push`, edge): cono davanti (raggio 2.1, ±~70°), knockback 10.5 + stordimento 0.5 s, cooldown 0.75 s; l'affondo in avanti è predetto, l'effetto sugli altri lo decide il server.
  Lo scudo la para. Con boost la spinta è ×1.25.
* **Afferra** (`grab`, tenuto): aggancia il robot più vicino davanti (raggio 1.7). Il bersaglio va al 40% e non salta (`slow`), chi afferra al 75%; lo si trascina davanti a sé.
  Max 2.4 s poi cooldown 3.5 s; si molla se si rilascia il tasto, ci si stordisce o la distanza supera ~2.7. **Spingi mentre afferri = lancio** (15 u/s, stordimento 0.7 s).
* **Urti**: correre addosso a qualcuno a >6.5 u/s di velocità relativa è un `bump` (knockback ∝ velocità, stordimento 0.28 s); sotto soglia resta la spinta morbida.
* Tutti passano da `resolveImpact` (i-frame, scudo): una tabella sola. Il robot colpito cade all'indietro e si rialza (animazione guidata da `st`).

## 4d. Round a sopravvivenza (Arena)

`Course.survival`: niente traguardo, **cadere = eliminato** (nessun respawn, `outAt`), vince l'ultimo; classifica = ordine di eliminazione. La mappa **Platform Panic** è una griglia 7×7 di tessere
con `Platform.vanishAt` (funzione pura del tempo: crollano dall'anello esterno verso il centro, ultimi secondi di tremolio rosso), più due barre rotanti incrociate al centro.
La modalità `arena` gioca solo mappe `survival`; le modalità di corsa non estraggono mai l'arena (`RACE_MAP_IDS` / `SURVIVAL_MAP_IDS`).

## 4e. Traguardo e qualificazione (leggibilità)

Cartello **FINISH** a scacchi su due pali alti 16 u e striscia a scacchi sul pavimento; ogni riquadro mostra distanza residua, barra di avanzamento e, al taglio, **QUALIFICATO!**
(eliminazione) / **TRAGUARDO!** con coriandoli; l'intestazione mostra `qualificati n/N`. Lo snapshot porta `qf` (arrivati), `qq` (posti), `fz` (z del traguardo), `sv` (sopravvivenza).

## 4f. Round extra: Hex-A-Gone, squadre, corona

* **Tessere dinamiche** (`Platform.dynamic`): lo stato non è funzione del tempo ma dei giocatori, quindi lo decide **solo il server** (`RaceSim.tiles`): dopo 0,45 s di contatto la tessera riceve `vanishAt = now + collapseDelay`
  (1,8 s sul piano alto, 2,8 s su quello basso). `vanishAt` è già onorato da `platformBox`, quindi la fisica resta identica ovunque; i client lo ricevono nello snapshot (`tv`: `[id, vanishAt, …]`).
* **Squadre** (`PlayerState.team`, assegnate alternando per slot): `resolveImpact` ignora spinte, urti, tuffi, droni e prese tra compagni (non trappole/ostacoli); i punti d'arrivo si sommano per squadra (`Match.teamPoints`).
* **Corona** (`Course.crown`, `RaceSim.crown`): re della collina. Chi è entro il raggio e non stordito la prende (grazia 0,9 s), `crownScore` cresce per secondo di possesso, il portatore è al 90% di velocità e la perde se stordito/cade
  (torna sul piedistallo dopo 1,5 s). Vince chi arriva a 20 s o, a tempo scaduto, il punteggio più alto. È anche la **finale** della modalità Eliminazione quando restano 2 robot.
* **Causa dell'eliminazione**: `lastHit*` ricorda chi/che cosa ha colpito per ultimo; se si cade entro 2 s l'evento `out` porta `by`/`how` ("spinto fuori da…"), usato dal feed e dalla telemetria.

## 4g. Progressione, aspetto, emote, audio, bilanciamento

* `shared/cosmetics.ts`: 12 colori, 8 cappelli con livello minimo, curva XP, emote. `ProfileStore` (server) salva `{xp, matches, wins}` per token in `.data/profiles.json` (scrittura atomica con debounce).
  Un token ben formato (32 hex) è l'identità; il server **valida** l'aspetto contro il livello (un cappello non sbloccato viene scartato).
* **XP** assegnati alla fine del match nel punto unico `Room.broadcast('matchEnd')`; ogni telefono riceve `profile {gain}`.
* **Emote**: messaggio `emote` → `session.handleEmote` (cooldown 72 tick per giocatore) → evento nello stream degli snapshot, visibile a tutti gli schermi.
* **Audio** (`client/audio.ts`): WebAudio puro, nessun asset; effetti con limitazione di frequenza per nome, musica generativa a 4 note per tema.
* **Telemetria**: `MatchLog` per match (`.data/matches.jsonl`); **simulatore** `scripts/balance.ts` (bot "fighter"/"hexer"/corsa) con finestre target e segnalazioni; `scripts/report.ts` aggrega i dati veri.

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
* **Schermo diviso** (`main.ts` in modalità `?screen`, `layout.ts`): una camera per giocatore (`PlayerCam`, spawn dietro il robot, mai condivisa),
  `Stage.renderViews` disegna la scena una volta per riquadro con `viewport`+`scissor`; per-camera: culling per distanza, posizione di acqua/neve, LOD dei robot (`focusView`).
  Griglia 1×1 / 2×1 / 2×2 / 3×2 / 4×2 (la cella avanzata ospita la classifica). Con molti riquadri: ombre reali spente (un solo frustum non copre giocatori lontani),
  portata di visibilità ridotta, nebbia più fitta e risoluzione dinamica (`adaptQuality`). Il bloom (post-processing) è disattivato nel multi-riquadro.
  Una camera non insegue un robot che cade nel vuoto (mantiene l'ultima altezza a terra); i riquadri degli eliminati osservano il leader.
  Lo schermo riceve lo stato **a ogni tick (60 Hz)**, i telefoni a 30 Hz (`sendDisplays`/`sendPlayers`): buffer di interpolazione 2 snapshot + 12 ms (≈45 ms), allargato dalla stima del jitter.
  Misurato: dal tocco sul joystick al primo movimento nello stato del server ≈ 19 ms (mediana, localhost).
* **Joypad** (`pad.html` + `pad.ts`, ~10 KB, nessun three.js): joystick flottante + 5 pulsanti (SALTA, SPINGI, AFFERRA, TUFFO, oggetto; tap latched).
  Layout in unità `--u = min(1dvh, 1.7vw)`: i pulsanti scalano con l'altezza *reale* visibile e stanno sempre nello schermo (verificato a 700×300). Anti-zoom: `touch-action:none`, blocco di `gesture*`/pizzico,
  blocco del doppio tocco **solo in gioco** (altrove cancellerebbe il click dei menu), `position:fixed`+`dvh` contro le barre del browser.
  Inoltre, invia `InputFrame` a 60 Hz con le stesse regole del client completo
  (latch dei tap, ridondanza, flush per frame). Nessuna predizione: il robot si vede sullo schermo.
* **Inclinazione** (`tilt.ts`, pura e testata): il vettore "su" nel sistema del dispositivo `u = (-cosβ·sinγ, sinβ, cosβ·cosγ)` è indipendente dalla bussola e dalla piattaforma;
  si ruota nel sistema dello schermo con `screen.orientation.angle` (verticale/orizzontale, entrambi i versi) e si ricava roll/pitch. Poi: sottrazione della posa di riposo
  calibrata, zona morta 2.5°, curva ^1.35 (controllo fine al centro), saturazione a 26°, smussamento esponenziale indipendente dal framerate.
* **HTTPS (solo per l'inclinazione opzionale)**: i browser mobili espongono i sensori solo su origini sicure; il joypad normale usa HTTP e non mostra avvisi. Il server apre anche HTTPS (`porta+1`) con un certificato **autofirmato** (`selfsigned`, SAN = localhost + IP LAN,
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

## 9. Pipeline Blender e fisica delle piattaforme

- `tools/blender/{textures,meshes,build_assets}.py` producono `models.glb` e i set PBR (vedi README). Il client li carica in `assets.ts`; `textures.ts` e `robot.ts` li sostituiscono alle versioni procedurali appena disponibili (`texVersion()` invalida i materiali in cache, `Stage.rebuild()` ricostruisce il percorso).
- Piattaforme mobili: la posizione è funzione pura del tick. Il rendering usa il tick interpolato (schermo) o predetto (giocatore locale) in modo coerente con i robot; i robot remoti appoggiati a una piattaforma ricevono la differenza tra i due istanti.
- `PlayerState.ivx/ivy/ivz` (snapshot `ix/iy/iz`): velocità ereditata lasciando una piattaforma `mover`/`piston`; azzerata all'atterraggio e al respawn. Test in `tests/physics.test.ts`.
