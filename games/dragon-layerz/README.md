# Dragon Layerz — Descent to the Cosmic Gate

A retro arcade shooter packaged as a SpaceKit app. You pilot a dragon down through ten layers, each named after a real exoplanet (KELT-9b, WASP-12b, TRAPPIST-1 c and more), fighting a boss at the end of each one on the way to **The Cosmic Gate**.

The whole game is one self-contained HTML file, so it also makes a good template for shipping a small game on SpaceKit.

## How to play

| Action | Keyboard | Touch / mouse |
|--------|----------|---------------|
| Move | Arrow keys or WASD | Drag to fly |
| Fire | Space | Automatic while dragging |
| Confirm / start | Enter | Tap |
| Pause | P | — |
| Mute | M | — |

Grab ◆ POWER orbs to upgrade your guns, keep your lives, and get onto the Top Pilots table. If you quit partway, you can continue from the last layer you reached.

## SpaceKit integration

When running inside SpaceKit, the game uses `window.spacekit.storage` to save your pilot name, high scores and progress, so they follow your SpaceKit identity across devices. Outside SpaceKit it falls back to local browser storage.

## Layout

```
dragon-layerz/
├── ui/dragon-layerz-v1.html   # The entire game (HTML + CSS + JS)
├── scripts/
│   ├── package.sh             # Packages the HTML as a signed .spkg
│   ├── deploy.sh              # Uploads and publishes to the marketplace
│   └── undeploy.sh            # Removes a deployment
├── deploy.toml                # Marketplace listing (title, category, price)
└── spacekit.toml
```

## Prerequisites

- The SpaceKit CLI (`spacekit`) on your `PATH`
- Node.js and Python 3 (the deploy scripts use them to read the package manifest)

## Play locally

Open `ui/dragon-layerz-v1.html` in a browser. There's no build step.

## Package and deploy

```bash
./scripts/package.sh   # → ui/dist/dragon-layerz-<version>.spkg (the HTML is shipped as index.html)
./scripts/deploy.sh    # packages if needed, then uploads and publishes
```

`deploy.sh` removes any previous deployment of the same app ID first. Use `./scripts/undeploy.sh <app-id>` to remove a deployment by hand.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SPACEKIT_STORAGE_NODE_URL` | From the website `.env`, else `http://127.0.0.1:3030` | Storage node to deploy to |
| `DRAGON_LAYERZ_VERSION` | `1.0.0` | Package version |
| `DRAGON_LAYERZ_PUBLISH` | `1` | Set to `0` to upload without publishing |

The marketplace listing is defined in `deploy.toml`: category `games`, public, free.

## License

Apache 2.0 — see [LICENSE](LICENSE).
