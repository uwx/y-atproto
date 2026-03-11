import { StatefulReactOAuthClient, useUser as _useUser, useHandle as _useHandle } from "kitty-agent/oauth-react";
import { YClient } from "./client";

import metadata from '../../public/client-metadata.json' with { type: 'json' };
import { useSyncExternalStore } from "react";

export const oauthClient = new StatefulReactOAuthClient<YClient>(
    {
        clientId: document.location.hostname === '127.0.0.1' || document.location.hostname === 'localhost'
            ? `http://localhost?redirect_uri=${encodeURIComponent(`http://127.0.0.1:${document.location.port}/`)}` +
                `&scope=${encodeURIComponent(metadata.scope)}`
            : metadata.client_id,
        redirectUri: document.location.hostname === '127.0.0.1' || document.location.hostname === 'localhost'
            ? `http://127.0.0.1:${document.location.port}/`
            : metadata.redirect_uris[0],
        scope: metadata.scope,
    },
    useSyncExternalStore,
    (loginState) => new YClient(loginState),
);

export const useUser = () => _useUser(oauthClient);
export const useSavedHandle = () => _useHandle(oauthClient);