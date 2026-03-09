import { openDB, type DBSchema, type IDBPDatabase } from "idb";

interface MlsStoreSchema extends DBSchema {
    /** Serialized MLS ClientState keyed by room AT-URI */
    state: {
        key: string;
        value: {
            room: string;
            state: Uint8Array;
            epoch: number;
            lastMessageTid: string;
        };
    };
    /** Stored private key packages keyed by room AT-URI, for verifying/decrypting */
    privateKeys: {
        key: string;
        value: {
            room: string;
            privateKeyPackage: Uint8Array;
            keyPackage: Uint8Array;
        };
    };
}

const DB_NAME = "y-atproto-mls";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<MlsStoreSchema>> | undefined;

function getDb(): Promise<IDBPDatabase<MlsStoreSchema>> {
    if (dbPromise == null) {
        dbPromise = openDB<MlsStoreSchema>(DB_NAME, DB_VERSION, {
            upgrade(db) {
                db.createObjectStore("state", { keyPath: "room" });
                db.createObjectStore("privateKeys", { keyPath: "room" });
            },
        });
    }
    return dbPromise;
}

export async function saveClientState(
    room: string,
    state: Uint8Array,
    epoch: number,
    lastMessageTid: string,
): Promise<void> {
    const db = await getDb();
    await db.put("state", { room, state, epoch, lastMessageTid });
}

export async function loadClientState(
    room: string,
): Promise<{ state: Uint8Array; epoch: number; lastMessageTid: string } | undefined> {
    const db = await getDb();
    return db.get("state", room);
}

export async function deleteClientState(room: string): Promise<void> {
    const db = await getDb();
    await db.delete("state", room);
}

export async function savePrivateKeys(
    room: string,
    privateKeyPackage: Uint8Array,
    keyPackage: Uint8Array,
): Promise<void> {
    const db = await getDb();
    await db.put("privateKeys", { room, privateKeyPackage, keyPackage });
}

export async function loadPrivateKeys(
    room: string,
): Promise<{ privateKeyPackage: Uint8Array; keyPackage: Uint8Array } | undefined> {
    const db = await getDb();
    return db.get("privateKeys", room);
}

export async function deletePrivateKeys(room: string): Promise<void> {
    const db = await getDb();
    await db.delete("privateKeys", room);
}
