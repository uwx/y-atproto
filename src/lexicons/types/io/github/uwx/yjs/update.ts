import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _blobUpdateDataSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("io.github.uwx.yjs.update#blobUpdateData"),
  ),
  blob: /*#__PURE__*/ v.blob(),
});
const _bytesUpdateDataSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("io.github.uwx.yjs.update#bytesUpdateData"),
  ),
  bytes: /*#__PURE__*/ v.bytes(),
});
const _mainSchema = /*#__PURE__*/ v.record(
  /*#__PURE__*/ v.tidString(),
  /*#__PURE__*/ v.object({
    $type: /*#__PURE__*/ v.literal("io.github.uwx.yjs.update"),
    /**
     * Whether this update is a full update (all changes) or a partial update (only changes since last full update)
     */
    isFullUpdate: /*#__PURE__*/ v.boolean(),
    /**
     * The room this update belongs to
     */
    room: /*#__PURE__*/ v.resourceUriString(),
    /**
     * The update data from Y.js
     */
    get update() {
      return /*#__PURE__*/ v.variant([
        blobUpdateDataSchema,
        bytesUpdateDataSchema,
      ]);
    },
  }),
);

type blobUpdateData$schematype = typeof _blobUpdateDataSchema;
type bytesUpdateData$schematype = typeof _bytesUpdateDataSchema;
type main$schematype = typeof _mainSchema;

export interface blobUpdateDataSchema extends blobUpdateData$schematype {}
export interface bytesUpdateDataSchema extends bytesUpdateData$schematype {}
export interface mainSchema extends main$schematype {}

export const blobUpdateDataSchema =
  _blobUpdateDataSchema as blobUpdateDataSchema;
export const bytesUpdateDataSchema =
  _bytesUpdateDataSchema as bytesUpdateDataSchema;
export const mainSchema = _mainSchema as mainSchema;

export interface BlobUpdateData extends v.InferInput<
  typeof blobUpdateDataSchema
> {}
export interface BytesUpdateData extends v.InferInput<
  typeof bytesUpdateDataSchema
> {}
export interface Main extends v.InferInput<typeof mainSchema> {}

declare module "@atcute/lexicons/ambient" {
  interface Records {
    "io.github.uwx.yjs.update": mainSchema;
  }
}
