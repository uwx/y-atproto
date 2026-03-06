// https://github.com/yjs/y-webrtc/blob/c411f1d7223b68f3c6fc9c5901a19819a17db667/src/crypto.js

import {
    createEncoder,
    writeVarString,
    writeVarUint8Array,
    toUint8Array,
} from "lib0/encoding";
import { createDecoder, readVarString, readVarUint8Array } from "lib0/decoding";
import { encodeUtf8 } from "lib0/string";

export async function deriveKey(
    secret: string,
    roomName: string,
): Promise<CryptoKey> {
    const secretBuffer = encodeUtf8(secret);
    const salt = encodeUtf8(roomName);
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        secretBuffer,
        "PBKDF2",
        false,
        ["deriveKey"],
    );
    return await crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations: 100000,
            hash: "SHA-256",
        },
        keyMaterial,
        {
            name: "AES-GCM",
            length: 256,
        },
        true,
        ["encrypt", "decrypt"],
    );
}

function isLocalBufferView(data: Uint8Array): data is Uint8Array<ArrayBuffer>;
function isLocalBufferView(data: Uint8ClampedArray): data is Uint8ClampedArray<ArrayBuffer>;
function isLocalBufferView(data: Uint16Array): data is Uint16Array<ArrayBuffer>;
function isLocalBufferView(data: Uint32Array): data is Uint32Array<ArrayBuffer>;
function isLocalBufferView(data: Int8Array): data is Int8Array<ArrayBuffer>;
function isLocalBufferView(data: Int16Array): data is Int16Array<ArrayBuffer>;
function isLocalBufferView(data: Int32Array): data is Int32Array<ArrayBuffer>;
function isLocalBufferView(data: Float32Array): data is Float32Array<ArrayBuffer>;
function isLocalBufferView(data: Float64Array): data is Float64Array<ArrayBuffer>;
function isLocalBufferView(data: BigInt64Array): data is BigInt64Array<ArrayBuffer>;
function isLocalBufferView(data: BigUint64Array): data is BigUint64Array<ArrayBuffer>;
function isLocalBufferView<T extends ArrayBufferView<ArrayBufferLike>>(data: T): data is T & ArrayBufferView<ArrayBuffer> {
    return data.buffer instanceof ArrayBuffer;
}

/**
 * @param data data to be encrypted
 * @param key
 * @return encrypted, base64 encoded message
 */
export async function encrypt(
    data: Uint8Array,
    key: CryptoKey | null,
): Promise<Uint8Array> {
    if (!key) {
        return data;
    }
    if (!isLocalBufferView(data)) {
        throw new Error("Only local buffer views are supported");
    }

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt(
        {
            name: "AES-GCM",
            iv,
        },
        key,
        data,
    );
    const encryptedDataEncoder = createEncoder();
    writeVarString(encryptedDataEncoder, "AES-GCM");
    writeVarUint8Array(encryptedDataEncoder, iv);
    writeVarUint8Array(encryptedDataEncoder, new Uint8Array(cipher));
    return toUint8Array(encryptedDataEncoder);
}

/**
 * @param data
 * @param key
 * @return decrypted buffer
 */
export async function decrypt(
    data: Uint8Array,
    key: CryptoKey | null,
): Promise<Uint8Array> {
    if (!key) {
        return data;
    }
    if (!isLocalBufferView(data)) {
        throw new Error("Only local buffer views are supported");
    }
    const dataDecoder = createDecoder(data);
    const algorithm = readVarString(dataDecoder);
    if (algorithm !== "AES-GCM") {
        throw new Error("Unknown encryption algorithm");
    }
    const iv = readVarUint8Array(dataDecoder);
    const cipher = readVarUint8Array(dataDecoder);
    const data_1 = await crypto.subtle.decrypt(
        {
            name: "AES-GCM",
            iv,
        },
        key,
        cipher,
    );
    return new Uint8Array(data_1);
}
