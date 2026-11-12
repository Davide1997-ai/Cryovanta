# Cryovanta

Hub di giochi multiplayer **a stanze** (hard cap: **7 client per istanza**), con netcode **server-autoritativo**.
Primo titolo: **Neon Circuit**, platformer a ostacoli competitivo a eliminazione, con casse oggetto, proiettili a ricerca,
boost e trappole rilasciabili.

![gameplay](docs/screenshot-gameplay.png)

```bash
npm install
npm run dev:server     # ws://localhost:8080  (+ /healthz)
npm run dev:client     # http://localhost:5173  (apri 2+ schede, "Partita rapida", "Pronto!")
npm test               # 44 test: fisica, impatti, lobby/cap, match completo via rete, ws reali
npm run typecheck
```

### App desktop (.exe, offline)

```bash
npm run desktop     # avvia l'app Electron in locale (server + client integrati)
npm run dist:win    # produce packages/desktop/release/CryovantaNeonCircuit-portable.exe (+ installer su Windows)
```

L'exe non richiede Node né internet: avvia il server di gioco al suo interno (porta 8080, o una libera se occupata) e apre la finestra.
Menu *Gioco → Come far giocare amici in LAN* mostra l'indirizzo da aprire nel browser degli altri PC. In alternativa la
GitHub Action `Build Windows exe` (avvio manuale) costruisce installer e portable su un runner Windows.

Controlli: **WASD/frecce** muovi · **Spazio** salta (premi di nuovo in aria = propulsore) · **Shift** tuffo · **E / click** usa oggetto · tasto destro + mouse: ruota camera.

Architettura, netcode, tabella degli impatti, come aggiungere un gioco: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| Pacchetto | Contenuto |
|---|---|
| `packages/shared` | Simulazione deterministica (controller, collisioni, oggetti, impatti, round/match), protocollo, predizione client |
| `packages/server` | Hub, stanze (cap 7), loop a timestep fisso 60 Hz, sessione autoritativa di Neon Circuit |
| `packages/client` | Three.js: robot procedurali, piattaforme neon, bloom, input, interpolazione, lobby/HUD |
| `tests` | Vitest: harness in-process a tempo virtuale + test su WebSocket reali |
