import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _blobMessageDataSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("io.github.uwx.yjs.mls.message#blobMessageData"),
  ),
  blob: /*#__PURE__*/ v.blob(),
});
const _bytesMessageDataSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("io.github.uwx.yjs.mls.message#bytesMessageData"),
  ),
  bytes: /*#__PURE__*/ v.bytes(),
});
const _mainSchema = /*#__PURE__*/ v.record(
  /*#__PURE__*/ v.tidString(),
  /*#__PURE__*/ v.object({
    $type: /*#__PURE__*/ v.literal("io.github.uwx.yjs.mls.message"),
    /**
     * The serialized MLS ClientState (only for messageType "checkpoint")
     */
    checkpointState: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.bytes()),
    /**
     * The MLS epoch this message belongs to
     */
    epoch: /*#__PURE__*/ v.integer(),
    /**
     * Whether this is a full state update (only for messageType "update")
     */
    isFullUpdate: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.boolean()),
    /**
     * The TID of the last processed message when this checkpoint was created (only for messageType "checkpoint")
     */
    lastMessageTid: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.tidString()),
    /**
     * The serialized MLS message payload
     */
    get message() {
      return /*#__PURE__*/ v.variant([
        blobMessageDataSchema,
        bytesMessageDataSchema,
      ]);
    },
    /**
     * The type of MLS message
     */
    get messageType() {
      return messageTypeSchema;
    },
    /**
     * The room this message belongs to
     */
    room: /*#__PURE__*/ v.resourceUriString(),
  }),
);
const _messageTypeSchema = /*#__PURE__*/ v.string<
  | "application"
  | "awareness"
  | "checkpoint"
  | "commit"
  | "proposal"
  | "update"
  | "welcome"
  | (string & {})
>();

type blobMessageData$schematype = typeof _blobMessageDataSchema;
type bytesMessageData$schematype = typeof _bytesMessageDataSchema;
type main$schematype = typeof _mainSchema;
type messageType$schematype = typeof _messageTypeSchema;

export interface blobMessageDataSchema extends blobMessageData$schematype {}
export interface bytesMessageDataSchema extends bytesMessageData$schematype {}
export interface mainSchema extends main$schematype {}
export interface messageTypeSchema extends messageType$schematype {}

export const blobMessageDataSchema =
  _blobMessageDataSchema as blobMessageDataSchema;
export const bytesMessageDataSchema =
  _bytesMessageDataSchema as bytesMessageDataSchema;
export const mainSchema = _mainSchema as mainSchema;
export const messageTypeSchema = _messageTypeSchema as messageTypeSchema;

export interface BlobMessageData extends v.InferInput<
  typeof blobMessageDataSchema
> {}
export interface BytesMessageData extends v.InferInput<
  typeof bytesMessageDataSchema
> {}
export interface Main extends v.InferInput<typeof mainSchema> {}
export type MessageType = v.InferInput<typeof messageTypeSchema>;

declare module "@atcute/lexicons/ambient" {
  interface Records {
    "io.github.uwx.yjs.mls.message": mainSchema;
  }
}
