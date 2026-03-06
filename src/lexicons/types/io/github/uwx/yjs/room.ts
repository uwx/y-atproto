import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _mainSchema = /*#__PURE__*/ v.record(
  /*#__PURE__*/ v.tidString(),
  /*#__PURE__*/ v.object({
    $type: /*#__PURE__*/ v.literal("io.github.uwx.yjs.room"),
    /**
     * If set, an allowlist of DIDs that are allowed to send updates to this room
     */
    authorizedDids: /*#__PURE__*/ v.optional(
      /*#__PURE__*/ v.array(/*#__PURE__*/ v.didString()),
    ),
    /**
     * When this room was created
     */
    createdAt: /*#__PURE__*/ v.datetimeString(),
    /**
     * Whether this room is encrypted
     */
    encrypted: /*#__PURE__*/ v.boolean(),
  }),
);

type main$schematype = typeof _mainSchema;

export interface mainSchema extends main$schematype {}

export const mainSchema = _mainSchema as mainSchema;

export interface Main extends v.InferInput<typeof mainSchema> {}

declare module "@atcute/lexicons/ambient" {
  interface Records {
    "io.github.uwx.yjs.room": mainSchema;
  }
}
