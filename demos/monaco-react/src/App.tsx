import { Doc } from "yjs";
import { MonacoBinding } from "y-monaco";

import { useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { oauthClient, savedHandle, user } from "./atproto/signed-in-user";
import AtprotoProvider from "y-atproto";
import { ActorIdentifier, RecordKey } from "@atcute/lexicons";

function EditorApp({ provider, ydoc }: { provider: AtprotoProvider, ydoc: Doc }) {
    const [editor, setEditor] = useState<editor.IStandaloneCodeEditor | null>(null);
    const [binding, setBinding] = useState<MonacoBinding | null>(null);

    // this effect manages the lifetime of the editor binding
    useEffect(() => {
        if (provider == null || editor == null) {
            return;
        }
        console.log("reached", provider);
        const binding = new MonacoBinding(
            ydoc.getText(),
            editor.getModel()!,
            new Set([editor]),
            provider?.awareness,
        );
        setBinding(binding);
        return () => {
            binding.destroy();
        };
    }, [ydoc, provider, editor]);

    return (
        <Editor
            height="90vh"
            defaultValue="// some comment"
            defaultLanguage="javascript"
            onMount={(editor) => {
                setEditor(editor);
            }}
        />
    );
}

function App() {
    const [hasInitialSession, setHasInitialSession] = useState(false);
    const [provider, setProvider] = useState<AtprotoProvider | null>(null);
    const [room, setRoom] = useState<string | null>(null);

    const ydoc = useMemo(() => new Doc(), []);

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

        if (!user.value) {
            const handle = prompt(
                "Enter your ATProto handle:",
                savedHandle.value || "",
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
        if (!user.value) {
            return;
        }

        const password = prompt("Enter a password for the room or leave empty:");

        const { provider, room } = await AtprotoProvider.createNew({
            secret: password ? password : undefined,
            repo: user.value.did,
            handler: user.value.agent,
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
        if (!user.value) {
            return;
        }

        const room = prompt("Enter the room at-uri to join:");
        if (!room) {
            return;
        }

        const password = prompt("Enter a password for the room or leave empty:");

        const provider = await AtprotoProvider.resume({
            secret: password ? password : undefined,
            repo: user.value.did,
            handler: user.value.agent,
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
                if (!user.value) {
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
            {user.value ? (
                <div>
                    <p>Signed in as {user.value.handle}</p>
                    <button onClick={() => oauthClient.revokeSessions()}>Sign Out</button>
                    <button onClick={() => newRoom()}>Create Room</button>
                    <button onClick={() => joinRoom()}>Join Room</button>
                    {provider && ydoc && <EditorApp provider={provider} ydoc={ydoc} key={room} />}
                </div>
            ) : (
                <p>Not signed in</p>
            )}
        </div>
    );
}

export default App;
