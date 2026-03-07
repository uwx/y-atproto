import { StatefulPreactOAuthClient } from "kitty-agent/oauth-preact";
import { YClient } from "./client";
import { computed, signal } from "@preact/signals";

import metadata from '../../client-metadata.json' with { type: 'json' };

export const oauthClient = new StatefulPreactOAuthClient<YClient>(
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
    {
        computed,
        signal,
    },
    (loginState) => new YClient(loginState),
);

export const user = oauthClient.user;
export const savedHandle = oauthClient.handle;