import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _mainSchema = /*#__PURE__*/ v.record(
  /*#__PURE__*/ v.tidString(),
  /*#__PURE__*/ v.object({
    $type: /*#__PURE__*/ v.literal("io.github.uwx.yjs.mls.room"),
    /**
     * The MLS ciphersuite identifier used by this group
     */
    cipherSuite: /*#__PURE__*/ v.string(),
    /**
     * When this room was created
     */
    createdAt: /*#__PURE__*/ v.datetimeString(),
    /**
     * The DID of the room creator, who is responsible for issuing MLS commits
     */
    creator: /*#__PURE__*/ v.didString(),
  }),
);

type main$schematype = typeof _mainSchema;

export interface mainSchema extends main$schematype {}

export const mainSchema = _mainSchema as mainSchema;

export interface Main extends v.InferInput<typeof mainSchema> {}

declare module "@atcute/lexicons/ambient" {
  interface Records {
    "io.github.uwx.yjs.mls.room": mainSchema;
  }
}
