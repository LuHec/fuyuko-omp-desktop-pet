# OMP Desktop Pet

A desktop sprite overlay controlled by an OMP extension.

## Usage with OMP

The extension `~/.omp/agent/extensions/omp-pet-bridge/` is auto-discovered by OMP.

In OMP, type:

```text
/pet on      # show desktop pet
/pet off     # hide desktop pet
```

The pet reacts to OMP events:

- `running` while agent is working / tool is running
- `waiting` when tool approval is requested
- `review` after a successful tool execution
- `failed` after a failed tool execution or auto-retry
- `idle` otherwise

## Run standalone (for testing)

```bash
cd ~/.omp/omp-desktop-pet
bunx electron .
```

Right-click the pet to close.

## Replace the sprite

Edit `index.html`. Replace the `<svg>` with an `<img>`:

```html
<img src="character.png" width="180" height="220" style="pointer-events: none;">
```

For animation, swap `src` in a `setInterval` loop or use an animated WebP/GIF.

## Build portable exe

```bash
bun run build
```

Output under `dist/`.

## Disable

```yaml
# ~/.omp/agent/config.yml
disabledExtensions:
  - extension-module:omp-pet-bridge
```
