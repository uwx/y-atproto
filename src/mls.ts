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
import {
    IoGithubUwxYjsMlsKeyPackage,
    IoGithubUwxYjsMlsMessage,
    type IoGithubUwxYjsMlsRoom,
} from "./lexicons/index.js";
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
import {
    applyAwarenessUpdate,
    Awareness,
    encodeAwarenessUpdate,
    outdatedTimeout,
} from "y-protocols/awareness.js";
import {
    createEncoder,
    writeVarUint8Array,
    toUint8Array as encoderToUint8Array,
} from "lib0/encoding";
import {
    createDecoder,
    readVarUint8Array,
} from "lib0/decoding";
import {
    type MLSContext,
    type MLSMessage,
    type ClientState,
    type GroupState,
    type CiphersuiteImpl,
    type KeyPackage,
    type PrivateKeyPackage,
    type Credential,
    type CiphersuiteName,
    type MlsPrivateMessage,
    type MlsPublicMessage,
    type ProcessMessageResult,
    type Proposal,
    type PrivateMessage,
    type Welcome,
    createGroup,
    joinGroup,
    createCommit,
    createApplicationMessage,
    processMessage,
    generateKeyPackage,
    getCiphersuiteFromName,
    getCiphersuiteImpl,
    encodeMlsMessage,
    decodeMlsMessage,
    encodeGroupState,
    decodeGroupState,
    defaultCapabilities,
    defaultLifetime,
    acceptAll,
    emptyPskIndex,
    defaultAuthenticationService,
    defaultKeyRetentionConfig,
    defaultLifetimeConfig,
    defaultKeyPackageEqualityConfig,
    defaultPaddingConfig,
} from "ts-mls";
import {
    saveClientState,
    loadClientState,
    savePrivateKeys,
    loadPrivateKeys,
} from "./mls-store.js";
import { createModuleLogger } from "lib0/logging";

const log = createModuleLogger("y-atproto-mls");

const constellation = new ConstellationClient({
    userAgent: "y-atproto/1.0.0",
});

const slingshot = new SlingshotClient({
    userAgent: "y-atproto/1.0.0",
});

// Number of key packages to maintain published at all times (excluding the last-resort)
const KEY_PACKAGE_POOL_SIZE = 10;

const DEFAULT_CIPHERSUITE: CiphersuiteName =
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";

const defaultClientConfig = {
    keyRetentionConfig: defaultKeyRetentionConfig,
    lifetimeConfig: defaultLifetimeConfig,
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
    paddingConfig: defaultPaddingConfig,
    authService: defaultAuthenticationService,
};

function makeCredential(did: Did): Credential {
    return {
        credentialType: "basic",
        identity: new TextEncoder().encode(did),
    };
}

function didFromCredential(credential: Credential): Did | undefined {
    if (credential.credentialType !== "basic") return undefined;
    return new TextDecoder().decode(credential.identity) as Did;
}

async function getMessageData(
    actor: ActorIdentifier,
    record: IoGithubUwxYjsMlsMessage.Main,
): Promise<Uint8Array> {
    if (record.message.$type === "io.github.uwx.yjs.mls.message#blobMessageData") {
        const { did, pds } = await getDidAndPds(actor);
        const agent = KittyAgent.createUnauthed(pds);
        const cid = isLegacyBlob(record.message.blob)
            ? record.message.blob.cid
            : record.message.blob.ref.$link;
        return agent.getBlobAsBinary({ cid, did });
    }

    if (record.message.$type === "io.github.uwx.yjs.mls.message#bytesMessageData") {
        return toUint8Array(record.message.bytes.$bytes);
    }

    throw new Error("Unknown message data type");
}

/**
 * Decode an MLSMessage from bytes, returning undefined on failure.
 */
function tryDecodeMlsMessage(bytes: Uint8Array): MLSMessage | undefined {
    const result = decodeMlsMessage(bytes, 0);
    if (result == null) return undefined;
    return result[0];
}

/**
 * Wrap a PrivateMessage into an MLSMessage for wire encoding.
 */
function wrapAsPrivateMessage(privateMessage: PrivateMessage): MLSMessage {
    return {
        version: "mls10",
        wireformat: "mls_private_message",
        privateMessage,
    } satisfies MLSMessage;
}

/**
 * Simple serialization for PrivateKeyPackage (3 Uint8Arrays).
 * ts-mls doesn't export a TLS encoder for this, so we use a length-prefixed format.
 */
function encodePrivateKeyPackage(pkg: PrivateKeyPackage): Uint8Array {
    const encoder = createEncoder();
    writeVarUint8Array(encoder, pkg.initPrivateKey);
    writeVarUint8Array(encoder, pkg.hpkePrivateKey);
    writeVarUint8Array(encoder, pkg.signaturePrivateKey);
    return encoderToUint8Array(encoder);
}

function decodePrivateKeyPackage(data: Uint8Array): PrivateKeyPackage | undefined {
    const decoder = createDecoder(data);
    return {
        initPrivateKey: readVarUint8Array(decoder),
        hpkePrivateKey: readVarUint8Array(decoder),
        signaturePrivateKey: readVarUint8Array(decoder),
    };
}

/**
 * MLS-encrypted Y.js provider over AT Protocol.
 *
 * Unlike the PSK-based AtprotoProvider, this uses MLS (RFC 9420) for
 * group key agreement. All encryption state transitions (commits, welcomes,
 * proposals) are stored as atproto records and distributed via Jetstream.
 *
 * The room creator is the sole committer — only they issue MLS Commits.
 * Other participants propose changes (e.g. Add proposals via external join)
 * which the creator then commits.
 *
 * Y.js document updates are encrypted as MLS application messages.
 * Awareness updates are also encrypted with the current group key.
 */
export default class MlsAtprotoProvider extends ObservableV2<{
    sync(hasQueued: boolean): void;
    "mls:epoch-advanced"(epoch: bigint): void;
    "mls:member-added"(did: Did): void;
    "mls:member-removed"(did: Did): void;
}> {
    readonly ydoc: Doc;
    readonly resendAllUpdates: boolean;
    readonly queuedYjsUpdates: Uint8Array[];
    readonly autosaveLoop: number | NodeJS.Timeout;
    readonly jetstream: JetstreamSubscription;
    readonly room!: ResourceUri;
    readonly agent!: KittyAgent;
    readonly repo!: ActorIdentifier;
    readonly did!: Did;
    readonly awareness: Awareness;
    readonly awarenessBroadcastLoop?: number | NodeJS.Timeout;
    readonly fullUpdateRate: number;
    readonly isCreator: boolean;
    readonly cs: CiphersuiteImpl;

    stopped = false;
    mlsState: ClientState;
    lastProcessedTid: string | undefined;

    // Key package management
    private keyPackage: KeyPackage;
    private privateKeyPackage: PrivateKeyPackage;

    private constructor({
        mlsState,
        cs,
        keyPackage,
        privateKeyPackage,
        state,
        repo,
        did,
        handler,
        room,
        record,
        jetstreamService,
        ydoc,
        autosaveInterval,
        resendAllUpdates,
        fullUpdateRate,
        awarenessBroadcastInterval,
        awareness,
        awarenessLive,
        awarenessData,
        lastProcessedTid,
    }: {
        mlsState: ClientState;
        cs: CiphersuiteImpl;
        keyPackage: KeyPackage;
        privateKeyPackage: PrivateKeyPackage;
        state?: Uint8Array;
        repo: ActorIdentifier;
        did: Did;
        handler: FetchHandler | FetchHandlerObject | KittyAgent;
        room: ResourceUri;
        record: IoGithubUwxYjsMlsRoom.Main;
        jetstreamService?: string;
        ydoc: Doc;
        autosaveInterval: number;
        resendAllUpdates?: boolean;
        fullUpdateRate?: number;
        awarenessBroadcastInterval?: number;
        awareness?: Awareness;
        awarenessLive?: boolean;
        awarenessData?: Uint8Array[];
        lastProcessedTid?: string;
    }) {
        super();

        this.repo = repo;
        this.did = did;
        this.agent =
            handler instanceof KittyAgent
                ? handler
                : new KittyAgent({ handler });
        this.room = room;
        this.ydoc = ydoc;
        this.resendAllUpdates = resendAllUpdates ?? false;
        this.fullUpdateRate = fullUpdateRate ?? 0.1;
        this.awareness = awareness ?? new Awareness(ydoc);
        this.isCreator = record.creator === did;
        this.mlsState = mlsState;
        this.cs = cs;
        this.keyPackage = keyPackage;
        this.privateKeyPackage = privateKeyPackage;
        this.lastProcessedTid = lastProcessedTid;

        if (state != null) {
            applyUpdateV2(this.ydoc, state, "atproto/constellation");
        }

        if (awarenessData != null) {
            for (const data of awarenessData) {
                applyAwarenessUpdate(
                    this.awareness,
                    data,
                    "atproto/constellation",
                );
            }
        }

        this.queuedYjsUpdates = [];

        const jetstream = (this.jetstream = new JetstreamSubscription({
            url: jetstreamService ?? "wss://jetstream2.us-east.bsky.network",
            wantedCollections: [
                "io.github.uwx.yjs.mls.room",
                "io.github.uwx.yjs.mls.message",
            ],
        }));

        (async () => {
            for await (const event of jetstream) {
                if (this.stopped) break;
                if (event.kind !== "commit") continue;

                const commit = event.commit;
                if (commit.operation !== "create") continue;

                if (commit.collection === "io.github.uwx.yjs.mls.message") {
                    const mlsRecord = commit.record;
                    if (
                        !is(IoGithubUwxYjsMlsMessage.mainSchema, mlsRecord)
                    ) {
                        continue;
                    }
                    if (mlsRecord.room !== this.room) continue;

                    // Skip our own messages (we already applied them locally)
                    if (event.did === this.did) continue;

                    await this.receiveMessage(
                        event.did,
                        mlsRecord,
                        event.commit.rkey,
                    );
                }
            }
        })();

        ydoc.on("updateV2", (yjsupdate: Uint8Array, origin: unknown) =>
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
            this.awareness.on(
                "change",
                (
                    {
                        added,
                        updated,
                        removed,
                    }: {
                        added: number[];
                        updated: number[];
                        removed: number[];
                    },
                    origin: unknown,
                ) => {
                    if (
                        (typeof origin !== "string" ||
                            !origin.startsWith("atproto/")) &&
                        (added.includes(this.awareness.clientID) ||
                            updated.includes(this.awareness.clientID) ||
                            removed.includes(this.awareness.clientID))
                    ) {
                        this.broadcastAwarenessUpdate();
                    }
                },
            );
        }
    }

    async destroy() {
        await this.syncToChatPeers(true);
        await this.checkpoint();
        this.stopped = true;
        clearInterval(this.autosaveLoop);
        if (this.awarenessBroadcastLoop != null)
            clearInterval(this.awarenessBroadcastLoop);
        super.destroy();
    }

    /**
     * Bootstrap MLS credentials for this user. Creates a credential and key package,
     * stores private keys locally, and publishes a pool of key packages to the repo
     * so that room creators can add this user via addMember().
     *
     * Call this once before joining any rooms.
     */
    static async bootstrap({
        repo,
        did,
        handler,
        ciphersuiteName,
    }: {
        repo: ActorIdentifier;
        did: Did;
        handler: FetchHandler | FetchHandlerObject | KittyAgent;
        ciphersuiteName?: CiphersuiteName;
    }) {
        const csName = ciphersuiteName ?? DEFAULT_CIPHERSUITE;
        const cs = await getCiphersuiteImpl(getCiphersuiteFromName(csName));
        const credential = makeCredential(did);

        const agent =
            handler instanceof KittyAgent
                ? handler
                : new KittyAgent({ handler });

        await publishKeyPackagePool(agent, repo, credential, cs);
    }

    /**
     * Create a new MLS-encrypted room. The caller becomes the room creator
     * (sole committer for MLS group operations).
     */
    static async createNew({
        repo,
        did,
        handler,
        ydoc,
        autosaveInterval,
        resendAllUpdates,
        fullUpdateRate,
        awarenessBroadcastInterval,
        awareness,
        awarenessLive,
        ciphersuiteName,
    }: {
        repo: ActorIdentifier;
        did: Did;
        handler: FetchHandler | FetchHandlerObject | KittyAgent;
        ydoc: Doc;
        autosaveInterval: number;
        resendAllUpdates?: boolean;
        fullUpdateRate?: number;
        awarenessBroadcastInterval?: number;
        awareness?: Awareness;
        awarenessLive?: boolean;
        ciphersuiteName?: CiphersuiteName;
    }) {
        const csName = ciphersuiteName ?? DEFAULT_CIPHERSUITE;
        const cs = await getCiphersuiteImpl(getCiphersuiteFromName(csName));
        const credential = makeCredential(did);

        // Generate key package for self
        const { publicPackage: keyPackage, privatePackage: privateKeyPackage } =
            await generateKeyPackage(
                credential,
                defaultCapabilities(),
                defaultLifetime,
                [],
                cs,
            );

        // Use the room AT-URI as groupId for uniqueness
        const rkey = tidNow();
        const room =
            `at://${did}/io.github.uwx.yjs.mls.room/${rkey}` as ResourceUri;
        const groupId = new TextEncoder().encode(room);

        // Create MLS group
        const mlsState = await createGroup(
            groupId,
            keyPackage,
            privateKeyPackage,
            [],
            cs,
        );

        const agent =
            handler instanceof KittyAgent
                ? handler
                : new KittyAgent({ handler });

        // Create room record
        const record = {
            $type: "io.github.uwx.yjs.mls.room" as const,
            createdAt: new Date().toISOString(),
            creator: did,
            cipherSuite: csName,
        } satisfies IoGithubUwxYjsMlsRoom.Main;

        await agent.create({
            collection: "io.github.uwx.yjs.mls.room",
            record,
            rkey,
            repo,
        });

        // Publish key package pool
        await publishKeyPackagePool(agent, repo, credential, cs);

        // Save state locally
        const stateBytes = encodeGroupState(mlsState);
        await saveClientState(room, stateBytes, 0, rkey);

        const privBytes = encodePrivateKeyPackage(privateKeyPackage);
        const pubBytes = encodeMlsMessage({
            version: "mls10",
            wireformat: "mls_key_package",
            keyPackage: keyPackage,
        });
        await savePrivateKeys(room, privBytes, pubBytes);

        const provider = new MlsAtprotoProvider({
            mlsState,
            cs,
            keyPackage,
            privateKeyPackage,
            ydoc,
            room,
            record,
            handler,
            repo,
            did,
            fullUpdateRate,
            autosaveInterval,
            resendAllUpdates,
            awarenessBroadcastInterval,
            awareness,
            awarenessLive,
        });

        provider.syncToChatPeers(true);

        return { provider, room };
    }

    /**
     * Resume an existing MLS room. Restores MLS state from IndexedDB if available,
     * falls back to scanning our own checkpoint records, otherwise replays
     * all MLS messages from Constellation backlinks in a single chronological pass.
     */
    static async resume({
        repo,
        did,
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
        repo: ActorIdentifier;
        did: Did;
        handler: FetchHandler | FetchHandlerObject | KittyAgent;
        room: ResourceUri;
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
            collection: "io.github.uwx.yjs.mls.room",
            rkey: parsedUri.value.rkey as RecordKey,
            repo: parsedUri.value.repo as ActorIdentifier,
        });

        // Resolve DID so key derivation is immutable
        room = `at://${await resolveHandleAnonymously(parsedUri.value.repo)}/io.github.uwx.yjs.mls.room/${parsedUri.value.rkey}` as ResourceUri;

        const csName = record.value.cipherSuite as CiphersuiteName;
        const cs = await getCiphersuiteImpl(getCiphersuiteFromName(csName));
        const credential = makeCredential(did);

        // Try to load from IndexedDB first
        let mlsState: ClientState | undefined;
        let lastProcessedTid: string | undefined;
        const cached = await loadClientState(room);
        if (cached != null) {
            const decoded = decodeGroupState(cached.state, 0);
            if (decoded != null) {
                const [groupState] = decoded;
                mlsState = { ...groupState, clientConfig: defaultClientConfig };
            }
            lastProcessedTid = cached.lastMessageTid;
        }

        // Load or generate key package
        let keyPackage: KeyPackage;
        let privateKeyPackage: PrivateKeyPackage;
        const cachedKeys = await loadPrivateKeys(room);
        if (cachedKeys != null) {
            const pubMsg = decodeMlsMessage(cachedKeys.keyPackage, 0);
            let pub: KeyPackage | undefined;
            if (
                pubMsg != null &&
                pubMsg[0].version === "mls10" &&
                pubMsg[0].wireformat === "mls_key_package"
            ) {
                pub = pubMsg[0].keyPackage;
            }

            const priv = decodePrivateKeyPackage(cachedKeys.privateKeyPackage);
            if (pub != null && priv != null) {
                keyPackage = pub;
                privateKeyPackage = priv;
            } else {
                const kp = await generateKeyPackage(
                    credential,
                    defaultCapabilities(),
                    defaultLifetime,
                    [],
                    cs,
                );
                keyPackage = kp.publicPackage;
                privateKeyPackage = kp.privatePackage;
            }
        } else {
            const kp = await generateKeyPackage(
                credential,
                defaultCapabilities(),
                defaultLifetime,
                [],
                cs,
            );
            keyPackage = kp.publicPackage;
            privateKeyPackage = kp.privatePackage;
        }

        const agent =
            handler instanceof KittyAgent
                ? handler
                : new KittyAgent({ handler });

        if (mlsState == null) {
            // No cached state — scan backlinks for a Welcome addressed to us
            mlsState = await joinViaWelcome(
                room,
                cs,
                keyPackage,
                privateKeyPackage,
            );
        }

        // Unified single-pass replay of all messages since our last processed TID
        const replay = await unifiedReplay(
            room,
            mlsState,
            cs,
            lastProcessedTid,
        );
        mlsState = replay.state;
        lastProcessedTid = replay.lastProcessedTid ?? lastProcessedTid;

        const yjsState =
            replay.yjsUpdates.length > 0
                ? mergeUpdatesV2(replay.yjsUpdates)
                : undefined;

        // Save restored state
        const stateBytes = encodeGroupState(mlsState);
        await saveClientState(
            room,
            stateBytes,
            Number(mlsState.groupContext.epoch),
            lastProcessedTid ?? "",
        );
        const privBytes = encodePrivateKeyPackage(privateKeyPackage);
        const pubBytes = encodeMlsMessage({
            version: "mls10",
            wireformat: "mls_key_package",
            keyPackage: keyPackage,
        });
        await savePrivateKeys(room, privBytes, pubBytes);

        return new MlsAtprotoProvider({
            mlsState,
            cs,
            keyPackage,
            privateKeyPackage,
            ydoc,
            room,
            record: record.value,
            handler,
            repo,
            did,
            fullUpdateRate,
            autosaveInterval,
            resendAllUpdates,
            state: yjsState,
            awarenessBroadcastInterval,
            awareness,
            awarenessData: replay.awarenessData,
            awarenessLive,
            lastProcessedTid,
        });
    }

    /**
     * Add a member to the group. Only the room creator can do this.
     * Fetches a KeyPackage from the target's repo and creates an Add + Commit.
     */
    async addMember(memberDid: Did): Promise<void> {
        if (!this.isCreator) {
            throw new Error("Only the room creator can add members");
        }

        // Fetch a non-last-resort key package from the member's repo
        const memberKeyPackage = await fetchKeyPackage(memberDid);
        if (memberKeyPackage == null) {
            throw new Error(
                `No available key packages for ${memberDid}`,
            );
        }

        const addProposal: Proposal = {
            proposalType: "add",
            add: { keyPackage: memberKeyPackage },
        };

        const mlsContext: MLSContext = {
            state: this.mlsState,
            cipherSuite: this.cs,
            pskIndex: emptyPskIndex,
        };

        const result = await createCommit(mlsContext, {
            extraProposals: [addProposal],
            ratchetTreeExtension: true,
            groupInfoExtensions: [],
        });

        this.mlsState = result.newState;

        // Publish the commit
        const commitBytes = encodeMlsMessage(result.commit);
        const commitTid = tidNow();
        await this.agent.put({
            collection: "io.github.uwx.yjs.mls.message",
            record: {
                $type: "io.github.uwx.yjs.mls.message" as const,
                room: this.room,
                messageType: "commit",
                message: {
                    $type: "io.github.uwx.yjs.mls.message#bytesMessageData" as const,
                    bytes: { $bytes: fromUint8Array(commitBytes) },
                },
                epoch: Number(this.mlsState.groupContext.epoch),
            } satisfies IoGithubUwxYjsMlsMessage.Main,
            rkey: commitTid,
            repo: this.repo,
        });
        this.lastProcessedTid = commitTid;

        // Publish the welcome if present
        if (result.welcome != null) {
            const welcomeBytes = encodeMlsMessage({
                version: "mls10",
                wireformat: "mls_welcome",
                welcome: result.welcome,
            });
            await this.agent.put({
                collection: "io.github.uwx.yjs.mls.message",
                record: {
                    $type: "io.github.uwx.yjs.mls.message" as const,
                    room: this.room,
                    messageType: "welcome",
                    message: {
                        $type: "io.github.uwx.yjs.mls.message#bytesMessageData" as const,
                        bytes: { $bytes: fromUint8Array(welcomeBytes) },
                    },
                    epoch: Number(this.mlsState.groupContext.epoch),
                } satisfies IoGithubUwxYjsMlsMessage.Main,
                rkey: tidNow(),
                repo: this.repo,
            });
        }

        this.emit("mls:member-added", [memberDid]);
        this.emit("mls:epoch-advanced", [this.mlsState.groupContext.epoch]);
    }

    /**
     * Remove a member from the group. Only the room creator can do this.
     */
    async removeMember(memberDid: Did): Promise<void> {
        if (!this.isCreator) {
            throw new Error("Only the room creator can remove members");
        }

        // Find the leaf index for this member
        const leafIndex = findMemberLeafIndex(this.mlsState, memberDid);
        if (leafIndex == null) {
            throw new Error(`Member ${memberDid} not found in group`);
        }

        const removeProposal: Proposal = {
            proposalType: "remove",
            remove: { removed: leafIndex },
        };

        const mlsContext: MLSContext = {
            state: this.mlsState,
            cipherSuite: this.cs,
            pskIndex: emptyPskIndex,
        };

        const result = await createCommit(mlsContext, {
            extraProposals: [removeProposal],
            ratchetTreeExtension: true,
        });

        this.mlsState = result.newState;

        const commitBytes = encodeMlsMessage(result.commit);
        const commitTid = tidNow();
        await this.agent.put({
            collection: "io.github.uwx.yjs.mls.message",
            record: {
                $type: "io.github.uwx.yjs.mls.message" as const,
                room: this.room,
                messageType: "commit",
                message: {
                    $type: "io.github.uwx.yjs.mls.message#bytesMessageData" as const,
                    bytes: { $bytes: fromUint8Array(commitBytes) },
                },
                epoch: Number(this.mlsState.groupContext.epoch),
            } satisfies IoGithubUwxYjsMlsMessage.Main,
            rkey: commitTid,
            repo: this.repo,
        });
        this.lastProcessedTid = commitTid;

        this.emit("mls:member-removed", [memberDid]);
        this.emit("mls:epoch-advanced", [this.mlsState.groupContext.epoch]);
    }

    /**
     * Encrypt and send queued Y.js updates as MLS application messages,
     * stored as io.github.uwx.yjs.mls.message records.
     */
    async syncToChatPeers(fullUpdate = false) {
        if (this.queuedYjsUpdates.length <= 0) return;

        log("Syncing to chat peers");

        let mergedYjsUpdate: Uint8Array;

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

        // Encrypt with MLS
        const appMsg = await createApplicationMessage(
            this.mlsState,
            mergedYjsUpdate,
            this.cs,
        );
        this.mlsState = appMsg.newState;
        const encrypted = encodeMlsMessage(
            wrapAsPrivateMessage(appMsg.privateMessage),
        );

        const tid = tidNow();

        if (encrypted.length > 1_000_000) {
            const blob = await this.agent.uploadBlob(encrypted);
            await this.agent.put({
                collection: "io.github.uwx.yjs.mls.message",
                record: {
                    $type: "io.github.uwx.yjs.mls.message" as const,
                    room: this.room,
                    messageType: "update",
                    message: {
                        $type: "io.github.uwx.yjs.mls.message#blobMessageData" as const,
                        blob,
                    },
                    epoch: Number(this.mlsState.groupContext.epoch),
                    isFullUpdate: doFullUpdate,
                } satisfies IoGithubUwxYjsMlsMessage.Main,
                rkey: tid,
                repo: this.repo,
            });
        } else {
            await this.agent.put({
                collection: "io.github.uwx.yjs.mls.message",
                record: {
                    $type: "io.github.uwx.yjs.mls.message" as const,
                    room: this.room,
                    messageType: "update",
                    message: {
                        $type: "io.github.uwx.yjs.mls.message#bytesMessageData" as const,
                        bytes: { $bytes: fromUint8Array(encrypted) },
                    },
                    epoch: Number(this.mlsState.groupContext.epoch),
                    isFullUpdate: doFullUpdate,
                } satisfies IoGithubUwxYjsMlsMessage.Main,
                rkey: tid,
                repo: this.repo,
            });
        }

        this.lastProcessedTid = tid;
        this.emit("sync", [false]);
    }

    async broadcastAwarenessUpdate() {
        const data = encodeAwarenessUpdate(this.awareness, [
            this.awareness.clientID,
        ]);

        // Encrypt awareness with MLS too
        const appMsg = await createApplicationMessage(
            this.mlsState,
            data,
            this.cs,
        );
        this.mlsState = appMsg.newState;
        const encrypted = encodeMlsMessage(
            wrapAsPrivateMessage(appMsg.privateMessage),
        );

        await this.agent.put({
            collection: "io.github.uwx.yjs.mls.message",
            record: {
                $type: "io.github.uwx.yjs.mls.message" as const,
                room: this.room,
                messageType: "awareness",
                message: {
                    $type: "io.github.uwx.yjs.mls.message#bytesMessageData" as const,
                    bytes: { $bytes: fromUint8Array(encrypted) },
                },
                epoch: Number(this.mlsState.groupContext.epoch),
            } satisfies IoGithubUwxYjsMlsMessage.Main,
            rkey: tidNow(),
            repo: this.repo,
        });
    }

    /**
     * Process an incoming message from Jetstream, routing by messageType.
     */
    private async receiveMessage(
        senderDid: Did,
        record: IoGithubUwxYjsMlsMessage.Main,
        rkey: string,
    ) {
        const messageType = record.messageType;

        // Checkpoints and welcomes don't need real-time processing
        if (messageType === "welcome" || messageType === "checkpoint") return;

        const messageBytes = await getMessageData(senderDid, record);
        const mlsMsg = tryDecodeMlsMessage(messageBytes);
        if (mlsMsg == null) {
            log("Failed to decode MLS message");
            return;
        }

        const framedMsg = mlsMsg as MlsPrivateMessage | MlsPublicMessage;
        const result = await processMessage(
            framedMsg,
            this.mlsState,
            emptyPskIndex,
            acceptAll,
            this.cs,
        );

        if (result.kind === "newState") {
            // Commit or proposal — MLS state advanced
            this.mlsState = result.newState;
            this.lastProcessedTid = rkey;
            this.emit("mls:epoch-advanced", [
                this.mlsState.groupContext.epoch,
            ]);
        } else if (result.kind === "applicationMessage") {
            // Decrypted application message — dispatch by messageType
            this.mlsState = result.newState;
            this.lastProcessedTid = rkey;

            if (messageType === "update" || messageType === "application") {
                applyUpdateV2(this.ydoc, result.message, "atproto/jetstream");
            } else if (messageType === "awareness") {
                applyAwarenessUpdate(
                    this.awareness,
                    result.message,
                    "atproto/jetstream",
                );
            }
        }
    }

    private receiveYjsUpdate(yjsUpdate: Uint8Array, origin: unknown) {
        if (origin === "atproto/jetstream" || origin === "atproto/constellation") {
            return;
        }
        this.queuedYjsUpdates.push(yjsUpdate);
        this.emit("sync", [true]);
    }

    /**
     * Save MLS state checkpoint to both IndexedDB and an atproto record.
     */
    async checkpoint() {
        const stateBytes = encodeGroupState(this.mlsState);
        const epoch = Number(this.mlsState.groupContext.epoch);
        const lastTid = this.lastProcessedTid ?? tidNow();

        // Save locally
        await saveClientState(this.room, stateBytes, epoch, lastTid);

        // Publish checkpoint as a message record for remote resume
        await this.agent.put({
            collection: "io.github.uwx.yjs.mls.message",
            record: {
                $type: "io.github.uwx.yjs.mls.message" as const,
                room: this.room,
                messageType: "checkpoint",
                message: {
                    $type: "io.github.uwx.yjs.mls.message#bytesMessageData" as const,
                    bytes: { $bytes: fromUint8Array(new Uint8Array(0)) },
                },
                epoch,
                checkpointState: { $bytes: fromUint8Array(stateBytes) },
                lastMessageTid: lastTid,
            } satisfies IoGithubUwxYjsMlsMessage.Main,
            rkey: tidNow(),
            repo: this.repo,
        });
    }

}

// -------- Helper functions --------

/**
 * Join a group by scanning backlinks for a Welcome message addressed to us.
 * The creator publishes a Welcome when they add a member via addMember().
 */
async function joinViaWelcome(
    room: ResourceUri,
    cs: CiphersuiteImpl,
    keyPackage: KeyPackage,
    privateKeyPackage: PrivateKeyPackage,
): Promise<ClientState> {
    const iter = constellation.getAllBacklinks({
        subject: room,
        source: "io.github.uwx.yjs.mls.message:room",
    });

    for await (const link of iter) {
        const { value: record } = await slingshot.tryGetRecord({
            collection: "io.github.uwx.yjs.mls.message",
            rkey: link.rkey,
            repo: link.did,
        });
        if (record == null) continue;
        if (record.room !== room) continue;
        if (record.messageType !== "welcome") continue;

        const messageBytes = await getMessageData(link.did, record);
        const mlsMsg = tryDecodeMlsMessage(messageBytes);
        if (mlsMsg == null || mlsMsg.wireformat !== "mls_welcome") continue;

        const welcome = (mlsMsg as { welcome: Welcome }).welcome;

        try {
            const state = await joinGroup(
                welcome,
                keyPackage,
                privateKeyPackage,
                emptyPskIndex,
                cs,
            );
            return { ...state, clientConfig: defaultClientConfig };
        } catch {
            // This Welcome wasn't for us — try the next one
            continue;
        }
    }

    throw new Error("No Welcome message found — have you been added to the room?");
}

/**
 * Unified single-pass replay of all messages (handshake, updates, awareness)
 * in chronological order. This ensures MLS state is always current when
 * decrypting application messages, preventing cross-epoch key retention failures.
 *
 * During the backward scan through backlinks, if a checkpoint record is found,
 * MLS state is restored from it and only messages after the checkpoint's
 * lastMessageTid are replayed, avoiding a full history replay.
 */
async function unifiedReplay(
    room: ResourceUri,
    initialState: ClientState,
    cs: CiphersuiteImpl,
    sinceMessageTid?: string,
): Promise<{
    state: ClientState;
    yjsUpdates: Uint8Array[];
    awarenessData: Uint8Array[];
    lastProcessedTid: string | undefined;
}> {
    const iter = constellation.getAllBacklinks({
        subject: room,
        source: "io.github.uwx.yjs.mls.message:room",
    });

    type CollectedMsg = {
        rkey: string;
        did: Did;
        record: IoGithubUwxYjsMlsMessage.Main;
    };

    const messages: CollectedMsg[] = [];
    let checkpointState: ClientState | undefined;
    let checkpointCutoffTimestamp: number | undefined;

    for await (const link of iter) {
        // Stop at messages we've already processed (from local IndexedDB)
        if (sinceMessageTid != null) {
            const linkTime = parseTid(link.rkey).timestamp;
            const sinceTime = parseTid(sinceMessageTid).timestamp;
            if (linkTime <= sinceTime) break;
        }

        // If we already found a checkpoint, keep scanning a few seconds past
        // its cutoff to catch any messages that were created around the same
        // time but appear after the checkpoint in backlink ordering, then stop.
        if (checkpointCutoffTimestamp != null) {
            const linkTime = parseTid(link.rkey).timestamp;
            if (linkTime < checkpointCutoffTimestamp - 5_000_000) break;
        }

        const { value: record } = await slingshot.tryGetRecord({
            collection: "io.github.uwx.yjs.mls.message",
            rkey: link.rkey,
            repo: link.did,
        });
        if (record == null) continue;
        if (record.room !== room) continue;

        // If we find a checkpoint, restore MLS state from it
        if (
            checkpointState == null &&
            record.messageType === "checkpoint" &&
            record.checkpointState != null &&
            record.lastMessageTid != null
        ) {
            const decoded = decodeGroupState(
                toUint8Array(record.checkpointState.$bytes),
                0,
            );
            if (decoded != null) {
                const [groupState] = decoded;
                checkpointState = {
                    ...groupState,
                    clientConfig: defaultClientConfig,
                };
                checkpointCutoffTimestamp = parseTid(
                    record.lastMessageTid,
                ).timestamp;
                // Don't add the checkpoint itself to messages — continue scanning
                continue;
            }
        }

        messages.push({ rkey: link.rkey, did: link.did, record });
    }

    // If we found a checkpoint, filter out messages it already incorporates
    if (checkpointCutoffTimestamp != null) {
        const cutoff = checkpointCutoffTimestamp;
        const before = messages.length;
        const filtered = messages.filter(
            (m) => parseTid(m.rkey).timestamp > cutoff,
        );
        messages.length = 0;
        messages.push(...filtered);
        log(
            `Checkpoint found: skipping ${before - messages.length} already-processed messages, replaying ${messages.length}`,
        );
    }

    // Use checkpoint state if available, otherwise the caller-provided initial state
    let state = checkpointState ?? initialState;

    // Reverse to chronological order (backlinks are newest-first)
    messages.reverse();

    const yjsUpdates: Uint8Array[] = [];
    const awarenessData: Uint8Array[] = [];
    let lastProcessedTid: string | undefined;

    for (const msg of messages) {
        // Welcomes don't carry processable wire messages
        if (msg.record.messageType === "welcome" || msg.record.messageType === "checkpoint") {
            continue;
        }

        const data = await getMessageData(msg.did, msg.record);
        const mlsMsg = tryDecodeMlsMessage(data);
        if (mlsMsg == null) continue;

        try {
            const framedMsg = mlsMsg as MlsPrivateMessage | MlsPublicMessage;
            const result = await processMessage(
                framedMsg,
                state,
                emptyPskIndex,
                acceptAll,
                cs,
            );

            if (result.kind === "newState") {
                // Commit or proposal — MLS state advanced
                state = result.newState;
            } else if (result.kind === "applicationMessage") {
                state = result.newState;

                if (msg.record.messageType === "update" || msg.record.messageType === "application") {
                    yjsUpdates.push(result.message);
                } else if (msg.record.messageType === "awareness") {
                    // Only include recent awareness updates
                    const time = parseTid(msg.rkey).timestamp / 1_000;
                    if (Date.now() - time < outdatedTimeout) {
                        awarenessData.push(result.message);
                    }
                }
            }
            lastProcessedTid = msg.rkey;
        } catch (err) {
            log("Failed to process message during replay:", err);
        }
    }

    return { state, yjsUpdates, awarenessData, lastProcessedTid };
}

/**
 * Publish a pool of key packages + one last-resort key package.
 */
async function publishKeyPackagePool(
    agent: KittyAgent,
    repo: ActorIdentifier,
    credential: Credential,
    cs: CiphersuiteImpl,
) {
    // Publish regular key packages
    for (let i = 0; i < KEY_PACKAGE_POOL_SIZE; i++) {
        const { publicPackage } = await generateKeyPackage(
            credential,
            defaultCapabilities(),
            defaultLifetime,
            [],
            cs,
        );
        const kpBytes = encodeMlsMessage({
            version: "mls10",
            wireformat: "mls_key_package",
            keyPackage: publicPackage,
        });
        await agent.put({
            collection: "io.github.uwx.yjs.mls.keyPackage",
            record: {
                $type: "io.github.uwx.yjs.mls.keyPackage" as const,
                createdAt: new Date().toISOString(),
                keyPackage: { $bytes: fromUint8Array(kpBytes) },
            } satisfies IoGithubUwxYjsMlsKeyPackage.Main,
            rkey: tidNow(),
            repo,
        });
    }

    // Publish one last-resort key package
    const { publicPackage: lastResort } = await generateKeyPackage(
        credential,
        defaultCapabilities(),
        defaultLifetime,
        [],
        cs,
    );
    const lastResortBytes = encodeMlsMessage({
        version: "mls10",
        wireformat: "mls_key_package",
        keyPackage: lastResort,
    });
    await agent.put({
        collection: "io.github.uwx.yjs.mls.keyPackage",
        record: {
            $type: "io.github.uwx.yjs.mls.keyPackage" as const,
            createdAt: new Date().toISOString(),
            keyPackage: { $bytes: fromUint8Array(lastResortBytes) },
            lastResort: true,
        } satisfies IoGithubUwxYjsMlsKeyPackage.Main,
        rkey: tidNow(),
        repo,
    });
}

/**
 * Fetch a non-last-resort key package from a member's published records.
 * Falls back to the last-resort key package only if no regular ones remain.
 */
async function fetchKeyPackage(
    memberDid: Did,
): Promise<KeyPackage | undefined> {
    const { did, pds } = await getDidAndPds(memberDid);
    const agent = KittyAgent.createUnauthed(pds);

    // List key package records
    const response = await agent.list({
        collection: "io.github.uwx.yjs.mls.keyPackage",
        repo: did,
        limit: 50,
    });

    let lastResortKp: KeyPackage | undefined;

    for (const item of response.records) {
        if (!is(IoGithubUwxYjsMlsKeyPackage.mainSchema, item.value)) continue;

        const kpBytes = toUint8Array(item.value.keyPackage.$bytes);

        const pubMsg = decodeMlsMessage(kpBytes, 0);
        let kp: KeyPackage | undefined;
        if (
            pubMsg != null &&
            pubMsg[0].version === "mls10" &&
            pubMsg[0].wireformat === "mls_key_package"
        ) {
            kp = pubMsg[0].keyPackage;
        }
        
        if (kp == null) continue;

        if (item.value.lastResort) {
            lastResortKp = kp;
            continue;
        }

        // Use this one (non-last-resort)
        return kp;
    }

    // Fall back to last-resort
    return lastResortKp;
}

/**
 * Find the leaf index of a member by their DID credential.
 */
function findMemberLeafIndex(
    state: ClientState,
    memberDid: Did,
): number | undefined {
    const tree = state.ratchetTree;
    for (let i = 0; i < tree.length; i++) {
        const node = tree[i];
        if (node == null) continue;
        // Leaf nodes are at even indices in the ratchet tree
        if (i % 2 !== 0) continue;
        if (node.nodeType === "leaf") {
            const cred = node.leaf.credential;
            if (didFromCredential(cred) === memberDid) {
                return i / 2;
            }
        }
    }
    return undefined;
}
