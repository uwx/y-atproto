import type { KittyAgent } from "kitty-agent";
import type { Did } from "@atcute/lexicons";

export class YClient {
    readonly appviewAgent: KittyAgent;

    constructor(private readonly loginState: {
        readonly handle: string;
        readonly did: Did;
        readonly pds: string;
        readonly agent: KittyAgent;
    }) {
        this.appviewAgent = this.agent.clone({
            proxy: {
                did: 'did:web:api.bsky.app',
                serviceId: '#bsky_appview'
            },
        });
    }

    get agent(): KittyAgent {
        return this.loginState.agent;
    }

    get user() {
        return this.loginState;
    }
}