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