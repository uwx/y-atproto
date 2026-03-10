import { createRoot } from "react-dom/client";

import { Excalidraw } from "@excalidraw/excalidraw";
import * as Y from "yjs";

import { ExcalidrawBinding, yjsToExcalidraw } from "y-excalidraw";

import AtprotoProvider from "y-atproto";
import type { ActorIdentifier, RecordKey } from "@atcute/lexicons";
import { useState, useMemo, useEffect, useRef } from "react";
import { oauthClient, useUser, useSavedHandle } from "./atproto/signed-in-user";

import * as random from "lib0/random";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

const usercolors = [
    { color: "#30bced", light: "#30bced33" },
    { color: "#6eeb83", light: "#6eeb8333" },
    { color: "#ffbc42", light: "#ffbc4233" },
    { color: "#ecd444", light: "#ecd44433" },
    { color: "#ee6352", light: "#ee635233" },
    { color: "#9ac2c9", light: "#9ac2c933" },
    { color: "#8acb88", light: "#8acb8833" },
    { color: "#1be7ff", light: "#1be7ff33" },
];

function EditorApp({
    handle,
    provider,
    ydoc,
}: {
    handle: string;
    provider: AtprotoProvider;
    ydoc: Y.Doc;
}) {
    const userColor = useMemo(
        () => usercolors[random.uint32() % usercolors.length],
        [],
    );
    provider.awareness.setLocalStateField("user", {
        name: handle,
        color: userColor.color,
        colorLight: userColor.light,
    });

    const yElements = ydoc.getArray<Y.Map<any>>("elements"); // structure = {el: NonDeletedExcalidrawElement, pos: string}
    const yAssets = ydoc.getMap("assets");

    const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
    const [binding, setBindings] = useState<ExcalidrawBinding | null>(null);
    const excalidrawRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!api || !excalidrawRef.current) return;

        const binding = new ExcalidrawBinding(
            yElements,
            yAssets,
            api,
            provider.awareness,
            // excalidraw dom is needed to override the undo/redo buttons in the UI as there is no way to override it via props in excalidraw
            // You might need to pass {trackedOrigins: new Set()} to undomanager depending on whether your provider sets an origin or not
            {
                excalidrawDom: excalidrawRef.current,
                undoManager: new Y.UndoManager(yElements),
            },
        );
        setBindings(binding);
        return () => {
            setBindings(null);
            binding.destroy();
        };
    }, [api]);

    const initData = {
        elements: yjsToExcalidraw(yElements),
    };

    return (
        <div style={{ width: "100vw", height: "90vh" }} ref={excalidrawRef}>
            <Excalidraw
                initialData={initData} // Need to set the initial data
                excalidrawAPI={setApi}
                onPointerUpdate={binding?.onPointerUpdate}
                theme="light"
            />
        </div>
    );
}

function App() {
    const [hasInitialSession, setHasInitialSession] = useState(false);
    const [provider, setProvider] = useState<AtprotoProvider | null>(null);
    const [room, setRoom] = useState<string | null>(null);
    const user = useUser();
    const savedHandle = useSavedHandle();

    const ydoc = useMemo(() => new Y.Doc(), []);

    // this effect manages the lifetime of the Yjs document and the provider
    useEffect(() => {
        return () => {
            ydoc.destroy();
        };
    }, [ydoc]);

    async function signIn() {
        if (!hasInitialSession) {
            await oauthClient.waitForInitialSession();
        }

        if (!user) {
            const handle = prompt(
                "Enter your ATProto handle:",
                savedHandle || "",
            );

            if (!handle) {
                return;
            }

            await oauthClient.authenticateIfNecessary(handle, false);
            // This may not return if OAuth redirect, in which case the second part is handled below
            // in the useEffect that checks for the OAuth redirect page.
        }
    }

    async function newRoom() {
        if (!user) {
            return;
        }

        const password = prompt(
            "Enter a password for the room or leave empty:",
        );

        const { provider, room } = await AtprotoProvider.createNew({
            secret: password ? password : undefined,
            repo: user.did,
            handler: user.agent,
            ydoc,
            autosaveInterval: 1000,
            resendAllUpdates: false,
        });
        setProvider(provider);

        console.log("Created room", room);
        alert(`Created room: ${room}`);

        setRoom(room);
    }

    async function joinRoom() {
        if (!user) {
            return;
        }

        const room = prompt("Enter the room at-uri to join:");
        if (!room) {
            return;
        }

        const password = prompt(
            "Enter a password for the room or leave empty:",
        );

        const provider = await AtprotoProvider.resume({
            secret: password ? password : undefined,
            repo: user.did,
            handler: user.agent,
            room: room as `at://${ActorIdentifier}/io.github.uwx.yjs.room/${RecordKey}`,
            ydoc,
            autosaveInterval: 1000,
            resendAllUpdates: false,
        });
        setProvider(provider);

        console.log("Joined room");
        setRoom(room);
    }

    useEffect(() => {
        const hash = document.location.hash.slice(1);
        oauthClient
            .waitForInitialSession()
            .then(() => setHasInitialSession(true))
            .finally(async () => {
                console.log("Finalizing authorization");
                if (!user && hash) {
                    await oauthClient.finalizeAuthorization(
                        new URLSearchParams(hash),
                    );
                }

                // clear hash
                history.pushState(null, "", window.location.pathname);
            });
    }, []);

    return (
        <div>
            <button onClick={() => signIn()}>Sign In</button>
            {user ? (
                <div>
                    <p>Signed in as {user.handle}</p>
                    <button onClick={() => oauthClient.revokeSessions()}>
                        Sign Out
                    </button>
                    <button onClick={() => newRoom()}>Create Room</button>
                    <button onClick={() => joinRoom()}>Join Room</button>
                    {provider && ydoc && (
                        <EditorApp provider={provider} ydoc={ydoc} key={room} handle={user.handle} />
                    )}
                </div>
            ) : (
                <p>Not signed in</p>
            )}
        </div>
    );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
