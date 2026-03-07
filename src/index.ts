import {
    applyUpdateV2,
    mergeUpdatesV2,
    encodeStateAsUpdateV2,
    type Doc,
} from "yjs";
import { ObservableV2 } from "lib0/observable";
import {
    ConstellationClient,
    getDidAndPds,
    KittyAgent,
    resolveHandleAnonymously,
    SlingshotClient,
} from "kitty-agent";
import { IoGithubUwxYjsAwareness, IoGithubUwxYjsRoom, IoGithubUwxYjsUpdate } from "./lexicons/index.js";
import {
    parseResourceUri,
    type ActorIdentifier,
    type Did,
    type RecordKey,
    type ResourceUri,
} from "@atcute/lexicons";
import { JetstreamSubscription } from "@atcute/jetstream";
import { is } from "@atcute/lexicons";
import { fromUint8Array, toUint8Array } from "js-base64";
import type { FetchHandler, FetchHandlerObject } from "@atcute/client";
import { now as tidNow, parse as parseTid } from "@atcute/tid";
import { isLegacyBlob } from "@atcute/lexicons/interfaces";
import { decrypt, deriveKey, encrypt } from "./crypto.js";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, outdatedTimeout } from 'y-protocols/awareness.js'
import { createModuleLogger } from 'lib0/logging';

const log = createModuleLogger('y-webrtc')

const constellation = new ConstellationClient({
    userAgent: "y-atproto/1.0.0",
});

const slingshot = new SlingshotClient({
    userAgent: "y-atproto/1.0.0",
});

async function getUpdateData(
    actor: ActorIdentifier,
    record: IoGithubUwxYjsUpdate.Main,
) {
    if (record.update.$type == "io.github.uwx.yjs.update#blobUpdateData") {
        const { did, pds } = await getDidAndPds(actor);
        const agent = KittyAgent.createUnauthed(pds);
        const cid = isLegacyBlob(record.update.blob)
            ? record.update.blob.cid
            : record.update.blob.ref.$link;
        const blobData = await agent.getBlobAsBinary({
            cid,
            did,
        });

        return blobData;
    } else if (
        record.update.$type == "io.github.uwx.yjs.update#bytesUpdateData"
    ) {
        return toUint8Array(record.update.bytes.$bytes);
    }

    throw new Error("Unknown update type");
}

async function getAwarenessForResume(
    room: ResourceUri,
    authorizedDids?: Did[],
): Promise<Uint8Array[]> {
    // read through all backlinks newer than the last 30 seconds (the outdatedTimeout in y-protocols/awareness) for the room
    // to be applied.

    const iter = constellation.getAllBacklinks({
        subject: room,
        source: "io.github.uwx.yjs.awareness:room",
    });

    const updateBuffer: Uint8Array[] = [];

    for await (const link of iter) {
        // TID is in microseconds
        const time = new Date(parseTid(link.rkey).timestamp / 1_000);

        if (authorizedDids != null && !authorizedDids.includes(link.did)) {
            continue; // skip updates from unauthorized DIDs
        }

        if (time < new Date(Date.now() - outdatedTimeout)) {
            // we've found enough updates
            break;
        }

        const { value: record } = await slingshot.tryGetRecord({
            collection: "io.github.uwx.yjs.awareness",
            rkey: link.rkey,
            repo: link.did,
        });

        if (record == null) {
            continue; // skip deleted records. hopefully this won't lead to broken document state.
        }

        updateBuffer.push(toUint8Array(record.update.$bytes));
    }

    return updateBuffer;
}

/**
 * Accumulates all updates for a room from the atmosphere and returns them as a single merged update.
 * @param room
 */
async function getStateForResume(
    room: ResourceUri,
    authorizedDids?: Did[],
    key?: CryptoKey,
): Promise<Uint8Array> {
    // read through all backlinks for the room up until either the first update or any full update.
    // if we find a full update, we walk back a little bit further to get a few extra updates with similar timestamps,
    // to make sure we get the full update regardless of race conditions.

    const iter = constellation.getAllBacklinks({
        subject: room,
        source: "io.github.uwx.yjs.update:room",
    });

    const updateBuffer: Uint8Array[] = [];

    let dateCutoff: Date | undefined = undefined;

    for await (const link of iter) {
        log("Found update backlink", link);

        // TID is in microseconds
        const time = new Date(parseTid(link.rkey).timestamp / 1_000);

        if (authorizedDids != null && !authorizedDids.includes(link.did)) {
            continue; // skip updates from unauthorized DIDs
        }

        if (dateCutoff != null) {
            if (time < dateCutoff) {
                log("Skipping update because it's too old");
                // we've found enough updates
                break;
            }
        }

        const { value: record } = await slingshot.tryGetRecord({
            collection: "io.github.uwx.yjs.update",
            rkey: link.rkey,
            repo: link.did,
        });

        if (record == null) {
            continue; // skip deleted records. hopefully this won't lead to broken document state.
        }

        if (dateCutoff == null && record.isFullUpdate) {
            // we've found a full update, let's set a date cutoff for a few seconds in the past
            // and load those few updates.
            dateCutoff = new Date(time.getTime() - 15000);
            log("Setting date cutoff to", dateCutoff);
        }

        let data = await getUpdateData(link.did, record);
        if (key != null) {
            data = await decrypt(data, key);
        }
        updateBuffer.push(data);
    }

    return mergeUpdatesV2(updateBuffer);
}

export default class AtprotoProvider extends ObservableV2<{
    sync(hasQueued: boolean): void;
}> {
    readonly ydoc: Doc;
    readonly resendAllUpdates: boolean;
    readonly queuedYjsUpdates: Uint8Array[];
    readonly autosaveLoop: number;
    readonly jetstream: JetstreamSubscription;
    readonly room: ResourceUri;
    readonly agent: KittyAgent;
    readonly repo: ActorIdentifier;
    stopped = false;
    readonly fullUpdateRate: number;
    readonly key: CryptoKey | undefined;
    readonly awareness: Awareness;
    readonly awarenessBroadcastLoop?: number;

    private constructor({
        key,
        fullUpdateRate,
        state,
        repo,
        handler,
        room,
        record,
        jetstreamService,
        ydoc,
        autosaveInterval,
        resendAllUpdates,
        awarenessBroadcastInterval,
        awareness,
        awarenessLive,
        awarenessData,
    }: {
        key?: CryptoKey;
        state?: Uint8Array;
        repo: ActorIdentifier;
        handler: FetchHandler | FetchHandlerObject | KittyAgent;
        room: `at://${ActorIdentifier}/io.github.uwx.yjs.room/${RecordKey}`;
        record: IoGithubUwxYjsRoom.Main;
        jetstreamService?: string;
        ydoc: Doc;
        autosaveInterval: number;
        resendAllUpdates?: boolean;
        fullUpdateRate?: number;
        awarenessBroadcastInterval?: number;
        awareness?: Awareness;
        awarenessLive?: boolean;
        awarenessData?: Uint8Array[];
    }) {
        super();

        this.repo = repo;
        this.agent = handler instanceof KittyAgent ? handler : new KittyAgent({ handler });
        this.room = room;
        this.ydoc = ydoc;
        this.resendAllUpdates = resendAllUpdates ?? false;
        this.fullUpdateRate = fullUpdateRate ?? 0.1;
        this.key = key;
        this.awareness = awareness ?? new Awareness(ydoc);

        if (record.encrypted && this.key == null) {
            throw new Error("Room is encrypted but no key was provided");
        }

        if (state != null) {
            applyUpdateV2(this.ydoc, state, 'atproto/constellation');
        }

        if (awarenessData != null) {
            for (const data of awarenessData) {
                applyAwarenessUpdate(this.awareness, data, 'atproto/constellation');
            }
        }

        // queued yjs-updates, to be flushed and sent out in syncToChatPeers()
        this.queuedYjsUpdates = [];

        const jetstream = (this.jetstream = new JetstreamSubscription({
            url: jetstreamService ?? "wss://jetstream2.us-east.bsky.network",
            wantedCollections: ["io.github.uwx.yjs.update", "io.github.uwx.yjs.room", "io.github.uwx.yjs.awareness"],
        }));

        (async () => {
            for await (const event of jetstream) {
                if (this.stopped) {
                    break;
                }

                if (event.kind === "commit") {
                    const commit = event.commit;

                    if (commit.operation === "update") {
                        if (commit.collection !== "io.github.uwx.yjs.room") {
                            continue;
                        }

                        const updateRecord = commit.record;
                        if (!is(IoGithubUwxYjsRoom.mainSchema, updateRecord)) {
                            continue;
                        }
                    }

                    if (commit.operation === "create") {
                        if (
                            record.authorizedDids != null &&
                            !record.authorizedDids.includes(event.did)
                        ) {
                            continue;
                        }

                        if (commit.collection === "io.github.uwx.yjs.update") {
                            log("Got update", commit);

                            const createRecord = commit.record;
                            if (!is(IoGithubUwxYjsUpdate.mainSchema, createRecord)) {
                                continue;
                            }

                            await this.receiveJetstreamUpdate(
                                await getUpdateData(event.did, createRecord),
                            );
                        }

                        if (commit.collection === "io.github.uwx.yjs.awareness") {
                            log("Got awareness", commit);

                            const createRecord = commit.record;
                            if (!is(IoGithubUwxYjsAwareness.mainSchema, createRecord)) {
                                continue;
                            }

                            await this.receiveJetstreamAwarenessUpdate(
                                toUint8Array(createRecord.update.$bytes),
                            );
                        }
                    }
                }
            }
        })();

        ydoc.on("updateV2", (yjsupdate, origin) =>
            this.receiveYjsUpdate(yjsupdate, origin),
        );
        this.autosaveLoop = setInterval(
            () => this.syncToChatPeers(),
            autosaveInterval,
        );

        if (!awarenessLive) {
            this.awarenessBroadcastLoop = setInterval(
                () => this.broadcastAwarenessUpdate(),
                awarenessBroadcastInterval ?? 29_000,
            );
        } else {
            this.awareness.on('change', ({ added, updated, removed }: { added: number[], updated: number[], removed: number[] }, origin: any) => {
                if ((typeof origin !== 'string' || !origin.startsWith('atproto/')) &&
                    (added.includes(this.awareness.clientID) || updated.includes(this.awareness.clientID) || removed.includes(this.awareness.clientID))) {
                    this.broadcastAwarenessUpdate();
                }
            });
        }
    }

    destroy() {
        super.destroy();
        this.syncToChatPeers(true);
        this.stopped = true;
        clearInterval(this.autosaveLoop);
        if (this.awarenessBroadcastLoop != null) clearInterval(this.awarenessBroadcastLoop);
    }

    static async createNew({
        secret,
        repo,
        handler,
        ydoc,
        autosaveInterval,
        resendAllUpdates,
        fullUpdateRate,
        awarenessBroadcastInterval,
        awareness,
        awarenessLive,
    }: {
        secret?: string;
        repo: ActorIdentifier;
        handler: FetchHandler | FetchHandlerObject | KittyAgent;
        ydoc: Doc;
        autosaveInterval: number;
        resendAllUpdates?: boolean;
        fullUpdateRate?: number;
        awarenessBroadcastInterval?: number;
        awareness?: Awareness;
        awarenessLive?: boolean;
    }) {
        const rkey = tidNow();
        const room =
            `at://${repo}/io.github.uwx.yjs.room/${rkey}` as `at://${ActorIdentifier}/io.github.uwx.yjs.room/${RecordKey}`;

        const agent = handler instanceof KittyAgent ? handler : new KittyAgent({ handler });

        const record = {
            $type: "io.github.uwx.yjs.room",
            authorizedDids: undefined, // we can set this to undefined to allow any DID, or set it to an array of DIDs to only allow those DIDs.
            createdAt: new Date().toISOString(),
            encrypted: secret != null,
        } satisfies IoGithubUwxYjsRoom.Main;
        agent.create({
            collection: "io.github.uwx.yjs.room",
            record,
            rkey,
            repo,
        });

        const provider = new AtprotoProvider({
            key: secret != null ? await deriveKey(secret, room) : undefined,
            ydoc,
            room,
            record,
            handler,
            repo,
            fullUpdateRate,
            autosaveInterval,
            resendAllUpdates,
            awarenessBroadcastInterval,
            awareness,
            awarenessLive,
        });

        provider.syncToChatPeers(true);

        return {
            provider,
            room,
        };
    }

    static async resume({
        secret,
        repo,
        handler,
        room,
        ydoc,
        autosaveInterval,
        resendAllUpdates,
        fullUpdateRate,
        awarenessBroadcastInterval,
        awareness,
        awarenessLive,
    }: {
        secret?: string;
        repo: ActorIdentifier;
        handler: FetchHandler | FetchHandlerObject | KittyAgent;
        room: `at://${ActorIdentifier}/io.github.uwx.yjs.room/${RecordKey}`;
        ydoc: Doc;
        autosaveInterval: number;
        resendAllUpdates?: boolean;
        fullUpdateRate?: number;
        awarenessBroadcastInterval?: number;
        awareness?: Awareness;
        awarenessLive?: boolean;
    }) {
        const parsedUri = parseResourceUri(room);
        if (!parsedUri.ok) {
            throw new Error(`Invalid room URI: ${room}`);
        }

        const record = await slingshot.getRecord({
            collection: "io.github.uwx.yjs.room",
            rkey: parsedUri.value.rkey as RecordKey,
            repo: parsedUri.value.repo as ActorIdentifier,
        });

        // resolve DID from handle so when we derive the key it's immutable
        room = `at://${await resolveHandleAnonymously(parsedUri.value.repo)}/io.github.uwx.yjs.room/${parsedUri.value.rkey}`;

        const key = secret != null ? await deriveKey(secret, room) : undefined;

        const state = await getStateForResume(
            room,
            record.value.authorizedDids,
            key,
        );

        const awarenessData = await getAwarenessForResume(
            room,
            record.value.authorizedDids,
        );

        return new AtprotoProvider({
            key,
            ydoc,
            room,
            record: record.value,
            handler,
            repo,
            fullUpdateRate,
            autosaveInterval,
            resendAllUpdates,
            state,
            awarenessBroadcastInterval,
            awareness,
            awarenessData,
            awarenessLive,
        });
    }

    async syncToChatPeers(fullUpdate = false) {
        if (this.queuedYjsUpdates.length <= 0) {
            return;
        }

        log("Syncing to chat peers");

        let mergedYjsUpdate;

        const doFullUpdate =
            fullUpdate ||
            this.resendAllUpdates ||
            Math.random() < this.fullUpdateRate;
        if (doFullUpdate) {
            mergedYjsUpdate = encodeStateAsUpdateV2(this.ydoc);
        } else {
            mergedYjsUpdate = mergeUpdatesV2(this.queuedYjsUpdates);
        }
        this.queuedYjsUpdates.length = 0;

        if (this.key != null) {
            mergedYjsUpdate = await encrypt(mergedYjsUpdate, this.key);
        }

        // record max length is 1MiB, so we cutoff at 1MB and send a blob instead
        if (mergedYjsUpdate.length > 1_000_000) {
            const blob = await this.agent.uploadBlob(mergedYjsUpdate);

            await this.agent.put({
                collection: "io.github.uwx.yjs.update",
                record: {
                    $type: "io.github.uwx.yjs.update",
                    room: this.room,
                    update: {
                        $type: "io.github.uwx.yjs.update#blobUpdateData",
                        blob,
                    },
                    isFullUpdate: doFullUpdate,
                },
                rkey: tidNow(),
                repo: this.repo,
            });
        } else {
            await this.agent.put({
                collection: "io.github.uwx.yjs.update",
                record: {
                    $type: "io.github.uwx.yjs.update",
                    room: this.room,
                    update: {
                        $type: "io.github.uwx.yjs.update#bytesUpdateData",
                        bytes: {
                            $bytes: fromUint8Array(mergedYjsUpdate),
                        },
                    },
                    isFullUpdate: doFullUpdate,
                },
                rkey: tidNow(),
                repo: this.repo,
            });
        }
        this.emit("sync", [false]);
    }

    async broadcastAwarenessUpdate() {
        const data = encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]);

        await this.agent.put({
            collection: "io.github.uwx.yjs.awareness",
            record: {
                $type: "io.github.uwx.yjs.awareness",
                room: this.room,
                update: {
                    $bytes: fromUint8Array(data),
                }
            },
            rkey: tidNow(),
            repo: this.repo,
        });
    }

    async receiveJetstreamUpdate(update: Uint8Array) {
        if (this.key != null) {
            update = await decrypt(update, this.key);
        }

        applyUpdateV2(this.ydoc, update, 'atproto/jetstream');
    }

    async receiveJetstreamAwarenessUpdate(data: Uint8Array<ArrayBufferLike>) {
        applyAwarenessUpdate(this.awareness, data, 'atproto/jetstream');
    }

    receiveYjsUpdate(yjsUpdate: Uint8Array, origin: any) {
        if (origin === 'atproto/jetstream') {
            return;
        }

        this.queuedYjsUpdates.push(yjsUpdate);

        this.emit("sync", [true]);
    }
}
