import "@typelex/emitter";
import "./externals.tsp";

namespace io.github.uwx.yjs.room {
  /** A Y.js room declaration */
  @rec("tid")
  model Main {
    /** When this room was created */
    @required createdAt: datetime;

    /** Whether this room is encrypted */
    @required encrypted: boolean;

    /** If set, an allowlist of DIDs that are allowed to send updates to this room */
    authorizedDids?: did[];
  }
}

namespace io.github.uwx.yjs.update {
  /** A Y.js update from a remote peer */
  @rec("tid")
  model Main {
    /** The room this update belongs to */
    @required room: atUri;

    /** The update data from Y.js */
    @required update: UpdateData;

    /** Whether this update is a full update (all changes) or a partial update (only changes since last full update) */
    @required isFullUpdate: boolean;
  }

  @inline union UpdateData { BytesUpdateData, BlobUpdateData }

  /** The update data from Y.js as bytes */
  model BytesUpdateData {
    @required bytes: bytes;
  }

  /** The update data from Y.js as a blob */
  model BlobUpdateData {
    @required blob: Blob;
  }
}

namespace io.github.uwx.yjs.awareness {
  /** An awareness update from a remote peer */
  @rec("tid")
  model Main {
    /** The room this awareness update belongs to */
    @required room: atUri;

    /** The awareness data for this peer from Y.js */
    @required update: bytes;
  }
}

namespace io.github.uwx.yjs.mls.room {
  /** An MLS-encrypted Y.js room declaration */
  @rec("tid")
  model Main {
    /** When this room was created */
    @required createdAt: datetime;

    /** The DID of the room creator, who is responsible for issuing MLS commits */
    @required creator: did;

    /** If set, an allowlist of DIDs that are allowed to participate in this room */
    authorizedDids?: did[];

    /** The MLS ciphersuite identifier used by this group */
    @required cipherSuite: string;

    /** The serialized MLS GroupInfo with external pub and ratchet tree extensions, for external joins */
    groupInfo?: bytes;
  }
}

namespace io.github.uwx.yjs.mls.keyPackage {
  /** A published MLS KeyPackage for out-of-band group joining */
  @rec("tid")
  model Main {
    /** When this key package was created */
    @required createdAt: datetime;

    /** The serialized MLS KeyPackage message */
    @required keyPackage: bytes;

    /** Whether this is a last-resort key package that should not be consumed except when no others are available */
    lastResort?: boolean;
  }
}

namespace io.github.uwx.yjs.mls.message {
  /** An MLS message scoped to a room. All data (handshake, updates, awareness, checkpoints) flows through this single collection. */
  @rec("tid")
  model Main {
    /** The room this message belongs to */
    @required room: atUri;

    /** The type of MLS message */
    @required messageType: MessageType;

    /** The serialized MLS message payload */
    @required message: MessageData;

    /** The MLS epoch this message belongs to */
    @required epoch: integer;

    /** Whether this is a full state update (only for messageType "update") */
    isFullUpdate?: boolean;

    /** The serialized MLS ClientState (only for messageType "checkpoint") */
    checkpointState?: bytes;

    /** The TID of the last processed message when this checkpoint was created (only for messageType "checkpoint") */
    lastMessageTid?: tid;
  }

  /** The type of MLS message */
  union MessageType { "welcome", "commit", "proposal", "application", "update", "awareness", "checkpoint", string }

  @inline union MessageData { BytesMessageData, BlobMessageData }

  /** The message data as inline bytes */
  model BytesMessageData {
    @required bytes: bytes;
  }

  /** The message data as a blob reference */
  model BlobMessageData {
    @required blob: Blob;
  }
}

