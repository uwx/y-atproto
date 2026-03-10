# y-atproto

A [Yjs](https://yjs.dev/) CRDT provider that syncs documents over the [AT Protocol](https://atproto.com/). Documents are stored as ATProto records and real-time updates are delivered via [Jetstream](https://github.com/bluesky-social/jetstream).

## How it works

- Each collaborative session is represented by a **room** record (`io.github.uwx.yjs.room`) in the user's ATProto repository.
- Document updates are written as `io.github.uwx.yjs.update` records, with small updates stored inline and large updates (>1 MB) stored as blobs.
- Real-time sync is achieved by subscribing to Jetstream for new update and awareness records.
- Rooms can optionally be **encrypted** (AES-256-GCM with PBKDF2 key derivation) and restricted to an **allowlist of DIDs**.
- Awareness (cursor positions, user presence) is supported via `io.github.uwx.yjs.awareness` records.

## Installation

```
pnpm install y-atproto
```

## Usage

### Creating a new room

```ts
import { Doc } from "yjs";
import AtprotoProvider from "y-atproto";

const ydoc = new Doc();

const { provider, room } = await AtprotoProvider.createNew({
  secret: "optional-password",
  repo: did,
  handler: agent,
  ydoc,
  autosaveInterval: 1000,
});
```

### Joining an existing room

```ts
const provider = await AtprotoProvider.resume({
  secret: "optional-password",
  repo: did,
  handler: agent,
  room: "at://did:plc:.../io.github.uwx.yjs.room/...",
  ydoc,
  autosaveInterval: 1000,
});
```

### Options

| Option | Type | Description |
|---|---|---|
| `secret` | `string` | Optional password for end-to-end encryption |
| `repo` | `ActorIdentifier` | DID or handle of the authenticated user |
| `handler` | `FetchHandler \| KittyAgent` | Authenticated AT Protocol agent |
| `ydoc` | `Doc` | Yjs document to sync |
| `autosaveInterval` | `number` | Milliseconds between flushes of queued updates |
| `resendAllUpdates` | `boolean` | If true, always send the full document state |
| `fullUpdateRate` | `number` | Probability (0-1) of sending a full update on each flush (default 0.1) |
| `awareness` | `Awareness` | Custom Yjs awareness instance to reuse |
| `awarenessLive` | `boolean` | If true, broadcast awareness on every local change instead of on an interval |
| `awarenessBroadcastInterval` | `number` | Milliseconds between awareness broadcasts (default 29000) |

## Demos

- **demos/monaco-react** -- Collaborative Monaco editor.
- **demos/react-prosemirror** -- Collaborative ProseMirror editor.

## Building

Requires [pnpm](https://pnpm.io/).

```
pnpm install
pnpm build
```

## License

MIT
